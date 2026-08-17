/**
 * End-to-end test of the running web application.
 *
 *   npm run build && npm run start     # in one terminal
 *   npm run e2e                        # in another
 *
 * Drives the app the way a browser does — over HTTP, through the same routes the
 * screens call — while standing in for Freighter with a local keypair. It covers
 * the whole path the demo takes:
 *
 *   1. SEP-10: challenge, sign, session token
 *   2. a session token is actually required (unauthenticated calls are refused)
 *   3. issue a right through /api/issue as the issuer
 *   4. publish an offer, then withdraw it
 *   5. rent it out with issuer approval — succeeds
 *   6. try the same transfer with the approval withheld — rejected on chain
 *   7. the issuer declines to approve a week it has not attested
 *   8. one account cannot get an approval for another account's week
 *
 * Steps 6, 7, and 8 are the ones worth having. Anything can pass a happy path.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE, issuerSecret } from "../src/lib/config";
import { readHolder, readIsActive } from "../src/lib/contract";
import { isoDateToUnix, type OwnershipRecord } from "../src/lib/record";
import { fatal, loadEnv, log } from "./lib/cli";

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
  const challengeResponse = await fetch(
    `${BASE}/api/auth?account=${encodeURIComponent(keypair.publicKey())}`,
  );
  const challenge = (await challengeResponse.json()) as { transaction?: string; error?: string };
  if (!challenge.transaction) {
    throw new Error(`no challenge: ${challenge.error ?? challengeResponse.status}`);
  }

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
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Sign an envelope and submit it, returning what the ledger did. */
async function signAndSubmit(
  xdr: string | undefined,
  keypair: Keypair,
  token: string,
): Promise<{ hash?: string; successful?: boolean; failure?: string }> {
  if (!xdr) {
    // The previous step already recorded its own failure; don't bury it under an
    // XDR parse error.
    return { successful: false, failure: "no transaction to sign — a previous step failed" };
  }
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
  tx.sign(keypair);
  const response = await post("/api/tx/submit", { xdr: tx.toXDR() }, token);
  return (await response.json()) as { hash?: string; successful?: boolean; failure?: string };
}

function freshRecord(ownerAccount: string): OwnershipRecord {
  return {
    schema: "quietstay.ownership-record.v1",
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { name: "E2E Owner", email: "e2e@example.invalid", stellar_account: ownerAccount },
    resort: { name: "Cliffside Bay Club", country: "Portugal", unit: "Villa E2E", bedrooms: 2 },
    week: { check_in: "2026-11-28", check_out: "2026-12-05", use_year: 2026, week_number: 48 },
    title: {
      deed_reference: `E2E-${randomBytes(3).toString("hex").toUpperCase()}`,
      registry: "Cliffside Bay Club Members Registry",
      recorded_on: "2022-05-01",
    },
    maintenance_fees: {
      annual_amount: "820.00",
      currency: "EUR",
      paid_through: "2026-12-31",
      outstanding: "0.00",
    },
  };
}

