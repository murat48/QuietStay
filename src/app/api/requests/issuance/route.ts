/**
 * Ask the issuer to issue a week to you, and read the asks that concern you.
 *
 *   POST /api/requests/issuance  { secret_hash }  → the request, as recorded
 *   GET  /api/requests/issuance                   → { requests }
 *
 * The owner's side of issuance, built like an ask for a week (../route.ts). The
 * first holder is taken **from the SEP-10 session**, never from the body: a body
 * naming another account is refused, so nobody can file an `h` in someone else's
 * name. `secret_hash` is `h = Poseidon(s)`, checked exactly as /api/issue checks
 * it — a number, decimal or hex, above 0 and below the BLS12-381 scalar modulus.
 * The secret `s` itself is never sent; `h` is the only thing that reaches this
 * server.
 *
 * GET serves the issuer every open ask, and any other account only its own.
 * Issuing from an ask closes it (/api/issue, `request_id`).
 */

import { randomUUID } from "node:crypto";

import { parseSecretHash } from "@/lib/consent";
import { readIssuer } from "@/lib/contract";
import {
  RequestStoreUnavailable,
  loadIssuanceRequests,
  saveIssuanceRequests,
  type IssuanceRequest,
} from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json(
      { error: "not authenticated — connect the wallet the week should be issued to, and sign in" },
      { status: 401 },
    );
  }

  let body: { secret_hash?: unknown; owner?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  // The ask is the session's account's, and only its. A body that names anyone
  // else is somebody trying to file an h for an account they have not proved.
  if (body.owner !== undefined && body.owner !== caller) {
    return Response.json(
      {
        error: "an issuance request is always for the account signed in — you cannot ask on another account's behalf",
        authenticated_as: caller,
      },
      { status: 403 },
    );
  }

  let h: bigint;
  try {
    h = parseSecretHash(body.secret_hash);
  } catch (error) {
    return Response.json({ error: `secret_hash: ${(error as Error).message}` }, { status: 400 });
  }

  try {
    const all = await loadIssuanceRequests();
    const duplicate = all.find((r) => r.by === caller && r.status === "open" && r.secret_hash === h.toString());
    if (duplicate) {
      return Response.json(
        { error: "you already have an open request with this h", request: duplicate },
        { status: 409 },
      );
    }

    const record: IssuanceRequest = {
      id: randomUUID(),
      by: caller,
      secret_hash: h.toString(),
      requested_at: new Date().toISOString(),
      status: "open",
    };
    all.push(record);
    await saveIssuanceRequests(all);

    return Response.json({
      request: record,
      note: "Asked the issuer to issue a week to this account. Keep your secret file: it is what lets you rent the week out or sell it.",
    });
  } catch (error) {
    if (error instanceof RequestStoreUnavailable) {
      return Response.json({ error: error.message, read_only: true }, { status: 503 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not record the request" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });

  try {
    const [issuer, all] = await Promise.all([readIssuer(), loadIssuanceRequests()]);
    const requests =
      caller === issuer ? all.filter((r) => r.status === "open") : all.filter((r) => r.by === caller);
    return Response.json({ requests, as_issuer: caller === issuer });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read requests" },
      { status: 502 },
    );
  }
}
