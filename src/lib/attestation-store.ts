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
 * The attestation on file for a right, or `null` if the issuer never signed one.
 *
 * Three places, in order, and the order is the point: a freshly signed
 * attestation in the writable root wins over an older copy that shipped with the
 * build. Both are searched rather than one being chosen, because a deployment
 * that mounts a volume would otherwise **hide** what shipped behind an empty
 * directory, and every week would read as never attested.
 *
 * The reads are written out one at a time rather than looping over a list of
 * paths, which is not style. A build traces `readFileSync` to decide which files
 * to deploy, and it can only do that when the folder is a literal — given
 * `resolve(someVariable, …)` it gives up and copies the entire project into the
 * output, source and all. Two of these three folders are literals for that
 * reason. The third cannot be: it is an environment variable pointing at a
 * volume that does not exist until the container runs, so it is hidden from the
 * tracer instead, which costs nothing — there is nothing there at build time to
 * find.
 */
export function loadAttestation(rightId: number): Attestation | null {
  const name = `right-${rightId}.attestation.json`;

  // The writable root, when a deployment has one that is not the project itself.
  if (DATA_ROOT !== process.cwd()) {
    try {
      const path = resolve(DATA_ROOT, PRIMARY_DIR, name);
      return JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as Attestation;
    } catch {
      // Not there; fall through to what shipped.
    }
  }

  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "inventory/attestations", name), "utf8"),
    ) as Attestation;
  } catch {
    // Not here either; try the evidence run's own directory.
  }

  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "inventory/evidence/attestations", name), "utf8"),
    ) as Attestation;
  } catch {
    return null;
  }
}

/** Record an attestation. Returns the path, for the caller to report. */
export function saveAttestation(rightId: number, attestation: Attestation): string {
  const name = `right-${rightId}.attestation.json`;
  const path = resolve(DATA_ROOT, PRIMARY_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
  return join(PRIMARY_DIR, name);
}
