/**
 * The holder's vault: record secrets, private records and sealed-link keys,
 * kept in this browser's IndexedDB and nowhere else (docs/PHASE3_SPEC.md §2).
 *
 * Nothing in this file sends anything anywhere. The no-leak test
 * (e2e/no-leak.spec.ts) records every request the app makes while proving
 * and submitting, and fails if any of them carries a secret, a record or `d`.
 *
 * What is kept, all scoped to (network, contract):
 *
 * - `secret:<h>`: a record secret `s` and its hash `h`. Made when an owner asks
 *   for a week or a buyer asks to buy. Only `h` ever leaves the browser.
 * - `key:<key hash>`: a sealed-link recipient key. The private half is a
 *   non-extractable CryptoKey: even this app cannot read it out.
 * - `record:<right id>`: a record received through a sealed link and checked
 *   against the commitment on chain, with the holder and `h` it was checked for.
 * - `holding:<right id>`: the record and the `h` this browser can prove with for
 *   a right it holds title to.
 *
 * If this storage is lost (cleared site data, another device, a private
 * window), the holder can no longer prove for their weeks. The weeks stay
 * theirs; nobody can recover the ability to move them. That is a stated
 * limitation (DESIGN.md, "Known limitations").
 */

import type { JsonValue } from "./canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE } from "./config";
import { prover } from "./prover-client";
import { newRecipientKey } from "./sealed";
import { randomSecret } from "./zk-fields";

const DB = "quietstay-vault";
const STORE = "entries";
const scope = `${NETWORK_PASSPHRASE}|${CONTRACT_ID}`;

interface Entry<T> {
  key: string;
  value: T;
  saved_at: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error ?? new Error("this browser's storage is unavailable"));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((ok, fail) => {
      const t = db.transaction(STORE, mode);
      const r = run(t.objectStore(STORE));
      t.oncomplete = () => ok(r.result);
      t.onerror = () => fail(t.error ?? new Error("storage write failed"));
    });
  } finally {
    db.close();
  }
}

const k = (name: string) => `${scope}|${name}`;

async function put<T>(name: string, value: T): Promise<void> {
  await tx("readwrite", (s) => s.put({ key: k(name), value, saved_at: new Date().toISOString() } satisfies Entry<T>));
}

async function get<T>(name: string): Promise<T | null> {
  const e = (await tx("readonly", (s) => s.get(k(name)))) as Entry<T> | undefined;
  return e?.value ?? null;
}

async function all<T>(prefix: string): Promise<T[]> {
  const entries = (await tx("readonly", (s) => s.getAll())) as Entry<T>[];
  return entries.filter((e) => e.key.startsWith(k(prefix))).map((e) => e.value);
}

// --- secrets ------------------------------------------------------------------

interface SecretEntry {
  s: string;
  h: string;
  purpose: string;
}

/**
 * Make a record secret in this browser and keep it. Returns only `h`, which is
 * what may leave the browser. Stored before `h` is returned, so it is never
 * possible to have sent an `h` whose secret was not kept.
 */
export async function newSecret(purpose: string): Promise<bigint> {
  const s = randomSecret();
  const h = await prover.secretHash(s);
  await put<SecretEntry>(`secret:${h}`, { s: s.toString(), h: h.toString(), purpose });
  return h;
}

export async function secretFor(h: bigint): Promise<bigint | null> {
  const e = await get<SecretEntry>(`secret:${h}`);
  return e ? BigInt(e.s) : null;
}

// --- sealed-link keys -----------------------------------------------------------

interface KeyEntry {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  keyHash: string;
  purpose: string;
}

/** A new sealed-link recipient key, kept here. Returns its public half and hash. */
export async function newSealKey(purpose: string): Promise<{ publicRaw: Uint8Array; keyHash: string }> {
  const key = await newRecipientKey();
  await put<KeyEntry>(`key:${key.keyHash}`, { ...key, purpose });
  return { publicRaw: key.publicRaw, keyHash: key.keyHash };
}

export async function sealKey(keyHash: string): Promise<KeyEntry | null> {
  return get<KeyEntry>(`key:${keyHash}`);
}

export async function allSealKeys(): Promise<KeyEntry[]> {
  return all<KeyEntry>("key:");
}

// --- records and holdings -------------------------------------------------------

export interface RecordEntry {
  right_id: number;
  record: JsonValue;
  /** The holder and `h` the record was checked against on chain. */
  holder: string;
  h: string;
  /** The commitment it matched. */
  commitment: string;
}

export interface Holding {
  right_id: number;
  record: JsonValue;
  /** The holder this browser proves as, and the `h` of the secret it holds. */
  holder: string;
  h: string;
}

/**
 * The issuer's own copy of a record it just issued from an owner's ask, kept
 * in the issuer's browser so it can be sealed back to the owner (D3).
 */
export interface IssuedEntry {
  right_id: number;
  record: JsonValue;
  owner: string;
  h: string;
  ask_id: string;
}

export const putIssued = (e: IssuedEntry) => put(`issued:${e.right_id}`, e);
export const getIssued = (rightId: number) => get<IssuedEntry>(`issued:${rightId}`);

export const putRecord = (e: RecordEntry) => put(`record:${e.right_id}`, e);
export const getRecord = (rightId: number) => get<RecordEntry>(`record:${rightId}`);
export const putHolding = (e: Holding) => put(`holding:${e.right_id}`, e);
export const getHolding = (rightId: number) => get<Holding>(`holding:${rightId}`);

/**
 * Find what this browser can prove with for `rightId`, held by `holder` under
 * on-chain commitment `commitment`.
 *
 * A stored holding is used if it still matches. Otherwise every kept secret is
 * tried with the right's record: that is how a buyer's pending `s'` becomes
 * their secret once the sale lands, and how an owner's first record becomes
 * provable. Nothing is trusted that does not reproduce the on-chain value.
 */
export async function resolveHolding(rightId: number, holder: string, commitment: bigint): Promise<Holding | null> {
  const known = await getHolding(rightId);
  const candidates: JsonValue[] = [];
  if (known) candidates.push(known.record);
  const rec = await getRecord(rightId);
  if (rec) candidates.push(rec.record);
  if (candidates.length === 0) return null;

  const secrets = await all<SecretEntry>("secret:");
  const hs = known ? [known.h, ...secrets.map((s) => s.h).filter((h) => h !== known.h)] : secrets.map((s) => s.h);
  for (const record of candidates) {
    for (const h of hs) {
      if ((await prover.commitment(record, holder, BigInt(h))).commitment === commitment) {
        const holding = { right_id: rightId, record, holder, h };
        await putHolding(holding);
        return holding;
      }
    }
  }
  return null;
}
