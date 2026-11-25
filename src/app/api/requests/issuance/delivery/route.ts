/**
 * The issuance inbox (D3 as amended 2026-11-25, docs/PHASE3_SPEC.md §2).
 *
 *   POST   /api/requests/issuance/delivery  { id, blob }  → the issuer leaves the sealed record
 *   DELETE /api/requests/issuance/delivery?id=<id>        → the owner's browser kept it; drop it
 *
 * The owner reads it with GET /api/requests/issuance, among their own asks.
 *
 * What this server holds is ciphertext: the issuer's browser sealed the
 * record to the owner's public key (ECDH P-256, HKDF, AES-256-GCM;
 * src/lib/sealed.ts), and only the owner's browser holds the private key,
 * non-extractable. The server already saw the record in the clear at
 * issuance (/api/issue computes d and C), so keeping its sealed form until
 * the owner picks it up tells it nothing new. It is dropped once picked up,
 * or after SEALED_TTL_DAYS.
 *
 * Only the issuer may deliver, only for an issued ask that carries a key,
 * and only once. Only the ask's owner may drop it.
 */

import { readIssuer } from "@/lib/contract";
import {
  RequestStoreUnavailable,
  expireSealed,
  loadIssuanceRequests,
  parseSealedBlob,
  saveIssuanceRequests,
} from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

function storeError(error: unknown): Response {
  if (error instanceof RequestStoreUnavailable) {
    return Response.json({ error: error.message, read_only: true }, { status: 503 });
  }
  return Response.json({ error: error instanceof Error ? error.message : "the request store failed" }, { status: 500 });
}

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });

  let body: { id?: unknown; blob?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  let blob: string;
  try {
    if (typeof body.id !== "string" || body.id === "") throw new Error("id is required");
    blob = parseSealedBlob(body.blob);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  try {
    const [issuer, all] = await Promise.all([readIssuer(), loadIssuanceRequests()]);
    if (caller !== issuer) {
      return Response.json({ error: "only the issuer delivers a new week's record" }, { status: 403 });
    }
    const ask = all.find((r) => r.id === body.id && !r.direct);
    if (!ask) return Response.json({ error: "no such request" }, { status: 404 });
    if (ask.status !== "issued") return Response.json({ error: "this request has not been issued yet" }, { status: 409 });
    if (!ask.public_key) {
      return Response.json({ error: "this request carries no key to seal to; use the request link" }, { status: 409 });
    }
    if (ask.sealed_record) {
      return Response.json({ error: "a sealed record is already waiting for this owner" }, { status: 409 });
    }
    ask.sealed_record = { blob, delivered_at: new Date().toISOString() };
    expireSealed(all);
    await saveIssuanceRequests(all);
    return Response.json({ delivered: true, id: ask.id, right_id: ask.right_id });
  } catch (error) {
    return storeError(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  try {
    const all = await loadIssuanceRequests();
    const ask = all.find((r) => r.id === id && !r.direct);
    if (!ask || ask.by !== caller) return Response.json({ error: "no such request of yours" }, { status: 404 });
    if (!ask.sealed_record) return Response.json({ removed: false });
    delete ask.sealed_record;
    await saveIssuanceRequests(all);
    return Response.json({ removed: true });
  } catch (error) {
    return storeError(error);
  }
}
