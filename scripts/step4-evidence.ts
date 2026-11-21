/**
 * Phase 3 Step 4: the swap's testnet evidence (docs/PHASE3_PROMPT.md Step 4
 * checkpoint), on the Step 4 contract.
 *
 *   npx tsx scripts/step4-evidence.ts <step> --contract <C…>
 *
 * Steps, each with weeks of its own (qs-owner is the maker, qs-buyer the
 * taker, qs-renter a third builder account):
 *   requests-rented  D4a requests in both directions; refused acceptances: a
 *                    request for the wrong week (#61), someone else with the
 *                    holder's proof (#21) and with a proof of their own (#19);
 *                    the real acceptance; the taker rents the week out, so
 *                    complete_swap is refused (#4, D5); the taker withdraws, and
 *                    complete_swap is refused again (#59)
 *   sold             the taker sells the week after accepting: complete refused (#19)
 *   replay           a valid swap, a swap back to the original secrets, then
 *                    the first swap's taker proof replayed: refused by its
 *                    nullifier (#27)
 *   expired          a week whose validity ends while the swap is pending (#6),
 *                    and a maker proof past its window (#24)
 *
 * **Testnet only.** Every envelope is signed by a Stellar CLI identity
 * (`stellar tx sign --sign-with-key`); this script never reads a key.
 *
 * A refused transaction is sent with the resources of a valid sibling
 * simulation (scripts/lib/zk-tx.ts `withSiblingResources`), plus, where the
 * refused call reads an entry the sibling does not (another account's record
 * request, a spent nullifier), exactly that entry, read-only. Each must fail
 * with exactly the expected error. Records and secrets go to
 * .secrets/<contract 8>/step4/ (gitignored, 0700). Every transaction is
 * appended to evidence/step4-testnet-<contract 8>.json, and every step ends
 * with `check-privacy` over its transactions.
 */

