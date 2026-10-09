/**
 * The accepted transfers of one usage right, as the contract's events record them,
 * and the deployment's evidence transactions to fall back on.
 *
 *   GET /api/right/3/transfers
 *     → { transfers: [{ tx, ledger, closed_at, from, to, kind, … }],
 *         evidence: [{ id, title, accepted, error, right_id, tx, explorer }] }
 *
 * Each transfer is an ownership proof the contract verified on chain: `transfer`
 * publishes its event only after the pairing check passes, and nothing else can
 * move a right. But the RPC keeps events for about a week, so after that a week's
 * own transfers drop out of `transfers` — the explorer still has them.
 *
 * `evidence` is what the verify screen shows instead: the accepted and refused
 * transactions in docs/EVIDENCE.md, read from docs/evidence-phase2.json, which
 * are permanent and each openable in an explorer. Only when that file is about
 * the contract this app is reading — a deployment pointed at another contract
 * gets none, rather than another contract's links.
 */

import evidenceFile from "../../../../../../docs/evidence-phase2.json";

import { CONTRACT_ID, explorer } from "@/lib/config";
import { readTransferEvents } from "@/lib/contract";

export const dynamic = "force-dynamic";

interface EvidenceRow {
  id: string;
  title: string;
  right_id: number;
  hash: string;
  successful: boolean;
  error: string | null;
}

function evidenceFor(contract: string) {
  const file = evidenceFile as { contract: string; transactions: EvidenceRow[] };
  if (file.contract !== contract) return [];
  return file.transactions.map((t) => ({
    id: t.id,
    title: t.title,
    right_id: t.right_id,
    accepted: t.successful,
    error: t.error,
    tx: t.hash,
    explorer: explorer.tx(t.hash),
  }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const rightId = Number(id);
  if (!Number.isInteger(rightId) || rightId < 1) {
    return Response.json({ error: "right id must be a positive integer" }, { status: 400 });
  }
  const evidence = evidenceFor(CONTRACT_ID);
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
      evidence,
    });
  } catch (error) {
    // The events could not be read at all — the screen falls back the same way.
    return Response.json({
      transfers: [],
      evidence,
      events_error: error instanceof Error ? error.message : "could not read the contract's events",
    });
  }
}
