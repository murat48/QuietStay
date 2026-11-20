/**
 * Phase 3 Step 3: the testnet evidence runs on the deployed contract
 * (docs/PHASE3_PROMPT.md Step 3 checkpoint, approved 2026-11-20).
 *
 *   npx tsx scripts/step3-evidence.ts <step> --contract <C…>
 *
 * Steps, in the order run:
 *   issue              issue weeks 1–5 to qs-owner (signed by qs-issuer)
 *   wait-rental        week 1: rental with the earliest check-in, paid out after the wait (collect next session)
 *   sale               week 2: record request, sale offer, one-step sale
 *   dispute-open       week 3: rental, problem report, evidence from both sides, and the rejections while Disputed
 *   dispute-close      after scripts/arbiter-resolve.sh: the rejections after the refund   [--resolve-tx <hash>]
 *   confirm            week 5: rental confirmed early by the renter, then the rejections after payout
 *   sale-rejections    week 4: wrong amount, low allowance, low balance, expired offer
 *   escrow-rejections  week 1's Funded escrow: collect too early, the arbiter on an undisputed escrow,
 *                      an outside account; and the arbiter trying to move a right
 *   unaccepted-offer   week 4: a sale offer nobody accepts, which expires; USDC read before, during, after
 *
 * **Testnet only.** Every envelope is signed by a Stellar CLI identity
 * (`stellar tx sign --sign-with-key <identity>`); this script never reads a
 * key. The one exception is the outside account, a throwaway `Keypair.random()`
 * funded by Friendbot, which exists only in memory and is in no keystore.
 *
 * Rejected transactions are submitted with `withSiblingResources`
 * (scripts/lib/zk-tx.ts): the resources of a valid simulation, so each one
 * fails on the ledger at the contract's own check. Each must fail with exactly
 * the expected error, or the run stops and records nothing for it.
 *
 * Records and secrets go to .secrets/<contract 8>/step3/ (gitignored, 0700).
 * Every transaction is appended to evidence/step3-testnet-<contract 8>.json, and each step
 * ends with `check-privacy` over its transactions, output in evidence/privacy/.
 */

import { execFileSync } from "node:child_process";
import { createECDH, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Address, Keypair, nativeToScVal, rpc, scValToNative, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";

import type { JsonValue } from "../src/lib/canonical";
import { NETWORK_PASSPHRASE, USDC_CONTRACT_ID } from "../src/lib/config";
import { isoWeekNumber, validateRecord, type OwnershipRecord } from "../src/lib/record";
import { PUBLIC_SIGNALS } from "../src/lib/zk-fields";
import { fatal, log } from "./lib/cli";
import { commitment, randomSecret, secretHash, splitRecordDigest } from "./lib/zk";
import { fr } from "./lib/zk-encode";
import { proveTransfer } from "./lib/zk-prove";
import { buildCall, sendAndWait, simulate, struct, withSiblingResources, type Outcome } from "./lib/zk-tx";

const USDC = 10_000_000n;
const DAY = 86_400;
const OFFER_LEDGERS = 120_960;
const PROOF_WINDOW = 360n;
const TODAY = new Date().toISOString().slice(0, 10);
const HORIZON = "https://horizon-testnet.stellar.org";

if (NETWORK_PASSPHRASE !== "Test SDF Network ; September 2015") throw new Error("testnet only");

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: { contract: { type: "string" }, "resolve-tx": { type: "string" }, "resume-offer": { type: "string" } },
});
const STEP = positionals[0];
const C = a.contract ?? "";
if (!/^C[A-Z2-7]{55}$/.test(C)) throw new Error("--contract <C…> is required");
const DIR = resolve(".secrets", C.slice(0, 8), "step3");
mkdirSync(DIR, { recursive: true, mode: 0o700 });
// One log per contract, so a superseded deployment's runs stay apart.
const LOG = resolve(`evidence/step3-testnet-${C.slice(0, 8)}.json`);

// --- identities (public keys only) -------------------------------------------

const pk = (identity: string) => execFileSync("stellar", ["keys", "public-key", identity], { encoding: "utf8" }).trim();
const ID = {
  issuer: "qs-issuer",
  owner: "qs-owner",
  buyer: "qs-buyer",
  renter: "qs-renter",
  arbiter: "qs-arbiter",
} as const;
type Who = keyof typeof ID;
const ADDR = Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, pk(v)])) as Record<Who, string>;

// --- encoding ------------------------------------------------------------------

const addr = (g: string) => new Address(g).toScVal();
const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u256 = (n: bigint | string) => nativeToScVal(BigInt(n), { type: "u256" });
const bytes32 = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
const variant = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
const sha256File = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// --- state and the evidence log -----------------------------------------------

