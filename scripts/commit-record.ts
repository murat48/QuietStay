/**
 * Compute the commitment for an off-chain ownership record.
 *
 *   npm run commit-record -- inventory/records/week-01.json
 *
 * Writes the canonical bytes next to the record so that anyone can reproduce the
 * hash with nothing but `sha256sum`, which is the point: a commitment a reviewer
 * cannot recompute is not a commitment, it is an assertion.
 */

import { basename, join } from "node:path";

import { canonicalText } from "../src/lib/canonical";
import { onChainWindows, recordCommitment, unixToIsoDate, validateRecord } from "../src/lib/record";
import { fatal, log, readJson, requireArg, writeCanonical } from "./lib/cli";

async function main(): Promise<void> {
  const path = requireArg(0, "npm run commit-record -- <record.json>");
  const record = validateRecord(readJson(path));

  const canonical = canonicalText(record as never);
  const commitment = await recordCommitment(record);
  const windows = onChainWindows(record);

  const outPath = join("inventory/canonical", basename(path).replace(/\.json$/, ".canonical.json"));
  writeCanonical(outPath, canonical);

  log.step(`Commitment for ${path}`);
  log.info(`canonical bytes  ${canonical.length} bytes, written to ${outPath}`);
  log.info(`                 (no trailing newline — sha256sum must match exactly)`);
  log.ok(`commitment       ${commitment}`);

  log.step("Derived on-chain windows");
  log.info(
    `occupancy period ${unixToIsoDate(windows.period.start)} .. ${unixToIsoDate(windows.period.end)}` +
      `  (${windows.period.start} .. ${windows.period.end})`,
  );
  log.info(
    `validity window  ${unixToIsoDate(windows.validity.from)} .. ${unixToIsoDate(windows.validity.until)}` +
      `  (${windows.validity.from} .. ${windows.validity.until})`,
  );

  log.step("Verify independently");
  log.info(`sha256sum ${outPath}`);
}

main().catch(fatal);
