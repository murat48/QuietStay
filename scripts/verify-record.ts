/**
 * Verify a week from the command line.
 *
 *   npm run verify-record -- <right_id> <attestation.json> [record.json]
 *
 * The same checks the verify screen runs, against the same deployed contract, so a
 * browser result can be confirmed without a browser. Exits non-zero if any check
 * fails.
 *
 * The files may be given in either order — each is identified by its contents, not
 * its position — and the **record is optional**. An attestation plus the contract
 * is enough to establish that the week is real, owes nothing, and is held by a
 * particular account, with no document disclosed. That is the point of the design,
 * so the tool has to demonstrate it rather than quietly require a deed.
 *
 * Verifies with no document at all:
 *   npm run verify-record -- 3 inventory/phase2/attestations/right-3.attestation.json
 *
 * The same week, with the record disclosed and checked against the attestation:
 *   npm run verify-record -- 3 inventory/phase2/attestations/right-3.attestation.json \
 *     inventory/records/week-03.json
 *
 * And the last step the browser does not take — the record against the ledger's
 * commitment C = Poseidon(d, title holder, h), which needs the holder's secret
 * hash h (disclosed with the record; never the secret itself):
 *   npm run verify-record -- 3 <attestation> inventory/records/week-03.json --secret-hash <h>
 *
 * A week that should fail, because it carries unpaid fees:
 *   npm run verify-record -- 4 inventory/phase2/attestations/right-4.attestation.json
 */

import type { JsonValue } from "../src/lib/canonical";
import { verifyAttestation, type Check } from "../src/lib/attestation";
import { digestsMatch } from "../src/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE } from "../src/lib/config";
import { readHolding, readIsActive, readRight } from "../src/lib/contract";
import {
  recordCommitment,
  unixToIsoDate,
  validateRecord,
  type OwnershipRecord,
} from "../src/lib/record";
import { fatal, loadEnv, log, readJson } from "./lib/cli";
import { commitment as poseidonCommitment, splitRecordDigest } from "./lib/zk";
import { fr } from "./lib/zk-encode";

loadEnv();

