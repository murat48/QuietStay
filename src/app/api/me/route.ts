/**
 * The signed-in account's standing on this deployment.
 *
 *   GET /api/me   (Bearer token from the SEP-10 handshake)
 *     → { account, roles, owned, renting, rented_out }
 *
 * Requires the session token rather than accepting an address as a query
 * parameter, deliberately: an address anyone can type is a claim, and roles that
 * followed a claim would gate nothing. The account here is one the wallet proved
 * control of.
 *
 * Even so, this endpoint grants nothing. It reports what the registry already says
 * so the interface can stop offering actions the contract would refuse. Every
 * limit implied by a role is enforced on chain independently — see
 * `src/lib/roles.ts`.
 */

import { CONTRACT_ID, hasIssuerSecret } from "@/lib/config";
import { readInventory, readIssuer } from "@/lib/contract";
import { ROLE_LABELS, deriveStanding, summarize } from "@/lib/roles";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  const account = await authenticatedAccount(request);
  if (!account) {
    return Response.json(
      { error: "not authenticated — complete the SEP-10 handshake first" },
      { status: 401 },
    );
  }

  try {
    const [issuer, rows] = await Promise.all([readIssuer(), readInventory()]);
    const standing = deriveStanding(account, issuer, rows.map(summarize));

    return Response.json({
      contract: CONTRACT_ID,
      issuer,
      account: standing.account,
      roles: standing.roles,
      role_labels: standing.roles.map((role) => ROLE_LABELS[role]),
      is_issuer: standing.isIssuer,
      /*
       * Whether this deployment can sign anything at all. A public one is not
       * expected to hold the issuer key, so the interface has to stop offering
       * issuing, fee entry and transfer approval — the alternative is a button
       * that costs a signature to discover a 503.
       */
      read_only: !hasIssuerSecret(),
      owned: standing.owned,
      renting: standing.renting,
      rented_out: standing.rentedOut,
      counts: {
        owned: standing.owned.length,
        renting: standing.renting.length,
        rented_out: standing.rentedOut.length,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read the registry" },
      { status: 502 },
    );
  }
}
