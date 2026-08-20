/**
 * Sign an issuer attestation for a right that already exists.
 *
 *   npm run attest -- <right_id> <record.json> [flags]
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
 * ## Fee status is not read off the record alone
 *
 * A record's `maintenance_fees` block is a snapshot taken at issuance, and it can
 * never be edited afterwards — the commitment is immutable, so an edited record
 * would stop hashing to what the ledger holds. Deriving fee status from it alone
 * would therefore make the first case above impossible: a week attested unclean
 * could never become clean, no matter who paid what.
 *
 * So the record supplies the default and two flags override it, in either
 * direction. Both are legitimate things for an issuer to publish, and the verify
 * screen and the approval service act on whichever is signed:
 *
 *   --fees-outstanding          the week is NOT clean
 *   --fees-current              the week IS clean — arrears have been settled
 *   --fees-paid-through <date>  the date fees are now settled through
 *
 * The same restatement is available to the issuer in the app, on the list screen.
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

  // `--fees-paid-through <date>` takes a value, so its argument is not a
  // positional one.
  const throughIndex = args.indexOf("--fees-paid-through");
  const paidThroughOverride = throughIndex === -1 ? undefined : args[throughIndex + 1];
  // Guard on the flag being present at all: `indexOf` returns -1 when it is not,
  // and -1 + 1 addresses the first positional argument rather than nothing.
  const valueIndex = throughIndex === -1 ? -1 : throughIndex + 1;
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== valueIndex);
  const [rawId, recordPath] = positional;

  if (!rawId || !recordPath) {
    console.error(
      "usage: npm run attest -- <right_id> <record.json> " +
        "[--fees-current | --fees-outstanding] [--fees-paid-through YYYY-MM-DD]",
    );
    process.exit(1);
  }
  if (flags.has("--fees-current") && flags.has("--fees-outstanding")) {
    throw new Error("--fees-current and --fees-outstanding contradict each other");
  }
  if (throughIndex !== -1 && !/^\d{4}-\d{2}-\d{2}$/.test(paidThroughOverride ?? "")) {
    throw new Error("--fees-paid-through needs an ISO date (YYYY-MM-DD)");
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

  // The record is the default; the flags are the issuer restating what it now
  // knows. Without that override a week attested unclean could never become
  // clean, because the record it was committed from can never be edited.
  let clean = feesAreCurrent(record);
  if (flags.has("--fees-outstanding")) {
    clean = false;
    log.warn("--fees-outstanding given: signing an attestation that the week is NOT clean");
  } else if (flags.has("--fees-current")) {
    clean = true;
    log.warn(
      "--fees-current given: signing a clean attestation, overriding the " +
        `${record.maintenance_fees.outstanding} ${record.maintenance_fees.currency} ` +
        "the record records as outstanding",
    );
  } else if (!clean) {
    log.warn(
      `the record shows ${record.maintenance_fees.outstanding} ` +
        `${record.maintenance_fees.currency} outstanding, so the attestation will say the week ` +
        "is not clean — pass --fees-current if they have since been settled",
    );
  }

  const feesPaidThrough = paidThroughOverride ?? record.maintenance_fees.paid_through;
  if (paidThroughOverride !== undefined) {
    log.warn(
      `--fees-paid-through given: attesting fees settled through ${paidThroughOverride}, ` +
        `not ${record.maintenance_fees.paid_through} as the record has it`,
    );
  } else if (clean && !feesAreCurrent(record)) {
    // Attesting "current" while carrying the record's stale date reads oddly: it
    // says fees are settled, through a date that has passed. The boolean is what
    // gets checked, so this is a warning rather than a refusal.
    log.warn(
      `attesting fees current but keeping the record's date, ${record.maintenance_fees.paid_through} ` +
        "— pass --fees-paid-through to say through when they are actually settled",
    );
  }

  const attestation = signAttestation(issuer, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId,
    commitment,
    weekValid: true,
    feesCurrent: clean,
    feesPaidThrough,
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