/** Tell an attestation from a record by what is inside it, not by argument order. */
function classify(paths: string[]): { attestation?: string; record?: string } {
  const out: { attestation?: string; record?: string } = {};
  for (const path of paths) {
    const parsed = readJson<Record<string, unknown>>(path);
    if (parsed.payload && parsed.signature) out.attestation = path;
    else if (parsed.schema === "quietstay.ownership-record.v1") out.record = path;
    else throw new Error(`${path} is neither an attestation nor an ownership record`);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const hAt = argv.indexOf("--secret-hash");
  const secretHash = hAt === -1 ? undefined : argv[hAt + 1];
  const [rawId, ...files] = argv.filter((_, i) => hAt === -1 || (i !== hAt && i !== hAt + 1));
  if (!rawId || files.length === 0) {
    console.error(
      "usage: npm run verify-record -- <right_id> <attestation.json> [record.json [--secret-hash <h>]]",
    );
    process.exit(1);
  }

  const rightId = Number(rawId);
  if (!Number.isInteger(rightId) || rightId < 1) {
    throw new Error("right_id must be a positive integer");
  }

  const { attestation: attestationPath, record: recordPath } = classify(files);

  log.step(`Verifying right #${rightId}`);
  log.info(`contract ${CONTRACT_ID}`);

  // --- what the ledger says ------------------------------------------------
  const [right, holding, active] = await Promise.all([
    readRight(rightId),
    readHolding(rightId),
    readIsActive(rightId),
  ]);

  log.info(
    `week     ${unixToIsoDate(right.period.start)} → ${unixToIsoDate(right.period.end)}`,
  );
  log.info(`issuer   ${right.issuer}`);
  log.info(
    `holder   ${holding.holder}` +
      (holding.expiresAt === null ? " (outright)" : ` until ${unixToIsoDate(holding.expiresAt)}`),
  );
  log.info(`on chain 0x${right.commitment}`);

  const checks: Check[] = [];

  // --- leg 1: the record, only if one was disclosed ------------------------
  //
  // Optional. An attestation plus the contract already answers the questions that
  // matter; requiring a deed here would reinstate the document exchange the design
  // removes. See the note at the top of this file.
  let record: OwnershipRecord | null = null;
  let recomputed: string | undefined;

  if (recordPath) {
    record = validateRecord(readJson(recordPath));
    // d, as sha256sum would give it. The attestation check below compares it with
    // what the issuer signed.
    recomputed = await recordCommitment(record);
    log.info(`record d 0x${recomputed}`);

    // The step only the command line takes: C = Poseidon(d, title holder, h).
    if (secretHash !== undefined) {
      const d = await splitRecordDigest(record as unknown as JsonValue);
      const titleHolder = right.holdings[0]?.holder ?? "";
      const c = fr(await poseidonCommitment(d, titleHolder, BigInt(secretHash)));
      const matches = digestsMatch(c, right.commitment);
      checks.push({
        id: "record-commitment",
        label: "The record and h give the commitment the ledger holds",
        ok: matches,
        detail: matches
          ? `Poseidon(d, ${titleHolder.slice(0, 8)}…, h) = 0x${c}`
          : `Poseidon(d, ${titleHolder.slice(0, 8)}…, h) = 0x${c}, the ledger holds 0x${right.commitment}`,
      });
    } else {
      log.warn("no --secret-hash: the record is checked against the attestation, not against C on chain");
    }
  }

  // --- leg 2: the attestation ----------------------------------------------
  if (attestationPath) {
    const verification = verifyAttestation(readJson(attestationPath), {
      contract: CONTRACT_ID,
      network: NETWORK_PASSPHRASE,
      rightId,
      // From the contract, never from the attestation itself.
      contractIssuer: right.issuer,
      recordDigest: recomputed,
    });
    checks.push(...verification.checks);
  } else {
    checks.push({
      id: "attestation-absent",
      label: "Issuer attestation supplied",
      ok: false,
      detail: "no attestation given — nothing vouches that this week is free of unpaid fees",
    });
  }

  // --- leg 3: the holder, and whether the week is transferable -------------
  //
  // Only meaningful when a record was disclosed. The contract is always the
  // authority on who holds a week; this compares the record's *stated* account
  // against it, which is a different question and a weaker one.
  if (record) {
    checks.push({
      id: "record-owner",
      label: "The record's stated account is the holder the contract names",
      ok: record.owner.stellar_account === holding.holder,
      detail:
        record.owner.stellar_account === holding.holder
          ? `${holding.holder} matches the record`
          : `record names ${record.owner.stellar_account}; the contract says ${holding.holder} holds it` +
            " (expected if the week has since changed hands — check against who is offering it to you)",
    });
  } else {
    checks.push({
      id: "holder",
      label: "The contract names the current holder",
      ok: true,
      detail:
        `${holding.holder}` +
        (holding.expiresAt === null
          ? " holds it outright"
          : ` holds it until ${unixToIsoDate(holding.expiresAt)}`) +
        " — confirm this is the account offering it to you",
    });
  }

  checks.push({
    id: "active",
    label: "The right is inside its validity window",
    ok: active,
    detail: active
      ? `use year ${unixToIsoDate(right.validity.from)} → ${unixToIsoDate(right.validity.until)}`
      : "the use year has closed; this right can no longer be transferred",
  });

  if (holding.expiresAt !== null) {
    checks.push({
      id: "encumbered",
      label: "The week is not already rented out",
      ok: false,
      detail: `held on a term ending ${unixToIsoDate(holding.expiresAt)}; until then it cannot be sold`,
    });
  }

  // --- report ---------------------------------------------------------------
  log.step("Checks");
  for (const check of checks) {
    if (check.ok) log.ok(check.label);
    else log.fail(check.label);
    log.info(`   ${check.detail}`);
  }

  const failures = checks.filter((check) => !check.ok);
  log.step("Result");
  if (failures.length === 0) {
    log.ok("every check passed — the week is what it claims to be");
  } else {
    log.fail(`${failures.length} check(s) failed — do not proceed`);
    process.exitCode = 1;
  }
}

main().catch(fatal);
