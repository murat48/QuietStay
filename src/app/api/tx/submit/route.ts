/**
 * Submit a signed transaction and report what the ledger did with it.
 *
 *   POST /api/tx/submit  { xdr }  → { hash, successful, failure?, explorer }
 *
 * A rejected transaction is a normal, successful outcome for this endpoint: the
 * transfer screen has a control that deliberately submits an unapproved transfer
 * so the contract's refusal can be seen rather than described. That refusal comes
 * back here as `successful: false` with the reason, and with a hash a reviewer can
 * open — not as an error.
 */

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE } from "@/lib/config";
import { submit } from "@/lib/contract";

export async function POST(request: Request): Promise<Response> {
  let body: { xdr?: string };
  try {
    body = (await request.json()) as { xdr?: string };
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  if (!body.xdr) {
    return Response.json({ error: "xdr is required" }, { status: 400 });
  }

  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(body.xdr, NETWORK_PASSPHRASE) as Transaction;
  } catch {
    return Response.json({ error: "could not parse the transaction XDR" }, { status: 400 });
  }

  try {
    return Response.json(await submit(tx));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "submission failed" },
      { status: 502 },
    );
  }
}
