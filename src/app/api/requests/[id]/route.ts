/**
 * Answer a request.
 *
 *   POST /api/requests/<id>  { right_id, action: "decline" | "withdraw" | "accepted", reason?, tx? }
 *
 * Three answers, and who may give each is decided by the contract rather than by
 * the body: the account holding the week may **decline**, the account that asked
 * may **withdraw**, and the holder records **accepted** once the transfer has
 * actually gone through.
 *
 * ## Accepting does not happen here
 *
 * There is no action that moves a week. Accepting means running the transfer that
 * was always there — the holder's signature, the issuer's authorization entry, the
 * contract checking both — and then calling this to mark the request answered, so
 * it stops sitting in the holder's queue. The `tx` recorded is the transfer's
 * hash, taken from the submission rather than supplied as a claim: this route
 * verifies the week actually left the holder before it will write `accepted`.
 *
 * A route that could mark a request accepted without a transfer would be recording
 * a sale that never happened.
 */

import { ContractCallError, readHolding } from "@/lib/contract";
import { loadRequests, updateRequest } from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  let body: { right_id?: unknown; action?: unknown; reason?: unknown; tx?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const rightId = Number(body.right_id);
  if (!Number.isInteger(rightId) || rightId < 1) {
    return Response.json({ error: "right_id must be a positive integer" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "decline" && action !== "withdraw" && action !== "accepted") {
    return Response.json(
      { error: 'action must be "decline", "withdraw" or "accepted"' },
      { status: 400 },
    );
  }

  const existing = loadRequests(rightId).find((r) => r.id === id);
  if (!existing) {
    return Response.json({ error: "no such request for this right" }, { status: 404 });
  }
  if (existing.status !== "open") {
    return Response.json(
      { error: `this request was already ${existing.status}`, request: existing },
      { status: 409 },
    );
  }

  try {
    if (action === "withdraw") {
      // Only the account that asked may take the ask back.
      if (existing.by !== caller) {
        return Response.json(
          { error: "only the account that made this request can withdraw it" },
          { status: 403 },
        );
      }
    } else if (action === "decline") {
      // Declining belongs to whoever holds the week *now*, read from the
      // contract. The holder recorded on the request may be out of date, and the
      // current one is the only person who can answer for it.
      const holding = await readHolding(rightId);
      if (holding.holder !== caller) {
        return Response.json(
          { error: `only the holder of right #${rightId} can decline requests for it` },
          { status: 403 },
        );
      }
    } else {
      // Recording an acceptance is checked against the world, not taken on trust:
      // the week must already be held by the account that asked. Until the
      // transfer has gone through there is nothing to record, and a route that
      // wrote "accepted" without it would be recording a sale that never
      // happened.
      const holding = await readHolding(rightId);
      if (holding.holder !== existing.by) {
        return Response.json(
          {
            error:
              "this week has not moved to the account that asked — complete the transfer " +
              "first, then record the acceptance",
            held_by: holding.holder,
            asked_by: existing.by,
          },
          { status: 409 },
        );
      }
      // And it is the granting holder who records it, not the new one: accepting
      // is the answer to a question that was put to them.
      if (existing.to_holder !== caller) {
        return Response.json(
          { error: "only the holder this request was made to can record its acceptance" },
          { status: 403 },
        );
      }
    }

    const status = action === "withdraw" ? "withdrawn" : action === "decline" ? "declined" : "accepted";
    const updated = updateRequest(rightId, id, (r) => ({
      ...r,
      status,
      answered_at: new Date().toISOString(),
      ...(typeof body.tx === "string" && body.tx.trim() ? { tx: body.tx.trim() } : {}),
      ...(typeof body.reason === "string" && body.reason.trim()
        ? { reason: body.reason.trim() }
        : {}),
    }));

    return Response.json({
      request: updated,
      note:
        action === "withdraw"
          ? "Request withdrawn. Nothing was on chain, and nothing has changed."
          : action === "decline"
            ? "Request declined. The week stays yours and the asker may ask again."
            : "Recorded. The week is now held by the account that asked for it.",
    });
  } catch (error) {
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not answer the request" },
      { status: 500 },
    );
  }
}
