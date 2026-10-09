/**
 * Prepare a buyer's consent to a sale, for the buyer's wallet to sign.
 *
 *   POST /api/requests/consent  { right_id, next_secret_hash }
 *     → { entry, preimage, valid_until_ledger }
 *
 * The buyer has made a record secret on their own machine (`npm run zk:secret`)
 * and pastes its hash `h'`. This returns the authorization the contract will
 * demand of the buyer on the sale — `transfer(right_id, h')` on this contract —
 * and the preimage the wallet signs (`signAuthEntry`). The signature then goes
 * to `POST /api/requests` with the ask, which checks it.
 *
 * Nothing is recorded here, and nothing is signed by the server.
 */

import { consentToSign, parseSecretHash } from "@/lib/consent";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json({ error: "not authenticated — sign in first" }, { status: 401 });
  }
  try {
    const body = (await request.json()) as { right_id?: unknown; next_secret_hash?: unknown };
    const rightId = Number(body.right_id);
    if (!Number.isInteger(rightId) || rightId < 1) throw new Error("right_id must be a positive integer");
    const h = parseSecretHash(body.next_secret_hash);
    return Response.json(await consentToSign(caller, rightId, h));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not prepare the consent" },
      { status: 400 },
    );
  }
}
