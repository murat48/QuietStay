/**
 * Everything the ledger holds about one usage right.
 *
 *   GET /api/right/3  → issuer, week, validity window, commitment, holding chain
 *
 * This is what the verify screen checks a disclosed record and attestation
 * against. Note what is *not* here, because it is not on chain: no owner, no
 * resort, no unit, no deed, no fee history. Only the commitment to all of that.
 */

import { CONTRACT_ID, explorer } from "@/lib/config";
import { ContractCallError, readIsActive, readListing, readRight } from "@/lib/contract";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const rightId = Number(id);

  if (!Number.isInteger(rightId) || rightId < 1) {
    return Response.json({ error: "right id must be a positive integer" }, { status: 400 });
  }

  try {
    const [right, listing, active] = await Promise.all([
      readRight(rightId),
      readListing(rightId),
      readIsActive(rightId),
    ]);

    const effective = right.holdings[right.holdings.length - 1];

    return Response.json({
      contract: CONTRACT_ID,
      contract_explorer: explorer.contract(),
      id: right.id,
      issuer: right.issuer,
      week: { start: right.period.start, end: right.period.end },
      validity: right.validity,
      commitment: right.commitment,
      active,
      title_holder: right.holdings[0]?.holder ?? null,
      effective_holder: effective?.holder ?? null,
      term_ends: effective?.expiresAt ?? null,
      holdings: right.holdings.map((h) => ({ holder: h.holder, expires_at: h.expiresAt })),
      listing: listing
        ? { by: listing.by, term_secs: listing.termSecs, listed_at: listing.listedAt }
        : null,
    });
  } catch (error) {
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read the right" },
      { status: 502 },
    );
  }
}
