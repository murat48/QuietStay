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
 *   3. the owner asks for issuance with their h, from their own session — asking
 *      in another account's name, or with an h that is not a number below the
 *      field modulus, is refused. The Issue screen shows the issuer the form and
 *      the ask, and everyone else only the ask box. The issuer issues one week
 *      from the ask — h taken from it, the first holder bound to the asker, the
 *      ask closed — and one from an h given directly, in hex. The server's C is
 *      the CLI's; a malformed h is refused with 400 before anything is issued.
 *      Each week's C on chain is confirmed by `npm run verify-record` from the
 *      record the screen lets the issuer save
 *   4. publish an offer and withdraw it
 *   5. the renter asks; the owner proves a rental with `npm run zk:prove` from
 *      that saved record and uploads it; it goes through
 *   6. the same proof again is refused — the nullifier is spent
 *   7. the renter cannot submit the owner's proof; nor can a tampered proof pass
 *   8. a sale needs the buyer's consent: proved without one it is refused; the
 *      buyer's forged consent is refused; a real one is recorded with the ask
 *   9. the owner proves the sale with the buyer's h' and it goes through; the
 *      commitment is now the buyer's
 *  10. the week's proof-verified transfers are listed for the verify screen
 *  11. a week with no transfer in the RPC's event window — which every week is,
 *      a week after its last transfer — gets the evidence transactions instead,
 *      so the verify screen never shows an empty list. Checked on an app that
 *      reads the evidence contract: E2E_EVIDENCE_BASE_URL, or the app under test
 *      if that is the one
 *
 * Run it against a throwaway deployment, not the one in docs/EVIDENCE.md — it
 * issues weeks — and point the app's data directory somewhere disposable, since
 * every contract numbers its rights from 1 (docs/SETUP.md, "End-to-end test").
 */

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hash, Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { verifyAttestation } from "../src/lib/attestation";
import { commit, type JsonValue } from "../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, issuerSecret } from "../src/lib/config";
import { readCommitment, readHolder, readIsActive, readNextId, readRight, server } from "../src/lib/contract";
import evidenceFile from "../docs/evidence-phase2.json";
import type { OwnershipRecord } from "../src/lib/record";
import type { IssuanceRequest } from "../src/lib/requests";
import { issueScreenView, type AccountStanding } from "../src/lib/roles";
import { fatal, loadEnv, log } from "./lib/cli";
import { R, commitment as poseidonCommitment, randomSecret, secretHash, splitRecordDigest } from "./lib/zk";
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

