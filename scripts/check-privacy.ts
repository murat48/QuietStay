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
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { scValToNative, type xdr } from "@stellar/stellar-sdk";

import { toHex } from "../src/lib/canonical";
import { server } from "../src/lib/contract";
import type { OwnershipRecord } from "../src/lib/record";
import { fatal, loadEnv, log, readJson } from "./lib/cli";

loadEnv();

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

/** Render a decoded ScVal for a human, with bytes as hex and bigints as digits. */
function show(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (val && typeof val === "object" && (val as { type?: string }).type === "Buffer") {
        return `0x${toHex(new Uint8Array((val as { data: number[] }).data))}`;
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
  const evidence: Evidence = readJson("docs/evidence.json");
  const forbidden = forbiddenValues();

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
  if (problems === 0) {
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

main().catch(fatal);
