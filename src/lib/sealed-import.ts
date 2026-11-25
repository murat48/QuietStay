/**
 * Open a sealed record and keep it, only if it is the record behind a week on
 * chain (docs/PHASE3_SPEC.md §2). One implementation for both ways a sealed
 * record arrives:
 *
 * - a reply link, opened at /receive;
 * - the issuance inbox (D3 as amended 2026-11-25): the issuer's browser leaves
 *   the sealed record with the owner's ask, and the owner's browser picks it
 *   up when they sign in (src/components/SealedInbox.tsx).
 *
 * Browser only. Nothing here sends the record, the secret or `d` anywhere:
 * the only requests are reads of the week on chain.
 */

import type { JsonValue } from "./canonical";
import { CONTRACT_ID } from "./config";
import { prover } from "./prover-client";
import { open, type SealedRecord } from "./sealed";
import { allSealKeys, putHolding, putRecord, secretFor } from "./vault";

export interface ChainRight {
  id: number;
  commitment: string;
  title_holder: string | null;
  week: { start: number; end: number };
}

export async function chainRight(rightId: number): Promise<ChainRight> {
  const res = await fetch(`/api/right/${rightId}`);
  const body = (await res.json()) as ChainRight & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `could not read right #${rightId}`);
  return body;
}

export interface Imported {
  rightId: number;
  week: { start: number; end: number };
  /** This browser holds the secret behind the record's h: it can prove now. */
  owner: boolean;
  record: JsonValue;
}

/** Thrown when no key in this browser opens the blob: it was sealed to another browser. */
export class NotForThisBrowser extends Error {}

/**
 * Open `blob` with this browser's sealed-link keys, check it against the
 * chain, and keep it. Throws, keeping nothing, unless the record reproduces
 * the week's commitment on chain.
 */
export async function importSealed(blob: string): Promise<Imported> {
  let payload: SealedRecord | null = null;
  for (const key of await allSealKeys()) {
    try {
      payload = (await open(key.privateKey, key.keyHash, blob)) as SealedRecord;
      break;
    } catch {
      // not sealed to this key; try the next
    }
  }
  if (!payload) throw new NotForThisBrowser("this browser holds no key that opens this record. Open it in the browser that asked.");
  if (payload.v !== 1 || payload.contract !== CONTRACT_ID) {
    throw new Error("this record is for a different QuietStay deployment");
  }
  const right = await chainRight(payload.right_id);
  if (right.title_holder !== payload.holder) {
    throw new Error(`the chain says week #${payload.right_id} is held by ${right.title_holder ?? "nobody"}, not by the sender`);
  }
  const { commitment } = await prover.commitment(payload.record as JsonValue, payload.holder, BigInt(payload.h));
  if (commitment !== BigInt("0x" + right.commitment)) {
    throw new Error("this record does not match the commitment on chain. It is not the record behind this week; nothing was kept.");
  }
  await putRecord({
    right_id: payload.right_id,
    record: payload.record as JsonValue,
    holder: payload.holder,
    h: payload.h,
    commitment: right.commitment,
  });
  // The first owner already holds the secret behind h: this browser can prove now.
  const owner = (await secretFor(BigInt(payload.h))) !== null;
  if (owner) {
    await putHolding({ right_id: payload.right_id, record: payload.record as JsonValue, holder: payload.holder, h: payload.h });
  }
  return { rightId: payload.right_id, week: right.week, owner, record: payload.record as JsonValue };
}
