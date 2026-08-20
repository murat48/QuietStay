/**
 * Read the registry.
 *
 *   GET /api/inventory  → every right, with its holding, any standing offer, and
 *                         the issuer's current fee attestation
 *
 * Reads are simulations against the deployed contract, so this endpoint is a
 * convenience — it holds no state of its own and could be replaced by the browser
 * talking to the RPC directly. Nothing here is authoritative; the contract is.
 *
 * **One block is not from the ledger.** `fees` comes from the issuer's
 * attestation store, because fee status is off-chain by design and changes over
 * the life of a right. It is served here so that a buyer sees, on the same card
 * as the offer, whether the week can actually change hands — a transfer of a week
 * with arrears is declined, and discovering that only at signing time would be a
 * poor way to learn it.
 *
 * What is deliberately not served with it: the amount owed. That figure lives in
 * the off-chain record, which has no endpoint. A boolean and a date are what a
 * counterparty needs; the sum is between the holder and the resort.
 */

import { loadAttestation } from "@/lib/attestation-store";
import { CONTRACT_ID, NETWORK_PASSPHRASE, explorer } from "@/lib/config";
import { readInventory, readIssuer, readName, readSymbol } from "@/lib/contract";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try {
    const [name, symbol, issuer, rows] = await Promise.all([
      readName(),
      readSymbol(),
      readIssuer(),
      readInventory(),
    ]);

    const now = Math.floor(Date.now() / 1000);

    return Response.json({
      contract: CONTRACT_ID,
      contract_explorer: explorer.contract(),
      network: NETWORK_PASSPHRASE,
      token: { name, symbol, decimals: 0 },
      issuer,
      now,
      rights: rows.map(({ right, listing, holding, active }) => {
        const attestation = loadAttestation(right.id);
        return {
          id: right.id,
          // The week on offer. Public because a listing has to say what it is
          // offering; everything identifying stays in the off-chain record.
          week: { start: right.period.start, end: right.period.end },
          validity: right.validity,
          commitment: right.commitment,
          title_holder: right.holdings[0]?.holder ?? null,
          effective_holder: holding.holder,
          term_ends: holding.expiresAt,
          rented_out: holding.expiresAt !== null,
          chain_depth: right.holdings.length,
          active,
          listing: listing
            ? { by: listing.by, term_secs: listing.termSecs, listed_at: listing.listedAt }
            : null,
          // Off chain, from the issuer's attestation store. `null` means the
          // issuer has vouched for nothing, which is not the same as clean.
          fees: attestation
            ? {
                current: attestation.payload.maintenance_fees_current,
                paid_through: attestation.payload.fees_paid_through,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read the registry" },
      { status: 502 },
    );
  }
}
