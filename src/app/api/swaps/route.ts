/**
 * Public read of the swap state (docs/PHASE3_SPEC.md §7).
 *
 *   GET /api/swaps → { ledger, swaps: [{ offer, acceptance, expired }], requests }
 *
 * Everything here is on chain and public: swap offers (maker, the two weeks,
 * the maker's h' and key hash, expiry), acceptances (taker, h', key hash, the
 * proof's last ledger) and record requests. An acceptance whose proof has
 * passed its ledger is reported as `null`: the contract treats it as gone. No
 * session is needed and nothing private is read.
 */

import { latestLedger, readRecordRequests, readSwaps } from "@/lib/contract";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const [latest, swaps, requests] = await Promise.all([latestLedger(), readSwaps(), readRecordRequests()]);
    return Response.json({
      ledger: latest.sequence,
      swaps: swaps.map(({ offer, acceptance }) => ({
        offer,
        acceptance: acceptance && acceptance.expiryLedger >= latest.sequence ? acceptance : null,
        expired: offer.expiresLedger < latest.sequence,
      })),
      requests: requests.map((r) => ({ ...r, expired: r.expiresLedger < latest.sequence })),
    });
  } catch (error) {
    console.error("[swaps]", error);
    return Response.json({ error: error instanceof Error ? error.message : "could not read the swaps" }, { status: 502 });
  }
}