interface Week {
  right_id: number;
  record_file: string;
  secret_file: string;
  check_in: string;
  check_out: string;
  period: { start: number; end: number };
}
interface State {
  contract: string;
  weeks: Record<string, Week>;
  escrows: Record<string, number>;
  buyer_next_secret_files: string[];
}
const STATE_FILE = join(DIR, "state.json");
const state: State = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { contract: C, weeks: {}, escrows: {}, buyer_next_secret_files: [] };
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

interface Entry {
  step: string;
  label: string;
  hash: string;
  ledger: number;
  accepted: boolean;
  expected: string | null;
  errors: string[];
  note?: string;
}
const evidence: { contract: string; network: string; entries: Entry[] } = existsSync(LOG)
  ? JSON.parse(readFileSync(LOG, "utf8"))
  : { contract: C, network: "testnet", entries: [] };
const stepHashes: Record<string, string> = {};
function record(label: string, out: Outcome, expected: string | null, note?: string) {
  evidence.entries.push({
    step: STEP!,
    label,
    hash: out.hash,
    ledger: out.ledger,
    accepted: out.successful,
    expected,
    errors: out.errors,
    ...(note ? { note } : {}),
  });
  writeFileSync(LOG, JSON.stringify(evidence, null, 2) + "\n");
  stepHashes[label] = out.hash;
  const link = `https://stellar.expert/explorer/testnet/tx/${out.hash}`;
  if (out.successful) log.ok(`${label}: ${out.hash}`);
  else log.ok(`${label}: rejected on chain as expected (${expected}) ${out.hash}`);
  log.info(link);
}

// --- sending -----------------------------------------------------------------

/** Sign with a CLI identity from the keystore. The key never enters this process. */
function signAs(tx: Transaction, identity: string): Transaction {
  const signed = execFileSync("stellar", ["tx", "sign", "--sign-with-key", identity, "--network", "testnet"], {
    input: tx.toXDR(),
    encoding: "utf8",
  }).trim();
  return TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE) as Transaction;
}

type Signer = Who | Keypair;
const sourceOf = (s: Signer) => (s instanceof Keypair ? s.publicKey() : ADDR[s]);
function signWith(tx: Transaction, s: Signer): Transaction {
  if (s instanceof Keypair) {
    tx.sign(s);
    return tx;
  }
  return signAs(tx, ID[s]);
}

async function simulated(by: Signer, fn: string, args: xdr.ScVal[], contract = C) {
  const tx = await buildCall(sourceOf(by), contract, fn, args);
  return { tx, sim: await simulate(tx) };
}

/** A call meant to succeed: simulated, assembled, signed, sent. Stops the run if it fails. */
async function ok(label: string, by: Signer, fn: string, args: xdr.ScVal[], contract = C): Promise<Outcome> {
  const { tx, sim } = await simulated(by, fn, args, contract);
  const out = await sendAndWait(signWith(rpc.assembleTransaction(tx, sim).build(), by));
  if (!out.successful) throw new Error(`${label} failed: ${out.opResult} ${out.errors.join(" ")} (${out.hash})`);
  record(label, out, null);
  return out;
}

/**
 * A call the contract must refuse, sent on purpose so the refusal is on the
 * ledger. Its resources come from `sibling`, a valid simulation touching the
 * same entries. It must fail with exactly `expected`.
 */