import { execFileSync } from "node:child_process";
import { createECDH, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Address, nativeToScVal, rpc, scValToNative, SorobanDataBuilder, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";

import type { JsonValue } from "../src/lib/canonical";
import { NETWORK_PASSPHRASE } from "../src/lib/config";
import { isoWeekNumber, validateRecord, type OwnershipRecord } from "../src/lib/record";
import { PUBLIC_SIGNALS } from "../src/lib/zk-fields";
import { fatal, log } from "./lib/cli";
import { commitment, randomSecret, secretHash, splitRecordDigest } from "./lib/zk";
import { fr } from "./lib/zk-encode";
import { proveTransfer } from "./lib/zk-prove";
import { buildCall, sendAndWait, simulate, struct, withSiblingResources, type Outcome } from "./lib/zk-tx";

const DAY = 86_400;
const USDC = 10_000_000n;
const OFFER_LEDGERS = 2_000;
/** A proof's window, under the contract's 720, so a step has time for every call. */
const WINDOW = 700n;
const TODAY = new Date().toISOString().slice(0, 10);
const HORIZON = "https://horizon-testnet.stellar.org";

if (NETWORK_PASSPHRASE !== "Test SDF Network ; September 2015") throw new Error("testnet only");

const { positionals, values: a } = parseArgs({ allowPositionals: true, options: { contract: { type: "string" } } });
const STEP = positionals[0];
const C = a.contract ?? "";
if (!/^C[A-Z2-7]{55}$/.test(C)) throw new Error("--contract <C…> is required");
const DIR = resolve(".secrets", C.slice(0, 8), "step4");
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const LOG = resolve(`evidence/step4-testnet-${C.slice(0, 8)}.json`);

// --- identities (public keys only), signing ------------------------------------

const pk = (identity: string) => execFileSync("stellar", ["keys", "public-key", identity], { encoding: "utf8" }).trim();
const ID = { issuer: "qs-issuer", owner: "qs-owner", buyer: "qs-buyer", renter: "qs-renter" } as const;
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
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u256 = (n: bigint | string) => nativeToScVal(BigInt(n), { type: "u256" });
const bytes32 = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

// --- the log --------------------------------------------------------------------------

interface Entry {
  step: string;
  label: string;
  hash: string;
  ledger: number;
  accepted: boolean;
  expected: string | null;
  errors: string[];
  fee_charged: number;
}
const evidence = JSON.parse(readFileSync(LOG, "utf8")) as { entries: (Entry | Record<string, unknown>)[]; readings?: unknown[] };
const stepHashes: Record<string, string> = {};
const save = () => writeFileSync(LOG, JSON.stringify(evidence, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

function record(label: string, out: Outcome, expected: string | null) {
  evidence.entries.push({ step: STEP!, label, hash: out.hash, ledger: out.ledger, accepted: out.successful, expected, errors: out.errors, fee_charged: out.feeCharged });
  save();
  stepHashes[label] = out.hash;
  if (out.successful) log.ok(`${label}: ${out.hash}`);
  else log.ok(`${label}: rejected on chain as expected (${expected}) ${out.hash}`);
}

function reading(label: string, value: unknown) {
  (evidence.readings ??= []).push({ step: STEP, label, value });
  save();
  log.info(`${label}: ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

// --- sending ------------------------------------------------------------------------------

async function sim(who: Who, fn: string, args: xdr.ScVal[], contract = C) {
  const tx = await buildCall(ADDR[who], contract, fn, args);
  return { tx, sim: await simulate(tx) };
}

async function ok(label: string, who: Who, fn: string, args: xdr.ScVal[], contract = C): Promise<Outcome> {
  const { tx, sim: s } = await sim(who, fn, args, contract);
  const out = await sendAndWait(signAs(rpc.assembleTransaction(tx, s).build(), who));
  if (!out.successful) throw new Error(`${label} failed: ${out.opResult} ${out.errors.join(" ")} (${out.hash})`);
  record(label, out, null);
  return out;
}

/** A contract-data ledger key for one of the contract's `DataKey` variants. */
function dataKey(variant: string, arg: xdr.ScVal, durability: "temporary" | "persistent"): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(C).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), arg]),
      durability: durability === "temporary" ? xdr.ContractDataDurability.temporary() : xdr.ContractDataDurability.persistent(),
    }),
  );
}

/** The sibling's simulation with `extra` added to its read-only footprint. */
function plus(sibling: rpc.Api.SimulateTransactionSuccessResponse, extra: xdr.LedgerKey[]): rpc.Api.SimulateTransactionSuccessResponse {
  if (extra.length === 0) return sibling;
  const data = sibling.transactionData.build();
  const res = data.resources();
  const fp = res.footprint();
  const widened = new xdr.SorobanTransactionData({
    ext: data.ext(),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [...fp.readOnly(), ...extra], readWrite: fp.readWrite() }),
      instructions: res.instructions(),
      diskReadBytes: res.diskReadBytes(),
      writeBytes: res.writeBytes(),
    }),
    resourceFee: data.resourceFee(),
  });
  return { ...sibling, transactionData: new SorobanDataBuilder(widened) } as rpc.Api.SimulateTransactionSuccessResponse;
}

/**
 * A call the contract must refuse, sent on purpose so the refusal is on the
 * ledger, with the caller's own authorization of this exact call.
 */
async function rejected(
  label: string,
  who: Who,
  fn: string,
  args: xdr.ScVal[],
  sibling: rpc.Api.SimulateTransactionSuccessResponse,
  expected: string,
  extra: xdr.LedgerKey[] = [],
): Promise<Outcome> {
  const own = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(C).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: [],
    }),
  });
  const tx = await buildCall(ADDR[who], C, fn, args, [own]);
  const out = await sendAndWait(signAs(withSiblingResources(tx, plus(sibling, extra)), who));
  if (out.successful) throw new Error(`${label}: expected ${expected}, but it was accepted (${out.hash})`);
  if (out.opResult !== "invokeHostFunctionTrapped" || !out.errors.includes(expected)) {
    throw new Error(`${label}: expected ${expected}, got ${out.opResult} ${out.errors.join(" ")} (${out.hash}); not recorded`);
  }
  record(label, out, expected);
  return out;
}

// --- chain reads ------------------------------------------------------------------------

async function latestLedger(): Promise<{ sequence: number; closedAt: number }> {
  const res = await fetch(`${HORIZON}/ledgers?order=desc&limit=1`);
  const r = ((await res.json()) as { _embedded: { records: { sequence: number; closed_at: string }[] } })._embedded.records[0]!;
  return { sequence: r.sequence, closedAt: Math.floor(Date.parse(r.closed_at) / 1000) };
}

async function read(fn: string, args: xdr.ScVal[]): Promise<unknown> {
  const { sim: s } = await sim("issuer", fn, args);
  return s.result ? scValToNative(s.result.retval) : undefined;
}

async function waitUntil(test: (l: { sequence: number; closedAt: number }) => boolean, what: string) {
  log.info(`waiting for ${what}…`);
  for (;;) {
    const l = await latestLedger();
    if (test(l)) return l;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function holderOf(id: number) {
  return (await read("holder", [u64(id)])) as string;
}
async function commitmentOf(id: number) {
  return Buffer.from((await read("commitment", [u64(id)])) as Buffer).toString("hex");
}

// --- weeks, secrets, proofs ----------------------------------------------------------------

interface Week {
  right_id: number;
  record_file: string;
  /** The current holder's secret. */
  secret_file: string;
  holder: Who;
  period: { start: number; end: number };
  issued_commitment: string;
}
/**
 * For the privacy record: each week's record; each holder secret from
 * issuance, whose s and h must both stay off the ledger (`--secret`); and each
 * next secret s', whose h' a swap publishes by design (`--next-secret`).
 */
const files: { records: string[]; holder: string[]; next: string[] } = { records: [], holder: [], next: [] };

function secretFile(label: string, kind: "holder" | "next" = "next"): string {
  const file = join(DIR, `${STEP}-${label}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ secret: randomSecret().toString() }) + "\n", { mode: 0o600 });
  files[kind].push(file);
  return file;
}

/** A holder secret whose h is published as an h' after all (the swap back). */
function nowPublic(file: string) {
  files.holder = files.holder.filter((f) => f !== file);
  files.next.push(file);
}
const secretOf = (file: string) => BigInt(JSON.parse(readFileSync(file, "utf8")).secret);
const hOf = (file: string) => secretHash(secretOf(file));

async function issueWeek(holder: Who, n: number, opts: { endsSoon?: boolean } = {}): Promise<Week> {
  const like = JSON.parse(readFileSync("inventory/records/week-03.json", "utf8")) as OwnershipRecord;
  const { closedAt } = await latestLedger();
  let period: { start: number; end: number };
  let validity: { from: number; until: number };
  let checkIn: string;
  let checkOut: string;
  if (opts.endsSoon) {
    // A week whose right expires about ten minutes from now.
    period = { start: closedAt - 3600, end: closedAt + 300 };
    validity = { from: closedAt - DAY, until: closedAt + 600 };
    checkIn = new Date(period.start * 1000).toISOString().slice(0, 10);
    // The record's dates are whole days; the on-chain period is the short window.
    checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + DAY * 1000).toISOString().slice(0, 10);
  } else {
    // Weeks 1–5 weeks ahead, so every one stays in this use year (a week in
    // next year's would not be valid yet).
    checkIn = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 7 * (((n - 1) % 5) + 1) * DAY * 1000).toISOString().slice(0, 10);
    checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + 7 * DAY * 1000).toISOString().slice(0, 10);
    period = { start: Date.parse(`${checkIn}T00:00:00Z`) / 1000, end: Date.parse(`${checkOut}T00:00:00Z`) / 1000 };
    const year = Number(checkIn.slice(0, 4));
    validity = { from: Date.parse(`${year}-01-01T00:00:00Z`) / 1000, until: Date.parse(`${year + 1}-01-01T00:00:00Z`) / 1000 };
  }
  const rec = validateRecord({
    ...like,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { ...like.owner, stellar_account: ADDR[holder] },
    week: { check_in: checkIn, check_out: checkOut, use_year: Number(checkIn.slice(0, 4)), week_number: isoWeekNumber(checkIn) },
  });
  const recordFile = join(DIR, `${STEP}-week-${n}-record.json`);
  writeFileSync(recordFile, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  files.records.push(recordFile);
  const sFile = secretFile(`week-${n}-${holder}`, "holder");
  const d = await splitRecordDigest(rec as unknown as JsonValue);
  const c = fr(await commitment(d, ADDR[holder], await hOf(sFile)));
  const out = await ok(`${STEP}: issue week ${n} to ${ID[holder]}`, "issuer", "issue", [
    addr(ADDR[holder]),
    struct({ start: u64(period.start), end: u64(period.end) }),
    struct({ from: u64(validity.from), until: u64(validity.until) }),
    bytes32(c),
  ]);
  const id = Number(scValToNative(out.returnValue as xdr.ScVal));
  log.info(`week ${n} = right #${id}, held by ${ID[holder]}${opts.endsSoon ? `, valid until ${new Date(validity.until * 1000).toISOString()}` : ""}`);
  return { right_id: id, record_file: recordFile, secret_file: sFile, holder, period, issued_commitment: c };
}

