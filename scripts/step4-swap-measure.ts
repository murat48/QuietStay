/**
 * Phase 3 Step 4, first item: does a swap with two proof verifications fit in
 * one transaction? (docs/PHASE3_PROMPT.md Step 4.)
 *
 *   npx tsx scripts/step4-swap-measure.ts --contract <C…>
 *
 * On the integrated contract, with builder accounts only:
 *   1. issue one week to qs-owner (the maker) and one to qs-buyer (the taker);
 *   2. each side's record request for the other's week (D4a);
 *   3. offer_swap (maker), accept_swap (taker, proof stored);
 *   4. complete_swap (maker): simulated first, its resources recorded, then
 *      sent as one real transaction, its fee and on-chain resources recorded.
 *
 * The limits are read from the network by `stellar network settings` and
 * passed in as `--settings <json>`, never assumed. Memory is not in the RPC's
 * simulation; it comes from the local host budget
 * (`cargo test -p quietstay-rights swap_cost -- --nocapture`).
 *
 * **Testnet only.** Every envelope is signed by a Stellar CLI identity
 * (`stellar tx sign --sign-with-key`); this script never reads a key. Records
 * and secrets go to .secrets/<contract 8>/step4/ (gitignored, 0700). The log
 * goes to evidence/step4-testnet-<contract 8>.json, and the run ends with
 * `check-privacy` over its transactions.
 */

import { execFileSync } from "node:child_process";
import { createECDH, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Address, nativeToScVal, rpc, scValToNative, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";

import type { JsonValue } from "../src/lib/canonical";
import { NETWORK_PASSPHRASE, RPC_URL } from "../src/lib/config";
import { RetryingServer } from "../src/lib/rpc-server";
import { isoWeekNumber, validateRecord, type OwnershipRecord } from "../src/lib/record";
import { PUBLIC_SIGNALS } from "../src/lib/zk-fields";
import { fatal, log } from "./lib/cli";
import { commitment, randomSecret, secretHash, splitRecordDigest } from "./lib/zk";
import { fr } from "./lib/zk-encode";
import { proveTransfer } from "./lib/zk-prove";
import { buildCall, sendAndWait, simulate, struct, type Outcome } from "./lib/zk-tx";

const DAY = 86_400;
const OFFER_LEDGERS = 2_000;
const PROOF_WINDOW = 360n;
const TODAY = new Date().toISOString().slice(0, 10);
const HORIZON = "https://horizon-testnet.stellar.org";

if (NETWORK_PASSPHRASE !== "Test SDF Network ; September 2015") throw new Error("testnet only");

const { values: a } = parseArgs({ options: { contract: { type: "string" }, settings: { type: "string" } } });
const C = a.contract ?? "";
if (!/^C[A-Z2-7]{55}$/.test(C)) throw new Error("--contract <C…> is required");
if (!a.settings) throw new Error("--settings <stellar network settings --output json> is required");
const DIR = resolve(".secrets", C.slice(0, 8), "step4");
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const LOG = resolve(`evidence/step4-testnet-${C.slice(0, 8)}.json`);

// --- the network's limits, as read ------------------------------------------

const settings = Object.assign(
  {},
  ...(JSON.parse(readFileSync(a.settings, "utf8")) as { updated_entry: Record<string, unknown>[] }).updated_entry,
) as {
  contract_compute_v0: { tx_max_instructions: string; tx_memory_limit: number };
  contract_ledger_cost_v0: {
    tx_max_disk_read_entries: number;
    tx_max_disk_read_bytes: number;
    tx_max_write_ledger_entries: number;
    tx_max_write_bytes: number;
  };
  contract_bandwidth_v0: { tx_max_size_bytes: number };
  contract_events_v0: { tx_max_contract_events_size_bytes: number };
};
const LIMITS = {
  instructions: Number(settings.contract_compute_v0.tx_max_instructions),
  memory: settings.contract_compute_v0.tx_memory_limit,
  readEntries: settings.contract_ledger_cost_v0.tx_max_disk_read_entries,
  readBytes: settings.contract_ledger_cost_v0.tx_max_disk_read_bytes,
  writeEntries: settings.contract_ledger_cost_v0.tx_max_write_ledger_entries,
  writeBytes: settings.contract_ledger_cost_v0.tx_max_write_bytes,
  txBytes: settings.contract_bandwidth_v0.tx_max_size_bytes,
  eventBytes: settings.contract_events_v0.tx_max_contract_events_size_bytes,
};

// --- identities (public keys only) and signing --------------------------------

const pk = (identity: string) => execFileSync("stellar", ["keys", "public-key", identity], { encoding: "utf8" }).trim();
const ID = { issuer: "qs-issuer", maker: "qs-owner", taker: "qs-buyer" } as const;
type Who = keyof typeof ID;
const ADDR = Object.fromEntries(Object.entries(ID).map(([k, v]) => [k, pk(v)])) as Record<Who, string>;

function signAs(tx: Transaction, who: Who): Transaction {
  const signed = execFileSync("stellar", ["tx", "sign", "--sign-with-key", ID[who], "--network", "testnet"], {
    input: tx.toXDR(),
    encoding: "utf8",
  }).trim();
  return TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE) as Transaction;
}

