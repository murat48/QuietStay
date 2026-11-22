/**
 * Build the unsigned envelopes for a sale and a rental offer, one step at a
 * time, for `scripts/mainnet-sign-submit.sh` to review, sign and send
 * (docs/MAINNET_REHEARSAL.md, Part 6).
 *
 *   npx tsx scripts/pilot-envelope.ts <step> --network testnet|mainnet --contract <C…> --out <dir>
 *
 * Steps, in order. Each one writes `<dir>/<nn>-<step>.xdr` and prints the
 * signing command. From the second step on, it first reads the previous
 * envelope's outcome from the chain, by the hash mainnet-sign-submit.sh saved
 * in `<file>.submission/hash`:
 *   issue-a        the issuer issues week A to the owner (for the sale)
 *   issue-b        the issuer issues week B to the owner (for the rental offer)
 *   sale-request   the buyer's record request for week A
 *   sale-offer     the buyer's sale offer: 1 USDC, with a fresh next secret s'
 *   sale-accept    the owner accepts: a proof of ownership, the right and the
 *                  USDC move together (one-step sale)
 *   rental-offer   the renter's rental offer for week B: 1 USDC, check-in in
 *                  an hour (it is not accepted: an offer only)
 *   status         read-only: who holds each week, the offers, the USDC
 *                  balances, and the privacy check over every landed step
 *
 * **It signs nothing and never reads a key.** The accounts are public keys
 * from the environment: QS_REHEARSAL_{ISSUER,OWNER,BUYER,RENTER} on testnet,
 * QS_MAIN_{ISSUER,OWNER,BUYER,RENTER} on mainnet. The envelope's source is the
 * account that acts, so its own signature authorizes the call.
 *
 * The ownership records, the owner's secrets and the buyer's s' it creates
 * stay in `.secrets/<contract 8>/pilot-<network>/` (gitignored, 0700). They
 * are never printed; the proof and the privacy check read them.
 *
 * Each envelope is simulated twice, so its declared resources include the
 * check of its own authorization and match the review's re-simulation. It is
 * valid for 25 minutes (time bound); the sale's proof for 360 ledgers (~30
 * minutes). Sign it within that, or build it again.
 */

import { execFileSync } from "node:child_process";
import { createECDH, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Address, Contract, nativeToScVal, Operation, rpc, scValToNative, StrKey, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";

import type { JsonValue } from "../src/lib/canonical";
import { isoWeekNumber, validateRecord, type OwnershipRecord } from "../src/lib/record";
import { PUBLIC_SIGNALS } from "../src/lib/zk-fields";
import { commitment, randomSecret, secretHash, splitRecordDigest } from "./lib/zk";
import { fr } from "./lib/zk-encode";
import { proveTransfer } from "./lib/zk-prove";

const NETS = {
  testnet: {
    rpc: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    prefix: "QS_REHEARSAL",
    identity: "qs-rehearsal",
  },
  mainnet: {
    rpc: "https://mainnet.sorobanrpc.com",
    passphrase: "Public Global Stellar Network ; September 2015",
    usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    prefix: "QS_MAIN",
    identity: "qs-main",
  },
} as const;

const PRICE = 10_000_000n; // 1 USDC: the pilot's per-payment cap (D7)
const OFFER_LEDGERS = 120_960;
const PROOF_WINDOW = 360;
const TX_SECONDS = 1500;
const DAY = 86_400;
const STEPS = ["issue-a", "issue-b", "sale-request", "sale-offer", "sale-accept", "rental-offer"] as const;
type Step = (typeof STEPS)[number];
const SIGNER: Record<Step, Role> = {
  "issue-a": "issuer",
  "issue-b": "issuer",
  "sale-request": "buyer",
  "sale-offer": "buyer",
  "sale-accept": "owner",
  "rental-offer": "renter",
};
type Role = "issuer" | "owner" | "buyer" | "renter";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { network: { type: "string" }, contract: { type: "string" }, out: { type: "string" } },
});
const STEP = positionals[0] ?? "";
const netName = a.network as keyof typeof NETS;
const NET = NETS[netName];
if (!NET) throw new Error("--network testnet|mainnet is required");
const C = a.contract ?? "";
if (!StrKey.isValidContract(C)) throw new Error("--contract <C…> is required");
const OUT = resolve(a.out ?? "");
if (!a.out) throw new Error("--out <dir> is required (where the envelopes go)");
mkdirSync(OUT, { recursive: true });
const DIR = resolve(".secrets", C.slice(0, 8), `pilot-${netName}`);
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const server = new rpc.Server(NET.rpc);

