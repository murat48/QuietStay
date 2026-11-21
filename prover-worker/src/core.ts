// SPDX-License-Identifier: GPL-3.0
// Part of the QuietStay in-browser prover (prover-worker/). See ../LICENSE and ../README.md.

/**
 * What the prover worker computes, with no I/O: the record digest, the
 * commitment, the secret hash, and a Groth16 proof of one transfer, checked
 * off chain before it is returned.
 *
 * It mirrors `scripts/lib/zk.ts` and `scripts/lib/zk-prove.ts` (the CLI
 * prover) input for input, and `circuits/test/prover-core.test.ts` checks
 * that both give identical public signals. Poseidon, snarkjs and the keys are
 * passed in, so the same code runs in Node (the test) and in the worker.
 */

import type { Poseidon } from "../../circuits/gpl/poseidon-core";
import { encodeProof, fr, type EncodedProof } from "../../scripts/lib/zk-encode";
import { commit, type JsonValue } from "../../src/lib/canonical";
import {
  PUBLIC_SIGNALS,
  R,
  splitAddress,
  splitDigest,
  transferMode,
  type TransferContext,
} from "../../src/lib/zk-fields";

/** The slice of snarkjs's `groth16` this needs. */
export interface Groth16 {
  fullProve(
    input: Record<string, string>,
    wasm: Uint8Array,
    zkey: Uint8Array,
  ): Promise<{ proof: Parameters<typeof encodeProof>[0]; publicSignals: string[] }>;
  verify(vk: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
}

export interface Keys {
  wasm: Uint8Array;
  zkey: Uint8Array;
}

export interface ProofResult {
  /** The proof in the contract's byte layout (hex). */
  proof: EncodedProof;
  /** Public signals as decimal strings, in CIRCUIT.md §7 order. */
  signals: string[];
  /** The same signals as 32-byte hex. */
  signalsHex: string[];
  /** Time spent in `groth16.fullProve`, in milliseconds. */
  proveMs: number;
}

export function makeProver(poseidon: Poseidon, groth16: Groth16, keys: () => Promise<Keys>, vk: unknown) {
  const H = (inputs: bigint[]) => poseidon(inputs)[0]!;

  async function digest(record: JsonValue) {
    return splitDigest(await commit(record));
  }

  return {
    /** `h = Poseidon_1(s)`. */
    secretHash(secret: bigint): bigint {
      if (secret <= 0n || secret >= R) throw new Error("the secret is not a field element in [1, r)");
      return H([secret]);
    },

    /** `d` and `C = Poseidon_5(d_hi, d_lo, a_hi, a_lo, h)` for a holder. */
    async commitment(record: JsonValue, holder: string, h: bigint): Promise<{ d: string; commitment: bigint }> {
      const d = await digest(record);
      const [aHi, aLo] = splitAddress(holder);
      return { d: d.hex, commitment: H([d.hi, d.lo, aHi, aLo, h]) };
    },

    /**
     * Prove one transfer, then verify the proof against the committed key and
     * compare snarkjs's signals with the ones computed here. Throws on either
     * mismatch, so a proof that leaves the worker is one the contract accepts
     * on the pairing check.
     */
    async prove(record: JsonValue, secret: bigint, ctx: TransferContext): Promise<ProofResult> {
      const sale = ctx.expiresAt === null;
      if (!sale && ctx.nextSecretHash !== 0n) throw new Error("a rental carries no next secret hash");
      if (sale && ctx.nextSecretHash === 0n) throw new Error("a sale needs the buyer's next secret hash");
      for (const v of [ctx.rightId, ctx.expiryLedger, ctx.nextSecretHash]) {
        if (v < 0n || v >= R) throw new Error("a transfer value is not a canonical field element");
      }

      const d = await digest(record);
      const [fromHi, fromLo] = splitAddress(ctx.from);
      const [toHi, toLo] = splitAddress(ctx.to);
      const mode = transferMode(ctx.expiresAt, ctx.swapFor);
      const h = H([secret]);

      const values: Record<(typeof PUBLIC_SIGNALS)[number], bigint> = {
        commitment: H([d.hi, d.lo, fromHi, fromLo, h]),
        nullifier: H([secret, ctx.rightId, toHi, toLo, mode, ctx.expiryLedger]),
        right_id: ctx.rightId,
        from_hi: fromHi,
        from_lo: fromLo,
        to_hi: toHi,
        to_lo: toLo,
        mode,
        expiry_ledger: ctx.expiryLedger,
        next_secret_hash: ctx.nextSecretHash,
        next_commitment: H([d.hi, d.lo, toHi, toLo, ctx.nextSecretHash]),
      };
      const expected = PUBLIC_SIGNALS.map((k) => values[k]);
      const input: Record<string, string> = Object.fromEntries(PUBLIC_SIGNALS.map((k) => [k, values[k].toString()]));
      input.d_hi = d.hi.toString();
      input.d_lo = d.lo.toString();
      input.secret = secret.toString();

      const { wasm, zkey } = await keys();
      const t0 = performance.now();
      const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkey);
      const proveMs = performance.now() - t0;

      if (publicSignals.length !== expected.length || publicSignals.some((s, i) => BigInt(s) !== expected[i])) {
        throw new Error("the prover's public signals differ from the ones computed for this transfer");
      }
      if (!(await groth16.verify(vk, publicSignals, proof))) throw new Error("the proof does not verify");

      return {
        proof: encodeProof(proof as never),
        signals: publicSignals,
        signalsHex: publicSignals.map((s) => fr(s)),
        proveMs,
      };
    },
  };
}

export type Prover = ReturnType<typeof makeProver>;