async function rejected(
  label: string,
  by: Signer,
  fn: string,
  args: xdr.ScVal[],
  sibling: rpc.Api.SimulateTransactionSuccessResponse,
  expected: string,
): Promise<Outcome> {
  // The caller's own authorization of this exact call, as the source account:
  // what simulation would record. Without it even the caller's require_auth
  // fails, and the refusal would be the host's, not the contract's check.
  const own = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(C).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: [],
    }),
  });
  const tx = await buildCall(sourceOf(by), C, fn, args, [own]);
  const out = await sendAndWait(signWith(withSiblingResources(tx, sibling), by));
  if (out.successful) throw new Error(`${label}: expected ${expected}, but it was accepted (${out.hash})`);
  if (out.opResult !== "invokeHostFunctionTrapped" || !out.errors.includes(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${out.opResult} ${out.errors.join(" ")} (${out.hash}); not recorded`);
  }
  record(label, out, expected);
  return out;
}

/** A view's simulation, used only for its footprint. */
const view = async (fn: string, args: xdr.ScVal[], by: Signer = "issuer") => (await simulated(by, fn, args)).sim;

// --- chain reads ----------------------------------------------------------------

async function latestLedger(): Promise<{ sequence: number; closedAt: number }> {
  const res = await fetch(`${HORIZON}/ledgers?order=desc&limit=1`);
  const r = ((await res.json()) as { _embedded: { records: { sequence: number; closed_at: string }[] } })._embedded.records[0]!;
  return { sequence: r.sequence, closedAt: Math.floor(Date.parse(r.closed_at) / 1000) };
}

async function read(fn: string, args: xdr.ScVal[]): Promise<unknown> {
  const { sim } = await simulated("issuer", fn, args);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

const offerId = async () => Number(await read("next_offer_id", [])) - 1;
const escrowIdNow = async () => Number(await read("next_escrow_id", [])) - 1;

async function waitForLedger(target: number) {
  for (;;) {
    const { sequence } = await latestLedger();
    if (sequence >= target) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// --- weeks, proofs ---------------------------------------------------------------

const ownerSecret = (w: Week) => BigInt(JSON.parse(readFileSync(w.secret_file, "utf8")).secret);
const recordOf = (w: Week) => JSON.parse(readFileSync(w.record_file, "utf8")) as JsonValue;
const week = (n: number) => {
  const w = state.weeks[String(n)];
  if (!w) throw new Error(`week ${n} is not issued yet; run the issue step`);
  return w;
};

async function prove(w: Week, to: string, opts: { rentalUntil?: number; nextSecretHash?: bigint }) {
  const { sequence } = await latestLedger();
  const { file, seconds } = await proveTransfer(recordOf(w), ownerSecret(w), {
    rightId: BigInt(w.right_id),
    from: ADDR.owner,
    to,
    expiresAt: opts.rentalUntil === undefined ? null : BigInt(opts.rentalUntil),
    expiryLedger: BigInt(sequence) + PROOF_WINDOW,
    nextSecretHash: opts.nextSecretHash ?? 0n,
  });
  log.info(`proved in ${seconds.toFixed(1)} s, valid through ledger ${BigInt(sequence) + PROOF_WINDOW}`);
  const proof = struct({ a: bytes32(file.proof.a), b: bytes32(file.proof.b), c: bytes32(file.proof.c) });
  const signals = xdr.ScVal.scvVec(PUBLIC_SIGNALS.map((k) => u256(file.public_signals[k]!)));
  return { proof, signals };
}

/** A renter's offer with the earliest check-in that leaves time to accept: the last ledger's time plus `lead` seconds. */
async function rentalOffer(label: string, w: Week, renter: Who, price: bigint, lead = 180) {
  const { sequence, closedAt } = await latestLedger();
  const checkIn = closedAt + lead;
  if (checkIn < w.period.start || checkIn >= w.period.end) throw new Error("check-in falls outside the week");
  const expiresAt = w.period.end;
  await ok(label, renter, "create_rental_offer", [
    addr(ADDR[renter]),
    u64(w.right_id),
    i128(price),
    u64(expiresAt),
    u64(checkIn),
    u32(sequence + OFFER_LEDGERS),
  ]);
  return { offer: await offerId(), checkIn, expiresAt };
}

/** A buyer's record request and sale offer, with a fresh s' kept in .secrets. */
async function saleOffer(prefix: string, w: Week, price: bigint, expiresIn = OFFER_LEDGERS) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keyHash = createHash("sha256").update(ecdh.getPublicKey()).digest("hex");
  let { sequence } = await latestLedger();
  await ok(`${prefix} record request`, "buyer", "request_record", [addr(ADDR.buyer), u64(w.right_id), bytes32(keyHash), u32(sequence + OFFER_LEDGERS)]);
  const request = Number(await read("next_request_id", [])) - 1;
  const s = randomSecret();
  const sFile = join(DIR, `buyer-next-secret-right-${w.right_id}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(sFile, JSON.stringify({ secret: s.toString() }) + "\n", { mode: 0o600 });
  state.buyer_next_secret_files.push(sFile);
  saveState();
  const h = await secretHash(s);
  ({ sequence } = await latestLedger());
  await ok(`${prefix} sale offer`, "buyer", "create_sale_offer", [addr(ADDR.buyer), u64(request), i128(price), u256(h), u32(sequence + expiresIn)]);
  return { offer: await offerId(), h, sFile };
}

function checkPrivacy(group: string, opts: { weeks: Week[]; nextSecrets?: string[]; evidence?: string[] }) {
  const out = `evidence/privacy/${TODAY}-step3-${C.slice(0, 8)}-${group}.txt`;
  const args = ["tsx", "scripts/check-privacy.ts", "--network", "testnet", "--out", out];
  for (const [label, hash] of Object.entries(stepHashes)) args.push("--tx", `${label.replace(/[^a-z0-9-]+/gi, "-")}=${hash}`);
  for (const w of opts.weeks) args.push("--record", w.record_file, "--secret", w.secret_file);
  for (const f of opts.nextSecrets ?? []) args.push("--next-secret", f);
  for (const f of opts.evidence ?? []) args.push("--evidence", f);
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync("npx", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      log.ok(`privacy record: ${out}`);
      return;
    } catch (e) {
      const text = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`;
      if (attempt >= 3 || !/fetch failed|ECONNRESET|ETIMEDOUT/.test(text)) throw new Error(`check-privacy failed:\n${text}`);
      log.warn(`check-privacy hit a network failure (attempt ${attempt}); retrying`);
    }
  }
}

// --- the steps -------------------------------------------------------------------

async function issue() {
  const like = JSON.parse(readFileSync("inventory/records/week-03.json", "utf8")) as OwnershipRecord;
  const checkIn = TODAY;
  const checkOut = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 7 * DAY * 1000).toISOString().slice(0, 10);
  for (let n = 1; n <= 5; n += 1) {
    if (state.weeks[String(n)]) continue;
    const rec = validateRecord({
      ...like,
      record_id: randomUUID(),
      salt: randomBytes(32).toString("hex"),
      owner: { ...like.owner, stellar_account: ADDR.owner },
      week: { check_in: checkIn, check_out: checkOut, use_year: Number(checkIn.slice(0, 4)), week_number: isoWeekNumber(checkIn) },
    });
    const recordFile = join(DIR, `week-${n}-record.json`);
    const secretFile = join(DIR, `week-${n}-owner-secret.json`);
    writeFileSync(recordFile, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(secretFile, JSON.stringify({ secret: randomSecret().toString() }) + "\n", { mode: 0o600 });
    const d = await splitRecordDigest(rec as unknown as JsonValue);
    const h = await secretHash(BigInt(JSON.parse(readFileSync(secretFile, "utf8")).secret));
    const c = fr(await commitment(d, ADDR.owner, h));
    const period = { start: Date.parse(`${checkIn}T00:00:00Z`) / 1000, end: Date.parse(`${checkOut}T00:00:00Z`) / 1000 };
    const validity = { from: Date.parse(`${rec.week.use_year}-01-01T00:00:00Z`) / 1000, until: Date.parse(`${rec.week.use_year + 1}-01-01T00:00:00Z`) / 1000 };
    const out = await ok(`issue week ${n}`, "issuer", "issue", [
      addr(ADDR.owner),
      struct({ start: u64(period.start), end: u64(period.end) }),
      struct({ from: u64(validity.from), until: u64(validity.until) }),
      bytes32(c),
    ]);
    const rightId = Number(scValToNative(out.returnValue as xdr.ScVal));
    state.weeks[String(n)] = { right_id: rightId, record_file: recordFile, secret_file: secretFile, check_in: checkIn, check_out: checkOut, period };
    saveState();
    log.info(`week ${n} = right #${rightId}, ${checkIn} → ${checkOut}`);
  }
  checkPrivacy("issue", { weeks: Object.values(state.weeks) });
}

async function waitRental() {
  const w = week(1);
  const { offer, checkIn, expiresAt } = await rentalOffer("wait rental: rental offer", w, "renter", USDC, 90);
  const { proof, signals } = await prove(w, ADDR.renter, { rentalUntil: expiresAt });
  const { closedAt } = await latestLedger();
  if (closedAt > checkIn) throw new Error("check-in passed before acceptance; make the offer again with more lead");
  await ok("wait rental: accept (rental right + escrow)", "owner", "accept_rental", [addr(ADDR.owner), u64(offer), i128(USDC), proof, signals]);
  state.escrows.wait = await escrowIdNow();
  saveState();
  const collectAt = checkIn + DAY;
  log.step("Collect");
  log.info(`escrow #${state.escrows.wait}, check-in ${new Date(checkIn * 1000).toISOString()} (${checkIn})`);
  log.info(`collect possible from ledger time ${new Date(collectAt * 1000).toISOString()} (${collectAt})`);
  checkPrivacy("wait-rental", { weeks: [w] });
}

/**
 * Pick up a sale offer already on chain (its acceptance was refused in
 * simulation, nothing sent): its h' from the chain, the buyer's s' from the
 * file whose hash matches, and the offer's earlier transactions from the log
 * for the privacy record.
 */
async function resumeSaleOffer(offer: number, step = "sale") {
  const o = (await read("get_offer", [u64(offer)])) as { buyer: string; terms: [string, { next_secret_hash: bigint }] } | undefined;
  if (!o || o.terms[0] !== "Sale") throw new Error(`offer #${offer} is not a live sale offer`);
  const h = BigInt(o.terms[1].next_secret_hash);
  let sFile: string | undefined;
  for (const f of state.buyer_next_secret_files) {
    if ((await secretHash(BigInt(JSON.parse(readFileSync(f, "utf8")).secret))) === h) sFile = f;
  }
  if (!sFile) throw new Error(`no kept s' matches offer #${offer}'s h'`);
  for (const e of evidence.entries) if (e.step === step) stepHashes[e.label] = e.hash;
  log.info(`resuming offer #${offer}; s' found`);
  return { offer, h, sFile };
}

async function sale() {
  const w = week(2);
  const resume = a["resume-offer"];
  const { offer, h, sFile } = resume ? await resumeSaleOffer(Number(resume)) : await saleOffer("sale:", w, USDC);
  const { proof, signals } = await prove(w, ADDR.buyer, { nextSecretHash: h });
  await ok("sale: accept (right and USDC together)", "owner", "accept_sale", [addr(ADDR.owner), u64(offer), i128(USDC), proof, signals]);
  checkPrivacy("sale", { weeks: [w], nextSecrets: [sFile] });
}

const EVIDENCE = {
  report: "pilot/evidence/problem-report.txt",
  renter: "pilot/evidence/renter-evidence-1.txt",
  owner: "pilot/evidence/owner-evidence-1.txt",
  decision: "pilot/evidence/arbiter-decision.txt",
};

async function outsider(): Promise<Keypair> {
  const kp = Keypair.random();
  const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot: HTTP ${res.status}`);
  log.info(`outside account (throwaway, in memory only): ${kp.publicKey()}`);
  return kp;
}

async function disputeOpen() {
  const w = week(3);
  if (state.escrows.dispute) {
    // Resuming: the rental, the report and the evidence already landed.
    for (const e of evidence.entries) if (e.step === "dispute-open") stepHashes[e.label] = e.hash;
    log.info(`resuming at the rejections; escrow #${state.escrows.dispute} is already Disputed`);
    return disputeRejections(w, state.escrows.dispute);
  }
  const { offer, expiresAt } = await rentalOffer("dispute: rental offer", w, "renter", USDC);
  const { proof, signals } = await prove(w, ADDR.renter, { rentalUntil: expiresAt });
  await ok("dispute: accept (rental right + escrow)", "owner", "accept_rental", [addr(ADDR.owner), u64(offer), i128(USDC), proof, signals]);
  const e = await escrowIdNow();
  state.escrows.dispute = e;
  saveState();
  await ok("dispute: problem report (renter)", "renter", "report_problem", [addr(ADDR.renter), u64(e), bytes32(sha256File(EVIDENCE.report))]);
  await ok("dispute: evidence (renter)", "renter", "submit_evidence", [addr(ADDR.renter), u64(e), bytes32(sha256File(EVIDENCE.renter))]);
  await ok("dispute: evidence (owner)", "owner", "submit_evidence", [addr(ADDR.owner), u64(e), bytes32(sha256File(EVIDENCE.owner))]);
  return disputeRejections(w, e);
}

