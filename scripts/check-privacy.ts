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
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { scValToNative, type xdr } from "@stellar/stellar-sdk";

import { toHex } from "../src/lib/canonical";
import { server } from "../src/lib/contract";
import type { OwnershipRecord } from "../src/lib/record";
import { fatal, loadEnv, log, readJson } from "./lib/cli";
import { secretHash } from "./lib/zk";

loadEnv();

const PHASE2 = process.argv.includes("--phase2");

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

async function main(): Promise<void> {
  const evidence: Evidence = PHASE2 ? phase2Evidence() : readJson("docs/evidence.json");
  const forbidden = PHASE2 ? [...forbiddenValues(), ...(await phase2ForbiddenValues())] : forbiddenValues();

  log.step("Checking on-chain exposure");
  log.info(`${evidence.transactions.length} transactions, ${forbidden.length} forbidden values`);
  log.info(`contract ${evidence.contract}`);

  let problems = 0;

  for (const item of evidence.transactions) {
    const tx = await server.getTransaction(item.hash);
    log.step(`${item.id} — ${item.hash}`);

    if (tx.status === "NOT_FOUND") {
      log.fail("not on the ledger — this hash would not open in an explorer");
      problems += 1;
      continue;
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
      for (const hit of hits) log.fail(`LEAK — ${hit.label}: "${hit.value}"`);
      problems += hits.length;
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
  if (problems === 0 && PHASE2) {
    log.ok("No record contents, no record digest d, no owner secret s and no owner");
    log.ok("secret hash h appears in any Phase 2 evidence or issuance transaction,");
    log.ok("at any layer — accepted or rejected.");
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
    log.ok("or fee figure appears in any evidence transaction, at any layer.");
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

main().catch(fatal);
