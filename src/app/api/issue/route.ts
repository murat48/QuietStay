/**
 * Issue a usage right.
 *
 *   POST /api/issue  { record, secret_hash }  → { right_id, record_digest, commitment, tx, attestation }
 *
 * Only the issuer can issue, and the contract enforces that independently. This
 * route additionally requires the caller to have proved control of the issuer's
 * account over SEP-10, so the deployment's issuing key cannot be driven by anyone
 * who merely finds the URL.
 *
 * What happens here, in order: validate the record and the owner's `h`, compute
 * the record's digest `d` and the commitment `C = Poseidon(d, owner, h)`, issue on
 * chain with `C`, and sign an attestation bound to `d`, this right and this
 * contract, saying whether maintenance fees are settled.
 *
 * `h = Poseidon(s)` is all the owner sends; the secret `s` never reaches this
 * server. `C` is computed with `commitment` from scripts/lib/zk.ts — the module
 * `npm run zk:commitment` and `zk:issue` use, on the one Poseidon implementation
 * in circuits/gpl/ — so the app and the command line cannot disagree about it.
 * Poseidon runs in the circuit, the command line and here; never in the contract
 * and never in a browser (`npm run zk:check-bundle`). Any holder or buyer can
 * confirm `C` later with `npm run verify-record -- … --secret-hash <h>`.
 */

import { Keypair } from "@stellar/stellar-sdk";

// Server only: a route handler, never part of the browser bundle. GPL-3.0 code
// is reached through this import — see the license section of the README.
import { commitment as poseidonCommitment, splitRecordDigest } from "../../../../scripts/lib/zk";
import { fr } from "../../../../scripts/lib/zk-encode";

import { signAttestation } from "@/lib/attestation";
import { attestationStoreIsWritable, saveAttestation } from "@/lib/attestation-store";
import { canonicalText, type JsonValue } from "@/lib/canonical";
import { parseSecretHash } from "@/lib/consent";
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
          "issue or attest. Browsing, verifying and transfers need no issuer key.",
        read_only: true,
      },
      { status: 503 },
    );
  }

  // Asked here, before anything is submitted, because the issuance cannot be
  // undone: a right issued with nowhere to put its attestation would leave buyers
  // nothing to read. A host holding the key but with nothing writable — a
  // serverless deployment given the key by mistake — used to get as far as the
  // ledger and fail on `EROFS` afterwards.
  if (!(await attestationStoreIsWritable())) {
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

  let body: { record?: unknown; secret_hash?: unknown };
  try {
    body = (await request.json()) as { record?: unknown; secret_hash?: unknown };
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  try {
    const record = validateRecord(body.record);
    const canonical = canonicalText(record as never);
    // d — what the attestation binds. Phase 1 stored it on chain; Phase 2 wraps it.
    const recordDigest = await recordCommitment(record);
    // Checked before anything is submitted: a malformed h would otherwise make a
    // commitment nobody can prove against, and the issuance cannot be undone.
    let h: bigint;
    try {
      h = parseSecretHash(body.secret_hash);
    } catch (caught) {
      return Response.json(
        { error: `secret_hash: ${caught instanceof Error ? caught.message : "not valid"}` },
        { status: 400 },
      );
    }
    const d = await splitRecordDigest(record as unknown as JsonValue);
    const commitment = fr(await poseidonCommitment(d, record.owner.stellar_account, h));
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
      recordDigest,
      weekValid: true,
      // Where it is, how big it is, what it offers — everything someone
      // deciding to take the week needs, and nothing that names the apartment.
      property: propertyFacts(record),
      feesCurrent: clean,
      feesPaidThrough: record.maintenance_fees.paid_through,
      validForDays: 365,
    });

    // Record it, so the registry and buyers can read it — returning it to the
    // browser is not enough. No transfer depends on it.
    const attestationPath = await saveAttestation(rightId, attestation);

    return Response.json({
      right_id: rightId,
      record_digest: recordDigest,
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
