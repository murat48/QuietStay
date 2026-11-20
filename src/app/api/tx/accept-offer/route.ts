/**
 * Build `accept_sale` or `accept_rental` for the holder to sign.
 *
 *   POST /api/tx/accept-offer  { by, offerId, price, proof: {a,b,c}, signals: [11 decimals] }
 *     → { xdr, kind: "sale" | "rental" }
 *
 * The holder's browser proved ownership against the on-chain offer: its buyer
 * as recipient, and for a sale the buyer's h' from the offer, for a rental the
 * offer's end time (docs/PHASE3_SPEC.md §4–§5). Only the proof and its public
 * signals arrive here; the record and secret never leave the browser.
 *
 * `price` is what the holder was shown; the contract refuses unless it equals
 * the offer's, so a holder accepts exactly the amount they saw. Simulation
 * runs the whole acceptance, proof, allowance and balance included, so a
 * refusal comes back with the contract's reason before anything is signed.
 */

import { authenticatedAccount } from "@/lib/sep10";
import { ContractCallError, buildAcceptOfferTx, readOffer } from "@/lib/contract";

export const dynamic = "force-dynamic";

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n * 2}}$`);

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated — sign in first" }, { status: 401 });

  let body: { by?: string; offerId?: number; price?: string; proof?: { a?: unknown; b?: unknown; c?: unknown }; signals?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const { by, offerId, price, proof, signals } = body;
  if (!by || by !== caller) {
    return Response.json({ error: "you can only accept an offer as your own account", authenticated_as: caller }, { status: 403 });
  }
  if (typeof offerId !== "number" || !Number.isSafeInteger(offerId) || offerId < 1) {
    return Response.json({ error: "offerId must be a positive integer" }, { status: 400 });
  }
  if (typeof price !== "string" || !/^\d{1,30}$/.test(price)) {
    return Response.json({ error: "price must be a decimal string of USDC's smallest units" }, { status: 400 });
  }
  if (
    !proof ||
    ![proof.a, proof.c].every((p) => typeof p === "string" && HEX(96).test(p)) ||
    !(typeof proof.b === "string" && HEX(192).test(proof.b))
  ) {
    return Response.json({ error: "the proof's points are not in the contract's byte layout" }, { status: 400 });
  }
  if (!Array.isArray(signals) || signals.length !== 11 || !signals.every((x) => typeof x === "string" && /^\d{1,78}$/.test(x))) {
    return Response.json({ error: "expected the eleven public signals as decimal strings" }, { status: 400 });
  }

  try {
    const offer = await readOffer(offerId);
    if (!offer) return Response.json({ error: "that offer no longer exists: accepted, cancelled, or never made" }, { status: 404 });
    const tx = await buildAcceptOfferTx({
      kind: offer.terms.kind,
      by,
      offerId,
      price: BigInt(price),
      proof: { a: proof.a as string, b: proof.b as string, c: proof.c as string },
      signals: signals as string[],
    });
    return Response.json({ xdr: tx.toXDR(), kind: offer.terms.kind });
  } catch (error) {
    if (error instanceof ContractCallError) return Response.json({ error: error.message }, { status: 400 });
    console.error("[accept-offer]", error);
    return Response.json({ error: error instanceof Error ? error.message : "could not build the acceptance" }, { status: 500 });
  }
}
