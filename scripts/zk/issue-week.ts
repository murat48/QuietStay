/**
 * Issue one week from the terminal, start to finish.
 *
 *   npm run zk:issue -- --contract <C…> --owner <G…> --check-in 2026-12-05 --check-out 2026-12-12
 *       [--like inventory/records/week-03.json] [--record <existing record.json>]
 *       [--secret <owner secret.json>] [--dir <folder>]
 *
 * What the Issue screen and three commands do between them, in one:
 *
 *   1. the record — an existing one (--record), or a new one built from a sample
 *      (--like, default week 03) with a fresh record_id and 32-byte salt, the
 *      owner's account and the week's dates;
 *   2. the owner's secret — made if the file does not exist, never printed; only
 *      its hash h is used from here on;
 *   3. C = Poseidon(d, owner, h), as `npm run zk:commitment` computes it;
 *   4. `issue` on the contract, signed with the issuer key in .env.local;
 *   5. a v2 attestation bound to d, the new right id and the contract.
 *
 * Files go to --dir (default .secrets/<first 8 of the contract>/, gitignored):
 * the record, the owner's secret, and a summary. Keep the first two — proving a
 * transfer of this week needs both. The attestation goes to
 * inventory/phase2/attestations/ when the contract is the one that folder
 * belongs to (the live app reads it from there once it is committed and pushed),
 * and to --dir otherwise, so a throwaway contract can never write over it.
 *
 * Owner and issuer are the same person here, which is right for a demo or a
 * rehearsal. In real use the owner runs `npm run zk:secret` on their own machine
 * and sends only h; see docs/SETUP.md.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Keypair, rpc, scValToNative } from "@stellar/stellar-sdk";

import { signAttestation } from "../../src/lib/attestation";
import type { JsonValue } from "../../src/lib/canonical";
import { NETWORK_PASSPHRASE, explorer, issuerSecret } from "../../src/lib/config";
import {
  feesAreCurrent,
  isoWeekNumber,
  onChainWindows,
  propertyFacts,
  recordCommitment,
  validateRecord,
  type OwnershipRecord,
} from "../../src/lib/record";
import { fatal, loadEnv, log, writeJson } from "../lib/cli";
import { commitment, randomSecret, secretHash, splitRecordDigest } from "../lib/zk";
import { fr } from "../lib/zk-encode";
import { buildCall, issueArgs, sendAndWait, simulate } from "../lib/zk-tx";

const USAGE =
  "npm run zk:issue -- --contract <C…> --owner <G…> --check-in YYYY-MM-DD --check-out YYYY-MM-DD " +
  "[--like <sample record>] [--record <existing record>] [--secret <file>] [--dir <folder>]";

async function main() {
  loadEnv();
  const { values: a } = parseArgs({
    options: {
      contract: { type: "string" },
      owner: { type: "string" },
      "check-in": { type: "string" },
      "check-out": { type: "string" },
      like: { type: "string", default: "inventory/records/week-03.json" },
      record: { type: "string" },
      secret: { type: "string" },
      dir: { type: "string" },
    },
  });
  const contract = a.contract;
  if (!contract || !/^C[A-Z2-7]{55}$/.test(contract)) throw new Error(`--contract is required\n  usage: ${USAGE}`);
  const dir = resolve(a.dir ?? join(".secrets", contract.slice(0, 8)));
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // --- 1. the record --------------------------------------------------------
  let record: OwnershipRecord;
  let recordFile: string;
  if (a.record) {
    recordFile = resolve(a.record);
    record = validateRecord(JSON.parse(readFileSync(recordFile, "utf8")));
    if (a.owner && a.owner !== record.owner.stellar_account) {
      throw new Error(`--owner ${a.owner} differs from the record's owner ${record.owner.stellar_account}`);
    }
  } else {
    if (!a.owner || !a["check-in"] || !a["check-out"]) throw new Error(`--owner, --check-in and --check-out are required\n  usage: ${USAGE}`);
    const like = JSON.parse(readFileSync(resolve(a.like!), "utf8")) as OwnershipRecord;
    record = validateRecord({
      ...like,
      // Fresh for every record: one document must never be committable for two
      // rights, and a reused salt would let one commitment be tested against another.
      record_id: randomUUID(),
      salt: randomBytes(32).toString("hex"),
      owner: { ...like.owner, stellar_account: a.owner },
      week: {
        check_in: a["check-in"],
        check_out: a["check-out"],
        use_year: Number(a["check-in"]!.slice(0, 4)),
        week_number: isoWeekNumber(a["check-in"]!),
      },
    });
    recordFile = join(dir, `week-${a["check-in"]}-record.json`);
    if (existsSync(recordFile)) throw new Error(`${recordFile} exists; refusing to overwrite a record`);
    writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n");
  }
  const owner = record.owner.stellar_account;
  const d = await splitRecordDigest(record as unknown as JsonValue);
  log.step(`Issuing ${record.week.check_in} → ${record.week.check_out} to ${owner}`);
  log.info(`record            ${recordFile}`);
  log.info(`record digest d   ${d.hex}`);

  // --- 2. the owner's secret ---------------------------------------------------
  const secretFile = resolve(a.secret ?? join(dir, `week-${record.week.check_in}-owner.json`));
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, JSON.stringify({ secret: randomSecret().toString() }, null, 2) + "\n", { mode: 0o600 });
    log.info(`owner secret      ${secretFile} (new)`);
  } else {
    log.info(`owner secret      ${secretFile}`);
  }
  const h = await secretHash(BigInt((JSON.parse(readFileSync(secretFile, "utf8")) as { secret: string }).secret));

  // --- 3. C --------------------------------------------------------------------
  const c = fr(await commitment(d, owner, h));
  log.info(`commitment C      ${c}`);

  // --- 4. issue ----------------------------------------------------------------
  const issuer = Keypair.fromSecret(issuerSecret());
  const windows = onChainWindows(record);
  const tx = await buildCall(issuer.publicKey(), contract, "issue", issueArgs(owner, windows.period, windows.validity, c));
  const prepared = rpc.assembleTransaction(tx, await simulate(tx)).build();
  prepared.sign(issuer);
  const out = await sendAndWait(prepared);
  if (!out.successful) throw new Error(`issue failed: ${out.opResult} ${out.errors.join(" ")}`);
  const rightId = Number(scValToNative(out.returnValue as never));
  log.ok(`right #${rightId} issued`);
  log.link("transaction", explorer.tx(out.hash));

  // --- 5. attest ---------------------------------------------------------------
  const attestation = signAttestation(issuer, {
    contract,
    network: NETWORK_PASSPHRASE,
    rightId,
    recordDigest: await recordCommitment(record),
    weekValid: true,
    property: propertyFacts(record),
    feesCurrent: feesAreCurrent(record),
    feesPaidThrough: record.maintenance_fees.paid_through,
    validForDays: 365,
  });
  const issuedFile = "inventory/phase2/issued.json";
  const evidenceContract = existsSync(issuedFile)
    ? (JSON.parse(readFileSync(issuedFile, "utf8")) as { contract: string }).contract
    : null;
  const attestationFile =
    evidenceContract === contract
      ? join("inventory/phase2/attestations", `right-${rightId}.attestation.json`)
      : join(dir, `right-${rightId}.attestation.json`);
  writeJson(attestationFile, attestation);
  log.ok(`attestation       ${attestationFile} (fees current: ${attestation.payload.maintenance_fees_current})`);

  writeJson(join(dir, `right-${rightId}.issued.json`), {
    contract,
    right_id: rightId,
    owner,
    week: record.week,
    record_file: recordFile,
    owner_secret_file: secretFile,
    record_digest: d.hex,
    commitment: c,
    issue_tx: out.hash,
    attestation_file: attestationFile,
  });

  log.step("Keep");
  log.info(`${recordFile}`);
  log.info(`${secretFile}   ← proving any transfer of right #${rightId} needs it; lose it and the week can never move again`);
  if (evidenceContract === contract) {
    log.step("For the live app");
    log.info(`git add ${attestationFile} && git commit -m "Attest right #${rightId}" && git push`);
  }
  log.step("To rent it out or sell it later");
  log.info(`npm run zk:prove -- --record ${recordFile} --secret ${secretFile} --right ${rightId} --from ${owner} --to <G…> (--rental-until <unix> | --sale --next-secret-hash <buyer's h'>)`);
  process.exit(0);
}

main().catch(fatal);