async function disputeRejections(w: Week, e: number) {
  const sib = await view("get_escrow", [u64(e)]);
  await rejected("rejected: collect during a dispute", "owner", "collect", [addr(ADDR.owner), u64(e)], sib, "Error(Contract, #46)");
  const out = await outsider();
  await rejected("rejected: an outside account resolves", out, "resolve", [addr(out.publicKey()), u64(e), variant("RefundRenter"), bytes32(sha256File(EVIDENCE.decision))], sib, "Error(Contract, #51)");
  await rejected("rejected: an outside account submits evidence", out, "submit_evidence", [addr(out.publicKey()), u64(e), bytes32(sha256File(EVIDENCE.decision))], sib, "Error(Contract, #47)");
  checkPrivacy("dispute-open", { weeks: [w], evidence: Object.values(EVIDENCE) });
  log.step("Next");
  log.info(`scripts/arbiter-resolve.sh --network testnet --contract ${C} --escrow ${e} --outcome refund-renter --decision ${EVIDENCE.decision} --arbiter qs-arbiter`);
}

async function disputeClose() {
  const w = week(3);
  const e = state.escrows.dispute!;
  const hash = a["resolve-tx"];
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("--resolve-tx <hash> is required");
  stepHashes["dispute: arbiter resolves (refund renter)"] = hash;
  const esc = (await read("get_escrow", [u64(e)])) as { state: string[]; decision_hash: Buffer };
  if (esc.state[0] !== "Refunded") throw new Error(`escrow #${e} is ${esc.state[0]}, not Refunded`);
  if (Buffer.from(esc.decision_hash).toString("hex") !== sha256File(EVIDENCE.decision)) throw new Error("decision hash differs");
  log.ok(`escrow #${e} Refunded; decision hash matches ${EVIDENCE.decision}`);
  const sib = await view("get_escrow", [u64(e)]);
  await rejected("rejected: double refund", "owner", "refund", [addr(ADDR.owner), u64(e)], sib, "Error(Contract, #46)");
  await rejected("rejected: the arbiter resolves again", "arbiter", "resolve", [addr(ADDR.arbiter), u64(e), variant("PayOwner"), bytes32(sha256File(EVIDENCE.decision))], sib, "Error(Contract, #46)");
  await rejected("rejected: payout after refund", "renter", "confirm", [addr(ADDR.renter), u64(e)], sib, "Error(Contract, #46)");
  checkPrivacy("dispute-close", { weeks: [w], evidence: Object.values(EVIDENCE) });
}

