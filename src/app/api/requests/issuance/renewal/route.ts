/**
 * The owner changes a waiting renewal (2026-11-27).
 *
 *   POST /api/requests/issuance/renewal { id, price }       → { request }
 *   POST /api/requests/issuance/renewal { id, cancel: true } → { request }
 *
 * Only the account that filed it, and only while it waits (open, not yet
 * issued). `price` is the asking price to list the renewed week at, typed as
 * USDC and held to the listing cap; it binds nobody and is off chain. A
 * cancelled renewal is not refiled automatically; the owner can renew again.
 */

import { RequestStoreUnavailable, changeRenewal } from "@/lib/requests";
import { renewalPriceFrom } from "@/lib/renewal-price";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });

  let body: { id?: unknown; price?: unknown; cancel?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string" || body.id === "") return Response.json({ error: "id is required" }, { status: 400 });

  let change: { price: string } | { cancel: true };
  if (body.cancel === true) {
    change = { cancel: true };
  } else {
    try {
      const price = await renewalPriceFrom(body.price);
      if (!price) return Response.json({ error: "price is required (or cancel: true)" }, { status: 400 });
      change = { price };
    } catch (error) {
      return Response.json({ error: `price: ${(error as Error).message}` }, { status: 400 });
    }
  }

  try {
    const changed = await changeRenewal(body.id, caller, change);
    if (!changed) return Response.json({ error: "no renewal of yours waiting with that id" }, { status: 404 });
    return Response.json({ request: changed });
  } catch (error) {
    if (error instanceof RequestStoreUnavailable) {
      return Response.json({ error: error.message, read_only: true }, { status: 503 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "could not change the renewal" }, { status: 500 });
  }
}
