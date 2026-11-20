/**
 * One on-chain record request (D4a), for the holder's browser to check a
 * request link against before sealing.
 *
 *   GET /api/record-request/7  → { id, requester, rightId, keyHash, expiresLedger, live }
 *
 * Public chain data: the requester's account and the SHA-256 of their key.
 */

import { readRecordRequest, server } from "@/lib/contract";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const requestId = Number(id);
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    return Response.json({ error: "request id must be a positive integer" }, { status: 400 });
  }
  try {
    const [request, latest] = await Promise.all([readRecordRequest(requestId), server.getLatestLedger()]);
    if (!request) {
      return Response.json({ error: "no such record request: it was used, cancelled, has lapsed, or never existed" }, { status: 404 });
    }
    return Response.json({ ...request, live: request.expiresLedger >= latest.sequence });
  } catch (error) {
    console.error("[record-request]", error);
    return Response.json({ error: error instanceof Error ? error.message : "could not read the request" }, { status: 502 });
  }
}
