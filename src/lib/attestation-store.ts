/**
 * Where the issuer keeps the attestations it has signed.
 *
 * Files on disk, one per right. That is the right level of machinery for a
 * reference deployment and it keeps the artifacts inspectable — a reviewer can
 * open `inventory/attestations/right-3.attestation.json` and check the signature
 * by hand. A production issuer would put these in a database, behind the same two
 * functions.
 *
 * This store is not a source of truth about ownership; the contract is. It only
 * records what the issuer has vouched for, so that the approval service can refuse
 * to approve a transfer of a week it has never attested.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Attestation } from "./attestation";

/** Written by the web app and by `npm run issue`. */
const PRIMARY_DIR = "inventory/attestations";
/** Written by `npm run evidence`, kept separate so evidence runs stay disposable. */
const SEARCH_DIRS = [PRIMARY_DIR, "inventory/evidence/attestations"];

function pathFor(dir: string, rightId: number): string {
  return resolve(process.cwd(), dir, `right-${rightId}.attestation.json`);
}

/** The attestation on file for a right, or `null` if the issuer never signed one. */
export function loadAttestation(rightId: number): Attestation | null {
  for (const dir of SEARCH_DIRS) {
    try {
      return JSON.parse(readFileSync(pathFor(dir, rightId), "utf8")) as Attestation;
    } catch {
      // Not here; try the next directory.
    }
  }
  return null;
}

/** Record an attestation. Returns the path, for the caller to report. */
export function saveAttestation(rightId: number, attestation: Attestation): string {
  const path = pathFor(PRIMARY_DIR, rightId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  return join(PRIMARY_DIR, `right-${rightId}.attestation.json`);
}
