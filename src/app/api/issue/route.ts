/**
 * Issue a usage right.
 *
 *   POST /api/issue  { record }  → { right_id, commitment, tx, attestation }
 *
 * Only the issuer can issue, and the contract enforces that independently. This
 * route additionally requires the caller to have proved control of the issuer's
 * account over SEP-10, so the deployment's issuing key cannot be driven by anyone
 * who merely finds the URL.
 *
 * What happens here, in order: validate the record, commit to it, issue on chain,
 * and — only if the record itself says maintenance fees are settled — sign an
 * attestation to that effect. The issuer is trusted to attest honestly, and
 * attesting a week it can see carries arrears would be exactly the dishonesty the
 * trust model is supposed to make visible.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { signAttestation } from "@/lib/attestation";
import { attestationStoreIsWritable, saveAttestation } from "@/lib/attestation-store";
import { canonicalText } from "@/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, hasIssuerSecret, issuerSecret } from "@/lib/config";
import { ContractCallError, buildIssueTx, prepare, readNextId, signWith, submit } from "@/lib/contract";
import {
  RecordValidationError,
  feesAreCurrent,
  onChainWindows,
  propertyFacts,
  recordCommitment,
  validateRecord,
} from "@/lib/record";
import { authenticatedAccount } from "@/lib/sep10";

export async function POST(request: Request): Promise<Response> {
  // A deployment without the issuer key cannot sign, and says so rather than
  // failing on a missing environment variable. See `hasIssuerSecret`.
  if (!hasIssuerSecret()) {
    return Response.json(
      {
        error:
          "this deployment is read-only: it does not hold the issuer key, so it cannot " +
          "issue, attest, or approve a transfer. Browsing and verification need no key.",
        read_only: true,
      },
      { status: 503 },
    );
  }

  // Asked here, before anything is submitted, because the issuance cannot be
  // undone and the attestation is not optional: a right issued without one is a
  // right nobody can transfer. A host holding the key but with nothing writable
  // — a serverless deployment given the key by mistake — used to get as far as
  // the ledger and fail on `EROFS` afterwards.
  if (!(await attestationStoreIsWritable())) {
    return Response.json(
      {
        error:
          "this deployment cannot issue: it has nowhere to record the attestation, and a " +
          "right issued without one could never be transferred. Issue where the issuer key " +
          "and its records live.",
        read_only: true,
      },
      { status: 503 },
    );
  }

  const issuer = Keypair.fromSecret(issuerSecret());

  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json(
      { error: "not authenticated — connect the issuer's wallet and sign in" },
      { status: 401 },
    );
  }
  if (caller !== issuer.publicKey()) {
    return Response.json(
      {
        error: "only the issuer can issue usage rights",
        authenticated_as: caller,
        issuer: issuer.publicKey(),
      },
      { status: 403 },
    );
  }

  let body: { record?: unknown };
  try {
    body = (await request.json()) as { record?: unknown };
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  try {
    const record = validateRecord(body.record);
    const canonical = canonicalText(record as never);
    const commitment = await recordCommitment(record);
    const windows = onChainWindows(record);

    const rightId = await readNextId();
    const tx = await buildIssueTx({
      issuer: issuer.publicKey(),
      owner: record.owner.stellar_account,
      period: windows.period,
      validity: windows.validity,
      commitment,
    });
    const result = await submit(signWith(await prepare(tx), issuer));

    if (!result.successful) {
      return Response.json(
        { error: result.failure ?? "the contract rejected the issuance", tx: result.hash },
        { status: 400 },
      );
    }

    const clean = feesAreCurrent(record);
    const attestation = signAttestation(issuer, {
      contract: CONTRACT_ID,
      network: NETWORK_PASSPHRASE,
      rightId,
      commitment,
      weekValid: true,
      // Where it is, how big it is, what it offers — everything someone
      // deciding to take the week needs, and nothing that names the apartment.
      property: propertyFacts(record),
      feesCurrent: clean,
      feesPaidThrough: record.maintenance_fees.paid_through,
      validForDays: 365,
    });

    // Record it. The approval service will not approve a transfer of a week the
    // issuer has no attestation for, so a right issued without this step would be
    // untransferable — returning the attestation to the browser is not enough.
    const attestationPath = await saveAttestation(rightId, attestation);

    return Response.json({
      right_id: rightId,
      commitment,
      canonical_bytes: canonical.length,
      windows,
      tx: result.hash,
      explorer: result.explorer,
      attested_clean: clean,
      attestation,
      attestation_path: attestationPath,
      note: clean
        ? "The issuer attests this week is valid and free of unpaid maintenance fees."
        : "Issued, but NOT attested clean: the record shows maintenance fees outstanding. " +
          "A counterparty verifying this week will see that check fail.",
    });
  } catch (error) {
    if (error instanceof RecordValidationError) {
      return Response.json({ error: `record is not valid: ${error.message}` }, { status: 400 });
    }
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "issuance failed" },
      { status: 500 },
    );
  }
}
