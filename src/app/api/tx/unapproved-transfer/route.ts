/**
 * Build a transfer with the issuer's approval deliberately withheld.
 *
 *   POST /api/tx/unapproved-transfer  { from, to, rightId, expiresAt }
 *     → { xdr }   a transfer the contract will refuse
 *
 * This exists so that "verification is enforced at the contract level rather than
 * being advisory" is a thing you can watch rather than a sentence in a document.
 *
 * The transaction is well formed on purpose. Its resource footprint is obtained
 * from a simulation that *did* carry the issuer's authorization, and the
 * authorization is then removed. That way the network accepts it, includes it in a
 * ledger, and the **contract** is what refuses it — leaving a transaction hash a
 * reviewer can open. A transaction rejected at submission would leave nothing on
 * chain and would demonstrate nothing.
 *
 * It cannot be used to move anyone else's week: the caller must have proved
 * control of `from` over SEP-10, and every transfer still needs that account's
 * signature on the envelope. Withholding the issuer's approval only ever makes a
 * transfer fail; it can never make one succeed that otherwise would not.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { issuerSecret } from "@/lib/config";
import { ContractCallError, buildTransferTx, prepareUnapprovedTransfer } from "@/lib/contract";
import { authenticatedAccount } from "@/lib/sep10";

interface UnapprovedRequest {
  from?: string;
  to?: string;
  rightId?: number;
  expiresAt?: number | null;
}

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json({ error: "not authenticated — sign in first" }, { status: 401 });
  }

  let body: UnapprovedRequest;
  try {
    body = (await request.json()) as UnapprovedRequest;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { from, to, rightId } = body;
  const expiresAt = body.expiresAt ?? null;

  if (!from || !to || typeof rightId !== "number") {
    return Response.json({ error: "from, to, and rightId are required" }, { status: 400 });
  }
  if (from !== caller) {
    return Response.json(
      { error: "you can only build a transfer from your own account", authenticated_as: caller },
      { status: 403 },
    );
  }

  try {
    const unsigned = await buildTransferTx({ from, to, rightId, expiresAt });
    const stripped = await prepareUnapprovedTransfer(unsigned, Keypair.fromSecret(issuerSecret()));

    return Response.json({
      xdr: stripped.toXDR(),
      note:
        "The issuer's authorization entry has been removed. Sign and submit this: it will be " +
        "included in a ledger and the contract will reject it.",
    });
  } catch (error) {
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not build the transaction" },
      { status: 500 },
    );
  }
}