const ACCT = Object.fromEntries(
  (["issuer", "owner", "buyer", "renter"] as Role[]).map((r) => {
    const name = `${NET.prefix}_${r.toUpperCase()}`;
    const v = (process.env[name] ?? "").trim();
    if (!StrKey.isValidEd25519PublicKey(v)) throw new Error(`${name} must be a public key (G…); source the public-keys file first`);
    return [r, v];
  }),
) as Record<Role, string>;

// --- encoding ---------------------------------------------------------------------

const addr = (g: string) => new Address(g).toScVal();
const u64 = (n: bigint | number) => nativeToScVal(BigInt(n), { type: "u64" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u256 = (n: bigint | string) => nativeToScVal(BigInt(n), { type: "u256" });
const bytes32 = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! })),
  );

// --- state --------------------------------------------------------------------------

interface Week {
  right_id?: number;
  record_file: string;
  secret_file: string;
  period: { start: number; end: number };
}
interface State {
  contract: string;
  network: string;
  weeks: Record<string, Week>;
  request_id?: number;
  offer_id?: number;
  next_secret_file?: string;
  rental_offer_id?: number;
}
const STATE_FILE = join(DIR, "state.json");
const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { contract: C, network: netName, weeks: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });

const fileOf = (s: Step) => join(OUT, `${String(STEPS.indexOf(s) + 1).padStart(2, "0")}-${s}.xdr`);

// --- chain ----------------------------------------------------------------------------

/** The outcome of an earlier step's envelope, by the hash mainnet-sign-submit.sh saved. */
async function landed(s: Step): Promise<xdr.ScVal | undefined> {
  const hashFile = `${fileOf(s)}.submission/hash`;
  if (!existsSync(hashFile)) throw new Error(`step ${s} has not been signed yet (no ${hashFile}); sign it first`);
  const hash = readFileSync(hashFile, "utf8").trim();
  const t = await server.getTransaction(hash);
  if (t.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`step ${s} (${hash}) is ${t.status} on chain, not SUCCESS`);
  console.log(`  ${s} landed: ${hash} (ledger ${t.ledger})`);
  return (t as rpc.Api.GetSuccessfulTransactionResponse).returnValue;
}

async function view(fn: string, args: xdr.ScVal[], contract = C): Promise<unknown> {
  const acct = await server.getAccount(ACCT.issuer);
  const tx = new TransactionBuilder(acct, { fee: "100", networkPassphrase: NET.passphrase })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error}`);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

async function latest(): Promise<{ sequence: number; closedAt: number }> {
  const l = await server.getLatestLedger();
  // The ledger's close time, from the network (not this machine's clock).
  const res = (await fetch(NET.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLedgers", params: { startLedger: l.sequence, pagination: { limit: 1 } } }),
  }).then((r) => r.json())) as { result?: { ledgers: { ledgerCloseTime: string }[] } };
  const closedAt = Number(res.result?.ledgers[0]?.ledgerCloseTime ?? Math.floor(Date.now() / 1000));
  return { sequence: l.sequence, closedAt };
}

/** Build, simulate twice, assemble, and write the unsigned envelope. Signs nothing. */
async function envelope(step: Step, fn: string, args: xdr.ScVal[]) {
  const source = ACCT[SIGNER[step]];
  const build = async (): Promise<Transaction> => {
    const acct = await server.getAccount(source);
    return new TransactionBuilder(acct, { fee: "100", networkPassphrase: NET.passphrase })
      .addOperation(Operation.invokeHostFunction({ func: new Contract(C).call(fn, ...args).body().invokeHostFunctionOp().hostFunction(), auth: [] }))
      .setTimeout(TX_SECONDS)
      .build();
  };
  let tx = await build();
  for (let pass = 1; pass <= 2; pass++) {
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${step}: the simulation fails: ${sim.error}`);
    tx = rpc.assembleTransaction(tx, sim).build();
  }
  const file = fileOf(step);
  if (existsSync(`${file}.submission`)) throw new Error(`${file} was already signed (${file}.submission exists); nothing rebuilt`);
  writeFileSync(file, tx.toXDR() + "\n");
  console.log(`\nWrote ${file}`);
  console.log(`  ${fn}, source ${source} (${SIGNER[step]}), valid until ${new Date(Number(tx.timeBounds!.maxTime) * 1000).toISOString()}`);
  console.log("Review, sign and send it with:");
  console.log(`  scripts/mainnet-sign-submit.sh ${file} ${NET.identity}-${SIGNER[step]} --network ${netName}`);
}

