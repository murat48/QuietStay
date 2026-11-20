/**
 * Build an unsigned, simulated transaction for the caller to sign.
 *
 *   POST /api/tx/build  { action, by, ... }  → { xdr }
 *
 * Phase 1–2 actions: `list`, `unlist` ({ rightId, termSecs? }).
 *
 * Phase 3 Step 3 actions (docs/PHASE3_SPEC.md §4–§5), none of which carries a
 * proof:
 *   - `request_record`         { rightId, keyHash, expiresLedger }
 *   - `cancel_record_request`  { requestId }
 *   - `create_sale_offer`      { requestId, price, nextSecretHash, expiresLedger }
 *   - `create_rental_offer`    { rightId, price, expiresAt, checkIn, expiresLedger }
 *   - `cancel_offer`           { offerId }
 *   - `collect` | `confirm` | `refund`             { escrowId }
 *   - `report_problem` | `submit_evidence`         { escrowId, evidenceHash }
 *
 * `price` is a decimal string of USDC's smallest units, never a float. An
 * offer's simulation records the buyer's USDC `approve` as part of the same
 * authorization, which the buyer's wallet or passkey signs.
 *
 * Accepting an offer carries a proof and goes through `/api/tx/accept-offer`.
 * The arbiter's `resolve` is never built here: it is `scripts/arbiter-resolve`.
 *
 * The server does the simulation because that is where the RPC lives, not because
 * it has any authority: the transaction comes back unsigned, and the caller's
 * wallet is the only thing that can make it valid.
 */

import { authenticatedAccount } from "@/lib/sep10";
import {
  ContractCallError,
  buildCancelOfferTx,
  buildCancelRecordRequestTx,
  buildEscrowTx,
  buildListTx,
  buildRentalOfferTx,
  buildRequestRecordTx,
  buildSaleOfferTx,
  buildUnlistTx,
  prepare,
  readRight,
  type EscrowAction,
} from "@/lib/contract";
import { formatDate, weekIsOver } from "@/lib/format";

const ESCROW_ACTIONS: EscrowAction[] = ["collect", "confirm", "report_problem", "refund", "submit_evidence"];
const ACTIONS = [
  "list",
  "unlist",
  "request_record",
  "cancel_record_request",
  "create_sale_offer",
  "create_rental_offer",
  "cancel_offer",
  ...ESCROW_ACTIONS,
] as const;
type Action = (typeof ACTIONS)[number];

interface BuildRequest {
  action?: Action;
  by?: string;
  rightId?: number;
  /** Seconds for a rental offer; `null` offers the week open-ended. */
  termSecs?: number | null;
  requestId?: number;
  offerId?: number;
  escrowId?: number;
  keyHash?: string;
  evidenceHash?: string;
  /** Smallest USDC units, as a decimal string. */
  price?: string;
  nextSecretHash?: string;
  expiresLedger?: number;
  expiresAt?: number;
  checkIn?: number;
}

class BadRequest extends Error {}

const int = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new BadRequest(`${name} must be a non-negative integer`);
  return v;
};
const hex32 = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw new BadRequest(`${name} must be 64 lowercase hex digits`);
  return v;
};
/** A price: a decimal string of smallest units. Parsed as a bigint, never a float. */
const units = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^\d{1,30}$/.test(v)) throw new BadRequest("price must be a decimal string of USDC's smallest units");
  return BigInt(v);
};
const decimal = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new BadRequest(`${name} must be a decimal string`);
  return v;
};

function build(body: BuildRequest, by: string) {
  switch (body.action) {
    case "request_record":
      return buildRequestRecordTx({
        requester: by,
        rightId: int(body.rightId, "rightId"),
        keyHash: hex32(body.keyHash, "keyHash"),
        expiresLedger: int(body.expiresLedger, "expiresLedger"),
      });
    case "cancel_record_request":
      return buildCancelRecordRequestTx({ requester: by, requestId: int(body.requestId, "requestId") });
    case "create_sale_offer":
      return buildSaleOfferTx({
        buyer: by,
        requestId: int(body.requestId, "requestId"),
        price: units(body.price),
        nextSecretHash: decimal(body.nextSecretHash, "nextSecretHash"),
        expiresLedger: int(body.expiresLedger, "expiresLedger"),
      });
    case "create_rental_offer":
      return buildRentalOfferTx({
        renter: by,
        rightId: int(body.rightId, "rightId"),
        price: units(body.price),
        expiresAt: int(body.expiresAt, "expiresAt"),
        checkIn: int(body.checkIn, "checkIn"),
        expiresLedger: int(body.expiresLedger, "expiresLedger"),
      });
    case "cancel_offer":
      return buildCancelOfferTx({ buyer: by, offerId: int(body.offerId, "offerId") });
    default: {
      const action = body.action as EscrowAction;
      if (!ESCROW_ACTIONS.includes(action)) throw new BadRequest(`unknown action ${String(body.action)}`);
      const needsHash = action === "report_problem" || action === "submit_evidence";
      return buildEscrowTx({
        action,
        by,
        escrowId: int(body.escrowId, "escrowId"),
        evidenceHash: needsHash ? hex32(body.evidenceHash, "evidenceHash") : undefined,
      });
    }
  }
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
  if (!action || !by || !ACTIONS.includes(action)) {
    return Response.json({ error: `action (one of ${ACTIONS.join(", ")}) and by are required` }, { status: 400 });
  }
  if ((action === "list" || action === "unlist") && typeof rightId !== "number") {
    return Response.json({ error: "rightId is required" }, { status: 400 });
  }
  if (by !== caller) {
    return Response.json(
      { error: "you can only build a transaction for your own account", authenticated_as: caller },
      { status: 403 },
    );
  }

  try {
    // A week already over is refused here rather than published: the contract
    // would accept the listing, but nobody could ever take it up.
    if (action === "list") {
      const right = await readRight(rightId!);
      if (weekIsOver(right.period.end)) {
        return Response.json(
          {
            error: `right #${rightId}'s week ended on ${formatDate(right.period.end)} — there is nothing left to offer`,
          },
          { status: 409 },
        );
      }
    }

    const tx =
      action === "list"
        ? await buildListTx({ by, rightId: rightId!, termSecs: body.termSecs ?? null })
        : action === "unlist"
          ? await buildUnlistTx({ by, rightId: rightId! })
          : await build(body, by);

    return Response.json({ xdr: (await prepare(tx)).toXDR() });
  } catch (error) {
    if (error instanceof BadRequest) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not build the transaction" },
      { status: 500 },
    );
  }
}
