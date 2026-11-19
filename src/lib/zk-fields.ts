/**
 * The proof's public inputs as field elements, for the browser.
 *
 * Browser-safe (no Node built-ins, no Buffer, no Stellar SDK) and licensed
 * Apache-2.0 like the rest of the app. It holds no cryptography of its own:
 * it decodes addresses and lays out numbers exactly as `scripts/lib/zk.ts`
 * (the CLI prover) and `auth.rs` (the contract) do. `circuits/test/
 * zk-fields.test.ts` checks it against `scripts/lib/zk.ts` and the
 * Stellar SDK on every fixture.
 *
 * Used by the GPL prover worker (prover-worker/) and by app code that needs
 * to show or compare what a proof will bind.
 */

/** BLS12-381 scalar field modulus. */
export const R = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

/** The kind tag a `C…` contract address carries in `hi` (docs/PHASE3_SPEC.md §1). */
export const TAG_CONTRACT = 1n << 128n;

/** Longest a proof may stay valid, in ledgers (CIRCUIT.md §6). Mirrored in the contract. */
export const MAX_PROOF_WINDOW = 720;

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

// --- strkey -----------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** SEP-23 version bytes: `G…` is an Ed25519 public key, `C…` a contract. */
const VERSION_ACCOUNT = 6 << 3;
const VERSION_CONTRACT = 2 << 3;

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** A 56-character `G…` or `C…` strkey → its kind and 32-byte payload. Checks the checksum. */
export function decodeAddress(address: string): { kind: "account" | "contract"; bytes: Uint8Array } {
  if (!/^[GC][A-Z2-7]{55}$/.test(address)) throw new Error(`${address} is neither a G… account nor a C… contract`);
  const out = new Uint8Array(35);
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of address) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (n < 35) out[n++] = (value >> bits) & 0xff;
    }
  }
  // 56 characters carry 280 bits = 35 bytes exactly; any leftover bits must be zero.
  if (n !== 35 || (value & ((1 << bits) - 1)) !== 0) throw new Error(`${address} is not a valid strkey`);
  const version = out[0]!;
  const payload = out.subarray(1, 33);
  const checksum = out[33]! | (out[34]! << 8);
  if (crc16xmodem(out.subarray(0, 33)) !== checksum) throw new Error(`${address} has a bad checksum`);
  if (version === VERSION_ACCOUNT) return { kind: "account", bytes: payload.slice() };
  if (version === VERSION_CONTRACT) return { kind: "contract", bytes: payload.slice() };
  throw new Error(`${address} is neither a G… account nor a C… contract`);
}

// --- field elements -----------------------------------------------------------

function beInt(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

/** `split(b)`: 32 bytes → [big-endian int of b[0..16], big-endian int of b[16..32]]. */
export function split32(bytes: Uint8Array): [bigint, bigint] {
  if (bytes.length !== 32) throw new Error(`split32: expected 32 bytes, got ${bytes.length}`);
  return [beInt(bytes.subarray(0, 16)), beInt(bytes.subarray(16, 32))];
}

/**
 * `split(address)` with the kind tag (CIRCUIT.md §5, PHASE3_SPEC.md §1):
 * a `G…` account as Phase 2; a `C…` contract as (2^128 + hi, lo).
 */
export function splitAddress(address: string): [bigint, bigint] {
  const { kind, bytes } = decodeAddress(address);
  const [hi, lo] = split32(bytes);
  return kind === "contract" ? [TAG_CONTRACT + hi, lo] : [hi, lo];
}

/** A hex SHA-256 digest `d` → (d_hi, d_lo). */
export function splitDigest(hex: string): { hex: string; hi: bigint; lo: bigint } {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("expected a 64-character lowercase hex digest");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const [hi, lo] = split32(bytes);
  return { hex, hi, lo };
}

/** `mode`: 0 for a sale, the rental's end time (Unix seconds) for a rental. */
export function transferMode(expiresAt: bigint | null): bigint {
  if (expiresAt === null) return 0n;
  if (expiresAt <= 0n) throw new Error("a rental must end at a positive time");
  return expiresAt;
}

/** A field element as 32 bytes of hex, refusing anything not canonical. */
export function fieldHex(x: bigint): string {
  if (x < 0n || x >= R) throw new Error("not a canonical field element");
  return x.toString(16).padStart(64, "0");
}

/** A fresh record secret: 255 random bits, redrawn until in [1, r). */
export function randomSecret(): bigint {
  for (;;) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    b[0]! &= 0x7f;
    const s = beInt(b);
    if (s !== 0n && s < R) return s;
  }
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