// --- weeks and proofs ---------------------------------------------------------------

async function issueWeek(step: Step, key: "a" | "b") {
  if (key === "b") await landed("issue-a");
  const like = JSON.parse(readFileSync("inventory/records/week-03.json", "utf8")) as OwnershipRecord;
  const { closedAt } = await latest();
  const today = new Date(closedAt * 1000).toISOString().slice(0, 10);
  const checkOut = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * DAY * 1000).toISOString().slice(0, 10);
  const rec = validateRecord({
    ...like,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { ...like.owner, stellar_account: ACCT.owner },
    week: { check_in: today, check_out: checkOut, use_year: Number(today.slice(0, 4)), week_number: isoWeekNumber(today) },
  });
  const recordFile = join(DIR, `week-${key}-record.json`);
  const secretFile = join(DIR, `week-${key}-owner-secret.json`);
  writeFileSync(recordFile, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(secretFile, JSON.stringify({ secret: randomSecret().toString() }) + "\n", { mode: 0o600 });
  const d = await splitRecordDigest(rec as unknown as JsonValue);
  const h = await secretHash(BigInt(JSON.parse(readFileSync(secretFile, "utf8")).secret));
  const c = fr(await commitment(d, ACCT.owner, h));
  const period = { start: Date.parse(`${today}T00:00:00Z`) / 1000, end: Date.parse(`${checkOut}T00:00:00Z`) / 1000 };
  const validity = { from: Date.parse(`${rec.week.use_year}-01-01T00:00:00Z`) / 1000, until: Date.parse(`${rec.week.use_year + 1}-01-01T00:00:00Z`) / 1000 };
  state.weeks[key] = { record_file: recordFile, secret_file: secretFile, period };
  save();
  console.log(`week ${key.toUpperCase()}: ${today} → ${checkOut} (record and secret kept in ${DIR}, not printed)`);
  await envelope(step, "issue", [
    addr(ACCT.owner),
    struct({ start: u64(period.start), end: u64(period.end) }),
    struct({ from: u64(validity.from), until: u64(validity.until) }),
    bytes32(c),
  ]);
}

/** The right id an issue step returned on chain. */
async function rightOf(key: "a" | "b"): Promise<number> {
  const w = state.weeks[key];
  if (!w) throw new Error(`week ${key} was not built; run issue-${key}`);
  if (w.right_id === undefined) {
    const rv = await landed(key === "a" ? "issue-a" : "issue-b");
    w.right_id = Number(scValToNative(rv!));
    save();
  }
  return w.right_id;
}

// --- the steps ----------------------------------------------------------------------

