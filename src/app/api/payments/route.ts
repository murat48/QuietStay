/**
 * Public read of the payment state (docs/PHASE3_SPEC.md §4–§5).
 *
 *   GET /api/payments[?account=G…|C…]
 *     → { ledger, now, requests, offers, escrows, account? }
 *
 * Everything here is on chain and public: record requests (requester, right,
 * key hash), offers (buyer, right, price,
 * expiry), escrows (owner, renter, amount, state, evidence hashes). With
 * `account`, also that account's USDC balance (`null` for a G… account with no
 * USDC trustline) and its allowance to the contract. No session is needed and
 * nothing private is read.
 */

import { readAllowance, readEscrows, readOffers, readRecordRequests, readUsdcBalance, latestLedger } from "@/lib/contract";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const account = new URL(request.url).searchParams.get("account");
  if (account !== null && !/^[GC][A-Z2-7]{55}$/.test(account)) {
    return Response.json({ error: "account must be a G… or C… address" }, { status: 400 });
  }
  try {
    const [latest, requests, offers, escrows] = await Promise.all([
      latestLedger(),
      readRecordRequests(),
      readOffers(),
      readEscrows(),
    ]);
    const body: Record<string, unknown> = {
      ledger: latest.sequence,
      // Ledger close times drive the escrow windows; the server's clock is a
      // close stand-in for display only. The contract decides.
      now: Math.floor(Date.now() / 1000),
      requests: requests.map((r) => ({ ...r, expired: r.expiresLedger < latest.sequence })),
      offers: offers.map((o) => ({ ...o, expired: o.expiresLedger < latest.sequence })),
      escrows,
    };
    if (account) {
      const [balance, allowance] = await Promise.all([readUsdcBalance(account), readAllowance(account)]);
      body.account = { address: account, usdc: balance, allowance };
    }
    return Response.json(body);
  } catch (error) {
    console.error("[payments]", error);
    return Response.json({ error: error instanceof Error ? error.message : "could not read the payment state" }, { status: 502 });
  }
}
