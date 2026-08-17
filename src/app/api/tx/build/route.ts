/**
 * Build an unsigned, simulated transaction for the holder to sign.
 *
 *   POST /api/tx/build  { action: "list" | "unlist", by, rightId, termSecs? }
 *     → { xdr }
 *
 * Only for the actions that need no issuer involvement — publishing and
 * withdrawing an offer. A transfer goes through `/api/approve-transfer` instead,
 * because it needs the issuer's authorization entry attached before the holder
 * signs.
 *
 * The server does the simulation because that is where the RPC lives, not because
 * it has any authority: the transaction comes back unsigned, and the holder's
 * wallet is the only thing that can make it valid.
 */

import { authenticatedAccount } from "@/lib/sep10";
import { ContractCallError, buildListTx, buildUnlistTx, prepare } from "@/lib/contract";

interface BuildRequest {
  action?: "list" | "unlist";
  by?: string;
  rightId?: number;
  /** Seconds for a rental offer; `null` offers the week open-ended. */
  termSecs?: number | null;
}

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json({ error: "not authenticated — sign in first" }, { status: 401 });
  }

  let body: BuildRequest;
  try {
    body = (await request.json()) as BuildRequest;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { action, by, rightId } = body;
  if (!action || !by || typeof rightId !== "number") {
    return Response.json({ error: "action, by, and rightId are required" }, { status: 400 });
  }
  if (by !== caller) {
    return Response.json(
      { error: "you can only build a transaction for your own account", authenticated_as: caller },
      { status: 403 },
    );
  }

  try {
    const tx =
      action === "list"
        ? await buildListTx({ by, rightId, termSecs: body.termSecs ?? null })
        : await buildUnlistTx({ by, rightId });

    return Response.json({ xdr: (await prepare(tx)).toXDR() });
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