async function confirm() {
  const w = week(5);
  const { offer, expiresAt } = await rentalOffer("confirm: rental offer", w, "renter", USDC);
  const { proof, signals } = await prove(w, ADDR.renter, { rentalUntil: expiresAt });
  await ok("confirm: accept (rental right + escrow)", "owner", "accept_rental", [addr(ADDR.owner), u64(offer), i128(USDC), proof, signals]);
  const e = await escrowIdNow();
  state.escrows.confirm = e;
  saveState();
  await ok("confirm: the renter releases early", "renter", "confirm", [addr(ADDR.renter), u64(e)]);
  const sib = await view("get_escrow", [u64(e)]);
  await rejected("rejected: double payout", "renter", "confirm", [addr(ADDR.renter), u64(e)], sib, "Error(Contract, #46)");
  await rejected("rejected: refund after payout", "owner", "refund", [addr(ADDR.owner), u64(e)], sib, "Error(Contract, #46)");
  await rejected("rejected: problem report after payout", "renter", "report_problem", [addr(ADDR.renter), u64(e), bytes32(sha256File(EVIDENCE.report))], sib, "Error(Contract, #46)");
  checkPrivacy("confirm", { weeks: [w], evidence: [EVIDENCE.report] });
}

async function saleRejections() {
  const w = week(4);
  const { offer: A, h, sFile } = await saleOffer("sale rejections: offer A", w, USDC);
  const { proof, signals } = await prove(w, ADDR.buyer, { nextSecretHash: h });
  const accept = (offer: number, price: bigint) => [addr(ADDR.owner), u64(offer), i128(price), proof, signals];
  const sibA = (await simulated("owner", "accept_sale", accept(A, USDC))).sim;

  await rejected("rejected: wrong amount", "owner", "accept_sale", accept(A, USDC / 2n), sibA, "Error(Contract, #32)");

  let { sequence } = await latestLedger();
  await ok("sale rejections: the buyer lowers the allowance directly", "buyer", "approve", [addr(ADDR.buyer), addr(C), i128(USDC / 2n), u32(sequence + 2000)], USDC_CONTRACT_ID);
  await rejected("rejected: low allowance", "owner", "accept_sale", accept(A, USDC), sibA, "Error(Contract, #53)");

  // A second offer on the same week, with the same h', expiring soon. Its
  // creation also resets the allowance to the sum of live offers (A + B).
  ({ sequence } = await latestLedger());
  const request = await (async () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const keyHash = createHash("sha256").update(ecdh.getPublicKey()).digest("hex");
    await ok("sale rejections: offer B record request", "buyer", "request_record", [addr(ADDR.buyer), u64(w.right_id), bytes32(keyHash), u32(sequence + OFFER_LEDGERS)]);
    return Number(await read("next_request_id", [])) - 1;
  })();
  ({ sequence } = await latestLedger());
  const expiresB = sequence + 12;
  await ok("sale rejections: offer B (expires in 12 ledgers)", "buyer", "create_sale_offer", [addr(ADDR.buyer), u64(request), i128(USDC), u256(h), u32(expiresB)]);
  const B = await offerId();
  const sibB = (await simulated("owner", "accept_sale", accept(B, USDC))).sim;

  // Low balance: the buyer moves all but half a USDC away, then back.
  const balance = BigInt((await (async () => {
    const { sim } = await simulated("buyer", "balance", [addr(ADDR.buyer)], USDC_CONTRACT_ID);
    return scValToNative(sim.result!.retval);
  })()) as bigint);
  const away = balance - USDC / 2n;
  await ok("sale rejections: the buyer moves USDC away", "buyer", "transfer", [addr(ADDR.buyer), addr(ADDR.renter), i128(away)], USDC_CONTRACT_ID);
  await rejected("rejected: low balance", "owner", "accept_sale", accept(A, USDC), sibA, "Error(Contract, #54)");
  await ok("sale rejections: the USDC comes back", "renter", "transfer", [addr(ADDR.renter), addr(ADDR.buyer), i128(away)], USDC_CONTRACT_ID);

  log.info(`waiting for offer B to expire after ledger ${expiresB}…`);
  await waitForLedger(expiresB + 1);
  await rejected("rejected: expired offer", "owner", "accept_sale", accept(B, USDC), sibB, "Error(Contract, #34)");

  // Clean up: cancel A, which sets the allowance to the remaining live offers (none).
  await ok("sale rejections: the buyer cancels offer A", "buyer", "cancel_offer", [addr(ADDR.buyer), u64(A)]);
  checkPrivacy("sale-rejections", { weeks: [w], nextSecrets: [sFile] });
}

