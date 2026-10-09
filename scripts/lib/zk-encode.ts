/**
 * snarkjs JSON → the byte layouts Soroban's BLS12-381 types take.
 *
 * From soroban-sdk 27.0.6's own documentation (src/crypto/bls12_381.rs):
 *
 *   Bls12381G1Affine  96 bytes   be(X) ‖ be(Y)                         uncompressed, flags clear
 *   Bls12381G2Affine 192 bytes   be(X_c1) ‖ be(X_c0) ‖ be(Y_c1) ‖ be(Y_c0)
 *   Bls12381Fr        U256       big-endian, below r
 *
 * snarkjs writes an Fp2 element as [c0, c1], so every G2 coordinate pair is
 * swapped here. That is the same layout soroban-examples' groth16_verifier gets
 * from arkworks' `serialize_uncompressed` in its circom fixture test.
 */

import type { Groth16Proof } from "snarkjs";
import { R } from "./poseidon";

/** BLS12-381 base field modulus. */
const P =
  0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;

function be(x: bigint, bytes: number): string {
  const hex = x.toString(16);
  if (hex.length > bytes * 2) throw new Error("value does not fit");
  return hex.padStart(bytes * 2, "0");
}

function fp(s: string): string {
  const x = BigInt(s);
  if (x < 0n || x >= P) throw new Error("coordinate is not a canonical Fp element");
  return be(x, 48);
}

/** snarkjs affine G1 `[x, y, "1"]` → 96 bytes hex. */
export function g1(point: string[]): string {
  if (point[2] !== "1") throw new Error("expected an affine point (z = 1); the point at infinity is not used here");
  return fp(point[0]!) + fp(point[1]!);
}

/** snarkjs affine G2 `[[x_c0, x_c1], [y_c0, y_c1], ["1", "0"]]` → 192 bytes hex. */
export function g2(point: string[][]): string {
  if (point[2]?.[0] !== "1" || point[2]?.[1] !== "0") throw new Error("expected an affine G2 point");
  const [x, y] = [point[0]!, point[1]!];
  return fp(x[1]!) + fp(x[0]!) + fp(y[1]!) + fp(y[0]!);
}

/** A public signal → 32 bytes hex, refusing anything that is not a canonical scalar. */
export function fr(s: string | bigint): string {
  const x = BigInt(s);
  if (x < 0n || x >= R) throw new Error("public signal is not a canonical field element");
  return be(x, 32);
}

export interface EncodedProof {
  a: string;
  b: string;
  c: string;
}

export interface EncodedVerificationKey {
  alpha: string;
  beta: string;
  gamma: string;
  delta: string;
  ic: string[];
}

export function encodeProof(proof: Groth16Proof): EncodedProof {
  if (proof.protocol !== "groth16" || proof.curve !== "bls12381") {
    throw new Error(`expected a groth16 proof over bls12381, got ${proof.protocol} over ${proof.curve}`);
  }
  return { a: g1(proof.pi_a), b: g2(proof.pi_b), c: g1(proof.pi_c) };
}

interface VkJson {
  protocol: string;
  curve: string;
  nPublic: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
}

export function encodeVerificationKey(vk: VkJson): EncodedVerificationKey {
  if (vk.protocol !== "groth16" || vk.curve !== "bls12381") throw new Error("not a groth16/bls12381 key");
  if (vk.IC.length !== vk.nPublic + 1) throw new Error("IC length does not match nPublic + 1");
  return {
    alpha: g1(vk.vk_alpha_1),
    beta: g2(vk.vk_beta_2),
    gamma: g2(vk.vk_gamma_2),
    delta: g2(vk.vk_delta_2),
    ic: vk.IC.map(g1),
  };
}
