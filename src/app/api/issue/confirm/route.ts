/**
 * Confirm an issuance signed and sent with the CLI (Step 5 plan, item 3).
 *
 *   POST /api/issue/confirm { tx_hash, record, request_id } → { right_id, commitment, tx, … }
 *
 * The envelope came from `POST /api/issue { envelope: true }` and went to the
 * network through `scripts/mainnet-sign-submit.sh`. Nothing here trusts the
 * browser's word that it landed: the transaction is read from the chain by
 * its hash, and must be a successful `issue` on this contract, sent by the
 * issuer, for the ask's account, carrying exactly the commitment this record
 * and the ask's h make. Only then is the ask closed; the right's number is
 * the call's own return value.
 *
 * Where the deployment holds the issuer key (the testnet demo) the week is
 * attested as on the signed-here path. In `cli` mode there is no attestation.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { attestationStoreIsWritable } from "@/lib/attestation-store";
import { ATTESTATIONS, CONTRACT_ID, explorer, hasIssuerSecret, issuerSecret } from "@/lib/config";
import { ContractCallError, readIssuer, readLandedIssue } from "@/lib/contract";
import { IssuanceRefused, attestIssued, prepareIssuance } from "@/lib/issuance";
import { RecordValidationError } from "@/lib/record";
import { RequestStoreUnavailable, loadIssuanceRequests, markIssued } from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated — sign in as the issuer" }, { status: 401 });

  let body: { tx_hash?: unknown; record?: unknown; request_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const hash = typeof body.tx_hash === "string" ? body.tx_hash.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return Response.json({ error: "tx_hash must be 64 hex characters" }, { status: 400 });
  if (typeof body.request_id !== "string") return Response.json({ error: "request_id is required" }, { status: 400 });

  try {
    const issuer = await readIssuer();
    if (caller !== issuer) return Response.json({ error: "only the issuer confirms an issuance" }, { status: 403 });

    // Already confirmed with this very transaction: answer the same again.
    const asks = await loadIssuanceRequests();
    const ask = asks.find((r) => r.id === body.request_id);
    if (!ask) return Response.json({ error: "no such issuance request" }, { status: 404 });
    if (ask.status === "issued") {
      if (ask.tx === hash && ask.right_id !== undefined) {
        return Response.json({ right_id: ask.right_id, tx: hash, explorer: explorer.tx(hash), already: true });
      }
      return Response.json({ error: "this request was already issued, by another transaction" }, { status: 409 });
    }

    const landed = await readLandedIssue(hash);
    if (landed.status === "NOT_FOUND") {
      return Response.json(
        { error: "that transaction is not on chain (yet). If mainnet-sign-submit.sh has not reported it, wait and try again.", pending: true },
        { status: 409 },
      );
    }
    if (landed.status !== "SUCCESS") return Response.json({ error: "that transaction failed on chain; nothing was issued" }, { status: 400 });
    if (landed.contract !== CONTRACT_ID || landed.fn !== "issue") {
      return Response.json({ error: "that transaction is not an issuance on this contract" }, { status: 400 });
    }
    if (landed.source !== issuer) return Response.json({ error: "that transaction was not sent by the issuer" }, { status: 400 });

    // The same checks and commitment as when the envelope was built.
    const prepared = await prepareIssuance({ record: body.record, request_id: body.request_id }, issuer);
    if (landed.owner !== prepared.record.owner.stellar_account || landed.commitment !== prepared.commitment) {
      return Response.json(
        { error: "that issuance carries another owner or commitment than this record and request make" },
        { status: 400 },
      );
    }
    if (landed.rightId === undefined) return Response.json({ error: "could not read the new right's number" }, { status: 502 });
    const rightId = landed.rightId;

    let requestNote: string | undefined;
    try {
      await markIssued(prepared.requestId!, { right_id: rightId, tx: hash });
    } catch (caught) {
      requestNote = caught instanceof RequestStoreUnavailable ? caught.message : "the request could not be closed";
    }

    // The testnet demo still attests; `cli` mode has no attestations.
    let attested: Awaited<ReturnType<typeof attestIssued>> | null = null;
    if (ATTESTATIONS && hasIssuerSecret() && (await attestationStoreIsWritable())) {
      attested = await attestIssued(Keypair.fromSecret(issuerSecret()), prepared, rightId);
    }

    return Response.json({
      right_id: rightId,
      record_digest: prepared.recordDigest,
      commitment: prepared.commitment,
      windows: prepared.windows,
      tx: hash,
      explorer: explorer.tx(hash),
      request_id: prepared.requestId,
      ...(attested
        ? { attested_clean: attested.clean, attestation: attested.attestation, attestation_path: attested.attestationPath }
        : {}),
      ...(requestNote ? { request_note: requestNote } : {}),
      note: attested
        ? attested.clean
          ? "The issuer attests this week is valid and free of unpaid maintenance fees."
          : "Issued, but NOT attested clean: the record shows maintenance fees outstanding."
        : "Issued with the CLI and confirmed on chain. This deployment signs no attestations.",
    });
  } catch (error) {
    if (error instanceof IssuanceRefused) return Response.json({ error: error.message, ...error.extra }, { status: error.status });
    if (error instanceof RecordValidationError) return Response.json({ error: `record is not valid: ${error.message}` }, { status: 400 });
    if (error instanceof ContractCallError) return Response.json({ error: error.message }, { status: 400 });
    console.error("[/api/issue/confirm] unexpected failure:", error);
    return Response.json({ error: error instanceof Error ? error.message : "could not confirm" }, { status: 500 });
  }
}
