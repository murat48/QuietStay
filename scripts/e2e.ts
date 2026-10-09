/**
 * End-to-end test of the running web application — Phase 2, proof-gated transfers.
 *
 *   npm run build && npm run start     # in one terminal
 *   npm run e2e                        # in another
 *
 * Drives the app the way a browser does — over HTTP, through the routes the
 * screens call — standing in for the wallet with local keypairs from .env.local,
 * and for the holder's machine with the same prover `npm run zk:prove` uses:
 *
 *   1. SEP-10 for the issuer, owner, renter and buyer; a forged response refused
 *   2. routes refuse callers without a session, and non-issuers cannot issue
 *   3. issue two weeks — C computed as the CLI computes it, attestation v2 bound
 *      to d, the right id and the contract
 *   4. publish an offer and withdraw it
 *   5. the renter asks; the owner proves a rental and uploads it; it goes through
 *   6. the same proof again is refused — the nullifier is spent
 *   7. the renter cannot submit the owner's proof; nor can a tampered proof pass
 *   8. a sale needs the buyer's consent: proved without one it is refused; the
 *      buyer's forged consent is refused; a real one is recorded with the ask
 *   9. the owner proves the sale with the buyer's h' and it goes through; the
 *      commitment is now the buyer's
 *  10. the week's proof-verified transfers are listed for the verify screen
 *
 * Run it against a throwaway deployment, not the one in docs/EVIDENCE.md — it
 * issues weeks — and point the app's data directory somewhere disposable, since
 * every contract numbers its rights from 1 (docs/SETUP.md, "End-to-end test").
 */

import { randomBytes, randomUUID } from "node:crypto";

