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
 *
 * ## The public description
 *
 * Where the week is, how many it sleeps and what it offers are derived from the
 * record and need no flags. The overrides exist for one case: a record committed
 * before those fields were in the schema cannot gain them, because editing it
 * would break its commitment, and such a week would otherwise be listed as a
 * bare country with nothing else said about it.
 *
 *   --region <text>             town and country, e.g. "Lagos, Portugal"
 *   --sleeps <n>                how many people the unit sleeps
 *   --features <a, b, c>        what it offers, comma separated
 *
 * An overridden value is signed but not covered by the commitment, so a buyer
 * holding the record cannot check it. The script says so every time.
 *
 * Do not put the resort or the unit in any of them: this is what a buyer reads
 * *before* being trusted with the record, and it is public to everyone.
 */

import { signAttestation } from "../src/lib/attestation";
import { saveAttestation } from "../src/lib/attestation-store";
import { digestsMatch } from "../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, issuerSecret } from "../src/lib/config";
import { readRight } from "../src/lib/contract";
import { feesAreCurrent, propertyFacts, recordCommitment, validateRecord } from "../src/lib/record";
import { fatal, loadEnv, log, readJson } from "./lib/cli";
import { Keypair } from "@stellar/stellar-sdk";

loadEnv();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));

  // Some flags take a value, and that value must not be mistaken for one of the
  // two positional arguments. Reading them through here records where each value
  // sat, so the positional filter below can skip exactly those slots — the
  // alternative, testing indices by hand, gets subtly wrong the moment a second
  // valued flag is added.
  const valueSlots = new Set<number>();
  const valued = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    if (at === -1) return undefined;
    valueSlots.add(at + 1);
    return args[at + 1];
  };

  const paidThroughOverride = valued("--fees-paid-through");
  const regionOverride = valued("--region");
  const rawSleeps = valued("--sleeps");
  const rawFeatures = valued("--features");

  const positional = args.filter((a, i) => !a.startsWith("--") && !valueSlots.has(i));
  const [rawId, recordPath] = positional;

  if (!rawId || !recordPath) {
    console.error(
      "usage: npm run attest -- <right_id> <record.json> " +
        "[--fees-current | --fees-outstanding] [--fees-paid-through YYYY-MM-DD] " +
        "[--region <text>] [--sleeps <n>] [--features <a, b, c>]",
    );
    process.exit(1);
  }
  if (flags.has("--fees-current") && flags.has("--fees-outstanding")) {
    throw new Error("--fees-current and --fees-outstanding contradict each other");
  }
  if (flags.has("--fees-paid-through") && !/^\d{4}-\d{2}-\d{2}$/.test(paidThroughOverride ?? "")) {
    throw new Error("--fees-paid-through needs an ISO date (YYYY-MM-DD)");
  }
  if (flags.has("--region") && !regionOverride?.trim()) {
    throw new Error('--region needs a value, e.g. --region "Lagos, Portugal"');
  }
  const sleepsOverride = rawSleeps === undefined ? undefined : Number(rawSleeps);
  if (flags.has("--sleeps") && (!Number.isInteger(sleepsOverride) || (sleepsOverride ?? 0) < 1)) {
    throw new Error("--sleeps needs a whole number of people, at least 1");
  }
  const featuresOverride = rawFeatures
    ?.split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (flags.has("--features") && !featuresOverride?.length) {
    throw new Error('--features needs a comma-separated list, e.g. --features "pool, wifi"');
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

  // Everything the listing publishes, derived from the record so that it cannot
  // drift from the document the ledger committed to by mere inattention.
  const derived = propertyFacts(record);
  const property = {
    ...derived,
    ...(regionOverride ? { region: regionOverride.trim() } : {}),
    ...(sleepsOverride !== undefined ? { sleeps: sleepsOverride } : {}),
    ...(featuresOverride ? { features: featuresOverride } : {}),
  };

  const overridden = (["region", "sleeps", "features"] as const).filter(
    (key) => JSON.stringify(property[key]) !== JSON.stringify(derived[key]),
  );
  if (overridden.length > 0) {
    log.warn(`overridden by flag: ${overridden.join(", ")}`);
    log.warn(
      "an overridden value is the issuer's word alone — it is signed, but it is not covered " +
        "by the commitment, so a buyer holding the record cannot check it",
    );
  }

  // Records committed before these fields existed cannot gain them: editing one
  // would break its commitment. The flags are how such a week still gets a
  // description worth reading.
  const missing = (["city", "sleeps", "features"] as const).filter(
    (key) => record.resort[key] === undefined,
  );
  if (missing.length > 0 && overridden.length === 0) {
    log.warn(
      `this record predates resort.${missing.join(", resort.")} — pass ` +
        "--region / --sleeps / --features to publish what it cannot supply",
    );
  }

  const attestation = signAttestation(issuer, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId,
    commitment,
    weekValid: true,
    property,
    feesCurrent: clean,
    feesPaidThrough,
    validForDays: 365,
  });

  const path = await saveAttestation(rightId, attestation);

  log.step("Signed");
  log.ok(`${path}`);
  log.info(`region            ${property.region}`);
  log.info(`sleeps            ${property.sleeps ?? "not stated"}`);
  log.info(`features          ${property.features?.join(" · ") ?? "not stated"}`);
  log.info(`fees current      ${clean}`);
  log.info(`paid through      ${attestation.payload.fees_paid_through}`);
  log.info(`valid until       ${attestation.payload.expires_at}`);
  log.info("");
  log.info("Check it:");
  log.info(`  npm run verify-record -- ${rightId} ${recordPath} ${path}`);
}

main().catch(fatal);
