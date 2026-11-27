/**
 * The issuer declines an owner's issuance ask (2026-11-27).
 *
 *   POST /api/requests/issuance/decline { id, reason? } → { request }
 *
 * Only the issuer, and only an ask still open. The reason, if given, is shown
 * to the owner on their /issue screen; it is plain text, at most 500
 * characters, and should say what to correct, not repeat the record. The
 * ask's sealed details are dropped: nobody needs them any more. Nothing is
 * on chain, so nothing else changes; the owner can ask again.
 */

import { readIssuer } from "@/lib/contract";
import { RequestStoreUnavailable, markDeclined } from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

const MAX_REASON = 500;

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });

  let body: { id?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  if (typeof body.id !== "string" || body.id === "") return Response.json({ error: "id is required" }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > MAX_REASON) {
    return Response.json({ error: `the reason is longer than ${MAX_REASON} characters` }, { status: 400 });
  }

  try {
    const issuer = await readIssuer();
    if (caller !== issuer) return Response.json({ error: "only the issuer declines an issuance request" }, { status: 403 });
    const declined = await markDeclined(body.id, reason || undefined);
    if (!declined) return Response.json({ error: "no open issuance request with that id" }, { status: 404 });
    return Response.json({ request: declined });
  } catch (error) {
    if (error instanceof RequestStoreUnavailable) {
      return Response.json({ error: error.message, read_only: true }, { status: 503 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "could not decline" }, { status: 500 });
  }
}
