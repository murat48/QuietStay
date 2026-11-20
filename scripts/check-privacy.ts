/**
 * Check what the evidence transactions actually expose on chain.
 *
 *   npm run check-privacy
 *
 * The claim this project makes is that personal and ownership records never reach
 * the ledger. That claim is worth exactly as much as the check behind it, so this
 * script fetches each evidence transaction back from the network and does two
 * things with it:
 *
 *   1. **Searches the raw bytes** of every layer an explorer could render — the
 *      operation envelope, the result, and the transaction meta that carries the
 *      ledger entry changes — for any value out of the off-chain records. Raw
 *      bytes rather than parsed fields, because a structured reader only finds
 *      leaks in the fields you thought to look at.
 *
 *   2. **Decodes and prints** the operation parameters and the contract event, in
 *      full, so what *is* public is enumerated rather than summarised. This is the
 *      part a reviewer can compare against what stellar.expert shows them.
 *
 * Two things are public by design and are called out where they appear:
 *
 *   - the **week's date range**, held in contract state because a marketplace
 *     listing has to say which week is on offer, and therefore present in the meta
 *     of any transaction that writes that state; and
 *   - a **rental's term-end timestamp**, in the operation parameters, because the
 *     contract cannot enforce a term it cannot see. A sale carries no timestamp.
 *
 * Neither is tied to a name, a resort, a unit, a deed, or a fee history. See
 * docs/DESIGN.md, "What the ledger reveals".
 *
 *   npm run check-privacy -- --phase2
 *
 * checks the Phase 2 deployment instead: every transaction in
 * docs/evidence-phase2.json — accepted and rejected — and every issuance in
 * inventory/phase2/issued.json. On top of the record contents it forbids what
 * the ownership proof keeps private (docs/CIRCUIT.md §8): each record's SHA-256
 * digest `d` (as hex, as raw bytes, and as the two 16-byte halves the circuit
 * takes), each owner's record secret `s`, and each owner's secret hash `h`.
 * What is public by design in Phase 2 — the proof, its eleven signals, and on a
 * sale the buyer's next secret hash `h'` — is printed, not forbidden.
 *
 *   npm run check-privacy -- --tx <label>=<hash> [--tx …] [--record <file>]… [--secret <file>]…
 *                            [--network testnet|mainnet] --out evidence/privacy/<name>.txt
 *
 * Phase 3 (Step 2 review): run right after every evidence transaction, on
 * testnet and on mainnet, and commit the output. Stellar RPC keeps a
 * transaction's meta, and so its events, for about a week, and Horizon no
 * longer serves meta at all. So the committed output is the lasting record
 * that the events were checked. Each `--record` (an ownership record) and
 * `--secret` (`{ "secret": … }`, a holder's) adds that record's digest `d`, `d_hi`,
 * `d_lo` and that secret's `s` and `h` to the forbidden values. Each
 * `--next-secret` (a buyer's `s'`) adds `s'` only, because a sale publishes
 * `h'` by design. All of this comes on top of every
 * inventory record. They are searched for and never printed. `--out` gets the
 * full output in plain text, with the decoded call and every event.
 *
 * Phase 3 Step 3 (payments): offers, escrows and their events add values that
 * are **public by design**, printed in the decoded call and events, never
 * forbidden: USDC amounts and allowances, buyer, renter, owner and arbiter
 * addresses, check-in and rental-end times, offer and request expiry ledgers,
 * a buyer's `h'` in a sale offer, the SHA-256 `key_hash` of a requester's
 * sealed-link key, and the SHA-256 hashes of evidence files and of the
 * arbiter's decision. Each `--evidence <file>` (a dispute evidence file, or
 * the decision) forbids that file's contents: only its hash may be on chain,
 * and the output says whether that hash was found, as it should be.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

import { commit, toHex, type JsonValue } from "../src/lib/canonical";
import { HORIZON_URL } from "../src/lib/config";
import { server } from "../src/lib/contract";
import type { OwnershipRecord } from "../src/lib/record";
import { fatal, loadEnv, log, readJson } from "./lib/cli";
import { secretHash } from "./lib/zk";

loadEnv();

const PHASE2 = process.argv.includes("--phase2");

/** `--tx label=hash` mode (Phase 3): the named transactions only. */
const cli = parseArgs({
  args: process.argv.slice(2),
  options: {
    phase2: { type: "boolean" },
    tx: { type: "string", multiple: true },
    record: { type: "string", multiple: true },
    secret: { type: "string", multiple: true },
    "next-secret": { type: "string", multiple: true },
    evidence: { type: "string", multiple: true },
    network: { type: "string" },
    out: { type: "string" },
  },
  strict: true,
}).values;
const NETWORK = cli.network ?? "testnet";
if (NETWORK !== "testnet" && NETWORK !== "mainnet") throw new Error("--network must be testnet or mainnet");
const RPC = NETWORK === "mainnet" ? new rpc.Server(process.env.STELLAR_MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com") : server;
const HORIZON = NETWORK === "mainnet" ? "https://horizon.stellar.org" : HORIZON_URL;
const EXPERT = NETWORK === "mainnet" ? "https://stellar.expert/explorer/public/tx" : "https://stellar.expert/explorer/testnet/tx";

/** Everything printed, without colour codes, for --out. */
const transcript: string[] = [];
{
  const original = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    transcript.push(args.map(String).join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
    original(...args);
  };
}

/** d, d_hi, d_lo for each --record, and s, h for each --secret. */
async function givenForbiddenValues(): Promise<{ label: string; value: string }[]> {
  const out: { label: string; value: string }[] = [];
  for (const file of cli.record ?? []) {
    const name = file.split("/").pop();
    const rec = readJson<OwnershipRecord>(file);
    const d = await commit(rec as unknown as JsonValue);
    out.push({ label: `${name} record digest d (hex)`, value: d });
    out.push({ label: `${name} record digest d (raw bytes)`, value: raw(d) });
    out.push({ label: `${name} d_hi (raw 16 bytes)`, value: raw(d.slice(0, 32)) });
    out.push({ label: `${name} d_lo (raw 16 bytes)`, value: raw(d.slice(32)) });
    for (const [what, v] of [
      ["owner name", rec.owner?.name],
      ["owner email", rec.owner?.email],
      ["salt", rec.salt],
      ["record id", rec.record_id],
      ["deed reference", rec.title?.deed_reference],
    ] as const) {
      if (typeof v === "string" && v.length >= 4) out.push({ label: `${name} ${what}`, value: v });
    }
  }
  for (const file of cli.secret ?? []) {
    const name = file.split("/").pop();
    const secret = BigInt((readJson<{ secret: string }>(file)).secret);
    out.push({ label: `${name} secret s (raw bytes)`, value: raw(be32(secret)) });
    out.push({ label: `${name} secret s (decimal)`, value: secret.toString() });
    out.push({ label: `${name} secret hash h (raw bytes)`, value: raw(be32(await secretHash(secret))) });
  }
  // A buyer's next secret s': its hash h' is public by design on the sale
  // (the next_secret_hash signal, and the consent the buyer signs), so only
  // s' itself is forbidden.
  for (const file of cli["next-secret"] ?? []) {
    const name = file.split("/").pop();
    const secret = BigInt((readJson<{ secret: string }>(file)).secret);
    out.push({ label: `${name} next secret s' (raw bytes)`, value: raw(be32(secret)) });
    out.push({ label: `${name} next secret s' (decimal)`, value: secret.toString() });
  }
  // A dispute evidence file or decision: its hash is public by design, its
  // contents never go on chain. The whole file, and its first 64 bytes on
  // their own, are searched for.
  for (const file of cli.evidence ?? []) {
    const name = file.split("/").pop();
    const bytes = readFileSync(file);
    if (bytes.length >= 4) out.push({ label: `${name} evidence file contents`, value: bytes.toString("latin1") });
    if (bytes.length > 64) out.push({ label: `${name} evidence file, first 64 bytes`, value: bytes.subarray(0, 64).toString("latin1") });
  }
  return out;
}

/** SHA-256 of each --evidence file, which should appear (as 32 raw bytes) on chain. */
function evidenceHashes(): { file: string; hex: string; raw: string }[] {
  return (cli.evidence ?? []).map((file) => {
    const hex = createHash("sha256").update(readFileSync(file)).digest("hex");
    return { file, hex, raw: raw(hex) };
  });
}

interface Evidence {
  contract: string;
  transactions: { id: string; title: string; hash: string; explorer: string }[];
}

/** Every value out of the off-chain records that must never appear on chain. */
function forbiddenValues(): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const seen = new Set<string>();

  const add = (label: string, value: string) => {
    if (typeof value !== "string" || value.length < 4 || seen.has(value)) return;
    seen.add(value);
    out.push({ label, value });
  };

  const collect = (record: OwnershipRecord, source: string) => {
    add(`${source} owner name`, record.owner.name);
    add(`${source} owner email`, record.owner.email);
    add(`${source} resort`, record.resort.name);
    add(`${source} unit`, record.resort.unit);
    add(`${source} country`, record.resort.country);
    add(`${source} deed reference`, record.title.deed_reference);
    add(`${source} registry`, record.title.registry);
    add(`${source} record id`, record.record_id);
    add(`${source} salt`, record.salt);
    add(`${source} annual fee`, record.maintenance_fees.annual_amount);
    add(`${source} outstanding`, record.maintenance_fees.outstanding);
  };

  for (const file of readdirSync("inventory/records").filter((f) => f.endsWith(".json"))) {
    collect(readJson<OwnershipRecord>(join("inventory/records", file)), file);
  }
  const evidenceDir = "inventory/evidence/canonical";
  for (const file of readdirSync(evidenceDir).filter((f) => f.endsWith(".json"))) {
    collect(JSON.parse(readFileSync(join(evidenceDir, file), "utf8")) as OwnershipRecord, file);
  }

  return out;
}

