// SPDX-License-Identifier: GPL-3.0
// Derived from circomlibjs 0.1.7 src/poseidon_reference.js (iden3, GPL-3.0).

/**
 * Poseidon over the BLS12-381 scalar field, for the command-line tools and the
 * issuing server route (src/app/api/issue/route.ts).
 *
 * This is circomlibjs's `src/poseidon_reference.js` with two changes and no
 * others: the field is BLS12-381's scalar field instead of bn128's, and the
 * round constants and MDS matrices are the ones in `circuits/poseidon/bls12381.json`,
 * produced by the Poseidon authors' reference tool. The permutation loop is
 * line-for-line the upstream one.
 *
 * Poseidon runs in the circuit, here — called by the command-line tools and by
 * the server route that issues a week — and, since Phase 3, in the browser's
 * prover worker only (prover-worker/, decision D2), from the same core
 * (./poseidon-core.ts). The contract never computes it: commitments and
 * nullifiers reach it as public signals and are only compared and stored. The
 * app's own bundle never contains it (`npm run zk:check-bundle`).
 *
 * Checked by `npm run zk:check-poseidon` against the authors' published test
 * vectors for this field, and by the circuit tests against the circuit itself.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPoseidon, type Poseidon, type WidthConstants } from "./poseidon-core";

export { R, buildPoseidon, type Poseidon, type WidthConstants } from "./poseidon-core";

let cached: Promise<Poseidon> | null = null;

/** The permutation for the widths the circuit uses, from `circuits/poseidon/bls12381.json`. */
export function circuitPoseidon(): Promise<Poseidon> {
  cached ??= buildPoseidon(
    JSON.parse(readFileSync(resolve("circuits/poseidon/bls12381.json"), "utf8")) as Record<
      number,
      WidthConstants
    >,
  );
  return cached;
}

/** circomlib's `Poseidon(n)`: state [0, ...inputs], first element of the output. */
export async function hash(inputs: bigint[]): Promise<bigint> {
  const p = await circuitPoseidon();
  return p(inputs)[0]!;
}
