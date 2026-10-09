/**
 * The ownership proof's inputs, computed exactly as docs/CIRCUIT.md defines them.
 *
 * Shared by the CLI prover, the circuit tests and the contract fixtures, so the
 * three cannot drift apart: there is one place where a record becomes `d`, an
 * account becomes two field elements, and a transfer becomes a nullifier.
 */

import { randomBytes } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { commit, type JsonValue } from "../../src/lib/canonical";
import { hash, R } from "../../circuits/gpl/poseidon";

export { R };

/** Longest a proof may stay valid, in ledgers (CIRCUIT.md §6). Mirrored in the contract. */
export const MAX_PROOF_WINDOW = 720;

/** `split(b)`: 32 bytes → [big-endian int of b[0..16], big-endian int of b[16..32]]. */
export function split32(bytes: Uint8Array): [bigint, bigint] {
  if (bytes.length !== 32) throw new Error(`split32: expected 32 bytes, got ${bytes.length}`);
  const be = (b: Uint8Array) => BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));
  return [be(bytes.subarray(0, 16)), be(bytes.subarray(16, 32))];
}

/** A `G…` account's 32-byte Ed25519 key, split. Contract (`C…`) addresses are refused. */
export function splitAccount(account: string): [bigint, bigint] {
  if (!StrKey.isValidEd25519PublicKey(account)) {
    throw new Error(`${account} is not a G… account; only accounts can hold a right under Phase 2`);
  }
  return split32(StrKey.decodeEd25519PublicKey(account));
}

/** `d = SHA-256(RFC 8785 canonical JSON of the record)`, split — Phase 1's commitment, unchanged. */
export async function splitRecordDigest(record: JsonValue): Promise<{ hex: string; hi: bigint; lo: bigint }> {
  const hex = await commit(record);
  const [hi, lo] = split32(Buffer.from(hex, "hex"));
  return { hex, hi, lo };
}

/** A uniformly random field element: 255 random bits, redrawn until below r. */
export function randomSecret(): bigint {
  for (;;) {
    const b = randomBytes(32);
    b[0]! &= 0x7f;
    const s = BigInt("0x" + b.toString("hex"));
    if (s < R && s !== 0n) return s;
  }
}

/** `h = Poseidon_1(s)`. What a holder may disclose; never `s`. */
export function secretHash(s: bigint): Promise<bigint> {
  return hash([s]);
}

/** `C = Poseidon_5(d_hi, d_lo, a_hi, a_lo, h)`. */
export function commitment(d: { hi: bigint; lo: bigint }, account: string, h: bigint): Promise<bigint> {
  const [aHi, aLo] = splitAccount(account);
  return hash([d.hi, d.lo, aHi, aLo, h]);
}

/** `mode`: 0 for a sale, the rental's end time (Unix seconds) for a rental. */
export function transferMode(expiresAt: bigint | null): bigint {
  if (expiresAt === null) return 0n;
  if (expiresAt <= 0n) throw new Error("a rental must end at a positive time");
  return expiresAt;
}

export interface TransferContext {
  rightId: bigint;
  from: string;
  to: string;
  /** null for a sale; the rental's end time otherwise. */
  expiresAt: bigint | null;
  /** The last ledger at which the proof is accepted. */
  expiryLedger: bigint;
  /** h' = Poseidon(s'), from the buyer. Must be 0 on a rental. */
  nextSecretHash: bigint;
}

/** The public signals, in the order the verifier receives them (CIRCUIT.md §7). */
export const PUBLIC_SIGNALS = [
  "commitment",
  "nullifier",
  "right_id",
  "from_hi",
  "from_lo",
  "to_hi",
  "to_lo",
  "mode",
  "expiry_ledger",
  "next_secret_hash",
  "next_commitment",
] as const;

export type CircuitInput = Record<(typeof PUBLIC_SIGNALS)[number] | "d_hi" | "d_lo" | "secret", string>;

/**
 * Everything the circuit needs for one transfer, computed honestly from the
 * holder's record digest and secret. Tests derive dishonest inputs from this.
 */
export async function circuitInput(
  d: { hi: bigint; lo: bigint },
  secret: bigint,
  ctx: TransferContext,
): Promise<{ input: CircuitInput; publicSignals: bigint[] }> {
  const sale = ctx.expiresAt === null;
  if (!sale && ctx.nextSecretHash !== 0n) throw new Error("a rental carries no next secret hash");
  if (sale && ctx.nextSecretHash === 0n) throw new Error("a sale needs the buyer's next secret hash");
  for (const [name, v] of [
    ["right_id", ctx.rightId],
    ["expiry_ledger", ctx.expiryLedger],
    ["next_secret_hash", ctx.nextSecretHash],
  ] as const) {
    if (v < 0n || v >= R) throw new Error(`${name} is not a canonical field element`);
  }

  const [fromHi, fromLo] = splitAccount(ctx.from);
  const [toHi, toLo] = splitAccount(ctx.to);
  const mode = transferMode(ctx.expiresAt);
  const h = await secretHash(secret);

  const values = {
    commitment: await hash([d.hi, d.lo, fromHi, fromLo, h]),
    nullifier: await hash([secret, ctx.rightId, toHi, toLo, mode, ctx.expiryLedger]),
    right_id: ctx.rightId,
    from_hi: fromHi,
    from_lo: fromLo,
    to_hi: toHi,
    to_lo: toLo,
    mode,
    expiry_ledger: ctx.expiryLedger,
    next_secret_hash: ctx.nextSecretHash,
    next_commitment: await hash([d.hi, d.lo, toHi, toLo, ctx.nextSecretHash]),
  };
  const publicSignals = PUBLIC_SIGNALS.map((k) => values[k]);
  const input = Object.fromEntries([
    ...PUBLIC_SIGNALS.map((k) => [k, values[k].toString()]),
    ["d_hi", d.hi.toString()],
    ["d_lo", d.lo.toString()],
    ["secret", secret.toString()],
  ]) as CircuitInput;
  return { input, publicSignals };
}
