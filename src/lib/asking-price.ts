/**
 * A holder's asking price for a listed week.
 *
 * The contract's `Listing` carries a term and no price, and the contract stays
 * as it is. So the price a holder asks is kept off chain, beside the listing:
 * it is what the card shows and what the offer form starts from. It binds
 * nobody. The price that counts is the one in the USDC offer a buyer or renter
 * makes on chain, and the holder still decides whether to accept it.
 *
 * A price belongs to one listing: the account that listed and the moment it
 * listed (`listed_at`). Withdraw the listing, or let the week change hands, and
 * the price no longer applies, so a stale one is never shown for a new listing.
 */

import { loadAskingPriceStore, saveAskingPriceStore } from "./requests";

export interface AskingPrice {
  right_id: number;
  /** The account that listed, as on chain. */
  by: string;
  /** The listing's `listed_at`, as on chain. */
  listed_at: number;
  /** In USDC base units (7 decimals), as a decimal string. */
  price: string;
  set_at: string;
}

/** The price for a listing as it stands on chain, or `null` if none applies. */
export function priceForListing(
  all: AskingPrice[],
  rightId: number,
  listing: { by: string; listedAt: number } | null,
): AskingPrice | null {
  if (!listing) return null;
  return (
    all.find((p) => p.right_id === rightId && p.by === listing.by && p.listed_at === listing.listedAt) ?? null
  );
}

/** Why a price cannot be asked, or `null` when it can. */
export function askingPriceProblem(price: bigint, maxPayment: bigint | null): string | null {
  if (price <= 0n) return "the asking price must be more than 0 USDC";
  if (maxPayment !== null && maxPayment > 0n && price > maxPayment) {
    return "the asking price is above the most one payment can be on this contract";
  }
  return null;
}

/** Keep one price per week: the new one replaces any earlier one for the same right. */
export function withPrice(all: AskingPrice[], next: AskingPrice): AskingPrice[] {
  return [...all.filter((p) => p.right_id !== next.right_id), next];
}

export function loadAskingPrices(): Promise<AskingPrice[]> {
  return loadAskingPriceStore<AskingPrice>();
}

export function saveAskingPrices(all: AskingPrice[]): Promise<string> {
  return saveAskingPriceStore(all);
}