async function escrowRejections() {
  const e = state.escrows.wait;
  if (!e) throw new Error("run wait-rental first");
  const sib = await view("get_escrow", [u64(e)]);
  await rejected("rejected: collect before check-in + 24 h", "owner", "collect", [addr(ADDR.owner), u64(e)], sib, "Error(Contract, #48)");
  await rejected("rejected: the arbiter on an undisputed escrow", "arbiter", "resolve", [addr(ADDR.arbiter), u64(e), variant("PayOwner"), bytes32(sha256File(EVIDENCE.decision))], sib, "Error(Contract, #46)");
  const out = await outsider();
  await rejected("rejected: an outside account collects", out, "collect", [addr(out.publicKey()), u64(e)], sib, "Error(Contract, #47)");
  await rejected("rejected: an outside account confirms", out, "confirm", [addr(out.publicKey()), u64(e)], sib, "Error(Contract, #47)");
  // The arbiter tries to destroy a week it does not hold, naming its owner.
  const w = week(2 + 2); // week 4, still the owner's
  const sibIssuer = await view("get_right", [u64(w.right_id)], "arbiter");
  await rejected("rejected: the arbiter tries to burn a right (naming its owner)", "arbiter", "burn", [addr(ADDR.owner), u64(w.right_id)], sibIssuer, "Error(Auth, InvalidAction)");
  await rejected("rejected: the arbiter tries to burn a right (as itself)", "arbiter", "burn", [addr(ADDR.arbiter), u64(w.right_id)], sibIssuer, "Error(Contract, #4)");
  checkPrivacy("escrow-rejections", { weeks: [week(1), w] });
}

