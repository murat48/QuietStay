/**
 * The holder's asking price for a listed week (src/lib/asking-price.ts).
 *
 *   GET  /api/asking-price?right=<id>        → { price }  (base units, or null)
 *   POST /api/asking-price { right_id, price } → { price }  (price in USDC, e.g. "0.5")
 *
 * Only the account the listing is by may set its price, and only while the
 * listing is on chain. The price binds nobody: the one that counts is in the
 * USDC offer made on chain.
 */

import { askingPriceProblem, loadAskingPrices, priceForListing, saveAskingPrices, withPrice } from "@/lib/asking-price";
import { readListing, readMaxPayment } from "@/lib/contract";
import { RequestStoreUnavailable } from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";
import { parseUsdc } from "@/lib/usdc";

export const dynamic = "force-dynamic";

function rightIdFrom(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export async function GET(request: Request): Promise<Response> {
  const rightId = rightIdFrom(new URL(request.url).searchParams.get("right"));
  if (rightId === null) return Response.json({ error: "right must be a positive integer" }, { status: 400 });
  try {
    const [listing, all] = await Promise.all([readListing(rightId), loadAskingPrices()]);
    return Response.json({ price: priceForListing(all, rightId, listing)?.price ?? null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "could not read" }, { status: 502 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });

  let body: { right_id?: unknown; price?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const rightId = rightIdFrom(body.right_id);
  if (rightId === null) return Response.json({ error: "right_id must be a positive integer" }, { status: 400 });

  let price: bigint;
  try {
    price = parseUsdc(String(body.price ?? ""));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  try {
    const [listing, max] = await Promise.all([readListing(rightId), readMaxPayment().catch(() => null)]);
    if (!listing) return Response.json({ error: "this week is not listed" }, { status: 409 });
    if (listing.by !== caller) {
      return Response.json({ error: "only the account that listed this week can set its price" }, { status: 403 });
    }
    const problem = askingPriceProblem(price, max === null ? null : BigInt(max));
    if (problem) return Response.json({ error: problem }, { status: 400 });

    const next = {
      right_id: rightId,
      by: listing.by,
      listed_at: listing.listedAt,
      price: price.toString(),
      set_at: new Date().toISOString(),
    };
    await saveAskingPrices(withPrice(await loadAskingPrices(), next));
    return Response.json({ price: next.price });
  } catch (error) {
    if (error instanceof RequestStoreUnavailable) {
      return Response.json({ error: error.message, read_only: true }, { status: 503 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "could not save" }, { status: 500 });
  }
}
