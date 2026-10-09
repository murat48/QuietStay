/**
 * Build a proof-authorized transfer for the holder's wallet to sign.
 *
 *   POST /api/tx/proven-transfer  { transfer: <transfer.json from `npm run zk:prove`> }
 *     → { xdr, kind: "rental" | "sale", request_id? }
 *
 * The holder proves ownership on their own machine with the command-line prover
 * and uploads what it wrote. This route checks the file belongs to the signed-in
 * holder, and on a sale finds the consent the buyer signed when asking for the
 * week: an open request from exactly that buyer, carrying exactly the proof's
 * next secret hash. It then simulates the call — so the contract checks the proof
 * now, and a proof it would refuse is refused here with the contract's reason —
 * and returns the transaction unsigned.
 *
 * No issuer key is used. The server holds no authority over the result: only the
 * holder's wallet can make it valid.
 */

import { authenticatedAccount } from "@/lib/sep10";
import { ContractCallError, buildProvenTransferTx, type ProvenTransfer } from "@/lib/contract";
import { loadRequests } from "@/lib/requests";

export const dynamic = "force-dynamic";

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n * 2}}$`);

/** The parts of `transfer.json` this route needs, checked rather than trusted. */
function parseTransferFile(raw: unknown): ProvenTransfer {
  const file = raw as {
    transfer?: { right_id?: unknown; from?: unknown; to?: unknown; expires_at?: unknown };
    proof?: { a?: unknown; b?: unknown; c?: unknown };
    public_signals?: Record<string, unknown>;
  };
  const t = file?.transfer;
  if (!t || !file.proof || !file.public_signals) {
    throw new Error("this is not a transfer.json written by `npm run zk:prove`");
  }
  const from = String(t.from);
  const to = String(t.to);
  if (!/^G[A-Z2-7]{55}$/.test(from) || !/^G[A-Z2-7]{55}$/.test(to)) {
    throw new Error("the transfer must be between two G… accounts");
  }
  const rightId = Number(t.right_id);
  if (!Number.isInteger(rightId) || rightId < 1) throw new Error("right_id is not a positive integer");
  const expiresAt = t.expires_at === null ? null : Number(t.expires_at);
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= 0)) {
    throw new Error("expires_at is neither null nor a positive Unix time");
  }
  const { a, b, c } = file.proof;
  if (![a, c].every((p) => typeof p === "string" && HEX(96).test(p)) || !(typeof b === "string" && HEX(192).test(b))) {
    throw new Error("the proof's points are not in the contract's byte layout");
  }
  // The signals in the order the contract takes them; transfer.json names them.
  const order = [
    "commitment", "nullifier", "right_id", "from_hi", "from_lo", "to_hi", "to_lo",
    "mode", "expiry_ledger", "next_secret_hash", "next_commitment",
  ];
  const signals = order.map((k) => {
    const v = file.public_signals![k];
    if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new Error(`public signal ${k} is missing or not a number`);
    return v;
  });
  return { from, to, rightId, expiresAt, proof: { a: a as string, b: b as string, c: c as string }, signals };
}

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json({ error: "not authenticated — sign in first" }, { status: 401 });
  }

  let t: ProvenTransfer;
  try {
    const body = (await request.json()) as { transfer?: unknown };
    t = parseTransferFile(body.transfer);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "expected { transfer: <transfer.json> }" },
      { status: 400 },
    );
  }

  if (t.from !== caller) {
    return Response.json(
      {
        error:
          `this proof is for a transfer from ${t.from}, and you are signed in as ${caller} — ` +
          "only the holder it names can submit it",
      },
      { status: 403 },
    );
  }

  let consent: string | null = null;
  let requestId: string | undefined;
  if (t.expiresAt === null) {
    const nextSecretHash = t.signals[9]!;
    const match = (await loadRequests(t.rightId)).find(
      (r) =>
        r.status === "open" &&
        r.by === t.to &&
        r.term_secs === null &&
        r.consent?.next_secret_hash === nextSecretHash,
    );
    if (!match?.consent) {
      return Response.json(
        {
          error:
            `no open request from ${t.to} to buy right #${t.rightId} carries this proof's next secret ` +
            "hash. The buyer gives their consent — and their h' — when asking for the week; " +
            "prove with that h'.",
        },
        { status: 409 },
      );
    }
    consent = match.consent.auth_entry;
    requestId = match.id;
  } else {
    const match = (await loadRequests(t.rightId)).find(
      (r) => r.status === "open" && r.by === t.to && r.term_secs !== null,
    );
    requestId = match?.id;
  }

  try {
    const tx = await buildProvenTransferTx(t, consent);
    return Response.json({
      xdr: tx.toXDR(),
      kind: t.expiresAt === null ? "sale" : "rental",
      right_id: t.rightId,
      to: t.to,
      expires_at: t.expiresAt,
      ...(requestId ? { request_id: requestId } : {}),
    });
  } catch (error) {
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not build the transaction" },
      { status: 500 },
    );
  }
}