/**
 * The buyer's only live offer, cancelled: the contract sets the allowance to
 * zero, expiring at that offer's own last ledger (spec note 10). The USDC
 * contract must accept it, and the allowance must read back as 0.
 */
async function cancelLast() {
  const w = week(5);
  const { sequence, closedAt } = await latestLedger();
  await ok("cancel-last: the buyer's only offer", "buyer", "create_rental_offer", [
    addr(ADDR.buyer), u64(w.right_id), i128(USDC), u64(w.period.end), u64(closedAt + 3600), u32(sequence + 2000),
  ]);
  const offer = await offerId();
  const before = await allowanceOf(ADDR.buyer);
  await ok("cancel-last: cancel it (allowance to zero)", "buyer", "cancel_offer", [addr(ADDR.buyer), u64(offer)]);
  const after = await allowanceOf(ADDR.buyer);
  log.info(`allowance before ${before}, after ${after}`);
  if (before !== USDC || after !== 0n) throw new Error(`expected the allowance ${USDC} then 0, read ${before} then ${after}`);
  log.ok("the USDC contract accepted the zero allowance, and it reads back as 0");
  checkPrivacy("cancel-last", { weeks: [] });
}

async function allowanceOf(owner: string): Promise<bigint> {
  const { sim } = await simulated("issuer", "allowance", [addr(owner), addr(C)], USDC_CONTRACT_ID);
  return BigInt(scValToNative(sim.result!.retval) as bigint);
}

interface Reading {
  step: string;
  label: string;
  ledger: number;
  buyer: string;
  owner: string;
  contract: string;
  allowance: string;
}