/** As raw bytes, searched for in the binary layers like any string value. */
const raw = (hex: string) => Buffer.from(hex, "hex").toString("latin1");
const be32 = (x: bigint) => x.toString(16).padStart(64, "0");

/**
 * What the ownership proof keeps private, for the Phase 2 deployment. Secrets
 * are read from the local .secrets/ files named in inventory/phase2/issued.json;
 * they are searched for, never printed.
 */
async function phase2ForbiddenValues(): Promise<{ label: string; value: string }[]> {
  const issued = readJson<{
    rights: { record_file: string; record_digest: string; owner_secret_file: string }[];
  }>("inventory/phase2/issued.json");
  const out: { label: string; value: string }[] = [];
  for (const r of issued.rights) {
    const name = r.record_file.split("/").pop();
    out.push({ label: `${name} record digest d (hex)`, value: r.record_digest });
    out.push({ label: `${name} record digest d (raw bytes)`, value: raw(r.record_digest) });
    out.push({ label: `${name} d_hi (raw 16 bytes)`, value: raw(r.record_digest.slice(0, 32)) });
    out.push({ label: `${name} d_lo (raw 16 bytes)`, value: raw(r.record_digest.slice(32)) });
    if (!existsSync(r.owner_secret_file)) {
      throw new Error(`${r.owner_secret_file} is missing — the check needs it to search for the secret`);
    }
    const secret = BigInt(JSON.parse(readFileSync(r.owner_secret_file, "utf8")).secret);
    out.push({ label: `${name} owner secret s (raw bytes)`, value: raw(be32(secret)) });
    out.push({ label: `${name} owner secret s (decimal)`, value: secret.toString() });
    const h = await secretHash(secret);
    out.push({ label: `${name} owner secret hash h (raw bytes)`, value: raw(be32(h)) });
  }
  return out;
}

