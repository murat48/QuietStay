/**
 * The command-line prover: one proof for one transfer.
 *
 *   npm run zk:prove -- --record <record.json> --secret <secret.json>
 *       --right <id> --from <G…> --to <G…>
 *       ( --sale --next-secret-hash <h'> | --rental-until <unix seconds> )
 *       [ --expiry-ledger <n> | --window <ledgers> ]  [ --out <dir> ]
 *
 * Reads the holder's record and secret, computes every public signal as
 * docs/CIRCUIT.md defines it, proves with circuits/keys/, and — before writing
 * anything meant for the chain — verifies the proof off-chain with snarkjs
 * against the committed verification key. Writes to --out (default proofs/):
 *
 *   proof.json      snarkjs's proof
 *   public.json     snarkjs's public signals, in CIRCUIT.md §7 order
 *   transfer.json   the same proof and signals in the contract's byte layout,
 *                   plus the transfer they are bound to
 *
 * Nothing secret is written: the record secret and the record digest are
 * private inputs, and no output contains them.
 *
 * --expiry-ledger defaults to the current testnet ledger plus --window
 * (default 360, about half an hour; at most 720).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { server } from "../src/lib/contract";
import type { JsonValue } from "../src/lib/canonical";
import { fatal, log } from "./lib/cli";
import { MAX_PROOF_WINDOW } from "./lib/zk";
import { proveTransfer } from "./lib/zk-prove";

async function main() {
  const { values: a } = parseArgs({
    options: {
      record: { type: "string" },
      secret: { type: "string" },
      right: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      sale: { type: "boolean", default: false },
      "next-secret-hash": { type: "string" },
      "rental-until": { type: "string" },
      "expiry-ledger": { type: "string" },
      window: { type: "string" },
      out: { type: "string", default: "proofs" },
    },
  });
  for (const k of ["record", "secret", "right", "from", "to"] as const) {
    if (!a[k]) throw new Error(`--${k} is required`);
  }
  if (a.sale === Boolean(a["rental-until"])) throw new Error("give exactly one of --sale or --rental-until");
  if (a.sale && !a["next-secret-hash"]) throw new Error("a sale needs --next-secret-hash (h' from the buyer)");
  if (!a.sale && a["next-secret-hash"]) throw new Error("a rental takes no --next-secret-hash");

  let expiryLedger: bigint;
  if (a["expiry-ledger"]) {
    expiryLedger = BigInt(a["expiry-ledger"]);
  } else {
    const window = Number(a.window ?? 360);
    if (!Number.isInteger(window) || window < 1 || window > MAX_PROOF_WINDOW) {
      throw new Error(`--window must be 1..${MAX_PROOF_WINDOW} ledgers`);
    }
    const { sequence } = await server.getLatestLedger();
    expiryLedger = BigInt(sequence + window);
    log.info(`current ledger ${sequence}; proof valid through ledger ${expiryLedger}`);
  }

  const record = JSON.parse(readFileSync(resolve(a.record!), "utf8")) as JsonValue;
  const secret = BigInt((JSON.parse(readFileSync(resolve(a.secret!), "utf8")) as { secret: string }).secret);

  const ctx = {
    rightId: BigInt(a.right!),
    from: a.from!,
    to: a.to!,
    expiresAt: a.sale ? null : BigInt(a["rental-until"]!),
    expiryLedger,
    nextSecretHash: a.sale ? BigInt(a["next-secret-hash"]!) : 0n,
  };
  log.step(`Proving ${a.sale ? "a sale" : "a rental"} of right #${ctx.rightId}`);
  const { file, proof, publicSignals, seconds } = await proveTransfer(record, secret, ctx);
  log.ok(`proved in ${seconds.toFixed(1)} s`);
  log.ok("snarkjs groth16 verify: OK");

  const out = resolve(a.out!);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "proof.json"), JSON.stringify(proof, null, 2) + "\n");
  writeFileSync(join(out, "public.json"), JSON.stringify(publicSignals, null, 2) + "\n");
  writeFileSync(join(out, "transfer.json"), JSON.stringify(file, null, 2) + "\n");
  log.ok(`wrote ${out}/proof.json, public.json, transfer.json`);
  // ffjavascript's curve worker threads outlive the proof; nothing else is pending.
  process.exit(0);
}

main().catch(fatal);