/** The USDC that could move on an offer, read in one RPC round at one ledger each. */
async function readMoney(label: string): Promise<Reading> {
  const at = async (fn: string, args: xdr.ScVal[]) => {
    const { sim } = await simulated("issuer", fn, args, USDC_CONTRACT_ID);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`${fn} could not be read`);
    return { value: BigInt(scValToNative(sim.result.retval) as bigint), ledger: sim.latestLedger };
  };
  const [buyer, owner, contract, allowance] = await Promise.all([
    at("balance", [addr(ADDR.buyer)]),
    at("balance", [addr(ADDR.owner)]),
    at("balance", [addr(C)]),
    at("allowance", [addr(ADDR.buyer), addr(C)]),
  ]);
  const r: Reading = {
    step: STEP!,
    label,
    ledger: Math.min(buyer.ledger, owner.ledger, contract.ledger, allowance.ledger),
    buyer: buyer.value.toString(),
    owner: owner.value.toString(),
    contract: contract.value.toString(),
    allowance: allowance.value.toString(),
  };
  const e = evidence as typeof evidence & { readings?: Reading[] };
  (e.readings ??= []).push(r);
  writeFileSync(LOG, JSON.stringify(evidence, null, 2) + "\n");
  log.info(`${label} (ledger ${r.ledger}): buyer ${r.buyer}, owner ${r.owner}, contract ${r.contract}, buyer's allowance ${r.allowance}`);
  return r;
}

/**
 * The SOW's "an unaccepted offer moves no money" (Deliverable 2): the buyer
 * makes a 1 USDC sale offer for week 4 (still the owner's) that lives 30
 * ledgers, nobody accepts it, and it expires. The buyer's, the owner's and
 * the contract's USDC are read before the offer, while it is open, and after
 * it has expired. Nothing but the request and the offer is sent.
 */
async function unacceptedOffer() {
  const w = week(4);
  const resume = a["resume-offer"];
  let before: Reading, open: Reading, after: Reading, offer: number, sFile: string;
  if (resume) {
    // The offer and the three readings are already in the log; finish the checks.
    offer = Number(resume);
    const rs = ((evidence as { readings?: Reading[] }).readings ?? []).filter((r) => r.step === STEP);
    const find = (p: RegExp) => {
      const r = rs.find((x) => p.test(x.label));
      if (!r) throw new Error(`no reading matching ${p} in the log`);
      return r;
    };
    before = find(/^before the offer$/);
    open = find(new RegExp(`^offer #${offer} open`));
    after = find(new RegExp(`^offer #${offer} expired`));
    for (const e of evidence.entries) if (e.step === STEP) stepHashes[e.label] = e.hash;
    ({ sFile } = await resumeSaleOffer(offer, STEP!));
    log.info(`resuming offer #${offer} from the log`);
  } else {
    before = await readMoney("before the offer");
    ({ offer, sFile } = await saleOffer("unaccepted offer:", w, USDC, 30));
    const o = (await read("get_offer", [u64(offer)])) as { expires_ledger: number } | undefined;
    if (!o) throw new Error(`offer #${offer} is not on chain`);
    open = await readMoney(`offer #${offer} open, until ledger ${o.expires_ledger}`);
    log.info(`offer #${offer}: nobody accepts it; waiting past ledger ${o.expires_ledger}…`);
    await waitForLedger(o.expires_ledger + 2);
    after = await readMoney(`offer #${offer} expired, never accepted`);
  }
  const left = (await read("get_offer", [u64(offer)])) as { expires_ledger: number } | null | undefined;
  const { sequence } = await latestLedger();
  log.info(
    left == null
      ? `get_offer(${offer}) at ledger ${sequence}: none (the temporary entry has lapsed)`
      : `get_offer(${offer}) at ledger ${sequence}: still stored, expired since ledger ${left.expires_ledger} (it cannot be accepted: OfferExpired, #34)`,
  );
  for (const k of ["buyer", "owner", "contract"] as const) {
    if (before[k] !== open[k] || before[k] !== after[k]) throw new Error(`${k}'s USDC changed: ${before[k]} → ${open[k]} → ${after[k]}`);
  }
  if (open.allowance !== USDC.toString()) throw new Error(`expected an allowance of ${USDC} while open, read ${open.allowance}`);
  log.ok(`unaccepted offer #${offer} moved no USDC: buyer ${before.buyer}, owner ${before.owner}, contract ${before.contract} at all three readings`);
  checkPrivacy("unaccepted-offer", { weeks: [w], nextSecrets: [sFile] });
}

const STEPS: Record<string, () => Promise<void>> = {
  "unaccepted-offer": unacceptedOffer,
  "cancel-last": cancelLast,
  issue,
  "wait-rental": waitRental,
  sale,
  "dispute-open": disputeOpen,
  "dispute-close": disputeClose,
  confirm,
  "sale-rejections": saleRejections,
  "escrow-rejections": escrowRejections,
};

async function main() {
  const run = STEP ? STEPS[STEP] : undefined;
  if (!run) throw new Error(`step must be one of: ${Object.keys(STEPS).join(", ")}`);
  log.step(`Step 3 evidence: ${STEP} on ${C}`);
  await run();
  process.exit(0);
}

main().catch(fatal);
