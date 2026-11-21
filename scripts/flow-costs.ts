/**
 * Step 5 checklist, "Transaction costs": what every flow on the final testnet
 * deployment actually cost, read from the ledger, with what mainnet would
 * charge for the same transaction.
 *
 *   npx tsx scripts/flow-costs.ts --contract <C…> [--extra label=hash …]
 *   cd contracts && cargo test -p quietstay-rights mainnet_fees -- --ignored --nocapture
 *
 * Read-only. For each accepted transaction in evidence/step3-testnet-<C8>.json,
 * evidence/step4-testnet-<C8>.json and any `--extra` (the arbiter's resolve,
 * the passkey probe), `getTransaction` gives:
 *   - the fee charged, and its parts from the meta (non-refundable,
 *     refundable, of which rent);
 *   - the declared resources (instructions, disk read and write bytes,
 *     footprint) and the envelope's size;
 *   - every rent change: for each entry whose TTL or size changed, its size
 *     and live-until before and after, as the host's `compute_rent_fee` takes
 *     them. Sizes are XDR sizes of the ledger entries in the meta; an entry
 *     whose TTL moved but whose data did not appear is read now
 *     (`getLedgerEntries`), and marked so.
 *
 * Written to evidence/checklist/flow-resources-testnet-<C8>.json. The Rust
 * test then prices the rent changes with each network's own settings: with
 * testnet's it must reproduce the rent the meta says was charged (the check
 * on this reconstruction), and with mainnet's (its minimum TTLs and its rent
 * rate) it gives mainnet's rent. Every other fee rate, and the instruction
 * count (the cost parameters a protocol-27 build can use are identical on
 * both networks), is the same on both networks.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { rpc, xdr } from "@stellar/stellar-sdk";

import { RPC_URL } from "../src/lib/config";
import { RetryingServer } from "../src/lib/rpc-server";

const server = new RetryingServer(RPC_URL);

interface RentChange {
  key: string;
  is_persistent: boolean;
  is_code_entry: boolean;
  old_size_bytes: number;
  new_size_bytes: number;
  old_live_until_ledger: number;
  new_live_until_ledger: number;
  size_read_now?: boolean;
}

const keyHash = (k: xdr.LedgerKey) => createHash("sha256").update(k.toXDR()).digest("hex");

function dataKeyOf(e: xdr.LedgerEntry): xdr.LedgerKey | null {
  const d = e.data();
  switch (d.switch().name) {
    case "contractData": {
      const c = d.contractData();
      return xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: c.contract(), key: c.key(), durability: c.durability() }));
    }
    case "contractCode":
      return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: d.contractCode().hash() }));
    default:
      return null;
  }
}

function describeKey(k: xdr.LedgerKey): string {
  if (k.switch().name === "contractCode") return "ContractCode";
  const c = k.contractData();
  const key = c.key();
  const name = key.switch().name === "scvVec" ? (key.vec()?.[0]?.switch().name === "scvSymbol" ? key.vec()![0]!.sym().toString() : "vec") : key.switch().name;
  return `${c.durability().name === "persistent" ? "P" : "T"} ${c.contract().switch().name === "scAddressTypeContract" ? "contract" : "account"} ${name}`;
}

async function analyse(label: string, hash: string) {
  const t = await server.getTransaction(hash);
  if (t.status !== rpc.Api.GetTransactionStatus.SUCCESS) return { label, hash, status: t.status };
  const env = t.envelopeXdr;
  const tx = env.v1().tx();
  const sorobanData = tx.ext().sorobanData();
  const res = sorobanData.resources();
  const fp = res.footprint();
  const meta = t.resultMetaXdr;
  const v4 = meta.v4();
  const ext = v4.sorobanMeta()?.ext();
  const fees = ext && ext.switch() === 1 ? ext.v1() : null;
  const changes = v4.operations()[0]!.changes();

  // Before/after for data entries and TTLs, keyed by the data key's hash.
  const before = new Map<string, { size: number; durability?: string; code: boolean }>();
  const after = new Map<string, { size: number; durability?: string; code: boolean }>();
  const ttlBefore = new Map<string, number>();
  const ttlAfter = new Map<string, number>();
  const keys = new Map<string, xdr.LedgerKey>();
  for (const c of changes) {
    const kind = c.switch().name;
    if (kind === "ledgerEntryRemoved") continue;
    const e: xdr.LedgerEntry =
      kind === "ledgerEntryState" ? c.state() : kind === "ledgerEntryCreated" ? c.created() : kind === "ledgerEntryUpdated" ? c.updated() : c.restored();
    const d = e.data();
    if (d.switch().name === "ttl") {
      const h = d.ttl().keyHash().toString("hex");
      (kind === "ledgerEntryState" ? ttlBefore : ttlAfter).set(h, d.ttl().liveUntilLedgerSeq());
      continue;
    }
    const k = dataKeyOf(e);
    if (!k) continue;
    const h = keyHash(k);
    keys.set(h, k);
    const info = {
      size: e.toXDR().length,
      durability: d.switch().name === "contractData" ? d.contractData().durability().name : "persistent",
      code: d.switch().name === "contractCode",
    };
    (kind === "ledgerEntryState" ? before : after).set(h, info);
  }

  const rent: RentChange[] = [];
  const all = new Set([...after.keys(), ...ttlAfter.keys()]);
  for (const h of all) {
    let k = keys.get(h);
    let a = after.get(h);
    let b = before.get(h);
    let sizeReadNow = false;
    if (!a && !b) {
      // TTL moved, data unchanged and not in the meta: read the entry now.
      const known = [...fp.readOnly(), ...fp.readWrite()].find((x) => keyHash(x) === h);
      if (!known) throw new Error(`${label}: a TTL for an entry outside the footprint (${h})`);
      k = known;
      const r = await server.getLedgerEntries(known);
      const now = r.entries[0];
      if (!now) throw new Error(`${label}: ${h} is no longer on the ledger`);
      const size = new xdr.LedgerEntry({ lastModifiedLedgerSeq: now.lastModifiedLedgerSeq ?? 0, data: now.val, ext: new xdr.LedgerEntryExt(0) }).toXDR().length;
      const durability = now.val.switch().name === "contractData" ? now.val.contractData().durability().name : "persistent";
      a = b = { size, durability, code: now.val.switch().name === "contractCode" };
      sizeReadNow = true;
    }
    const info = a ?? b!;
    const isNew = !b;
    let oldLive = ttlBefore.get(h) ?? (isNew ? 0 : ttlAfter.get(h) ?? 0);
    let newLive = ttlAfter.get(h) ?? oldLive;
    let ttlReadNow = false;
    if (!isNew && !ttlBefore.has(h) && !ttlAfter.has(h)) {
      // The data changed but its TTL did not, so the meta has no TTL entry.
      // A size change pays rent for the remaining TTL: read it now.
      const r = await server.getLedgerEntries(k!);
      // A temporary entry may be gone by now: then its remaining TTL is
      // unknown, and the transaction's own ledger stands in (no remaining
      // time priced; flagged).
      const live = r.entries[0]?.liveUntilLedgerSeq ?? t.ledger;
      oldLive = newLive = live;
      ttlReadNow = true;
    }
    rent.push({
      key: k ? describeKey(k) : h,
      is_persistent: info.durability === "persistent",
      is_code_entry: info.code,
      old_size_bytes: isNew ? 0 : b!.size,
      new_size_bytes: a ? a.size : b!.size,
      old_live_until_ledger: oldLive,
      new_live_until_ledger: newLive,
      ...(sizeReadNow ? { size_read_now: true } : {}),
      ...(ttlReadNow ? { ttl_read_now: true } : {}),
    });
  }

  const classic = (k: xdr.LedgerKey) => !["contractData", "contractCode"].includes(k.switch().name);
  return {
    label,
    hash,
    status: t.status,
    ledger: t.ledger,
    fee_charged: Number(t.resultXdr.feeCharged().toBigInt()),
    declared_resource_fee: Number(sorobanData.resourceFee().toBigInt()),
    charged: fees
      ? {
          non_refundable: Number(fees.totalNonRefundableResourceFeeCharged().toBigInt()),
          refundable: Number(fees.totalRefundableResourceFeeCharged().toBigInt()),
          rent: Number(fees.rentFeeCharged().toBigInt()),
        }
      : null,
    resources: {
      instructions: res.instructions(),
      disk_read_bytes: res.diskReadBytes(),
      write_bytes: res.writeBytes(),
      read_only: fp.readOnly().length,
      read_write: fp.readWrite().length,
      classic_entries: [...fp.readOnly(), ...fp.readWrite()].filter(classic).length,
      tx_size_bytes: env.toXDR().length,
    },
    rent_changes: rent,
  };
}

async function main() {
  const { values: a } = parseArgs({ options: { contract: { type: "string" }, extra: { type: "string", multiple: true } } });
  const C = a.contract ?? "";
  if (!/^C[A-Z2-7]{55}$/.test(C)) throw new Error("--contract <C…> is required");
  const c8 = C.slice(0, 8);
  const list: { label: string; hash: string }[] = [];
  for (const f of [`evidence/step3-testnet-${c8}.json`, `evidence/step4-testnet-${c8}.json`]) {
    if (!existsSync(f)) continue;
    const log = JSON.parse(readFileSync(f, "utf8")) as { entries: { label: string; hash: string; accepted?: boolean }[] };
    for (const e of log.entries) if (e.accepted !== false) list.push({ label: e.label, hash: e.hash });
  }
  for (const x of a.extra ?? []) {
    const [label, hash] = x.split("=");
    list.push({ label: label!, hash: hash! });
  }
  const out = [];
  for (const { label, hash } of list) {
    const r = await analyse(label, hash);
    out.push(r);
    const charged = "charged" in r && r.charged ? `rent ${r.charged.rent}` : "";
    console.log(`${label.padEnd(58)} ${"fee_charged" in r ? r.fee_charged : r.status} ${charged}`);
  }
  const file = `evidence/checklist/flow-resources-testnet-${c8}.json`;
  writeFileSync(file, JSON.stringify({ contract: C, read_at: new Date().toISOString(), rpc: RPC_URL, transactions: out }, null, 2) + "\n");
  console.log(`wrote ${file} (${out.length} transactions)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