/** The holder's proof: `w` → `to`, for a swap against `swapFor`, a rental until `rentalUntil`, or a sale. */
async function prove(
  w: Week,
  to: Who,
  o: { swapFor?: number; rentalUntil?: number; nextSecretHash?: bigint; secret?: bigint; from?: Who; window?: bigint },
) {
  const { sequence } = await latestLedger();
  const window = o.window ?? WINDOW;
  const { file, seconds } = await proveTransfer(
    JSON.parse(readFileSync(w.record_file, "utf8")) as JsonValue,
    o.secret ?? secretOf(w.secret_file),
    {
      rightId: BigInt(w.right_id),
      from: ADDR[o.from ?? w.holder],
      to: ADDR[to],
      expiresAt: o.rentalUntil === undefined ? null : BigInt(o.rentalUntil),
      ...(o.swapFor === undefined ? {} : { swapFor: BigInt(o.swapFor) }),
      expiryLedger: BigInt(sequence) + window,
      nextSecretHash: o.nextSecretHash ?? 0n,
    },
  );
  log.info(`proved right #${w.right_id} → ${ID[to]} in ${seconds.toFixed(1)} s, valid through ledger ${BigInt(sequence) + window}`);
  return {
    proof: struct({ a: bytes32(file.proof.a), b: bytes32(file.proof.b), c: bytes32(file.proof.c) }),
    signals: xdr.ScVal.scvVec(PUBLIC_SIGNALS.map((k) => u256(file.public_signals[k]!))),
    nullifier: BigInt(file.public_signals.nullifier!),
  };
}

