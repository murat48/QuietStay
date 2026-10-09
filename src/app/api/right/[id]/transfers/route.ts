/**
 * The accepted transfers of one usage right, as the contract's events record them.
 *
 *   GET /api/right/3/transfers  → { transfers: [{ tx, ledger, closed_at, from, to, kind, … }] }
 *
 * Each one is an ownership proof the contract verified on chain: `transfer`
 * publishes its event only after the pairing check passes, and nothing else can
 * move a right. The RPC keeps events for a limited window (about a week on
 * testnet), so older transfers are not listed here — the explorer still has them.
 */

import { explorer } from "@/lib/config";
import { readTransferEvents } from "@/lib/contract";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const rightId = Number(id);
  if (!Number.isInteger(rightId) || rightId < 1) {
    return Response.json({ error: "right id must be a positive integer" }, { status: 400 });
  }
  try {
    const events = await readTransferEvents(rightId);
    return Response.json({
      transfers: events.map((e) => ({
        tx: e.txHash,
        explorer: explorer.tx(e.txHash),
        ledger: e.ledger,
        closed_at: e.closedAt,
        from: e.from,
        to: e.to,
        kind: e.expiresAt === null ? "sale" : "rental",
        expires_at: e.expiresAt,
        commitment: e.commitment,
      })),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read the contract's events" },
      { status: 502 },
    );
  }
}
