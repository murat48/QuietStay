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
 * Poseidon runs in the circuit, and here — called by the command-line tools and
 * by the server route that issues a week. The contract never computes it —
 * commitments and nullifiers reach it as public signals and are only compared and
 * stored — and the browser never computes it (`npm run zk:check-bundle`).
 *
 * Checked by `npm run zk:check-poseidon` against the authors' published test
 * vectors for this field, and by the circuit tests against the circuit itself.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCurveFromName } from "ffjavascript";

/** BLS12-381 scalar field modulus. */
export const R = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

const N_ROUNDS_F = 8;
// circomlib's table, unchanged. For a 255-bit field calc_round_numbers.py gives
// the same values at every width used here — see docs/CIRCUIT.md.
const N_ROUNDS_P = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];

type Fe = unknown;
interface Field {
  e(x: bigint | string | number): Fe;
  add(a: Fe, b: Fe): Fe;
  mul(a: Fe, b: Fe): Fe;
  square(a: Fe): Fe;
  toObject(a: Fe): bigint;
  zero: Fe;
}

/** Round constants and MDS matrix for one width, as hex or decimal strings. */
export interface WidthConstants {
  C: string[];
  M: string[][];
}

export type Poseidon = (inputs: bigint[], initState?: bigint, nOut?: number) => bigint[];

/** Build a Poseidon permutation over BLS12-381 from constants keyed by width t. */
export async function buildPoseidon(constants: Record<number, WidthConstants>): Promise<Poseidon> {
  const curve = await getCurveFromName("bls12381", true);
  const F = curve.Fr as Field;
  const CM: Record<number, { C: Fe[]; M: Fe[][] }> = {};
  for (const [t, { C, M }] of Object.entries(constants)) {
    CM[Number(t)] = { C: C.map((x) => F.e(x)), M: M.map((row) => row.map((x) => F.e(x))) };
  }

  const pow5 = (a: Fe) => F.mul(a, F.square(F.square(a)));

  return function poseidon(inputs, initState = 0n, nOut = 1) {
    if (inputs.length === 0 || inputs.length > N_ROUNDS_P.length) throw new Error("Poseidon: bad arity");
    for (const x of [...inputs, initState]) {
      if (x < 0n || x >= R) throw new Error("Poseidon: input is not a canonical field element");
    }
    const t = inputs.length + 1;
    const widths = CM[t];
    if (!widths) throw new Error(`Poseidon: no constants for width ${t}`);
    const { C, M } = widths;
    const nRoundsF = N_ROUNDS_F;
    const nRoundsP = N_ROUNDS_P[t - 2]!;

    let state: Fe[] = [F.e(initState), ...inputs.map((a) => F.e(a))];
    for (let r = 0; r < nRoundsF + nRoundsP; r++) {
      state = state.map((a, i) => F.add(a, C[r * t + i]));

      if (r < nRoundsF / 2 || r >= nRoundsF / 2 + nRoundsP) {
        state = state.map((a) => pow5(a));
      } else {
        state[0] = pow5(state[0]);
      }

      state = state.map((_, i) =>
        state.reduce((acc: Fe, a, j) => F.add(acc, F.mul(M[i]![j], a)), F.zero),
      );
    }
    return state.slice(0, nOut).map((x) => F.toObject(x));
  };
}

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