/** Run one of the command-line tools as a person would, with this process's environment. */
function cli(script: string, args: string[]): { status: number | null; output: string } {
  const run = spawnSync("node_modules/.bin/tsx", [script, ...args], { encoding: "utf8", env: process.env });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

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
  const notIssuer = await post("/api/issue", { record: freshRecord(owner.publicKey(), "2026-11-28", "2026-12-05"), secret_hash: "1" }, ownerToken);
  check(notIssuer.status === 403, "issuing as a non-issuer is refused (403)", notIssuer.status);
  check((await post("/api/requests/issuance", { secret_hash: "1" })).status === 401, "asking for issuance needs a session (401)");
  // What the Issue screen renders, from the standing /api/me reports for each account.
  const viewFor = async (token: string) => {
    const me = (await (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { is_issuer?: boolean };
    return issueScreenView({ isIssuer: me.is_issuer === true } as AccountStanding);
  };
  check((await viewFor(ownerToken)) === "request" && (await viewFor(renterToken)) === "request", "the Issue screen shows other accounts only the request box, not the form");
  check((await viewFor(issuerToken)) === "issue", "and shows the issuer the form");

  // --- 3. issue two weeks -------------------------------------------------
  log.step("3. The owner asks for issuance; the issuer issues from the ask, and from an h given directly");
  const work = mkdtempSync(join(tmpdir(), "quietstay-e2e-"));
  const hex = (h: bigint) => `0x${h.toString(16)}`;
  const issuanceAsks = async (token: string) =>
    ((await (await fetch(`${BASE}/api/requests/issuance`, { headers: { authorization: `Bearer ${token}` } })).json()) as { requests: IssuanceRequest[] }).requests;

  // The owner's side: a secret on their machine, and only its hash sent — from their session.
  const rentSecret = randomSecret();
  const rentHash = await secretHash(rentSecret);
  const forOther = await post("/api/requests/issuance", { secret_hash: rentHash.toString(), owner: renter.publicKey() }, ownerToken);
  check(forOther.status === 403, "asking in another account's name is refused (403)", forOther.status);
  for (const [what, value] of [["not a number", "twelve"], ["the field modulus r", R.toString()]] as const) {
    const bad = await post("/api/requests/issuance", { secret_hash: value }, ownerToken);
    check(bad.status === 400, `asking with h ${what} is refused (400)`, bad.status);
  }
  const asked = await post("/api/requests/issuance", { secret_hash: rentHash.toString() }, ownerToken);
  const issuanceAsk = ((await asked.json()) as { request?: IssuanceRequest }).request;
  check(asked.ok && issuanceAsk?.by === owner.publicKey() && issuanceAsk.secret_hash === rentHash.toString(), "the owner's ask is recorded for their own account, with h and nothing else", issuanceAsk);
  check(!(await issuanceAsks(renterToken)).some((r) => r.id === issuanceAsk?.id), "another account cannot see it");
  check((await issuanceAsks(issuerToken)).some((r) => r.id === issuanceAsk?.id && r.status === "open"), "the issuer sees it among the pending requests");

  // What the Issue screen sends: the record and h. The server computes C.
  const nextBefore = await readNextId();
  const badHashes: [string, unknown][] = [
    ["not a number", "twelve"],
    ["the field modulus r itself", R.toString()],
    ["r + 1, in hex", `0x${(R + 1n).toString(16)}`],
    ["zero", "0"],
    ["missing", undefined],
  ];
  for (const [what, value] of badHashes) {
    const response = await post("/api/issue", { record: freshRecord(owner.publicKey(), "2026-11-28", "2026-12-05"), secret_hash: value }, issuerToken);
    const body = (await response.json()) as { error?: string };
    check(response.status === 400 && /secret_hash/.test(body.error ?? ""), `h ${what}: refused (400)`, { status: response.status, body });
  }
  const wrongHolder = await post("/api/issue", { record: freshRecord(renter.publicKey(), "2026-11-28", "2026-12-05"), request_id: issuanceAsk?.id }, issuerToken);
  check(wrongHolder.status === 400, "issuing from the ask to anyone but the asker is refused (400)", wrongHolder.status);
  check((await readNextId()) === nextBefore, "and nothing was issued for any of them");

  type Via = { request: IssuanceRequest } | { encode: (h: bigint) => string };
  const issueWeek = async (checkIn: string, checkOut: string, secret: bigint, via: Via) => {
    const record = freshRecord(owner.publicKey(), checkIn, checkOut);
    const h = await secretHash(secret);
    // The record text as the screen holds it — what its "Save record" downloads.
    const recordText = JSON.stringify(record, null, 2);
    const response = await post(
      "/api/issue",
      "request" in via ? { record: JSON.parse(recordText), request_id: via.request.id } : { record: JSON.parse(recordText), secret_hash: via.encode(h) },
      issuerToken,
    );
    const body = (await response.json()) as { right_id?: number; record_digest?: string; commitment?: string; error?: string };
    check(response.ok && typeof body.right_id === "number", `week ${checkIn} issued ${"request" in via ? "from the owner's ask" : "with h given directly, in hex"}`, body);
    // The issuer's side, as `npm run zk:commitment` computes it.
    const d = await splitRecordDigest(record as unknown as JsonValue);
    const c = fr(await poseidonCommitment(d, owner.publicKey(), h));
    check(body.commitment === c, "the server's C is the C the command line computes");
    // The two files the owner keeps.
    const recordFile = join(work, `right-${body.right_id}.record.json`);
    writeFileSync(recordFile, recordText);
    const secretFile = join(work, `right-${body.right_id}.secret.json`);
    writeFileSync(secretFile, JSON.stringify({ secret: secret.toString() }), { mode: 0o600 });
    return { record, secret, h, rightId: body.right_id!, c, d: body.record_digest, recordFile, secretFile };
  };
  const forRent = await issueWeek("2026-11-28", "2026-12-05", rentSecret, { request: issuanceAsk! });
  check(!(await issuanceAsks(issuerToken)).some((r) => r.id === issuanceAsk?.id), "the issued ask drops off the issuer's list");
  const closed = (await issuanceAsks(ownerToken)).find((r) => r.id === issuanceAsk?.id);
  check(closed?.status === "issued" && closed.right_id === forRent.rightId, `the owner sees it issued as right #${forRent.rightId}`, closed);
  const again = await post("/api/issue", { record: freshRecord(owner.publicKey(), "2026-12-12", "2026-12-19"), request_id: issuanceAsk?.id }, issuerToken);
  check(again.status === 409, "an ask cannot be issued twice (409)", again.status);
  const forSale = await issueWeek("2026-12-05", "2026-12-12", randomSecret(), { encode: hex });
  check((await readCommitment(forRent.rightId)) === forRent.c, "the ledger holds the commitment the server computed");
  check(await readIsActive(forRent.rightId), "the new week is inside its validity window");
  check(forRent.d === (await commit(forRent.record as never)), "the app reports d = SHA-256 of the record");

  for (const week of [forRent, forSale]) {
    const attestationFile = join(work, `right-${week.rightId}.attestation.json`);
    writeFileSync(attestationFile, await (await fetch(`${BASE}/api/attestation/${week.rightId}`)).text());
    const verified = cli("scripts/verify-record.ts", [String(week.rightId), attestationFile, week.recordFile, "--secret-hash", week.h.toString()]);
    check(
      verified.status === 0 && verified.output.includes("The record and h give the commitment the ledger holds"),
      `npm run verify-record: the saved record and h give right #${week.rightId}'s C on chain`,
      verified.output.slice(-600),
    );
  }

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
  // The owner's machine: `npm run zk:prove` on the record saved from the Issue screen.
  const proofDir = join(work, "rental");
  const proved = cli("scripts/prove.ts", [
    "--record", forRent.recordFile,
    "--secret", forRent.secretFile,
    "--right", String(forRent.rightId),
    "--from", owner.publicKey(),
    "--to", renter.publicKey(),
    "--rental-until", String(unix("2026-12-05")),
    "--out", proofDir,
  ]);
  check(proved.status === 0, "npm run zk:prove proves the rental from the saved record", proved.output.slice(-600));
  const rental = { file: JSON.parse(readFileSync(join(proofDir, "transfer.json"), "utf8")) as TransferFile };
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

  // --- 11. the verify screen once the event window has passed ---------------
  log.step("11. A week with no transfer in the event window: evidence links instead");
  const evidenceBase = process.env.E2E_EVIDENCE_BASE_URL ?? BASE;
  const reads = ((await (await fetch(`${evidenceBase}/api/inventory`)).json()) as { contract: string; rights: { id: number }[] });
  if (reads.contract !== evidenceFile.contract) {
    failed += 1;
    log.fail(
      `${evidenceBase} reads ${reads.contract}, not the evidence contract ${evidenceFile.contract} — ` +
        "set E2E_EVIDENCE_BASE_URL to an app that reads it (docs/SETUP.md, End-to-end test)",
    );
  } else {
    // Any week the RPC has no recent transfer for is in the state every week
    // reaches a week after its last transfer.
    let quiet: { id: number; body: { transfers: unknown[]; evidence: { tx: string; accepted: boolean; error: string | null; explorer: string }[] } } | null = null;
    for (const r of reads.rights) {
      const body = await (await fetch(`${evidenceBase}/api/right/${r.id}/transfers`)).json();
      if (Array.isArray(body.transfers) && body.transfers.length === 0) {
        quiet = { id: r.id, body };
        break;
      }
    }
    check(quiet !== null, "found a week with no transfer in the event window", reads.rights.map((r) => r.id));
    if (quiet) {
      const { evidence } = quiet.body;
      const expected = evidenceFile.transactions.map((t) => t.hash);
      check(
        evidence.length === expected.length && evidence.every((e, i) => e.tx === expected[i]),
        `week #${quiet.id}: the screen gets all ${expected.length} evidence transactions, as in EVIDENCE.md`,
        evidence.map((e) => e.tx.slice(0, 8)),
      );
      check(
        evidence.filter((e) => e.accepted).length === 2 && evidence.filter((e) => !e.accepted && e.error).length === 5,
        "two accepted, five refused with their on-chain errors",
      );
      check(
        evidence.every((e) => e.explorer === `https://stellar.expert/explorer/testnet/tx/${e.tx}`),
        "each one is a Stellar Expert link",
      );
    }
  }
  const otherApp = (await (await fetch(`${BASE}/api/right/1/transfers`)).json()) as { evidence?: unknown[] };
  if (BASE !== evidenceBase) {
    check(otherApp.evidence?.length === 0, "an app on another contract shows no other contract's evidence", otherApp.evidence);
  }

  rmSync(work, { recursive: true, force: true });

  log.step("Result");
  log.info(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  // ffjavascript's curve worker threads outlive the last proof.
  process.exit(process.exitCode ?? 0);
}

main().catch(fatal);