import { hash, Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { verifyAttestation } from "../src/lib/attestation";
import { commit, type JsonValue } from "../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, issuerSecret } from "../src/lib/config";
import { readCommitment, readHolder, readIsActive, readRight, server } from "../src/lib/contract";
import type { OwnershipRecord } from "../src/lib/record";
import { fatal, loadEnv, log } from "./lib/cli";
import { commitment as poseidonCommitment, randomSecret, secretHash, splitRecordDigest } from "./lib/zk";
import { fr } from "./lib/zk-encode";
import { proveTransfer, type TransferFile } from "./lib/zk-prove";

loadEnv();

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;

function check(condition: boolean, description: string, detail?: unknown): void {
  if (condition) {
    passed += 1;
    log.ok(description);
  } else {
    failed += 1;
    log.fail(description);
    if (detail !== undefined) log.info(`   got: ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

function requireSecret(name: string): Keypair {
  const secret = process.env[name];
  if (!secret) throw new Error(`${name} is not set — see .env.example`);
  return Keypair.fromSecret(secret);
}

/** Stand in for a browser wallet: complete SEP-10 and return the session token. */
async function signIn(keypair: Keypair): Promise<string> {
  const challengeResponse = await fetch(`${BASE}/api/auth?account=${encodeURIComponent(keypair.publicKey())}`);
  const challenge = (await challengeResponse.json()) as { transaction?: string; error?: string };
  if (!challenge.transaction) throw new Error(`no challenge: ${challenge.error ?? challengeResponse.status}`);
  const tx = TransactionBuilder.fromXDR(challenge.transaction, NETWORK_PASSPHRASE) as Transaction;
  tx.sign(keypair);
  const sessionResponse = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  const session = (await sessionResponse.json()) as { token?: string; error?: string };
  if (!session.token) throw new Error(`sign-in failed: ${session.error ?? sessionResponse.status}`);
  return session.token;
}

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

/** Sign an envelope and submit it, returning what the ledger did. */
async function signAndSubmit(
  xdr: string | undefined,
  keypair: Keypair,
  token: string,
): Promise<{ hash?: string; successful?: boolean; failure?: string }> {
  if (!xdr) return { successful: false, failure: "no transaction to sign — a previous step failed" };
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
  tx.sign(keypair);
  const response = await post("/api/tx/submit", { xdr: tx.toXDR() }, token);
  return (await response.json()) as { hash?: string; successful?: boolean; failure?: string };
}

/** Build through the app with a proof file, the way the Transfer screen does. */
async function buildProven(file: TransferFile, token: string) {
  const response = await post("/api/tx/proven-transfer", { transfer: file }, token);
  return { status: response.status, body: (await response.json()) as { xdr?: string; error?: string; request_id?: string } };
}

function freshRecord(ownerAccount: string, checkIn: string, checkOut: string): OwnershipRecord {
  return {
    schema: "quietstay.ownership-record.v1",
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { name: "E2E Owner", email: "e2e@example.invalid", stellar_account: ownerAccount },
    resort: { name: "Cliffside Bay Club", country: "Portugal", unit: "Villa E2E", bedrooms: 2 },
    week: { check_in: checkIn, check_out: checkOut, use_year: 2026, week_number: 48 },
    title: {
      deed_reference: `E2E-${randomBytes(3).toString("hex").toUpperCase()}`,
      registry: "Cliffside Bay Club Members Registry",
      recorded_on: "2022-05-01",
    },
    maintenance_fees: { annual_amount: "820.00", currency: "EUR", paid_through: "2026-12-31", outstanding: "0.00" },
  };
}

const unix = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

async function main(): Promise<void> {
  const issuer = Keypair.fromSecret(issuerSecret());
  const owner = requireSecret("DEMO_OWNER_SECRET");
  const renter = requireSecret("DEMO_RENTER_SECRET");
  const buyer = requireSecret("DEMO_BUYER_SECRET");

  log.step(`Target ${BASE}, contract ${CONTRACT_ID}`);
  const reachable = await fetch(`${BASE}/api/inventory`).then((r) => r.ok).catch(() => false);
  if (!reachable) throw new Error(`${BASE} is not responding — start the app with \`npm run start\` first`);
  log.ok("app is responding");

  // --- 1. SEP-10 ---------------------------------------------------------
  log.step("1. SEP-10 authentication");
  const issuerToken = await signIn(issuer);
  const ownerToken = await signIn(owner);
  const renterToken = await signIn(renter);
  const buyerToken = await signIn(buyer);
  check([issuerToken, ownerToken, renterToken, buyerToken].every((t) => t.length > 0), "all four accounts completed SEP-10");
  const forged = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: "not-a-transaction" }),
  });
  check(forged.status === 401, "a malformed challenge response is refused (401)", forged.status);

  // --- 2. sessions required ----------------------------------------------
  log.step("2. Routes refuse unauthenticated callers");
  check((await post("/api/tx/proven-transfer", { transfer: {} })).status === 401, "building a transfer needs a session (401)");
  check((await post("/api/requests/consent", { right_id: 1, next_secret_hash: "1" })).status === 401, "preparing a consent needs a session (401)");
  check((await post("/api/issue", { record: {} })).status === 401, "issuing needs a session (401)");
  const notIssuer = await post("/api/issue", { record: freshRecord(owner.publicKey(), "2026-11-28", "2026-12-05"), commitment: "00".repeat(32) }, ownerToken);
  check(notIssuer.status === 403, "issuing as a non-issuer is refused (403)", notIssuer.status);

  // --- 3. issue two weeks -------------------------------------------------
  log.step("3. Issue two weeks, each committed to the owner's secret");
  const issueWeek = async (checkIn: string, checkOut: string) => {
    const record = freshRecord(owner.publicKey(), checkIn, checkOut);
    // The owner's side: a secret, and only its hash handed over.
    const secret = randomSecret();
    const h = await secretHash(secret);
    // The issuer's side, as `npm run zk:commitment` computes it.
    const d = await splitRecordDigest(record as unknown as JsonValue);
    const c = fr(await poseidonCommitment(d, owner.publicKey(), h));
    const response = await post("/api/issue", { record, commitment: c }, issuerToken);
    const body = (await response.json()) as { right_id?: number; record_digest?: string; commitment?: string; error?: string };
    check(response.ok && typeof body.right_id === "number", `week ${checkIn} issued`, body);
    return { record, secret, rightId: body.right_id!, c, d: body.record_digest };
  };
  const forRent = await issueWeek("2026-11-28", "2026-12-05");
  const forSale = await issueWeek("2026-12-05", "2026-12-12");
  check((await readCommitment(forRent.rightId)) === forRent.c, "the ledger holds the commitment the issuer computed");
  check(await readIsActive(forRent.rightId), "the new week is inside its validity window");
  check(forRent.d === (await commit(forRent.record as never)), "the app reports d = SHA-256 of the record");

  const attestation = await (await fetch(`${BASE}/api/attestation/${forRent.rightId}`)).json();
  const verified = verifyAttestation(attestation, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId: forRent.rightId,
    contractIssuer: issuer.publicKey(),
    recordDigest: forRent.d,
  });
  check(verified.ok, "the attestation verifies against d, this right and this contract", verified.checks.filter((c) => !c.ok));
  const elsewhere = verifyAttestation(attestation, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId: forSale.rightId,
    contractIssuer: issuer.publicKey(),
  });
  check(!elsewhere.ok, "the same attestation does not verify for another week");

  // --- 4. offers ---------------------------------------------------------
  log.step("4. Publish an offer, withdraw it, publish again");
  const offer = async (rightId: number, termSecs: number | null) => {
    const built = await post("/api/tx/build", { action: "list", by: owner.publicKey(), rightId, termSecs }, ownerToken);
    return signAndSubmit(((await built.json()) as { xdr?: string }).xdr, owner, ownerToken);
  };
  check((await offer(forRent.rightId, 7 * 86_400)).successful === true, "rental offer published");
  const unlist = await post("/api/tx/build", { action: "unlist", by: owner.publicKey(), rightId: forRent.rightId }, ownerToken);
  check((await signAndSubmit(((await unlist.json()) as { xdr?: string }).xdr, owner, ownerToken)).successful === true, "offer withdrawn");
  check((await offer(forRent.rightId, 7 * 86_400)).successful === true, "rental offer published again");
  check((await offer(forSale.rightId, null)).successful === true, "sale offer published");

  // --- 5. a proven rental -----------------------------------------------
  log.step("5. The renter asks; the owner proves a rental and submits it");
  const ask = await post("/api/requests", { right_id: forRent.rightId }, renterToken);
  check(ask.ok, "the renter's ask is recorded", await ask.clone().json());
  const latest = (await server.getLatestLedger()).sequence;
  const rental = await proveTransfer(forRent.record as unknown as JsonValue, forRent.secret, {
    rightId: BigInt(forRent.rightId),
    from: owner.publicKey(),
    to: renter.publicKey(),
    expiresAt: BigInt(unix("2026-12-05")),
    expiryLedger: BigInt(latest + 360),
    nextSecretHash: 0n,
  });
  log.info(`rental proved in ${rental.seconds.toFixed(1)} s`);
  const built = await buildProven(rental.file, ownerToken);
  check(built.status === 200 && !!built.body.xdr, "the app builds the rental from the proof file", built.body);
  check(typeof built.body.request_id === "string", "and links it to the renter's ask");
  const rented = await signAndSubmit(built.body.xdr, owner, ownerToken);
  check(rented.successful === true, "the proof-authorized rental succeeds on chain", rented);
  check((await readHolder(forRent.rightId)) === renter.publicKey(), "the renter now holds the week");
  if (built.body.request_id) {
    const answered = await post(`/api/requests/${built.body.request_id}`, { right_id: forRent.rightId, action: "accepted", tx: rented.hash }, ownerToken);
    check(answered.ok, "the ask is recorded as accepted", await answered.clone().json());
  }

  // --- 6. replay -------------------------------------------------------------
  log.step("6. The same proof again");
  const replay = await buildProven(rental.file, ownerToken);
  check(replay.status === 400 && /already been used|NullifierUsed/.test(replay.body.error ?? ""), "refused: the nullifier is spent", replay.body);

  // --- 7. wrong account, tampered proof ---------------------------------------
  log.step("7. Someone else's proof, and a tampered one");
  const stolen = await buildProven(rental.file, renterToken);
  check(stolen.status === 403, "the renter cannot submit the owner's proof (403)", stolen.status);
  const saleLatest = (await server.getLatestLedger()).sequence;
  const buyerSecret = randomSecret();
  const buyerHash = await secretHash(buyerSecret);
  const sale = await proveTransfer(forSale.record as unknown as JsonValue, forSale.secret, {
    rightId: BigInt(forSale.rightId),
    from: owner.publicKey(),
    to: buyer.publicKey(),
    expiresAt: null,
    expiryLedger: BigInt(saleLatest + 360),
    nextSecretHash: buyerHash,
  });
  const tamperedFile: TransferFile = { ...sale.file, proof: { a: sale.file.proof.c, b: sale.file.proof.b, c: sale.file.proof.a } };

  // --- 8. the buyer's consent ------------------------------------------------
  log.step("8. A sale needs the buyer's consent");
  const noConsent = await buildProven(sale.file, ownerToken);
  check(noConsent.status === 409, "proved before the buyer asked: refused, no consent on file (409)", noConsent.body);
  const askNoConsent = await post("/api/requests", { right_id: forSale.rightId }, buyerToken);
  check(askNoConsent.status === 400, "asking to buy without a consent is refused (400)", askNoConsent.status);

  const prep = await post("/api/requests/consent", { right_id: forSale.rightId, next_secret_hash: buyerHash.toString() }, buyerToken);
  const toSign = (await prep.json()) as { entry: string; preimage: string; valid_until_ledger: number };
  check(prep.ok && typeof toSign.preimage === "string", "the app prepares the consent for the buyer's wallet");
  // What the wallet does: sign the SHA-256 of the preimage with the account key.
  const sign = (kp: Keypair) => kp.sign(hash(Buffer.from(toSign.preimage, "base64"))).toString("base64");
  const forgedConsent = await post(
    "/api/requests",
    { right_id: forSale.rightId, consent: { next_secret_hash: buyerHash.toString(), entry: toSign.entry, signature: sign(renter), valid_until_ledger: toSign.valid_until_ledger } },
    buyerToken,
  );
  check(forgedConsent.status === 400, "a consent signed by another key is refused (400)", forgedConsent.status);
  const realConsent = await post(
    "/api/requests",
    { right_id: forSale.rightId, consent: { next_secret_hash: buyerHash.toString(), entry: toSign.entry, signature: sign(buyer), valid_until_ledger: toSign.valid_until_ledger } },
    buyerToken,
  );
  check(realConsent.ok, "the buyer's signed consent is recorded with the ask", await realConsent.clone().json());

  const tampered = await buildProven(tamperedFile, ownerToken);
  check(tampered.status === 400 && /did not verify|InvalidProof/.test(tampered.body.error ?? ""), "a tampered proof is refused: it does not verify", tampered.body);

  // --- 9. the sale ---------------------------------------------------------
  log.step("9. The owner proves the sale with the buyer's h' and submits it");
  const saleBuilt = await buildProven(sale.file, ownerToken);
  check(saleBuilt.status === 200 && !!saleBuilt.body.xdr, "the app builds the sale with the buyer's consent attached", saleBuilt.body);
  const sold = await signAndSubmit(saleBuilt.body.xdr, owner, ownerToken);
  check(sold.successful === true, "the proof-authorized sale succeeds on chain", sold);
  check((await readHolder(forSale.rightId)) === buyer.publicKey(), "the buyer now holds the week");
  const d2 = await splitRecordDigest(forSale.record as unknown as JsonValue);
  const buyerC = fr(await poseidonCommitment(d2, buyer.publicKey(), buyerHash));
  check((await readRight(forSale.rightId)).commitment === buyerC, "the commitment is now the buyer's — only they can prove next");

  // --- 10. the verify screen's on-chain list ------------------------------------
  log.step("10. The verify screen's list of proof-verified transfers");
  const listed = (await (await fetch(`${BASE}/api/right/${forSale.rightId}/transfers`)).json()) as { transfers?: { tx: string; kind: string }[] };
  check(listed.transfers?.some((t) => t.tx === sold.hash && t.kind === "sale") === true, "the sale is listed with its transaction", listed);

  log.step("Result");
  log.info(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  // ffjavascript's curve worker threads outlive the last proof.
  process.exit(process.exitCode ?? 0);
}

main().catch(fatal);
