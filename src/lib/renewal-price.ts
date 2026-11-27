import { askingPriceProblem } from "./asking-price";
import { readMaxPayment } from "./contract";
import { parseUsdc } from "./usdc";

/**
 * A renewal's asking price (2026-11-27), typed as USDC ("1.5"), in base units;
 * `undefined` when none was given. Held to the same cap as a listing's price.
 */
export async function renewalPriceFrom(value: unknown): Promise<string | undefined> {
  if (value === undefined || value === null || value === "") return undefined;
  const price = parseUsdc(String(value));
  const max = await readMaxPayment().catch(() => null);
  const problem = askingPriceProblem(price, max === null ? null : BigInt(max));
  if (problem) throw new Error(problem);
  return price.toString();
}
