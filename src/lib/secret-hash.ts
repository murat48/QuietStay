/**
 * A secret hash as a canonical BLS12-381 scalar — the owner's `h` at issuance,
 * the buyer's `h'` on a sale.
 *
 * No imports and no Poseidon: this only reads a number and checks its range, so
 * the browser can use it to check an `h` pasted or arriving in a link before
 * anything is sent. The server applies the same function again; this one is not
 * the boundary.
 */

/** The BLS12-381 scalar field modulus r. */
const R = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

/** Throws with a message fit for a 400. */
export function parseSecretHash(value: unknown): bigint {
  // Decimal, as `npm run zk:secret` prints it, or hex — `0x`-prefixed, or bare
  // when it has a letter in it. A bare string of digits is always decimal.
  const text = typeof value === "string" ? value.trim() : "";
  let h: bigint;
  if (/^\d{1,78}$/.test(text)) h = BigInt(text);
  else if (/^0x[0-9a-fA-F]{1,64}$/.test(text)) h = BigInt(text);
  else if (/^[0-9a-fA-F]{1,64}$/.test(text)) h = BigInt(`0x${text}`);
  else {
    throw new Error("the secret hash must be the number `npm run zk:secret` printed, in decimal or hex");
  }
  if (h === 0n || h >= R) {
    throw new Error("the secret hash is not a BLS12-381 scalar: it must be above 0 and below the field modulus r");
  }
  return h;
}

/**
 * The link `npm run zk:secret` prints: the Issue screen with `h` filled in for
 * asking the issuer. Only `h` travels in it — never the secret.
 */
export function issuanceRequestLink(appUrl: string, h: bigint): string {
  const url = new URL("/issue", appUrl);
  url.searchParams.set("h", h.toString());
  return url.toString();
}

/**
 * What the Request issuance box starts with when the screen is opened from that
 * link: the `h` parameter as given, and whether it is a valid `h` — checked by
 * the same rule the server applies. Nothing is sent until the owner asks.
 */
export function issuanceRequestPrefill(search: string): { value: string; error: string | null } {
  const value = new URLSearchParams(search).get("h") ?? "";
  if (value === "") return { value, error: null };
  try {
    parseSecretHash(value);
    return { value, error: null };
  } catch (error) {
    return { value, error: (error as Error).message };
  }
}
