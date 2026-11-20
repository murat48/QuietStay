/**
 * USDC amounts, exactly (docs/PHASE3_PROMPT.md: no floating point anywhere in
 * amount handling).
 *
 * An amount is a `bigint` count of the token's smallest unit, 10^-7 USDC, the
 * same i128 the contract takes. Text goes in and out through these two
 * functions only; no amount is ever a JavaScript `number`.
 */

import { USDC_DECIMALS } from "./config";

const SCALE = 10n ** BigInt(USDC_DECIMALS);

/**
 * Parse what a person typed, such as `"1"`, `"0.5"` or `"12.3456789"`, into
 * smallest units. Refuses anything that is not a plain positive decimal with
 * at most seven places, rather than rounding it.
 */
export function parseUsdc(text: string): bigint {
  const t = text.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) throw new Error(`"${text}" is not an amount: use digits and at most one decimal point, like 1.50`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`USDC has ${USDC_DECIMALS} decimal places; "${text}" has ${frac.length}`);
  }
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** Smallest units as text, with trailing zeros dropped: 15000000n → "1.5". */
export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
