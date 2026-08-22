/**
 * Ask for a week, and read the asks that concern you.
 *
 *   POST /api/requests  { right_id }   → the request, as recorded
 *   GET  /api/requests                 → { incoming, outgoing }
 *
 * Both need a SEP-10 session, and the requester's account is taken **from that
 * session** rather than from the body. That is the point of the whole flow: an
 * address nobody typed cannot be mistyped, and a week sent to a wrong-but-valid
 * account is gone — the issuer cannot claw it back, by design.
 *
 * The request carries no price and no money. It says "I want this week on the
 * terms you published", which is all a listing states.
 *
 * ## What is checked, and what deliberately is not
 *
 * Checked: the right exists, it is currently offered, and the asker is not
 * already its holder. All three are read from the contract, not from the body.
 *
 * Also refused: an offer on a week that is out on a term. Only the account holding
 * that term can have listed it, so the offer is a sub-let, which this issuer
 * declines to approve — the account holding title is not consulted by `transfer`
 * and would have no say. Such a request could never be accepted.
 *
 * Not checked: whether the issuer would approve the resulting transfer on fee
 * grounds. A week in arrears **can** be asked for, because the holder may settle
 * the fees precisely *because* somebody asked. Refusing there would make the
 * arrears self-fulfilling. The registry marks such weeks, and the transfer itself
 * would decline until they are paid.
 */

import { randomUUID } from "node:crypto";

import { ContractCallError, readInventory } from "@/lib/contract";
import {
  loadRequests,
  openRequestBy,
  saveRequests,
  type TransferRequest,
} from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json(
      { error: "not authenticated — connect a wallet and sign in to ask for a week" },
      { status: 401 },
    );
  }

  let body: { right_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const rightId = Number(body.right_id);
  if (!Number.isInteger(rightId) || rightId < 1) {
    return Response.json({ error: "right_id must be a positive integer" }, { status: 400 });
  }

  try {
    const row = (await readInventory()).find((r) => r.right.id === rightId);
    if (!row) {
      return Response.json({ error: `no right #${rightId} on this contract` }, { status: 404 });
    }
    if (!row.listing) {
      return Response.json(
        { error: `right #${rightId} is not on offer — nothing to ask for` },
        { status: 409 },
      );
    }
    if (row.holding.holder === caller) {
      return Response.json({ error: "you already hold this week" }, { status: 409 });
    }
    // A week out on a term can only have been listed by the account holding that
    // term, so any offer on one is a sub-let. The contract permits it and this
    // issuer declines to approve it, which means such a request could never be
    // accepted — recording one would only invite an ask that goes nowhere. The
    // screen hides the control; this is what enforces it.
    if (row.holding.expiresAt !== null) {
      return Response.json(
        {
          error:
            "this offer is a sub-let — the account offering it holds the week on a term, not " +
            "by title, and this issuer does not approve sub-lets",
          term_ends: row.holding.expiresAt,
          title_holder: row.right.holdings[0]?.holder ?? null,
        },
        { status: 409 },
      );
    }

    const existing = openRequestBy(rightId, caller);
    if (existing) {
      return Response.json(
        { error: "you already have an open request for this week", request: existing },
        { status: 409 },
      );
    }

    const record: TransferRequest = {
      id: randomUUID(),
      right_id: rightId,
      by: caller,
      // Whoever holds it now is who must answer. Recorded rather than looked up
      // later, so a request that goes stale is visibly about a past holder.
      to_holder: row.holding.holder,
      term_secs: row.listing.termSecs,
      requested_at: new Date().toISOString(),
      status: "open",
    };

    const all = loadRequests(rightId);
    all.push(record);
    saveRequests(rightId, all);

    return Response.json({
      request: record,
      note:
        record.term_secs === null
          ? "Asked to buy this week. The holder can accept or decline; nothing has moved."
          : "Asked to rent this week on the published term. The holder can accept or decline; " +
            "nothing has moved.",
    });
  } catch (error) {
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not record the request" },
      { status: 500 },
    );
  }
}

/**
 * The requests this account is party to, and only those.
 *
 * `incoming` are asks for weeks it currently holds; `outgoing` are asks it made.
 * A request names an account that wants a particular week, which is more than the
 * registry discloses about anyone, so it is never served to a third party.
 */
export async function GET(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ incoming: [], outgoing: [] });

  try {
    const rows = await readInventory();
    const incoming: TransferRequest[] = [];
    const outgoing: TransferRequest[] = [];

    for (const row of rows) {
      const holder = row.holding.holder;
      for (const req of loadRequests(row.right.id)) {
        if (holder === caller && req.by !== caller) incoming.push(req);
        if (req.by === caller) outgoing.push(req);
      }
    }

    return Response.json({ incoming, outgoing });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read requests" },
      { status: 502 },
    );
  }
}
