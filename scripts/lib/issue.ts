/**
 * Issue a right from a record, in one step: commit, issue, attest.
 *
 * Shared by `seed-inventory` (which issues the published sample weeks) and
 * `produce-evidence` (which issues its own throwaway weeks, so that it can be
 * run any number of times without depending on state a previous run left
 * behind).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Keypair } from "@stellar/stellar-sdk";

import { signAttestation, type Attestation } from "../../src/lib/attestation";
import { canonicalText } from "../../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE } from "../../src/lib/config";
import { buildIssueTx, prepare, readNextId, signWith, submit } from "../../src/lib/contract";
import {
  feesAreCurrent,
  onChainWindows,
  recordCommitment,
  regionLabel,
  validateRecord,
  type OwnershipRecord,
} from "../../src/lib/record";
import { writeCanonical, writeJson } from "./cli";

export interface IssuedRight {
  rightId: number;
  commitment: string;
  attested: boolean;
  attestation: Attestation;
  issueTx: string;
  canonicalPath: string;
  attestationPath: string;
}

/**
 * Commit to `record`, issue the right, and write the issuer's attestation.
 *
 * The attestation asserts fees are current only when the record says they are —
 * the issuer is trusted to attest honestly, and a script that attested a week it
 * knew carried arrears would be modelling a dishonest one.
 */
export async function issueFromRecord(
  issuer: Keypair,
  record: OwnershipRecord,
  outputDir: { canonical: string; attestations: string },
  stem: string,
): Promise<IssuedRight> {
  validateRecord(record);

  const canonical = canonicalText(record as never);
  const commitment = await recordCommitment(record);
  const windows = onChainWindows(record);

  const canonicalPath = join(outputDir.canonical, `${stem}.canonical.json`);
  writeCanonical(canonicalPath, canonical);

  // The contract assigns ids from a counter, so the id this issuance takes is
  // whatever `next_id` reports immediately before it.
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
    throw new Error(`could not issue ${stem}: ${result.failure}`);
  }

  const clean = feesAreCurrent(record);
  const attestation = signAttestation(issuer, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId,
    commitment,
    weekValid: true,
    region: regionLabel(record),
    feesCurrent: clean,
    feesPaidThrough: record.maintenance_fees.paid_through,
    validForDays: 365,
  });

  const attestationPath = join(outputDir.attestations, `right-${rightId}.attestation.json`);
  writeJson(attestationPath, attestation);

  return {
    rightId,
    commitment,
    attested: clean,
    attestation,
    issueTx: result.hash,
    canonicalPath,
    attestationPath,
  };
}

/**
 * A throwaway record for the evidence run, unique on every invocation.
 *
 * Fresh `record_id` and `salt` mean fresh commitments, so each run issues rights
 * nobody has touched — which is what makes the evidence reproducible rather than
 * a one-time snapshot.
 */
export function evidenceRecord(params: {
  ownerAccount: string;
  unit: string;
  checkIn: string;
  checkOut: string;
  useYear: number;
  weekNumber: number;
}): OwnershipRecord {
  return {
    schema: "quietstay.ownership-record.v1",
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: {
      name: "Evidence Fixture Owner",
      email: "fixture@example.invalid",
      stellar_account: params.ownerAccount,
    },
    resort: {
      name: "Cliffside Bay Club",
      city: "Lagos",
      country: "Portugal",
      unit: params.unit,
      bedrooms: 2,
    },
    week: {
      check_in: params.checkIn,
      check_out: params.checkOut,
      use_year: params.useYear,
      week_number: params.weekNumber,
    },
    title: {
      deed_reference: `EVID-${params.weekNumber}-${randomBytes(3).toString("hex").toUpperCase()}`,
      registry: "Cliffside Bay Club Members Registry",
      recorded_on: "2022-01-10",
    },
    maintenance_fees: {
      annual_amount: "820.00",
      currency: "EUR",
      paid_through: `${params.useYear}-12-31`,
      outstanding: "0.00",
    },
  };
}
