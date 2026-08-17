/**
 * Canonical serialization and hash commitments.
 *
 * A commitment is only worth something if two parties independently compute the
 * same bytes from the same record, so the encoding is pinned to a published
 * standard rather than to whatever `JSON.stringify` happens to do:
 *
 *   **canonical bytes** = UTF-8 of RFC 8785 (JSON Canonicalization Scheme)
 *   **commitment**      = SHA-256 of those bytes
 *
 * RFC 8785 fixes the three things that otherwise drift between implementations:
 * object keys are sorted by UTF-16 code unit, numbers use the ECMAScript
 * `Number::toString` form, and strings use the shortest legal escaping. The
 * scheme is implemented by the `canonicalize` package, not here — see
 * `docs/COMMITMENT.md` for the full specification and a worked example a
 * reviewer can reproduce with `sha256sum`.
 *
 * SHA-256 comes from WebCrypto, which is the same primitive in Node and in the
 * browser, so the verify screen recomputes the hash on the counterparty's own
 * machine rather than trusting a server to do it.
 */

import canonicalizeModule from "canonicalize";

// `canonicalize` ships as CommonJS; normalize the interop shape once.
const canonicalize = (canonicalizeModule as unknown as { default?: typeof canonicalizeModule })
  .default ?? canonicalizeModule;

/** JSON values that may appear in a committed record. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * The canonical text of a JSON document, per RFC 8785.
 *
 * Note there is no trailing newline. When this is written to a file for a
 * reviewer to hash, the file must not gain one either, or `sha256sum` will
 * disagree with every other implementation.
 */
export function canonicalText(value: JsonValue): string {
  const text = canonicalize(value);
  if (typeof text !== "string") {
    throw new Error("value is not serializable as canonical JSON");
  }
  return text;
}

/** The canonical bytes: UTF-8 of {@link canonicalText}. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalText(value));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`not a hex string: ${hex}`);
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** SHA-256, via WebCrypto — identical in Node and the browser. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

/**
 * The commitment for a JSON document: SHA-256 over its canonical bytes, as
 * lowercase hex. This is the value that goes on the ledger.
 */
export async function commit(value: JsonValue): Promise<string> {
  return toHex(await sha256(canonicalBytes(value)));
}

/** Constant-time-ish comparison of two hex digests, tolerant of case and `0x`. */
export function digestsMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/^0x/, "");
  const x = normalize(a);
  const y = normalize(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) {
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return diff === 0;
}