async function request(who: Who, rightId: number, label: string): Promise<number> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keyHash = createHash("sha256").update(ecdh.getPublicKey()).digest("hex");
  const { sequence } = await latestLedger();
  await ok(`${STEP}: ${label}`, who, "request_record", [addr(ADDR[who]), u64(rightId), bytes32(keyHash), u32(sequence + OFFER_LEDGERS)]);
  return Number(await read("next_request_id", [])) - 1;
}

async function offer(give: Week, want: Week, makerH: bigint, makerRequest: number, label = "offer_swap (maker)"): Promise<number> {
  const { sequence } = await latestLedger();
  await ok(`${STEP}: ${label}`, "owner", "offer_swap", [addr(ADDR.owner), u64(give.right_id), u64(want.right_id), u256(makerH), u64(makerRequest), u32(sequence + OFFER_LEDGERS)]);
  return Number(await read("next_swap_id", [])) - 1;
}

const acceptArgs = (who: Who, swap: number, takerH: bigint, req: number, p: { proof: xdr.ScVal; signals: xdr.ScVal }) => [
  addr(ADDR[who]),
  u64(swap),
  u256(takerH),
  u64(req),
  p.proof,
  p.signals,
];
const completeArgs = (swap: number, p: { proof: xdr.ScVal; signals: xdr.ScVal }) => [addr(ADDR.owner), u64(swap), p.proof, p.signals];
const requestKey = (id: number) => dataKey("Request", u64(id), "temporary");

