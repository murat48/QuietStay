/**
 * Attach a public description to a right whose record the issuer no longer has.
 *
 *   npm run describe -- <right_id> --region "Town, Country" --bedrooms <n>
 *                       [--sleeps <n>] [--features "a, b, c"]
 *
 * `npm run attest` is the normal way to describe a week, and it should be
 * preferred whenever the record is to hand: it derives the description from the
 * committed document, so what gets published cannot contradict what a buyer will
 * later be shown. This script exists for the case where that is impossible.
 *
 * ## When that happens
 *
 * A record is the issuer's own document and nothing stores it for them. A week
 * issued through the app before `npm run describe` existed — or by an operator who
 * closed the tab without keeping the JSON — leaves a right on the ledger, an
 * attestation on file, and no way to derive anything. Such a week is listed with
 * nothing said about where it is or what it offers, which is no use to anyone
 * deciding whether to take it.
 *
 * ## What this can and cannot do
 *
 * Every value here is the issuer's word alone. There is no record to check them
 * against, so a buyer holding one cannot confirm them the way they can confirm a
 * derived description. That is a real reduction in what verification is worth, and
 * it is the reason this is a separate command with its own warning rather than
 * another flag on `attest`.
 *
 * What it still cannot do is launder a mismatch: the attestation on file must
 * already commit to the record the ledger holds, or this refuses. And it restates
 * rather than originates — `week_valid` and the fee position are carried over
 * untouched, because this script learns nothing new about either.
 */

import { signAttestation } from "../src/lib/attestation";
import { loadAttestation, saveAttestation } from "../src/lib/attestation-store";
import { digestsMatch } from "../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, issuerSecret } from "../src/lib/config";
import { readRight } from "../src/lib/contract";
import type { PropertyFacts } from "../src/lib/record";
import { fatal, loadEnv, log } from "./lib/cli";
import { Keypair } from "@stellar/stellar-sdk";

loadEnv();

const USAGE =
  'usage: npm run describe -- <right_id> --region "Town, Country" --bedrooms <n> ' +
  '[--sleeps <n>] [--features "a, b, c"]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Same shape as `attest`: reading a valued flag records where its value sat, so
  // the positional filter can skip exactly those slots.
  const valueSlots = new Set<number>();
  const valued = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    if (at === -1) return undefined;
    valueSlots.add(at + 1);
    return args[at + 1];
  };

  const region = valued("--region")?.trim();
  const rawBedrooms = valued("--bedrooms");
  const rawSleeps = valued("--sleeps");
  const rawFeatures = valued("--features");

  const [rawId] = args.filter((a, i) => !a.startsWith("--") && !valueSlots.has(i));

  const rightId = Number(rawId);
  if (!Number.isInteger(rightId) || rightId < 1) {
    console.error(USAGE);
    throw new Error("right_id must be a positive integer");
  }
  if (!region) {
    console.error(USAGE);
    throw new Error('--region is required, e.g. --region "Lagos, Portugal"');
  }

  const bedrooms = Number(rawBedrooms);
  if (!Number.isInteger(bedrooms) || bedrooms < 0) {
    console.error(USAGE);
    throw new Error("--bedrooms is required and must be a whole number");
  }

  const sleeps = rawSleeps === undefined ? undefined : Number(rawSleeps);
  if (sleeps !== undefined && (!Number.isInteger(sleeps) || sleeps < 1)) {
    throw new Error("--sleeps must be a whole number of people, at least 1");
  }

  const features = rawFeatures
    ?.split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (rawFeatures !== undefined && !features?.length) {
    throw new Error('--features needs a comma-separated list, e.g. --features "pool, wifi"');
  }

  const issuer = Keypair.fromSecret(issuerSecret());

  // Restating, not originating. `week_valid` is a claim about the week itself and
  // the fee position is the issuer's current statement about arrears; neither is
  // this script's to invent, so a week nothing has been signed for yet must go
  // through issuance or `npm run attest` first.
  const existing = await loadAttestation(rightId);
  if (existing === null) {
    throw new Error(
      `no attestation exists for right #${rightId} to describe — ` +
        "issue the week or run `npm run attest` from its record first",
    );
  }

  const right = await readRight(rightId);

  log.step(`Describing right #${rightId}`);
  log.info(`contract  ${CONTRACT_ID}`);
  log.info(`issuer    ${issuer.publicKey()}`);

  if (right.issuer !== issuer.publicKey()) {
    throw new Error(
      `this right was issued by ${right.issuer}, not by ${issuer.publicKey()} — ` +
        "only the issuer the contract records can attest for it",
    );
  }

  // The attestation on file must already be about the record the ledger holds. If
  // it is not, the store is out of step with the chain and re-signing would
  // launder that discrepancy into a fresh, valid-looking signature.
  if (!digestsMatch(existing.payload.commitment, right.commitment)) {
    throw new Error(
      `the attestation on file commits to a different record than the ledger holds:\n` +
        `  on file   0x${existing.payload.commitment}\n` +
        `  on chain  0x${right.commitment}`,
    );
  }
  log.ok(`the attestation on file matches the ledger, 0x${right.commitment}`);

  if (existing.payload.property) {
    log.warn(
      `right #${rightId} is already described as "${existing.payload.property.region}" — ` +
        "this replaces that description",
    );
  }

  log.warn(
    "nothing here is derived from a record: these values are the issuer's word alone, " +
      "and a buyer holding the record cannot check them",
  );

  const property: PropertyFacts = {
    region,
    bedrooms,
    ...(sleeps !== undefined ? { sleeps } : {}),
    ...(features?.length ? { features } : {}),
  };

  const attestation = signAttestation(issuer, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId,
    commitment: right.commitment,
    // Carried over untouched. This script knows nothing new about whether the week
    // is a real interval or what is owed on it, and dropping either would quietly
    // un-attest the week on the way through.
    weekValid: existing.payload.week_valid,
    feesCurrent: existing.payload.maintenance_fees_current,
    feesPaidThrough: existing.payload.fees_paid_through,
    property,
    validForDays: 365,
  });

  const path = await saveAttestation(rightId, attestation);

  log.step("Signed");
  log.ok(`${path}`);
  log.info(`region            ${property.region}`);
  log.info(`bedrooms          ${property.bedrooms}`);
  log.info(`sleeps            ${property.sleeps ?? "not stated"}`);
  log.info(`features          ${property.features?.join(" · ") ?? "not stated"}`);
  log.info(`fees current      ${attestation.payload.maintenance_fees_current} (carried over)`);
  log.info(`valid until       ${attestation.payload.expires_at}`);
}

main().catch(fatal);