/** Render a decoded ScVal for a human, with bytes as hex and bigints as digits. */
function show(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (val && typeof val === "object" && (val as { type?: string }).type === "Buffer") {
        const hex = toHex(new Uint8Array((val as { data: number[] }).data));
        // Proof points run to 192 bytes; show enough to compare with the explorer.
        return hex.length > 64 ? `0x${hex.slice(0, 16)}…${hex.slice(-8)} (${hex.length / 2} bytes)` : `0x${hex}`;
      }
      return val;
    },
    0,
  );
}

/** The contract call an invokeHostFunction operation makes. */
function decodeInvocation(envelope: xdr.TransactionEnvelope): {
  fn: string;
  args: string[];
} | null {
  const operations = envelope.v1().tx().operations();
  const op = operations[0];
  if (!op) return null;
  const body = op.body();
  if (body.switch().name !== "invokeHostFunction") return null;
  const hostFn = body.invokeHostFunctionOp().hostFunction();
  if (hostFn.switch().name !== "hostFunctionTypeInvokeContract") return null;
  const invoke = hostFn.invokeContract();
  return {
    fn: invoke.functionName().toString(),
    args: invoke.args().map((arg) => show(scValToNative(arg))),
  };
}

/** Contract events, decoded to topics and named data fields. */
function decodeContractEvents(events: unknown): { topics: string; data: string }[] {
  const groups = (events as Record<string, unknown> | undefined)?.contractEventsXdr;
  if (!Array.isArray(groups)) return [];
  return groups
    .flat()
    .map((event) => {
      const body = (event as xdr.ContractEvent).body().v0();
      return {
        topics: show(body.topics().map((topic) => scValToNative(topic))),
        data: show(scValToNative(body.data())),
      };
    });
}

