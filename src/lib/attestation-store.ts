/**
 * Where the issuer keeps the attestations it has signed.
 *
 * Two layers, and which one answers depends on where the app is running.
 *
 * **Files**, one per right, are the base. They are what `npm run attest` writes,
 * what git carries, and what ships with the build, and they keep the artifacts
 * inspectable — a reviewer can open
 * `inventory/attestations/right-3.attestation.json` and check the signature by
 * hand, with no access to anything.
 *
 * **A key-value store**, when one is configured, is the writable overlay on top.
 * A serverless host has a read-only filesystem, so a week issued from the
 * deployed app has nowhere to put its attestation and would be issued on chain
 * and then be untransferable. See `kv.ts`.
 *
 * The overlay is read first and the files second, never one instead of the
 * other. That is what lets the 35 weeks already in git keep working on a host
 * whose store is empty, with no migration step: the store holds what was written
 * since the build, the files hold what came with it.
 *
 * This store is not a source of truth about ownership; the contract is. It only
 * records what the issuer has vouched for, so that the approval service can refuse
 * to approve a transfer of a week it has never attested.
 */

import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DATA_ROOT } from "./config";
import { kvGet, kvIsConfigured, kvIsReachable, kvSet } from "./kv";
import type { Attestation } from "./attestation";

/** The overlay's key for a right. Namespaced, since requests share the store. */
const kvKey = (rightId: number) => `quietstay:attestation:${rightId}`;

/** Written by the web app and by `npm run issue`. */
const PRIMARY_DIR = "inventory/attestations";
/** Written by `npm run evidence`, kept separate so evidence runs stay disposable. */
const EVIDENCE_DIR = "inventory/evidence/attestations";

/**
 * The attestation on file for a right, or `null` if the issuer never signed one.
 *
 * Four places, in order, and the order is the point: whatever was written since
 * the build wins over what came with it. Every layer is searched rather than one
 * being chosen, because a deployment with an empty overlay would otherwise
 * **hide** what shipped behind it, and every week would read as never attested.
 *
 * A missing key-value store is not an error here. A deployment that has none
 * still reads the files, which is exactly the local case and the read-only host
 * that only ever serves what git carried.
 *
 * The file reads are written out one at a time rather than looping over a list
 * of paths, which is not style. A build traces `readFileSync` to decide which
 * files to deploy, and it can only do that when the folder is a literal — given
 * `resolve(someVariable, …)` it gives up and copies the entire project into the
 * output, source and all. Two of these three folders are literals for that
 * reason. The third cannot be: it is an environment variable naming a directory
 * that does not exist until the app runs, so it is hidden from the tracer
 * instead, which costs nothing — there is nothing there at build time to find.
 */
export async function loadAttestation(rightId: number): Promise<Attestation | null> {
  const name = `right-${rightId}.attestation.json`;

  // Written since the build, if this deployment has anywhere to write.
  if (kvIsConfigured()) {
    try {
      const stored = await kvGet(kvKey(rightId));
      if (stored) return JSON.parse(stored) as Attestation;
    } catch {
      // The store is unreachable or the value is not JSON. Neither is a reason
      // to claim the week was never attested — fall through to the files, which
      // for everything issued before the host existed is where it actually is.
    }
  }

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

/** Whether the local filesystem would accept a write. */
function filesAreWritable(): boolean {
  try {
    const dir = resolve(DATA_ROOT, PRIMARY_DIR);
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an attestation could be written at all.
 *
 * Meant to be asked **before** anything reaches the ledger. Issuing puts a
 * transaction on chain and then records the attestation that goes with it, and
 * the chain half cannot be taken back: a deployment that discovers at the second
 * step that it has nowhere to write has already created a right nobody can
 * transfer, because the approval service will not approve a week the issuer has
 * no attestation for.
 *
 * Configured store first, disk second — the same order the writes take. The
 * store is actually pinged rather than assumed: credentials that are present but
 * wrong look identical to working ones until something is asked of them, and the
 * whole point of this call is to find out before the ledger does. One round
 * trip, on a path that already makes several.
 */
export async function attestationStoreIsWritable(): Promise<boolean> {
  if (kvIsConfigured()) return kvIsReachable();
  return filesAreWritable();
}

/**
 * The answer a route gives when it cannot record what it is about to sign.
 *
 * Separate from "no issuer key": a host may hold the key and still have nowhere
 * to put the result, which is exactly a serverless deployment given the key by
 * mistake.
 */
export class AttestationStoreUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super(
      "this deployment cannot record attestations: it has nowhere to write them. " +
        "A host with a read-only filesystem needs a key-value store configured — see docs/VERCEL.md.",
    );
    this.name = "AttestationStoreUnavailable";
  }
}

/**
 * Record an attestation. Returns where it went, for the caller to report.
 *
 * The configured store wins when there is one, and the write goes there only —
 * not to both. On a host the disk is read-only anyway, and locally there is no
 * store, so "only" is never a choice between two live copies that could
 * disagree.
 */
export async function saveAttestation(
  rightId: number,
  attestation: Attestation,
): Promise<string> {
  const body = `${JSON.stringify(attestation, null, 2)}\n`;

  if (kvIsConfigured()) {
    try {
      await kvSet(kvKey(rightId), body);
      return kvKey(rightId);
    } catch (error) {
      throw new AttestationStoreUnavailable(error);
    }
  }

  const name = `right-${rightId}.attestation.json`;
  const path = resolve(DATA_ROOT, PRIMARY_DIR, name);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
  } catch (error) {
    // EROFS, EACCES, ENOSPC. The caller has usually already touched the ledger by
    // now, so this carries the attestation nowhere — it says so plainly instead
    // of surfacing a bare errno.
    throw new AttestationStoreUnavailable(error);
  }
  return join(PRIMARY_DIR, name);
}
