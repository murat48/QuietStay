// SPDX-License-Identifier: GPL-3.0
// Derived from circomlibjs 0.1.7 src/poseidon_reference.js (iden3, GPL-3.0).

/**
 * The Poseidon permutation over the BLS12-381 scalar field, with no I/O: the
 * constants are passed in. Shared by the Node loader (./poseidon.ts: the
 * command-line tools and the issuing server route) and the in-browser prover
 * worker (prover-worker/, Phase 3 decision D2), so both run the same code.
 *
 * This is circomlibjs's `src/poseidon_reference.js` with two changes and no
 * others: the field is BLS12-381's scalar field instead of bn128's, and the
 * round constants and MDS matrices are the ones in `circuits/poseidon/bls12381.json`,
 * produced by the Poseidon authors' reference tool. The permutation loop is
 * line-for-line the upstream one.
 */

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
