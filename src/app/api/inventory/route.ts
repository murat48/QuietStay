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
 * **Two fields are not from the ledger.** `fees` and `region` come from the
 * issuer's attestation store — signed, but not on chain.
 *
 * `fees`, because fee status is off-chain by design and changes over the life of
 * a right. It is served here so that a buyer sees, on the same card as the offer,
 * whether the week can actually change hands — a transfer of a week with arrears
 * is declined, and discovering that only at signing time would be a poor way to
 * learn it.
 *
 * `property`, because a commitment is a hash of the whole record: nothing in it
 * can be revealed piecemeal, so a listing built from the ledger alone can say
 * when a week is and nothing else — not where, not how many it sleeps, not what
 * it offers. Nobody takes a week on those terms, and the reveal step that would
 * answer those questions never begins, because a buyer cannot tell which week to
 * ask about.
 *
 * What is deliberately not served with either: the amount owed, and the resort or
 * unit. Both live in the off-chain record, which has no endpoint. What a
 * counterparty needs in order to ask is a town, a size, a boolean and a date; the
 * rest is disclosed once, to them, in exchange for their interest.
 */

import { attestationIsAuthentic } from "@/lib/attestation";
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

    /*
     * Built before the response rather than inside it, because looking an
     * attestation up is now asynchronous — a configured store is over the
     * network. Every row is fetched at once: they do not depend on each other,
     * and doing them in sequence would make the registry's load time the sum of
     * one round trip per week.
     */
    const rights = await Promise.all(
      rows.map(async ({ right, listing, holding, active }) => {
        /*
         * Read it, then prove it before showing it.
         *
         * The store is a directory, and in a deployment a mounted volume that
         * attestations are copied into by hand as new weeks are issued. A file
         * that lands under the wrong name — `right-28` saved as `right-27` —
         * would otherwise be displayed as that week's town and fee state, with
         * nothing anywhere saying it was wrong. That is a slip, not an attack,
         * and it is the likely one given how the files get there.
         *
         * Provenance only. Whether the issuer says the fees are *paid* is
         * content, and the registry's job is to report it, not to suppress it:
         * hiding a week in arrears behind "not attested" would replace a true
         * statement with a false one.
         */
        const onFile = await loadAttestation(right.id);
        const attestation =
          onFile !== null &&
          attestationIsAuthentic(onFile, {
            contract: CONTRACT_ID,
            network: NETWORK_PASSPHRASE,
            rightId: right.id,
            contractIssuer: right.issuer,
            onChainCommitment: right.commitment,
          })
            ? onFile
            : null;
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
          // Also from the attestation: where the week is, how many it sleeps, and
          // what it offers. Without this a buyer cannot tell one week from
          // another well enough to know whose record to ask for; with more than
          // this the listing would name the apartment and defeat the point of
          // keeping the record off the ledger. Named `property` so it is not
          // confused with `listing` above, which is the offer, not the place.
          property: attestation?.payload.property ?? null,
        };
      }),
    );

    return Response.json({
      contract: CONTRACT_ID,
      contract_explorer: explorer.contract(),
      network: NETWORK_PASSPHRASE,
      token: { name, symbol, decimals: 0 },
      issuer,
      now,
      rights,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read the registry" },
      { status: 502 },
    );
  }
}