interface FetchedTx {
  source: "rpc" | "horizon";
  envelopeXdr?: xdr.TransactionEnvelope;
  resultXdr?: { toXDR(format: "base64"): string };
  resultMetaXdr?: xdr.TransactionMeta;
  events?: unknown;
}

/** The contract events inside a transaction's meta, in the shape RPC gives them. */
function eventsFromMeta(meta: xdr.TransactionMeta): unknown {
  try {
    if (meta.switch() === 3) return { contractEventsXdr: [meta.v3().sorobanMeta()?.events() ?? []] };
    if (meta.switch() === 4) return { contractEventsXdr: meta.v4().operations().map((op) => op.events()) };
  } catch {
    // an unexpected meta shape: the raw scan above still covers every byte
  }
  return undefined;
}

/**
 * A transaction from Stellar RPC, or, once it is older than RPC's retention
 * window (about a week on testnet), from Horizon's full history. Both return
 * the same envelope, result and meta XDR, so the scan below is the same.
 */
async function fetchTx(hash: string): Promise<FetchedTx | null> {
  const tx = await RPC.getTransaction(hash);
  if (tx.status !== "NOT_FOUND") {
    return { source: "rpc", envelopeXdr: tx.envelopeXdr, resultXdr: tx.resultXdr, resultMetaXdr: tx.resultMetaXdr, events: tx.events };
  }
  const res = await fetch(`${HORIZON}/transactions/${hash}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon answered HTTP ${res.status} for ${hash}`);
  const body = (await res.json()) as { envelope_xdr: string; result_xdr: string; result_meta_xdr?: string };
  // Current Horizon no longer serves the meta, which is where Soroban events
  // live. Without it, the envelope (every argument the call carried) and the
  // result are still scanned; the caller says the meta was not.
  const meta = body.result_meta_xdr ? xdr.TransactionMeta.fromXDR(body.result_meta_xdr, "base64") : undefined;
  return {
    source: "horizon",
    envelopeXdr: xdr.TransactionEnvelope.fromXDR(body.envelope_xdr, "base64"),
    resultXdr: { toXDR: () => body.result_xdr },
    resultMetaXdr: meta,
    events: meta ? eventsFromMeta(meta) : undefined,
  };
}

