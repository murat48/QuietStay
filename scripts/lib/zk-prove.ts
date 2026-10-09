/**
 * Make one proof and the transfer.json the web app takes — shared by the CLI
 * prover and the end-to-end test, so the test exercises exactly what a holder
 * would upload.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { groth16, type Groth16Proof } from "snarkjs";
import type { JsonValue } from "../../src/lib/canonical";
import { circuitInput, PUBLIC_SIGNALS, splitRecordDigest, type TransferContext } from "./zk";
import { encodeProof, fr } from "./zk-encode";

const KEYS = resolve("circuits/keys");

export interface TransferFile {
  transfer: {
    right_id: string;
    from: string;
    to: string;
    expires_at: string | null;
    expiry_ledger: string;
    next_secret_hash: string;
  };
  proof: { a: string; b: string; c: string };
  public_signals: Record<string, string>;
  public_signals_hex: string[];
}

/**
 * Prove a transfer and verify the proof off-chain before returning it. Throws
 * if snarkjs emits signals other than the ones computed for this transfer, or
 * the proof does not verify against the committed key.
 */
export async function proveTransfer(
  record: JsonValue,
  secret: bigint,
  ctx: TransferContext,
): Promise<{ file: TransferFile; proof: Groth16Proof; publicSignals: string[]; seconds: number }> {
  const d = await splitRecordDigest(record);
  const { input, publicSignals: expected } = await circuitInput(d, secret, ctx);

  const t0 = Date.now();
  const { proof, publicSignals } = await groth16.fullProve(
    input,
    join(KEYS, "transfer.wasm"),
    join(KEYS, "transfer.zkey"),
  );
  const seconds = (Date.now() - t0) / 1000;

  if (publicSignals.length !== expected.length || publicSignals.some((s, i) => BigInt(s) !== expected[i])) {
    throw new Error("snarkjs's public signals differ from the ones computed for this transfer");
  }
  const vk = JSON.parse(readFileSync(join(KEYS, "verification_key.json"), "utf8"));
  if (!(await groth16.verify(vk, publicSignals, proof))) throw new Error("the proof does not verify off-chain");

  const file: TransferFile = {
    transfer: {
      right_id: ctx.rightId.toString(),
      from: ctx.from,
      to: ctx.to,
      expires_at: ctx.expiresAt?.toString() ?? null,
      expiry_ledger: ctx.expiryLedger.toString(),
      next_secret_hash: ctx.nextSecretHash.toString(),
    },
    proof: encodeProof(proof),
    public_signals: Object.fromEntries(PUBLIC_SIGNALS.map((k, i) => [k, publicSignals[i]!])),
    public_signals_hex: publicSignals.map((s) => fr(s)),
  };
  return { file, proof, publicSignals, seconds };
}