async function main() {
  console.log(`pilot-envelope ${STEP} on ${netName}, contract ${C} (builds only; signs and sends nothing)`);
  switch (STEP) {
    case "issue-a":
      return issueWeek("issue-a", "a");
    case "issue-b":
      return issueWeek("issue-b", "b");
    case "sale-request": {
      await landed("issue-b");
      const right = await rightOf("a");
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      const keyHash = createHash("sha256").update(ecdh.getPublicKey()).digest("hex");
      const { sequence } = await latest();
      return envelope("sale-request", "request_record", [addr(ACCT.buyer), u64(right), bytes32(keyHash), u32(sequence + OFFER_LEDGERS)]);
    }
    case "sale-offer": {
      state.request_id = Number(scValToNative((await landed("sale-request"))!));
      const s = randomSecret();
      const sFile = join(DIR, `buyer-next-secret-${randomUUID().slice(0, 8)}.json`);
      writeFileSync(sFile, JSON.stringify({ secret: s.toString() }) + "\n", { mode: 0o600 });
      state.next_secret_file = sFile;
      save();
      const h = await secretHash(s);
      const { sequence } = await latest();
      return envelope("sale-offer", "create_sale_offer", [addr(ACCT.buyer), u64(state.request_id), i128(PRICE), u256(h), u32(sequence + OFFER_LEDGERS)]);
    }
    case "sale-accept": {
      state.offer_id = Number(scValToNative((await landed("sale-offer"))!));
      save();
      const w = state.weeks.a!;
      const h = await secretHash(BigInt(JSON.parse(readFileSync(state.next_secret_file!, "utf8")).secret));
      const { sequence } = await latest();
      const { file, seconds } = await proveTransfer(JSON.parse(readFileSync(w.record_file, "utf8")) as JsonValue, BigInt(JSON.parse(readFileSync(w.secret_file, "utf8")).secret), {
        rightId: BigInt(await rightOf("a")),
        from: ACCT.owner,
        to: ACCT.buyer,
        expiresAt: null,
        expiryLedger: BigInt(sequence + PROOF_WINDOW),
        nextSecretHash: h,
      });
      console.log(`proved in ${seconds.toFixed(1)} s; the proof is valid through ledger ${sequence + PROOF_WINDOW} (~30 min)`);
      const proof = struct({ a: bytes32(file.proof.a), b: bytes32(file.proof.b), c: bytes32(file.proof.c) });
      const signals = xdr.ScVal.scvVec(PUBLIC_SIGNALS.map((k) => u256(file.public_signals[k]!)));
      return envelope("sale-accept", "accept_sale", [addr(ACCT.owner), u64(state.offer_id), i128(PRICE), proof, signals]);
    }
    case "rental-offer": {
      await landed("sale-accept");
      const right = await rightOf("b");
      const w = state.weeks.b!;
      const { sequence, closedAt } = await latest();
      const checkIn = closedAt + 3600;
      if (checkIn >= w.period.end) throw new Error("check-in would fall after the week; issue week B again");
      return envelope("rental-offer", "create_rental_offer", [
        addr(ACCT.renter),
        u64(right),
        i128(PRICE),
        u64(w.period.end),
        u64(Math.max(checkIn, w.period.start)),
        u32(sequence + OFFER_LEDGERS),
      ]);
    }
    case "status":
      return status();
    default:
      throw new Error(`unknown step "${STEP}"; one of: ${[...STEPS, "status"].join(", ")}`);
  }
}

async function status() {
  const txs: string[] = [];
  for (const s of STEPS) {
    const hashFile = `${fileOf(s)}.submission/hash`;
    if (!existsSync(hashFile)) {
      console.log(`  ${s.padEnd(13)} not signed yet`);
      continue;
    }
    const hash = readFileSync(hashFile, "utf8").trim();
    const t = await server.getTransaction(hash);
    console.log(`  ${s.padEnd(13)} ${t.status} ${hash}`);
    if (t.status === rpc.Api.GetTransactionStatus.SUCCESS) txs.push(`${s}=${hash}`);
  }
  for (const key of ["a", "b"] as const) {
    const w = state.weeks[key];
    if (w?.right_id === undefined) continue;
    const who = String(await view("holder", [u64(w.right_id)]));
    const name = Object.entries(ACCT).find(([, g]) => g === who)?.[0] ?? "someone else";
    console.log(`  week ${key.toUpperCase()} = right #${w.right_id}, held by ${who} (${name})`);
  }
  if (state.offer_id !== undefined) {
    const o = await view("get_offer", [u64(state.offer_id)]);
    console.log(`  sale offer #${state.offer_id}: ${o == null ? "gone (accepted)" : JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  for (const r of ["owner", "buyer", "renter"] as Role[]) {
    const bal = await view("balance", [addr(ACCT[r])], NET.usdc);
    console.log(`  USDC ${r.padEnd(6)} ${String(bal)}`);
  }
  console.log(`  USDC rights contract ${String(await view("balance", [addr(C)], NET.usdc))}`);
  if (txs.length === 0) return;
  const out = `evidence/privacy/${new Date().toISOString().slice(0, 10)}-pilot-${netName}-${C.slice(0, 8)}.txt`;
  const args = ["tsx", "scripts/check-privacy.ts", "--network", netName, "--out", out];
  for (const t of txs) args.push("--tx", t);
  for (const w of Object.values(state.weeks)) args.push("--record", w.record_file, "--secret", w.secret_file);
  if (state.next_secret_file) args.push("--next-secret", state.next_secret_file);
  execFileSync("npx", args, { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`privacy record: ${out}`);
}

// snarkjs leaves worker threads running after a proof, so exit explicitly.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`pilot-envelope: ${(e as Error).message}`);
    process.exit(1);
  },
);