async function main(): Promise<void> {
  const named = (cli.tx ?? []).map((t) => {
    const [id, hash] = t.split("=");
    if (!id || !hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`--tx expects <label>=<64-hex hash>, got ${t}`);
    return { id, title: id, hash, explorer: `${EXPERT}/${hash}` };
  });
  const evidence: Evidence = named.length
    ? { contract: `the contracts these ${NETWORK} transactions call`, transactions: named }
    : PHASE2
      ? phase2Evidence()
      : readJson("docs/evidence.json");
  const forbidden = named.length
    ? [...forbiddenValues(), ...(await givenForbiddenValues())]
    : PHASE2
      ? [...forbiddenValues(), ...(await phase2ForbiddenValues())]
      : forbiddenValues();
  if (named.length) {
    log.info(`run ${new Date().toISOString()} · network ${NETWORK} · command: npm run check-privacy -- ${process.argv.slice(2).join(" ")}`);
  }

  log.step("Checking on-chain exposure");
  log.info(`${evidence.transactions.length} transactions, ${forbidden.length} forbidden values`);
  log.info(`contract ${evidence.contract}`);

  let problems = 0;
  let withoutMeta = 0;

  for (const item of evidence.transactions) {
    const tx = await fetchTx(item.hash);
    log.step(`${item.id} — ${item.hash}`);

    if (!tx) {
      log.fail("not on the ledger — this hash would not open in an explorer");
      problems += 1;
      continue;
    }
    if (tx.source === "horizon") {
      log.info("older than RPC's retention window: read from Horizon's full history");
      if (!tx.resultMetaXdr) {
        withoutMeta += 1;
        log.warn("Horizon serves no meta for it, so its events were not scanned here; the envelope and result were");
      }
    }

    // --- 1. the raw scan, over every layer -------------------------------
    const layers: { name: string; bytes: Buffer }[] = [];
    const push = (name: string, base64: string | undefined) => {
      if (base64) layers.push({ name, bytes: Buffer.from(base64, "base64") });
    };
    push("envelope", tx.envelopeXdr?.toXDR("base64"));
    push("result", tx.resultXdr?.toXDR("base64"));
    push("meta", tx.resultMetaXdr?.toXDR("base64"));

    const combined = Buffer.concat(layers.map((l) => l.bytes)).toString("latin1");
    const hits = forbidden.filter((f) => combined.includes(f.value));

    if (hits.length === 0) {
      log.ok(
        `no record contents in ${layers.length} layers ` +
          `(${combined.length} bytes: ${layers.map((l) => l.name).join(", ")})`,
      );
    } else {
      // Record fields are shown; secrets and digests are named but never printed.
      for (const hit of hits) {
        const hidden = /secret|digest|d_hi|d_lo/.test(hit.label);
        log.fail(`LEAK — ${hit.label}${hidden ? " (value not printed)" : `: "${hit.value}"`}`);
      }
      problems += hits.length;
    }

    // Evidence files: the hash is public by design and expected; noted, not a leak.
    for (const e of evidenceHashes()) {
      if (combined.includes(e.raw)) log.info(`public by design: SHA-256 of ${e.file} (${e.hex}) is on chain here, as it should be`);
    }

    // --- 2. what the operation and the event actually say ----------------
    if (tx.envelopeXdr) {
      const invocation = decodeInvocation(tx.envelopeXdr);
      if (invocation) {
        log.info(`call        ${invocation.fn}(`);
        for (const arg of invocation.args) log.info(`              ${arg},`);
        log.info(`            )`);
      }
    }
    for (const event of decodeContractEvents(tx.events)) {
      log.info(`event topics ${event.topics}`);
      log.info(`event data   ${event.data}`);
    }
  }

  log.step("Result");
  if (withoutMeta > 0) {
    log.warn(
      `${withoutMeta} of ${evidence.transactions.length} transactions are older than RPC's retention window, and ` +
        "Horizon serves no meta: for those, only the envelope and the result were scanned, not the events.",
    );
  }
  if (problems === 0 && named.length) {
    log.ok(`No inventory record value appears in any of these ${named.length} ${NETWORK} transactions, at any layer scanned.`);
    const given = (cli.record ?? []).length + (cli.secret ?? []).length + (cli["next-secret"] ?? []).length;
    if (given > 0) {
      log.ok(
        `Nor does the digest d (hex, bytes, d_hi, d_lo) of ${(cli.record ?? []).length} record(s) given, ` +
          `or s and h of ${(cli.secret ?? []).length} holder secret(s) given, or s' of ` +
          `${(cli["next-secret"] ?? []).length} buyer next secret(s) given (whose h' a sale publishes by design).`,
      );
    }
    log.info("Records and secrets searched for (by file, never printed):");
    for (const f of [...(cli.record ?? []), ...(cli.secret ?? []), ...(cli["next-secret"] ?? [])]) log.info(`  • ${f}`);
    log.info("A transaction whose record or secret is not listed above was checked against the inventory values only.");
  } else if (problems === 0 && PHASE2) {
    log.ok("No record contents, no record digest d, no owner secret s and no owner");
    log.ok("secret hash h appears in any Phase 2 evidence or issuance transaction,");
    log.ok(`at any layer ${withoutMeta > 0 ? "scanned (see the note above)" : ""} — accepted or rejected.`.replace("  ", " "));
    console.log("");
    log.info("Public, and visible above:");
    log.info("  • account addresses, and the contract address");
    log.info("  • the usage right's numeric id");
    log.info("  • the Poseidon commitment C, and after a sale the buyer's C'");
    log.info("  • the proof (three curve points) and its eleven public signals: C, the");
    log.info("    nullifier, the right id, both accounts' key halves, the mode (a rental's");
    log.info("    end, or 0), the proof's last valid ledger, h' and C'");
    log.info("  • on a sale, the buyer's next secret hash h' — public by design: it lets");
    log.info("    whoever holds the record check C' against it, and proves nothing alone");
    console.log("");
    log.info("Also public, in contract state: the week's date range, as in Phase 1.");
  } else if (problems === 0) {
    log.ok("No name, email, resort, country, unit, deed reference, registry, salt,");
    log.ok(`or fee figure appears in any evidence transaction, at any layer${withoutMeta > 0 ? " scanned (see the note above)" : ""}.`);
    console.log("");
    log.info("Public, and visible above:");
    log.info("  • account addresses, and the contract address");
    log.info("  • the usage right's numeric id");
    log.info("  • the SHA-256 commitment to the off-chain record");
    log.info("  • a rental's term-end timestamp — a sale's `expires_at` is null");
    console.log("");
    log.info("Also public, in contract state rather than in the call:");
    log.info("  • the week's date range and its use year, because a listing must say");
    log.info("    what is on offer. Visible in the `meta` layer of transactions that");
    log.info("    write a right's state. Not linked to any identity.");
  } else {
    log.fail(`${problems} problem(s) — the privacy claim does not hold as written`);
    process.exitCode = 1;
  }
}

/** The Phase 2 evidence transactions, plus every issuance on that contract. */
function phase2Evidence(): Evidence {
  const ev = readJson<{ contract: string; transactions: { id: string; title: string; hash: string; explorer: string }[] }>(
    "docs/evidence-phase2.json",
  );
  const issued = readJson<{ rights: { right_id: number; issue_tx: string }[] }>("inventory/phase2/issued.json");
  return {
    contract: ev.contract,
    transactions: [
      ...issued.rights.map((r) => ({
        id: `issue-${r.right_id}`,
        title: `issue right #${r.right_id}`,
        hash: r.issue_tx,
        explorer: `https://stellar.expert/explorer/testnet/tx/${r.issue_tx}`,
      })),
      ...ev.transactions,
    ],
  };
}

main()
  .then(() => writeTranscript())
  .catch((e) => {
    writeTranscript();
    fatal(e);
  });

function writeTranscript(): void {
  if (!cli.out) return;
  mkdirSync(dirname(cli.out), { recursive: true });
  writeFileSync(cli.out, transcript.join("\n") + "\n");
}