/** Both sides' requests, the offer and the real acceptance. */
async function acceptedSwap(give: Week, want: Week) {
  const makerReq = await request("owner", want.right_id, `maker's record request for #${want.right_id}`);
  const takerReq = await request("buyer", give.right_id, `taker's record request for #${give.right_id}`);
  const makerNext = secretFile(`maker-next-${want.right_id}`);
  const takerNext = secretFile(`taker-next-${give.right_id}`);
  const swap = await offer(give, want, await hOf(makerNext), makerReq);
  const takerProof = await prove(want, "owner", { swapFor: give.right_id, nextSecretHash: await hOf(makerNext) });
  await ok(`${STEP}: accept_swap (taker)`, "buyer", "accept_swap", acceptArgs("buyer", swap, await hOf(takerNext), takerReq, takerProof));
  return { swap, makerReq, takerReq, makerNext, takerNext, takerProof };
}

function checkPrivacy() {
  const out = `evidence/privacy/${TODAY}-step4-${C.slice(0, 8)}-${STEP}.txt`;
  const args = ["tsx", "scripts/check-privacy.ts", "--network", "testnet", "--out", out];
  for (const [label, hash] of Object.entries(stepHashes)) args.push("--tx", `${label.replace(/[^a-z0-9-]+/gi, "-")}=${hash}`);
  for (const f of files.records) args.push("--record", f);
  for (const f of files.holder) args.push("--secret", f);
  for (const f of files.next) args.push("--next-secret", f);
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

// --- the steps -----------------------------------------------------------------------------------

async function requestsRented() {
  const give = await issueWeek("owner", 1);
  const want = await issueWeek("buyer", 2);

  // D4a, both directions, before the swap.
  const makerReq = await request("owner", want.right_id, `maker's record request for #${want.right_id}`);
  const takerReq = await request("buyer", give.right_id, `taker's record request for #${give.right_id}`);
  reading(`request #${makerReq} (maker, for #${want.right_id}) before the offer`, await read("get_record_request", [u64(makerReq)]));
  reading(`request #${takerReq} (taker, for #${give.right_id}) before the acceptance`, await read("get_record_request", [u64(takerReq)]));
  const makerNext = secretFile(`maker-next-${want.right_id}`);
  const takerNext = secretFile(`taker-next-${give.right_id}`);
  const swap = await offer(give, want, await hOf(makerNext), makerReq);
  reading(`request #${makerReq} after offer_swap (consumed)`, (await read("get_record_request", [u64(makerReq)])) ?? null);

  const takerProof = await prove(want, "owner", { swapFor: give.right_id, nextSecretHash: await hOf(makerNext) });
  const takerH = await hOf(takerNext);
  const acceptSibling = (await sim("buyer", "accept_swap", acceptArgs("buyer", swap, takerH, takerReq, takerProof))).sim;

  // Refused acceptances.
  const wrongReq = await request("buyer", want.right_id, `taker's request for the wrong week, #${want.right_id}`);
  await rejected("rejected: accept with a record request for the wrong week", "buyer", "accept_swap", acceptArgs("buyer", swap, takerH, wrongReq, takerProof), acceptSibling, "Error(Contract, #61)", [requestKey(wrongReq)]);
  const renterReq = await request("renter", give.right_id, `someone else's (qs-renter) request for #${give.right_id}`);
  await rejected("rejected: someone else accepts with the holder's proof", "renter", "accept_swap", acceptArgs("renter", swap, takerH, renterReq, takerProof), acceptSibling, "Error(Contract, #21)", [requestKey(renterReq)]);
  const renterProof = await prove(want, "owner", { swapFor: give.right_id, nextSecretHash: await hOf(makerNext), secret: randomSecret(), from: "renter" });
  await rejected("rejected: someone else accepts with a proof of their own", "renter", "accept_swap", acceptArgs("renter", swap, takerH, renterReq, renterProof), acceptSibling, "Error(Contract, #19)", [requestKey(renterReq)]);

  await ok(`${STEP}: accept_swap (taker)`, "buyer", "accept_swap", acceptArgs("buyer", swap, takerH, takerReq, takerProof));
  reading(`request #${takerReq} after accept_swap (consumed)`, (await read("get_record_request", [u64(takerReq)])) ?? null);

  const makerProof = await prove(give, "buyer", { swapFor: want.right_id, nextSecretHash: takerH });
  const completeSibling = (await sim("owner", "complete_swap", completeArgs(swap, makerProof))).sim;

  // D5: nothing is locked; the taker rents the week out after accepting.
  const rental = await prove(want, "renter", { rentalUntil: want.period.end });
  await ok(`${STEP}: the taker rents #${want.right_id} out to qs-renter (transfer, rental)`, "buyer", "transfer", [addr(ADDR.buyer), addr(ADDR.renter), u64(want.right_id), optionU64(want.period.end), rental.proof, rental.signals]);
  reading(`holder of #${want.right_id} after the rental`, await holderOf(want.right_id));
  await rejected("rejected: complete_swap after the taker rented the week out", "owner", "complete_swap", completeArgs(swap, makerProof), completeSibling, "Error(Contract, #4)");

  await ok(`${STEP}: withdraw_swap_acceptance (taker)`, "buyer", "withdraw_swap_acceptance", [addr(ADDR.buyer), u64(swap)]);
  reading(`acceptance of swap #${swap} after the withdrawal`, (await read("get_swap_acceptance", [u64(swap)])) == null ? null : "present");
  await rejected("rejected: complete_swap after the acceptance was withdrawn", "owner", "complete_swap", completeArgs(swap, makerProof), completeSibling, "Error(Contract, #59)");

  reading("holders afterwards", { [`#${give.right_id}`]: await holderOf(give.right_id), [`#${want.right_id}`]: await holderOf(want.right_id) });
  reading("commitments unchanged", { [`#${give.right_id}`]: (await commitmentOf(give.right_id)) === give.issued_commitment, [`#${want.right_id}`]: (await commitmentOf(want.right_id)) === want.issued_commitment });
  checkPrivacy();
}

/** `Option<u64>`'s `Some(n)`, as the contract spec encodes it. */
function optionU64(n: number): xdr.ScVal {
  return nativeToScVal(BigInt(n), { type: "u64" });
}

async function sold() {
  const give = await issueWeek("owner", 3);
  const want = await issueWeek("buyer", 4);
  const s = await acceptedSwap(give, want);
  const makerProof = await prove(give, "buyer", { swapFor: want.right_id, nextSecretHash: await hOf(s.takerNext) });
  const completeSibling = (await sim("owner", "complete_swap", completeArgs(s.swap, makerProof))).sim;

  // The taker sells the week to qs-renter after accepting (a 1 USDC sale offer).
  const renterReq = await request("renter", want.right_id, `qs-renter's record request to buy #${want.right_id}`);
  const renterNext = secretFile(`renter-next-${want.right_id}`);
  const { sequence } = await latestLedger();
  await ok(`${STEP}: qs-renter's sale offer for #${want.right_id} (1 USDC)`, "renter", "create_sale_offer", [addr(ADDR.renter), u64(renterReq), i128(USDC), u256(await hOf(renterNext)), u32(sequence + OFFER_LEDGERS)]);
  const saleOffer = Number(await read("next_offer_id", [])) - 1;
  const saleProof = await prove(want, "renter", { nextSecretHash: await hOf(renterNext) });
  await ok(`${STEP}: the taker sells #${want.right_id} to qs-renter (accept_sale)`, "buyer", "accept_sale", [addr(ADDR.buyer), u64(saleOffer), i128(USDC), saleProof.proof, saleProof.signals]);
  reading(`holder of #${want.right_id} after the sale`, await holderOf(want.right_id));
  await rejected("rejected: complete_swap after the taker sold the week", "owner", "complete_swap", completeArgs(s.swap, makerProof), completeSibling, "Error(Contract, #19)");
  reading("holders afterwards", { [`#${give.right_id}`]: await holderOf(give.right_id), [`#${want.right_id}`]: await holderOf(want.right_id) });
  reading(`commitment of #${give.right_id} unchanged`, (await commitmentOf(give.right_id)) === give.issued_commitment);
  checkPrivacy();
}

async function replay() {
  const a3 = await issueWeek("owner", 5);
  const b3 = await issueWeek("buyer", 6);
  const ownerOriginal = a3.secret_file;
  const buyerOriginal = b3.secret_file;
  // The swap back republishes both original h as h', by design.
  nowPublic(ownerOriginal);
  nowPublic(buyerOriginal);

  // Swap 1: a3 (owner) ↔ b3 (buyer).
  const s1 = await acceptedSwap(a3, b3);
  const p1 = await prove(a3, "buyer", { swapFor: b3.right_id, nextSecretHash: await hOf(s1.takerNext) });
  await ok(`${STEP}: complete_swap #${s1.swap} (maker)`, "owner", "complete_swap", completeArgs(s1.swap, p1));
  reading("holders after swap 1", { [`#${a3.right_id}`]: await holderOf(a3.right_id), [`#${b3.right_id}`]: await holderOf(b3.right_id) });
  // a3 is now the buyer's (secret takerNext), b3 the owner's (secret makerNext).
  const a3b: Week = { ...a3, holder: "buyer", secret_file: s1.takerNext };
  const b3o: Week = { ...b3, holder: "owner", secret_file: s1.makerNext };

  // Swap back, each side choosing its *original* h as h'.
  const makerReq = await request("owner", a3.right_id, `maker's record request for #${a3.right_id} (swap back)`);
  const takerReq = await request("buyer", b3.right_id, `taker's record request for #${b3.right_id} (swap back)`);
  const back = await offer(b3o, a3b, await hOf(ownerOriginal), makerReq, "offer_swap back (maker), h' = the owner's original h");
  const backTaker = await prove(a3b, "owner", { swapFor: b3.right_id, nextSecretHash: await hOf(ownerOriginal) });
  await ok(`${STEP}: accept_swap back (taker), h' = the buyer's original h`, "buyer", "accept_swap", acceptArgs("buyer", back, await hOf(buyerOriginal), takerReq, backTaker));
  const backMaker = await prove(b3o, "buyer", { swapFor: a3.right_id, nextSecretHash: await hOf(buyerOriginal) });
  await ok(`${STEP}: complete_swap back #${back} (maker)`, "owner", "complete_swap", completeArgs(back, backMaker));
  reading("commitments after the swap back equal the issued ones", {
    [`#${a3.right_id}`]: (await commitmentOf(a3.right_id)) === a3.issued_commitment,
    [`#${b3.right_id}`]: (await commitmentOf(b3.right_id)) === b3.issued_commitment,
  });

  // The same swap as swap 1, then swap 1's taker proof replayed.
  const replayMakerReq = await request("owner", b3.right_id, `maker's record request for #${b3.right_id} (replay)`);
  const replayTakerReq = await request("buyer", a3.right_id, `taker's record request for #${a3.right_id} (replay)`);
  const again = await offer(a3, b3, await hOf(s1.makerNext), replayMakerReq, "offer_swap again, as swap 1");
  const fresh = await prove(b3, "owner", { swapFor: a3.right_id, nextSecretHash: await hOf(s1.makerNext) });
  const takerH = await hOf(secretFile("taker-next-replay"));
  const sibling = (await sim("buyer", "accept_swap", acceptArgs("buyer", again, takerH, replayTakerReq, fresh))).sim;
  const nullifier = dataKey("Nullifier", xdr.ScVal.scvBytes(Buffer.from(s1.takerProof.nullifier.toString(16).padStart(64, "0"), "hex")), "temporary");
  await rejected(`rejected: swap #${s1.swap}'s taker proof replayed after the swap back`, "buyer", "accept_swap", acceptArgs("buyer", again, takerH, replayTakerReq, s1.takerProof), sibling, "Error(Contract, #27)", [nullifier]);
  await ok(`${STEP}: cancel_swap #${again} (maker, clean-up)`, "owner", "cancel_swap", [addr(ADDR.owner), u64(again)]);
  reading("holders afterwards", { [`#${a3.right_id}`]: await holderOf(a3.right_id), [`#${b3.right_id}`]: await holderOf(b3.right_id) });
  checkPrivacy();
}

async function expired() {
  // A week whose right expires about ten minutes from now.
  const soon = await issueWeek("owner", 7, { endsSoon: true });
  const want = await issueWeek("buyer", 8);
  const s = await acceptedSwap(soon, want);
  const makerProof = await prove(soon, "buyer", { swapFor: want.right_id, nextSecretHash: await hOf(s.takerNext) });
  const sibling = (await sim("owner", "complete_swap", completeArgs(s.swap, makerProof))).sim;

  // Meanwhile: a maker proof past its window, on a second swap.
  const g2 = await issueWeek("owner", 9);
  const w2 = await issueWeek("buyer", 10);
  const s2 = await acceptedSwap(g2, w2);
  const shortProof = await prove(g2, "buyer", { swapFor: w2.right_id, nextSecretHash: await hOf(s2.takerNext), window: 12n });
  const sibling2 = (await sim("owner", "complete_swap", completeArgs(s2.swap, shortProof))).sim;
  const { sequence } = await latestLedger();
  await waitUntil((l) => l.sequence > sequence + 12, `the maker proof's window to pass (ledger ${sequence + 12})`);
  await rejected("rejected: complete_swap with a maker proof past its window", "owner", "complete_swap", completeArgs(s2.swap, shortProof), sibling2, "Error(Contract, #24)");
  reading("holders afterwards (second swap)", { [`#${g2.right_id}`]: await holderOf(g2.right_id), [`#${w2.right_id}`]: await holderOf(w2.right_id) });

  const right = (await read("get_right", [u64(soon.right_id)])) as { validity: { until: bigint } };
  const until = Number(right.validity.until);
  await waitUntil((l) => l.closedAt >= until, `right #${soon.right_id}'s validity to end (${new Date(until * 1000).toISOString()})`);
  await rejected(`rejected: complete_swap after right #${soon.right_id} expired`, "owner", "complete_swap", completeArgs(s.swap, makerProof), sibling, "Error(Contract, #6)");
  reading("holders afterwards (expired week)", { [`#${soon.right_id}`]: await holderOf(soon.right_id), [`#${want.right_id}`]: await holderOf(want.right_id) });
  checkPrivacy();
}

const STEPS: Record<string, () => Promise<void>> = { "requests-rented": requestsRented, sold, replay, expired };

async function main() {
  const run = STEP ? STEPS[STEP] : undefined;
  if (!run) throw new Error(`step must be one of: ${Object.keys(STEPS).join(", ")}`);
  if (!existsSync(LOG)) throw new Error(`${LOG} is missing; run scripts/step4-swap-measure.ts first`);
  log.step(`Step 4 evidence: ${STEP} on ${C}`);
  await run();
  process.exit(0);
}

main().catch(fatal);