const addr = (g: string) => new Address(g).toScVal();
const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u256 = (n: bigint | string) => nativeToScVal(BigInt(n), { type: "u256" });
const bytes32 = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

// --- the log -------------------------------------------------------------------

const evidence: { contract: string; network: string; date: string; limits: typeof LIMITS; entries: unknown[]; measurement?: unknown } = {
  contract: C,
  network: "testnet",
  date: TODAY,
  limits: LIMITS,
  entries: [],
};
const hashes: Record<string, string> = {};
const save = () => writeFileSync(LOG, JSON.stringify(evidence, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

async function ok(label: string, who: Who, fn: string, args: xdr.ScVal[]): Promise<Outcome> {
  const tx = await buildCall(ADDR[who], C, fn, args);
  const sim = await simulate(tx);
  const out = await sendAndWait(signAs(rpc.assembleTransaction(tx, sim).build(), who));
  if (!out.successful) throw new Error(`${label} failed: ${out.opResult} ${out.errors.join(" ")} (${out.hash})`);
  evidence.entries.push({ label, hash: out.hash, ledger: out.ledger, fee_charged: out.feeCharged });
  hashes[label] = out.hash;
  save();
  log.ok(`${label}: ${out.hash}`);
  return out;
}

async function read(fn: string, args: xdr.ScVal[]): Promise<unknown> {
  const sim = await simulate(await buildCall(ADDR.issuer, C, fn, args));
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

async function latestLedger(): Promise<{ sequence: number; closedAt: number }> {
  const res = await fetch(`${HORIZON}/ledgers?order=desc&limit=1`);
  const r = ((await res.json()) as { _embedded: { records: { sequence: number; closed_at: string }[] } })._embedded.records[0]!;
  return { sequence: r.sequence, closedAt: Math.floor(Date.parse(r.closed_at) / 1000) };
}

// --- weeks -----------------------------------------------------------------------

interface Week {
  right_id: number;
  holder: Who;
  record_file: string;
  secret_file: string;
}

async function issueWeek(holder: Who, n: number): Promise<Week> {
  const like = JSON.parse(readFileSync("inventory/records/week-03.json", "utf8")) as OwnershipRecord;
  const checkIn = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 7 * n * DAY * 1000).toISOString().slice(0, 10);
  const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + 7 * DAY * 1000).toISOString().slice(0, 10);
  const rec = validateRecord({
    ...like,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { ...like.owner, stellar_account: ADDR[holder] },
    week: { check_in: checkIn, check_out: checkOut, use_year: Number(checkIn.slice(0, 4)), week_number: isoWeekNumber(checkIn) },
  });
  const recordFile = join(DIR, `week-${n}-record.json`);
  const secretFile = join(DIR, `week-${n}-${holder}-secret.json`);
  writeFileSync(recordFile, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(secretFile, JSON.stringify({ secret: randomSecret().toString() }) + "\n", { mode: 0o600 });
  const d = await splitRecordDigest(rec as unknown as JsonValue);
  const h = await secretHash(BigInt(JSON.parse(readFileSync(secretFile, "utf8")).secret));
  const c = fr(await commitment(d, ADDR[holder], h));
  const period = { start: Date.parse(`${checkIn}T00:00:00Z`) / 1000, end: Date.parse(`${checkOut}T00:00:00Z`) / 1000 };
  const validity = { from: Date.parse(`${rec.week.use_year}-01-01T00:00:00Z`) / 1000, until: Date.parse(`${rec.week.use_year + 1}-01-01T00:00:00Z`) / 1000 };
  const out = await ok(`issue week ${n} to the ${holder}`, "issuer", "issue", [
    addr(ADDR[holder]),
    struct({ start: u64(period.start), end: u64(period.end) }),
    struct({ from: u64(validity.from), until: u64(validity.until) }),
    bytes32(c),
  ]);
  const rightId = Number(scValToNative(out.returnValue as xdr.ScVal));
  log.info(`week ${n} = right #${rightId}, ${checkIn} → ${checkOut}, held by ${ID[holder]}`);
  return { right_id: rightId, holder, record_file: recordFile, secret_file: secretFile };
}

/** A fresh s' kept in .secrets, and its h'. */
async function nextSecret(label: string): Promise<{ file: string; h: bigint }> {
  const s = randomSecret();
  const file = join(DIR, `next-secret-${label}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ secret: s.toString() }) + "\n", { mode: 0o600 });
  return { file, h: await secretHash(s) };
}

async function recordRequest(who: Who, rightId: number): Promise<number> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keyHash = createHash("sha256").update(ecdh.getPublicKey()).digest("hex");
  const { sequence } = await latestLedger();
  await ok(`${who}'s record request for right #${rightId}`, who, "request_record", [addr(ADDR[who]), u64(rightId), bytes32(keyHash), u32(sequence + OFFER_LEDGERS)]);
  return Number(await read("next_request_id", [])) - 1;
}

async function prove(w: Week, to: Who, swapFor: number, nextSecretHash: bigint) {
  const { sequence } = await latestLedger();
  const { file, seconds } = await proveTransfer(
    JSON.parse(readFileSync(w.record_file, "utf8")) as JsonValue,
    BigInt(JSON.parse(readFileSync(w.secret_file, "utf8")).secret),
    {
      rightId: BigInt(w.right_id),
      from: ADDR[w.holder],
      to: ADDR[to],
      expiresAt: null,
      swapFor: BigInt(swapFor),
      expiryLedger: BigInt(sequence) + PROOF_WINDOW,
      nextSecretHash,
    },
  );
  log.info(`proved right #${w.right_id} → ${ID[to]} in ${seconds.toFixed(1)} s, valid through ledger ${BigInt(sequence) + PROOF_WINDOW}`);
  const proof = struct({ a: bytes32(file.proof.a), b: bytes32(file.proof.b), c: bytes32(file.proof.c) });
  const signals = xdr.ScVal.scvVec(PUBLIC_SIGNALS.map((k) => u256(file.public_signals[k]!)));
  return { proof, signals };
}

// --- measuring ----------------------------------------------------------------------

const pct = (v: number, limit: number) => `${((100 * v) / limit).toFixed(1)}%`;

/** The declared resources of a simulated, assembled transaction. */
function resourcesOf(sim: rpc.Api.SimulateTransactionSuccessResponse, assembled: Transaction) {
  const data = sim.transactionData.build();
  const r = data.resources();
  const footprint = r.footprint();
  const readOnly = footprint.readOnly().length;
  const readWrite = footprint.readWrite().length;
  return {
    instructions: r.instructions(),
    disk_read_bytes: r.diskReadBytes(),
    write_bytes: r.writeBytes(),
    footprint_read_only: readOnly,
    footprint_read_write: readWrite,
    min_resource_fee: Number(sim.minResourceFee),
    tx_bytes: assembled.toEnvelope().toXDR().length,
    latest_ledger: sim.latestLedger,
  };
}

/** Fees and event bytes as the ledger recorded them (transaction meta v4). */
async function onChain(hash: string) {
  const server = new RetryingServer(RPC_URL);
  const got = await server.getTransaction(hash);
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${hash} is not a success`);
  const meta = got.resultMetaXdr;
  const v4 = meta.switch() === 4 ? meta.v4() : null;
  const sorobanMeta = v4?.sorobanMeta();
  const ext = sorobanMeta?.ext();
  const v1 = ext && ext.switch() === 1 ? ext.v1() : null;
  const events = v4 ? v4.operations().flatMap((op) => op.events()) : [];
  return {
    fee_charged: Number(got.resultXdr.feeCharged().toString()),
    non_refundable_resource_fee: v1 ? Number(v1.totalNonRefundableResourceFeeCharged().toString()) : null,
    refundable_resource_fee: v1 ? Number(v1.totalRefundableResourceFeeCharged().toString()) : null,
    rent_fee: v1 ? Number(v1.rentFeeCharged().toString()) : null,
    contract_events: events.length,
    contract_event_bytes: events.reduce((n, e) => n + e.toXDR().length, 0),
    ledger: got.ledger,
  };
}

// --- the run ----------------------------------------------------------------------

async function main() {
  log.step(`Step 4 swap measurement on ${C}`);
  log.info(`limits read from the network: ${JSON.stringify(LIMITS)}`);

  const give = await issueWeek("maker", 1);
  const want = await issueWeek("taker", 2);

  const makerRequest = await recordRequest("maker", want.right_id);
  const takerRequest = await recordRequest("taker", give.right_id);

  // Each side's s' for the week it receives.
  const makerNext = await nextSecret(`maker-right-${want.right_id}`);
  const takerNext = await nextSecret(`taker-right-${give.right_id}`);

  let { sequence } = await latestLedger();
  await ok("offer_swap (maker)", "maker", "offer_swap", [
    addr(ADDR.maker),
    u64(give.right_id),
    u64(want.right_id),
    u256(makerNext.h),
    u64(makerRequest),
    u32(sequence + OFFER_LEDGERS),
  ]);
  const swapId = Number(await read("next_swap_id", [])) - 1;

  const takerProof = await prove(want, "maker", give.right_id, makerNext.h);
  const acceptArgs = [addr(ADDR.taker), u64(swapId), u256(takerNext.h), u64(takerRequest), takerProof.proof, takerProof.signals];
  const acceptTx = await buildCall(ADDR.taker, C, "accept_swap", acceptArgs);
  const acceptSim = await simulate(acceptTx);
  const acceptAssembled = rpc.assembleTransaction(acceptTx, acceptSim).build();
  const acceptOut = await sendAndWait(signAs(acceptAssembled, "taker"));
  if (!acceptOut.successful) throw new Error(`accept_swap failed: ${acceptOut.opResult} ${acceptOut.errors.join(" ")}`);
  evidence.entries.push({ label: "accept_swap (taker)", hash: acceptOut.hash, ledger: acceptOut.ledger, fee_charged: acceptOut.feeCharged });
  hashes["accept_swap (taker)"] = acceptOut.hash;
  save();
  log.ok(`accept_swap (taker): ${acceptOut.hash}`);

  // --- the measurement: complete_swap, simulated, then sent ---------------------
  const makerProof = await prove(give, "taker", want.right_id, takerNext.h);
  const completeTx = await buildCall(ADDR.maker, C, "complete_swap", [addr(ADDR.maker), u64(swapId), makerProof.proof, makerProof.signals]);
  const completeSim = await simulate(completeTx);
  const completeAssembled = rpc.assembleTransaction(completeTx, completeSim).build();
  const simulated = resourcesOf(completeSim, completeAssembled);
  log.step("complete_swap, simulated (--send=no equivalent: RPC simulateTransaction)");
  log.info(`CPU ${simulated.instructions.toLocaleString()} instructions = ${pct(simulated.instructions, LIMITS.instructions)} of ${LIMITS.instructions.toLocaleString()}`);
  log.info(`disk read ${simulated.disk_read_bytes} bytes = ${pct(simulated.disk_read_bytes, LIMITS.readBytes)}; write ${simulated.write_bytes} bytes = ${pct(simulated.write_bytes, LIMITS.writeBytes)}`);
  log.info(`footprint ${simulated.footprint_read_only} read-only + ${simulated.footprint_read_write} read-write entries`);
  log.info(`transaction ${simulated.tx_bytes} bytes = ${pct(simulated.tx_bytes, LIMITS.txBytes)}; min resource fee ${simulated.min_resource_fee} stroops`);

  const completeOut = await sendAndWait(signAs(completeAssembled, "maker"));
  if (!completeOut.successful) throw new Error(`complete_swap failed: ${completeOut.opResult} ${completeOut.errors.join(" ")} (${completeOut.hash})`);
  hashes["complete_swap (maker)"] = completeOut.hash;
  const landed = await onChain(completeOut.hash);
  log.step("complete_swap, on the ledger");
  log.ok(`complete_swap (maker): ${completeOut.hash} (ledger ${landed.ledger})`);
  log.info(`fee charged ${landed.fee_charged} stroops (resource: non-refundable ${landed.non_refundable_resource_fee}, refundable ${landed.refundable_resource_fee}, rent ${landed.rent_fee})`);
  log.info(`${landed.contract_events} contract events, ${landed.contract_event_bytes} bytes = ${pct(landed.contract_event_bytes, LIMITS.eventBytes)}`);

  const holderGive = await read("holder", [u64(give.right_id)]);
  const holderWant = await read("holder", [u64(want.right_id)]);
  if (holderGive !== ADDR.taker || holderWant !== ADDR.maker) throw new Error(`holders after the swap: #${give.right_id} ${holderGive}, #${want.right_id} ${holderWant}`);
  log.ok(`right #${give.right_id} now held by qs-buyer, right #${want.right_id} by qs-owner`);

  evidence.entries.push({ label: "complete_swap (maker)", hash: completeOut.hash, ledger: completeOut.ledger, fee_charged: completeOut.feeCharged });
  evidence.measurement = {
    swap_id: swapId,
    give_right: give.right_id,
    want_right: want.right_id,
    accept_swap_simulated: resourcesOf(acceptSim, acceptAssembled),
    complete_swap_simulated: simulated,
    complete_swap_on_chain: landed,
  };
  save();

  // --- privacy record ---------------------------------------------------------------
  const out = `evidence/privacy/${TODAY}-step4-${C.slice(0, 8)}-swap-measure.txt`;
  const args = ["tsx", "scripts/check-privacy.ts", "--network", "testnet", "--out", out];
  for (const [label, hash] of Object.entries(hashes)) args.push("--tx", `${label.replace(/[^a-z0-9-]+/gi, "-")}=${hash}`);
  for (const w of [give, want]) args.push("--record", w.record_file, "--secret", w.secret_file);
  for (const n of [makerNext, takerNext]) args.push("--next-secret", n.file);
  execFileSync("npx", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  log.ok(`privacy record: ${out}`);
  process.exit(0);
}

main().catch(fatal);
