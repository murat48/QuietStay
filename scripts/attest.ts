/**
 * Sign an issuer attestation for a right that already exists.
 *
 *   npm run attest -- <right_id> <record.json> [--fees-outstanding]
 *
 * `npm run seed` and the issue screen both attest at issuance, so this is for the
 * cases that come later:
 *
 *   - arrears have been settled, and a week that was attested unclean should now
 *     get a clean attestation;
 *   - an attestation has expired and needs reissuing;
 *   - the deployment's attestation store was lost and needs rebuilding.
 *
 * The commitment is not taken on trust. It is recomputed from the record and
 * checked against what the contract holds, so this cannot mint an attestation for
 * a record the ledger never committed to.
 *
 * `--fees-outstanding` signs an attestation that says the week is **not** clean.
 * That is a legitimate thing for an issuer to publish, and the verify screen and
 * the approval service both act on it.
 */

import { signAttestation } from "../src/lib/attestation";
import { saveAttestation } from "../src/lib/attestation-store";
import { digestsMatch } from "../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, issuerSecret } from "../src/lib/config";
import { readRight } from "../src/lib/contract";
import { feesAreCurrent, recordCommitment, validateRecord } from "../src/lib/record";
import { fatal, loadEnv, log, readJson } from "./lib/cli";
import { Keypair } from "@stellar/stellar-sdk";

loadEnv();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const [rawId, recordPath] = args.filter((a) => !a.startsWith("--"));

  if (!rawId || !recordPath) {
    console.error("usage: npm run attest -- <right_id> <record.json> [--fees-outstanding]");
    process.exit(1);
  }

  const rightId = Number(rawId);
  if (!Number.isInteger(rightId) || rightId < 1) {
    throw new Error("right_id must be a positive integer");
  }

  const issuer = Keypair.fromSecret(issuerSecret());
  const record = validateRecord(readJson(recordPath));
  const right = await readRight(rightId);

  log.step(`Attesting right #${rightId}`);
  log.info(`contract  ${CONTRACT_ID}`);
  log.info(`issuer    ${issuer.publicKey()}`);

  if (right.issuer !== issuer.publicKey()) {
    throw new Error(
      `this right was issued by ${right.issuer}, not by ${issuer.publicKey()} — ` +
        "only the issuer the contract records can attest for it",
    );
  }

  // The record must be the one the ledger committed to. Without this check the
  // script would happily sign an attestation binding an arbitrary document to a
  // right, which is precisely the substitution the commitment exists to prevent.
  const commitment = await recordCommitment(record);
  if (!digestsMatch(commitment, right.commitment)) {
    throw new Error(
      `the record does not match right #${rightId}:\n` +
        `  record hashes to  0x${commitment}\n` +
        `  the ledger holds  0x${right.commitment}`,
    );
  }
  log.ok(`record matches the on-chain commitment 0x${commitment}`);

  const clean = flags.has("--fees-outstanding") ? false : feesAreCurrent(record);
  if (flags.has("--fees-outstanding")) {
    log.warn("--fees-outstanding given: signing an attestation that the week is NOT clean");
  } else if (!clean) {
    log.warn(
      `the record shows ${record.maintenance_fees.outstanding} ` +
        `${record.maintenance_fees.currency} outstanding, so the attestation will say the week ` +
        "is not clean",
    );
  }

  const attestation = signAttestation(issuer, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId,
    commitment,
    weekValid: true,
    feesCurrent: clean,
    feesPaidThrough: record.maintenance_fees.paid_through,
    validForDays: 365,
  });

  const path = saveAttestation(rightId, attestation);

  log.step("Signed");
  log.ok(`${path}`);
  log.info(`fees current      ${clean}`);
  log.info(`paid through      ${attestation.payload.fees_paid_through}`);
  log.info(`valid until       ${attestation.payload.expires_at}`);
  log.info("");
  log.info("Check it:");
  log.info(`  npm run verify-record -- ${rightId} ${recordPath} ${path}`);
}

main().catch(fatal);
