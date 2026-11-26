/**
 * Issue a usage right.
 *
 *   POST /api/issue  { record, request_id }                  → { right_id, … }   signed here
 *   POST /api/issue  { record, request_id, envelope: true }  → { xdr, … }        for the CLI
 *   POST /api/issue  { record, secret_hash }                 → the same, with an h typed in
 *
 * Two ways (src/lib/issuance.ts):
 *
 * - **Signed here**, where the deployment holds the issuer key (the testnet
 *   demo). The week is issued and attested at once.
 * - **As an envelope** (Step 5 plan, item 3, 2026-11-27): the unsigned
 *   `issue` call, built and simulated here, for the issuer to review, sign
 *   and send with `scripts/mainnet-sign-submit.sh`. Then
 *   `POST /api/issue/confirm` reads it back from the chain by its hash and
 *   closes the ask. The only way where the server holds no issuer key: `cli`
 *   mode, always on mainnet.
 *
 * Only the issuer can issue, and the contract enforces that independently.
 * This route also requires the caller's session to be the issuer's (SEP-10:
 * Freighter, or a challenge signed with the CLI), so nobody who merely finds
 * the URL can drive it.
 *
 * In order: validate the record and the owner's `h`, compute the record's
 * digest `d` and the commitment `C = Poseidon(d, owner, h)`, then issue on
 * chain with `C` (or build the envelope that will). `h = Poseidon(s)` is all
 * the owner sends; the secret `s` never reaches this server. Poseidon runs in
 * the circuit, the command line and here; never in the contract and never in
 * a browser (`npm run zk:check-bundle`).
 */

import { Keypair } from "@stellar/stellar-sdk";

import { attestationStoreIsWritable } from "@/lib/attestation-store";
import { explorer, hasIssuerSecret, issuerSecret } from "@/lib/config";
import { ContractCallError, ENVELOPE_SECONDS, buildIssueEnvelope, buildIssueTx, prepare, readIssuer, readNextId, signWith, submit } from "@/lib/contract";
import { IssuanceRefused, attestIssued, prepareIssuance } from "@/lib/issuance";
import { RecordValidationError } from "@/lib/record";
import { RequestStoreUnavailable, markIssued, recordDirectIssuance } from "@/lib/requests";
import { authenticatedAccount } from "@/lib/sep10";

export async function POST(request: Request): Promise<Response> {
  let body: { record?: unknown; secret_hash?: unknown; request_id?: unknown; envelope?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }
  const asEnvelope = body.envelope === true;

  // Signing here needs the key, and somewhere to keep the attestation. An
  // envelope needs neither: the CLI signs it, and there is no attestation in
  // `cli` mode.
  if (!asEnvelope && !hasIssuerSecret()) {
    return Response.json(
      {
        error:
          "this deployment does not hold the issuer key, so it cannot sign an issuance. " +
          "Build the envelope instead and sign it with the CLI.",
        read_only: true,
        envelope_only: true,
      },
      { status: 503 },
    );
  }
  if (!asEnvelope && !(await attestationStoreIsWritable())) {
    return Response.json(
      {
        error:
          "this deployment cannot issue: it has nowhere to record the attestation. Issue " +
          "where the issuer key and its records live.",
        read_only: true,
      },
      { status: 503 },
    );
  }

  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json(
      { error: "not authenticated — sign in as the issuer (wallet, or the CLI)" },
      { status: 401 },
    );
  }

  try {
    // The contract's issuer, read from the chain: in `cli` mode there is no key
    // here to take it from, and signed here it must be the same account.
    const issuerAddress = asEnvelope ? await readIssuer() : Keypair.fromSecret(issuerSecret()).publicKey();
    if (caller !== issuerAddress) {
      return Response.json(
        { error: "only the issuer can issue usage rights", authenticated_as: caller, issuer: issuerAddress },
        { status: 403 },
      );
    }

    const prepared = await prepareIssuance(body, issuerAddress);
    const issueParams = {
      issuer: issuerAddress,
      owner: prepared.record.owner.stellar_account,
      period: prepared.windows.period,
      validity: prepared.windows.validity,
      commitment: prepared.commitment,
    };

    if (asEnvelope) {
      // Issued only from an owner's ask, so the confirmation can find the h
      // and close it: a week whose secret no browser holds could never be
      // rented out or sold (D15).
      if (!prepared.requestId) {
        return Response.json({ error: "an envelope is built only from an owner's request" }, { status: 400 });
      }
      const tx = await buildIssueEnvelope(issueParams);
      return Response.json({
        xdr: tx.toXDR(),
        commitment: prepared.commitment,
        request_id: prepared.requestId,
        owner: issueParams.owner,
        expected_right_id: await readNextId(),
        valid_until: new Date(Number(tx.timeBounds!.maxTime) * 1000).toISOString(),
        valid_seconds: ENVELOPE_SECONDS,
        fee_stroops: tx.fee,
      });
    }

    const issuer = Keypair.fromSecret(issuerSecret());
    const rightId = await readNextId();
    const tx = await buildIssueTx(issueParams);
    const result = await submit(signWith(await prepare(tx), issuer));
    if (!result.successful) {
      return Response.json({ error: result.failure ?? "the contract rejected the issuance", tx: result.hash }, { status: 400 });
    }

    const { clean, attestation, attestationPath } = await attestIssued(issuer, prepared, rightId);

    // The week is on chain whatever happens here; a request left open is said so.
    let requestNote: string | undefined;
    try {
      if (prepared.requestId) {
        await markIssued(prepared.requestId, { right_id: rightId, tx: result.hash });
      } else {
        await recordDirectIssuance({
          owner: prepared.record.owner.stellar_account,
          secret_hash: prepared.h.toString(),
          right_id: rightId,
          tx: result.hash,
        });
      }
    } catch (caught) {
      requestNote = caught instanceof RequestStoreUnavailable ? caught.message : "the request could not be closed";
    }

    return Response.json({
      right_id: rightId,
      record_digest: prepared.recordDigest,
      commitment: prepared.commitment,
      canonical_bytes: prepared.canonicalBytes,
      windows: prepared.windows,
      tx: result.hash,
      explorer: result.explorer ?? explorer.tx(result.hash),
      attested_clean: clean,
      attestation,
      attestation_path: attestationPath,
      ...(prepared.requestId ? { request_id: prepared.requestId } : {}),
      ...(requestNote ? { request_note: requestNote } : {}),
      note: clean
        ? "The issuer attests this week is valid and free of unpaid maintenance fees."
        : "Issued, but NOT attested clean: the record shows maintenance fees outstanding. " +
          "A counterparty verifying this week will see that check fail.",
    });
  } catch (error) {
    if (error instanceof IssuanceRefused) {
      return Response.json({ error: error.message, ...error.extra }, { status: error.status });
    }
    if (error instanceof RecordValidationError) {
      return Response.json({ error: `record is not valid: ${error.message}` }, { status: 400 });
    }
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[/api/issue] unexpected failure:", error);
    return Response.json({ error: error instanceof Error ? error.message : "issuance failed" }, { status: 500 });
  }
}
