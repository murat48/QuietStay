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

import { DATA_ROOT } from "./config";
import type { Attestation } from "./attestation";

/** Written by the web app and by `npm run issue`. */
const PRIMARY_DIR = "inventory/attestations";
/** Written by `npm run evidence`, kept separate so evidence runs stay disposable. */
const EVIDENCE_DIR = "inventory/evidence/attestations";

/**
 * Where to look, in order.
 *
 * The writable root comes first so a freshly signed attestation wins over an
 * older copy shipped with the build. Then the working directory, which in a
 * container is the image and in development is the repository.
 *
 * Both are searched rather than one being chosen, because a deployment that
 * mounts a volume would otherwise **hide** the attestations baked into the image
 * behind an empty directory, and every week would read as never attested. The
 * volume adds to what shipped; it does not replace it.
 *
 * Locally `DATA_ROOT` is the working directory and the first two entries are the
 * same path. Harmless: the first hit wins.
 */
function candidates(rightId: number): string[] {
  const name = `right-${rightId}.attestation.json`;
  return [
    resolve(DATA_ROOT, PRIMARY_DIR, name),
    resolve(process.cwd(), PRIMARY_DIR, name),
    resolve(process.cwd(), EVIDENCE_DIR, name),
  ];
}

/** The attestation on file for a right, or `null` if the issuer never signed one. */
export function loadAttestation(rightId: number): Attestation | null {
  for (const path of candidates(rightId)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Attestation;
    } catch {
      // Not here; try the next location.
    }
  }
  return null;
}

/** Record an attestation. Returns the path, for the caller to report. */
export function saveAttestation(rightId: number, attestation: Attestation): string {
  const name = `right-${rightId}.attestation.json`;
  const path = resolve(DATA_ROOT, PRIMARY_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  return join(PRIMARY_DIR, name);
}
