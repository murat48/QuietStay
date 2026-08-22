/**
 * Issue the sample inventory on testnet.
 *
 *   npm run seed
 *
 * For each record in `inventory/records/`:
 *   1. validate it, and commit to it — SHA-256 over its canonical bytes
 *   2. `issue` the right on chain with that commitment and the derived windows
 *   3. write an issuer-signed attestation, **if the record warrants one**
 *
 * Step 3 is where the issuer's judgement enters. Week 04 carries unpaid
 * maintenance fees, so the issuer declines to attest it as clean and the file it
 * writes says so. That is the honest behaviour, and it gives the verify screen
 * something real to reject.
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { Keypair } from "@stellar/stellar-sdk";

import { signAttestation } from "../src/lib/attestation";
import { canonicalText } from "../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, explorer, issuerSecret } from "../src/lib/config";
import { buildIssueTx, prepare, readNextId, signWith, submit } from "../src/lib/contract";
import {
  feesAreCurrent,
  onChainWindows,
  propertyFacts,
  recordCommitment,
  unixToIsoDate,
  validateRecord,
  type OwnershipRecord,
} from "../src/lib/record";
import { fatal, loadEnv, log, readJson, writeCanonical, writeJson } from "./lib/cli";

loadEnv();

interface IssuedEntry {
  right_id: number;
  record_file: string;
  canonical_file: string;
  commitment: string;
  attestation_file: string;
  attested: boolean;
  issue_tx: string;
  week: { check_in: string; check_out: string; use_year: number };
  bedrooms: number;
}

async function main(): Promise<void> {
  const issuer = Keypair.fromSecret(issuerSecret());

  log.step("Issuer");
  log.info(`account   ${issuer.publicKey()}`);
  log.info(`contract  ${CONTRACT_ID}`);
  log.link("explorer", explorer.contract());

  const recordFiles = readdirSync("inventory/records")
    .filter((f) => f.endsWith(".json"))
    .sort();

  const issued: IssuedEntry[] = [];

  for (const file of recordFiles) {
    const recordPath = join("inventory/records", file);
    const stem = basename(file, ".json");
    const record: OwnershipRecord = validateRecord(readJson(recordPath));

    const canonical = canonicalText(record as never);
    const commitment = await recordCommitment(record);
    const windows = onChainWindows(record);

    const canonicalPath = join("inventory/canonical", `${stem}.canonical.json`);
    writeCanonical(canonicalPath, canonical);

    log.step(`${file} — ${record.week.check_in} .. ${record.week.check_out}`);
    log.info(`commitment  ${commitment}`);
    log.info(
      `windows     week ${unixToIsoDate(windows.period.start)}..${unixToIsoDate(windows.period.end)}, ` +
        `use year ${unixToIsoDate(windows.validity.from)}..${unixToIsoDate(windows.validity.until)}`,
    );

    // The contract assigns ids from a counter, so the id this issuance will take
    // is whatever `next_id` says before we send it.
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
      log.fail(`issue failed: ${result.failure}`);
      log.link("tx", result.explorer);
      throw new Error(`could not issue ${file}`);
    }
    log.ok(`issued as right #${rightId}`);
    log.link("tx", result.explorer);

    // --- the attestation ---------------------------------------------------
    const clean = feesAreCurrent(record);
    const attestation = signAttestation(issuer, {
      contract: CONTRACT_ID,
      network: NETWORK_PASSPHRASE,
      rightId,
      commitment,
      weekValid: true,
      property: propertyFacts(record),
      feesCurrent: clean,
      feesPaidThrough: record.maintenance_fees.paid_through,
      validForDays: 365,
    });

    const attestationPath = join("inventory/attestations", `right-${rightId}.attestation.json`);
    writeJson(attestationPath, attestation);

    if (clean) {
      log.ok(`attested clean, fees paid through ${record.maintenance_fees.paid_through}`);
    } else {
      log.warn(
        `attested NOT clean — ${record.maintenance_fees.outstanding} ` +
          `${record.maintenance_fees.currency} outstanding. A verifier will reject this week.`,
      );
    }

    issued.push({
      right_id: rightId,
      record_file: recordPath,
      canonical_file: canonicalPath,
      commitment,
      attestation_file: attestationPath,
      attested: clean,
      issue_tx: result.hash,
      week: {
        check_in: record.week.check_in,
        check_out: record.week.check_out,
        use_year: record.week.use_year,
      },
      bedrooms: record.resort.bedrooms,
    });
  }

  writeJson("inventory/issued.json", {
    note:
      "Maps issued rights to their off-chain records. The records themselves are sample data " +
      "and are published here only so reviewers can recompute commitments; in a real deployment " +
      "they would never leave the parties who hold them.",
    network: NETWORK_PASSPHRASE,
    contract: CONTRACT_ID,
    issuer: issuer.publicKey(),
    rights: issued,
  });

  log.step("Done");
  log.ok(`${issued.length} rights issued, index written to inventory/issued.json`);
}

main().catch(fatal);
