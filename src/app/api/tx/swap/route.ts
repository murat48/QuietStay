/**
 * Build `accept_swap` or `complete_swap` for the holder to sign
 * (docs/PHASE3_SPEC.md §7, D5).
 *
 *   POST /api/tx/swap  { step: "accept", by, swapId, nextSecretHash, requestId, proof: {a,b,c}, signals }
 *   POST /api/tx/swap  { step: "complete", by, swapId, proof: {a,b,c}, signals }
 *     → { xdr }
 *
 * The holder's browser proved ownership against the on-chain swap: the other
 * side as recipient, mode `2^64 + the week received`, and the other side's h'.
 * Only the proof and its public signals arrive here; the record and secret
 * never leave the browser. On `accept`, `nextSecretHash` is the taker's own h'
 * for the week they receive, made and kept in their browser.
 *
 * Simulation runs the whole call (complete: both proofs in full, against the
 * current state), so a refusal comes back with the contract's reason before
 * anything is signed.
 */

import { authenticatedAccount } from "@/lib/sep10";
import { ContractCallError, buildSwapProofTx, readSwap } from "@/lib/contract";

export const dynamic = "force-dynamic";

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n * 2}}$`);
const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated — sign in first" }, { status: 401 });

  let body: {
    step?: string;
    by?: string;
    swapId?: number;
    nextSecretHash?: string;
    requestId?: number;
    proof?: { a?: unknown; b?: unknown; c?: unknown };
    signals?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const { step, by, swapId, proof, signals } = body;
  if (step !== "accept" && step !== "complete") {
    return Response.json({ error: 'step must be "accept" or "complete"' }, { status: 400 });
  }
  if (!by || by !== caller) {
    return Response.json({ error: "you can only act on a swap as your own account", authenticated_as: caller }, { status: 403 });
  }
  if (!positive(swapId)) return Response.json({ error: "swapId must be a positive integer" }, { status: 400 });
  if (
    !proof ||
    ![proof.a, proof.c].every((p) => typeof p === "string" && HEX(96).test(p)) ||
    !(typeof proof.b === "string" && HEX(192).test(proof.b))
  ) {
    return Response.json({ error: "the proof's points are not in the contract's byte layout" }, { status: 400 });
  }
  if (!Array.isArray(signals) || signals.length !== 11 || !signals.every((x) => typeof x === "string" && /^\d{1,78}$/.test(x))) {
    return Response.json({ error: "expected the eleven public signals as decimal strings" }, { status: 400 });
  }
  if (step === "accept") {
    if (typeof body.nextSecretHash !== "string" || !/^\d{1,78}$/.test(body.nextSecretHash)) {
      return Response.json({ error: "nextSecretHash must be a decimal string" }, { status: 400 });
    }
    if (!positive(body.requestId)) return Response.json({ error: "requestId must be a positive integer" }, { status: 400 });
  }

  try {
    if (!(await readSwap(swapId as number))) {
      return Response.json({ error: "that swap no longer exists: completed, cancelled, or never made" }, { status: 404 });
    }
    const p = { proof: { a: proof.a as string, b: proof.b as string, c: proof.c as string }, signals: signals as string[] };
    const tx =
      step === "accept"
        ? await buildSwapProofTx({
            step,
            by,
            swapId: swapId as number,
            nextSecretHash: body.nextSecretHash as string,
            requestId: body.requestId as number,
            ...p,
          })
        : await buildSwapProofTx({ step, by, swapId: swapId as number, ...p });
    return Response.json({ xdr: tx.toXDR() });
  } catch (error) {
    if (error instanceof ContractCallError) return Response.json({ error: error.message }, { status: 400 });
    console.error("[tx/swap]", error);
    return Response.json({ error: error instanceof Error ? error.message : "could not build the swap step" }, { status: 500 });
  }
}