async function main(): Promise<void> {
  const issuer = Keypair.fromSecret(issuerSecret());
  const owner = requireSecret("DEMO_OWNER_SECRET");
  const renter = requireSecret("DEMO_RENTER_SECRET");

  log.step(`Target ${BASE}`);
  const reachable = await fetch(`${BASE}/api/inventory`).then((r) => r.ok).catch(() => false);
  if (!reachable) {
    throw new Error(`${BASE} is not responding — start the app with \`npm run start\` first`);
  }
  log.ok("app is responding");

  // --- 1. SEP-10 ---------------------------------------------------------
  log.step("1. SEP-10 authentication");
  const issuerToken = await signIn(issuer);
  const ownerToken = await signIn(owner);
  const renterToken = await signIn(renter);
  check(issuerToken.length > 0, "issuer completed the SEP-10 handshake");
  check(ownerToken.length > 0, "owner completed the SEP-10 handshake");

  const tampered = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: "not-a-transaction" }),
  });
  check(tampered.status === 401, "a malformed challenge response is refused (401)", tampered.status);

  // --- 2. the token is actually required ---------------------------------
  log.step("2. Routes refuse unauthenticated callers");
  const noToken = await post("/api/approve-transfer", {
    from: owner.publicKey(),
    to: renter.publicKey(),
    rightId: 3,
    expiresAt: null,
  });
  check(noToken.status === 401, "approval without a session token is refused (401)", noToken.status);

  const noTokenIssue = await post("/api/issue", { record: freshRecord(owner.publicKey()) });
  check(noTokenIssue.status === 401, "issuing without a session token is refused (401)", noTokenIssue.status);

  const wrongIssuer = await post("/api/issue", { record: freshRecord(owner.publicKey()) }, ownerToken);
  check(
    wrongIssuer.status === 403,
    "issuing as a non-issuer account is refused (403)",
    wrongIssuer.status,
  );

  // --- 3. issue ----------------------------------------------------------
  log.step("3. Issue a right as the issuer");
  const issueResponse = await post(
    "/api/issue",
    { record: freshRecord(owner.publicKey()) },
    issuerToken,
  );
  const issued = (await issueResponse.json()) as {
    right_id?: number;
    commitment?: string;
    attested_clean?: boolean;
    error?: string;
  };
  check(issueResponse.ok && typeof issued.right_id === "number", "right issued", issued);
  check(issued.attested_clean === true, "issuer attested the week as clean");
  const rightId = issued.right_id!;
  log.info(`right #${rightId}, commitment ${issued.commitment?.slice(0, 16)}…`);
  check(await readIsActive(rightId), "the new right is inside its validity window");
  check((await readHolder(rightId)) === owner.publicKey(), "the owner holds it");

  // --- 4. offers ---------------------------------------------------------
  log.step("4. Publish and withdraw an offer");
  const listBuild = await post(
    "/api/tx/build",
    { action: "list", by: owner.publicKey(), rightId, termSecs: 7 * 86_400 },
    ownerToken,
  );
  const listBody = (await listBuild.json()) as { xdr?: string; error?: string };
  check(listBuild.ok && !!listBody.xdr, "offer transaction built", listBody);
  const listed = await signAndSubmit(listBody.xdr, owner, ownerToken);
  check(listed.successful === true, "offer published on chain", listed);

  const unlistBuild = await post(
    "/api/tx/build",
    { action: "unlist", by: owner.publicKey(), rightId },
    ownerToken,
  );
  const unlistBody = (await unlistBuild.json()) as { xdr?: string };
  const unlisted = await signAndSubmit(unlistBody.xdr, owner, ownerToken);
  check(unlisted.successful === true, "offer withdrawn on chain", unlisted);

  // --- 5. a rental, with approval ----------------------------------------
  log.step("5. Rent it out with the issuer's approval");
  const rentalExpiry = isoDateToUnix("2026-12-05");
  const approval = await post(
    "/api/approve-transfer",
    { from: owner.publicKey(), to: renter.publicKey(), rightId, expiresAt: rentalExpiry },
    ownerToken,
  );
  const approvalBody = (await approval.json()) as {
    xdr?: string;
    approved_by?: string;
    error?: string;
  };
  check(approval.ok && !!approvalBody.xdr, "issuer approved the rental", approvalBody);
  check(
    approvalBody.approved_by === issuer.publicKey(),
    "approval carries the issuer's authorization",
  );

  const rented = await signAndSubmit(approvalBody.xdr, owner, ownerToken);
  check(rented.successful === true, "rental confirmed on chain", rented);
  check((await readHolder(rightId)) === renter.publicKey(), "the renter is now the holder");
  log.info(`tx ${rented.hash}`);

  // --- 6. the same transfer, approval withheld ---------------------------
  log.step("6. The same transfer without the issuer's approval");
  const unapproved = await post(
    "/api/tx/unapproved-transfer",
    { from: renter.publicKey(), to: owner.publicKey(), rightId, expiresAt: rentalExpiry },
    renterToken,
  );
  const unapprovedBody = (await unapproved.json()) as { xdr?: string; error?: string };
  check(unapproved.ok && !!unapprovedBody.xdr, "unapproved transfer built", unapprovedBody);

  const refused = await signAndSubmit(unapprovedBody.xdr, renter, renterToken);
  check(refused.successful === false, "the contract rejected it", refused);
  check(!!refused.hash, "the rejection has a transaction hash a reviewer can open");
  check(
    (await readHolder(rightId)) === renter.publicKey(),
    "the week did not move despite a signed, paid-for transaction",
  );
  log.info(`tx ${refused.hash} — ${refused.failure}`);

  // --- 7. the issuer declines a week it has not attested -----------------
  log.step("7. The issuer declines a week it cannot vouch for");
  const unattested = await post(
    "/api/approve-transfer",
    { from: owner.publicKey(), to: renter.publicKey(), rightId: 4, expiresAt: null },
    ownerToken,
  );
  const unattestedBody = (await unattested.json()) as { error?: string };
  check(
    unattested.status === 403,
    "approval declined for right #4, which carries unpaid maintenance fees",
    unattestedBody,
  );
  log.info(`reason: ${unattestedBody.error}`);
  check(
    (await readHolder(4)) === owner.publicKey(),
    "declining is not seizing — the holder still holds it",
  );

  // --- 8. no approvals on someone else's behalf --------------------------
  log.step("8. Nobody can get an approval for another account's week");
  const impersonation = await post(
    "/api/approve-transfer",
    { from: owner.publicKey(), to: renter.publicKey(), rightId: 3, expiresAt: null },
    renterToken,
  );
  check(
    impersonation.status === 403,
    "an approval request naming another account as sender is refused (403)",
    impersonation.status,
  );

  // --- 9. roles are read off the ledger, not declared ---------------------
  log.step("9. Roles come from the registry");

  const standing = async (token: string) => {
    const response = await fetch(`${BASE}/api/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        roles?: string[];
        is_issuer?: boolean;
        counts?: { owned: number; renting: number; rented_out: number };
        error?: string;
      },
    };
  };

  const anonymous = await fetch(`${BASE}/api/me`);
  check(anonymous.status === 401, "standing without a session token is refused (401)", anonymous.status);

  const issuerStanding = await standing(issuerToken);
  check(issuerStanding.body.is_issuer === true, "the issuer is recognised as the issuer", issuerStanding.body);
  check(
    issuerStanding.body.roles?.includes("issuer") === true,
    "issuer role present",
    issuerStanding.body.roles,
  );

  const ownerStanding = await standing(ownerToken);
  check(
    ownerStanding.body.roles?.includes("lessor") === true,
    "the owner is recognised as a lessor (kiraya veren)",
    ownerStanding.body.roles,
  );
  check(
    ownerStanding.body.is_issuer === false,
    "the owner is not mistaken for the issuer",
    ownerStanding.body.is_issuer,
  );
  log.info(
    `owner holds ${ownerStanding.body.counts?.owned} outright, ` +
      `${ownerStanding.body.counts?.rented_out} out on rental`,
  );

  const renterStanding = await standing(renterToken);
  check(
    renterStanding.body.roles?.includes("lessee") === true,
    "the renter is recognised as a lessee (kiracı)",
    renterStanding.body.roles,
  );
  check(
    (renterStanding.body.counts?.renting ?? 0) > 0,
    "the renter's held weeks are listed",
    renterStanding.body.counts,
  );

  // An account nobody has ever heard of, and which Horizon has never seen. SEP-10
  // permits authenticating it with its master key, and it should come back holding
  // nothing rather than erroring.
  const stranger = Keypair.random();
  const strangerToken = await signIn(stranger);
  const strangerStanding = await standing(strangerToken);
  check(
    strangerStanding.body.roles?.length === 1 && strangerStanding.body.roles[0] === "visitor",
    "an unfunded, unknown account authenticates and is a visitor",
    strangerStanding.body.roles,
  );
  check(
    strangerStanding.body.counts?.owned === 0 && strangerStanding.body.counts?.renting === 0,
    "a visitor holds nothing",
    strangerStanding.body.counts,
  );

  // A visitor has nothing to transfer, so the approval service must refuse them
  // even though they are properly authenticated.
  const visitorAttempt = await post(
    "/api/approve-transfer",
    { from: stranger.publicKey(), to: owner.publicKey(), rightId: 3, expiresAt: null },
    strangerToken,
  );
  check(
    visitorAttempt.status === 403,
    "a visitor cannot get approval for a week they do not hold (403)",
    visitorAttempt.status,
  );

  // --- done --------------------------------------------------------------
  log.step("Result");
  if (failed === 0) {
    log.ok(`${passed} checks passed`);
  } else {
    log.fail(`${failed} of ${passed + failed} checks failed`);
    process.exitCode = 1;
  }
}

main().catch(fatal);
