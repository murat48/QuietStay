/**
 * Two small server-side primitives: claim a key once, and count within a time
 * window. They are used by SEP-45 nonces (src/lib/sep45.ts) and by the fee
 * route's rate limits (/api/tx/sponsor).
 *
 * The deployment's existing Upstash store is used when it is configured (no
 * new infrastructure). Otherwise a JSON file under QUIETSTAY_DATA_DIR is used,
 * which is right for local development and tests. If neither can be written,
 * the functions throw, and callers refuse rather than run unlimited.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CONTRACT_ID, DATA_ROOT } from "./config";
import { kvCount, kvIsConfigured, kvPrefix, kvSetOnce } from "./kv";

const FILE = resolve(DATA_ROOT, "inventory/phase3/once-store.json");
const ns = (key: string) => `${kvPrefix()}:${CONTRACT_ID}:${key}`;

type FileState = Record<string, { n: number; until: number }>;

function withFile<T>(fn: (s: FileState, now: number) => T): T {
  let state: FileState = {};
  try {
    state = JSON.parse(readFileSync(FILE, "utf8")) as FileState;
  } catch {
    state = {};
  }
  const now = Date.now() / 1000;
  for (const [k, v] of Object.entries(state)) if (v.until <= now) delete state[k];
  const out = fn(state, now);
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state));
  return out;
}

/** True the first time `key` is claimed within `ttlSecs`; false ever after, until it expires. */
export async function claimOnce(key: string, ttlSecs: number): Promise<boolean> {
  if (kvIsConfigured()) return kvSetOnce(ns(key), "1", ttlSecs);
  return withFile((s, now) => {
    if (s[key]) return false;
    s[key] = { n: 1, until: now + ttlSecs };
    return true;
  });
}

/** Count one more event under `key` in a window of `ttlSecs`. Returns the count including this one. */
export async function countInWindow(key: string, ttlSecs: number): Promise<number> {
  if (kvIsConfigured()) return kvCount(ns(key), ttlSecs);
  return withFile((s, now) => {
    const e = s[key] ?? { n: 0, until: now + ttlSecs };
    e.n += 1;
    s[key] = e;
    return e.n;
  });
}
