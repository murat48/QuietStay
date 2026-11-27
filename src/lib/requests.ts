/**
 * Requests — the buyer's side of the marketplace, and the owner's side of issuance.
 *
 * Until now a transfer was a push: the holder typed a recipient's address and
 * sent the week. That worked, but it left two gaps. The person who wanted the
 * week could not say so — nothing in the system carried their interest — and the
 * holder had to type an account by hand, where a single wrong character sends a
 * week to a stranger irrecoverably. The issuer cannot claw it back, by design.
 *
 * A request closes both. Somebody browsing asks for a week on the terms already
 * published; the address travels with the request, from their SEP-10 session, so
 * nobody types one. The holder then accepts or declines.
 *
 * ## What this is not
 *
 * **It is not an escrow, and it is not a price.** A request says "I want this
 * week on your published terms" and nothing about money — payment and settlement
 * are out of scope, and a listing carries a term but never a price.
 *
 * **It is not on chain, and it binds nobody.** A request is a message between two
 * parties, kept by the deployment so the holder can act on it. Accepting one runs
 * exactly the transfer that was always there: the holder's ownership proof and
 * signature, and on a sale the buyer's consent, which an ask to buy carries.
 * Nothing here can move a week.
 *
 * **The issuer is not part of it.** Requests travel between holder and requester
 * only — and under Phase 2 the issuer has no part in the transfer either, so
 * nothing about a week's interest or movement passes through it.
 *
 * ## Visibility
 *
 * A request names an account that wants a particular week, which is more than the
 * registry says about anyone. It is served only to the two parties: the account
 * that made it, and the account holding the week it is for.
 *
 * ## Asking to have a week issued
 *
 * The same store keeps the owner's side of issuance. An owner signs in, enters
 * the hash `h` of a record secret made on their own machine, and asks the issuer
 * to issue a week to them. The account comes from the session, as on a transfer
 * ask; the secret `s` is never sent. The issuer picks the ask on the Issue screen,
 * which fills in the first holder and `h` from it, and the ask is closed when the
 * week is issued. Served to the account that made it and to the issuer only.
 */

import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CONTRACT_ID, DATA_ROOT } from "./config";
import { kvGet, kvIsConfigured, kvIsReachable, kvPrefix, kvSet } from "./kv";

/** Per deployment, like attestations: every contract numbers its rights from 1. */
export const REQUESTS_DIR = "inventory/phase2/requests";

/**
 * Where a list lives: a right's transfer requests, or the deployment's issuance
 * requests. One store, one key space, one directory.
 */
type Slot = number | "issuance" | "asking-prices" | "issuer-key";

/** The store's key for a list. Namespaced, since attestations share it. */
const kvKey = (slot: Slot) => `${kvPrefix()}:${CONTRACT_ID}:requests:${slot}`;

export type RequestStatus = "open" | "accepted" | "declined" | "withdrawn";

export interface TransferRequest {
  id: string;
  right_id: number;
  /** The account asking, proved over SEP-10 when the request was made. */
  by: string;
  /** The effective holder at the time of asking — the account that must answer. */
  to_holder: string;
  /**
   * What the listing offered when the request was made: `null` is a sale, a
   * number of seconds is a rental term. Recorded so the holder can see what was
   * being asked for even if they later change the offer.
   */
  term_secs: number | null;
  requested_at: string;
  status: RequestStatus;
  /**
   * A sale's buyer consent, given when asking (Phase 2). The buyer chooses a
   * record secret off line (`npm run zk:secret`), sends its hash `h'`, and signs
   * the authorization the contract demands of a buyer — over exactly
   * `(right_id, h')` — so the holder's proof can be built on `h'` and the sale
   * submitted without the buyer present. Absent on a rental ask.
   */
  consent?: {
    /** `h'`, decimal. */
    next_secret_hash: string;
    /** The signed SorobanAuthorizationEntry, base64 XDR. */
    auth_entry: string;
    /** The last ledger at which the signature is valid. */
    valid_until_ledger: number;
  };
  /**
   * Phase 3 (sealed links, spec §2): SHA-256 of the raw P-256 public key the
   * asker's browser made, hex. The holder's browser seals the private record
   * only to a link key that hashes to this. Absent on a rental ask: renters
   * never prove, so they need no record.
   */
  key_hash?: string;
  /** Set when accepted: the transaction that carried it out. */
  tx?: string;
  /** Set when declined, if the holder gave one. Never required. */
  reason?: string;
  answered_at?: string;
}

/*
 * Unlike attestations, requests are only ever written here — nothing ships with
 * the build — so there is one location rather than a search order.
 */
const fileName = (slot: Slot) =>
  slot === "issuance"
    ? "issuance.requests.json"
    : slot === "asking-prices"
      ? "asking-prices.json"
      : slot === "issuer-key"
        ? "issuer-key.json"
        : `right-${slot}.requests.json`;

function pathFor(slot: Slot): string {
  return resolve(DATA_ROOT, REQUESTS_DIR, fileName(slot));
}

/**
 * Every request ever made for one right, newest last.
 *
 * One location, not a search order: unlike attestations, nothing here ships with
 * the build, so wherever this deployment writes is the only place a request has
 * ever been.
 */
export function loadRequests(rightId: number): Promise<TransferRequest[]> {
  return loadSlot<TransferRequest>(rightId);
}

async function loadSlot<T>(slot: Slot): Promise<T[]> {
  if (kvIsConfigured()) {
    try {
      const stored = await kvGet(kvKey(slot));
      return stored ? (JSON.parse(stored) as T[]) : [];
    } catch {
      // Unreachable store. An empty list is the honest answer — it says nobody
      // has asked, which is what the holder would see anyway, rather than
      // failing a page that has other things to show.
      return [];
    }
  }

  try {
    return JSON.parse(readFileSync(pathFor(slot), "utf8")) as T[];
  } catch {
    return [];
  }
}

/**
 * Thrown when the deployment has nowhere to keep a request.
 *
 * A serverless host serves the app from a read-only filesystem, so this store
 * has no home there. `/tmp` is writable and would be the obvious dodge, but
 * every invocation may land on a different instance: the request would be
 * accepted, acknowledged, and gone before the holder ever saw it. Losing
 * somebody's ask silently is worse than declining to take it, so the write is
 * not attempted somewhere it cannot last.
 */
export class RequestStoreUnavailable extends Error {
  constructor(readonly cause: unknown) {
    super(
      "this deployment cannot record transfer requests: it has nowhere to keep them. " +
        "A host with a read-only filesystem needs a key-value store configured — see docs/VERCEL.md.",
    );
    this.name = "RequestStoreUnavailable";
  }
}

/**
 * Whether a request can be recorded at all.
 *
 * The store is pinged rather than assumed present, because credentials that are
 * set but wrong look exactly like working ones from here, and this answer is
 * what the interface uses to decide whether to offer the control at all.
 */
export async function requestStoreIsWritable(): Promise<boolean> {
  if (kvIsConfigured()) return kvIsReachable();
  try {
    mkdirSync(resolve(DATA_ROOT, REQUESTS_DIR), { recursive: true });
    accessSync(resolve(DATA_ROOT, REQUESTS_DIR), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function saveRequests(rightId: number, requests: TransferRequest[]): Promise<string> {
  return saveSlot(rightId, requests);
}

/** The holders' asking prices, kept in the same store (./asking-price.ts). */
export function loadAskingPriceStore<T>(): Promise<T[]> {
  return loadSlot<T>("asking-prices");
}

export function saveAskingPriceStore(items: unknown[]): Promise<string> {
  return saveSlot("asking-prices", items);
}

/** The issuer's published intake key (./issuer-key.ts), as a list of at most one. */
export function loadIssuerKeyStore<T>(): Promise<T[]> {
  return loadSlot<T>("issuer-key");
}

export function saveIssuerKeyStore(items: unknown[]): Promise<string> {
  return saveSlot("issuer-key", items);
}

async function saveSlot(slot: Slot, items: unknown[]): Promise<string> {
  const body = `${JSON.stringify(items, null, 2)}\n`;

  if (kvIsConfigured()) {
    try {
      await kvSet(kvKey(slot), body);
      return kvKey(slot);
    } catch (error) {
      throw new RequestStoreUnavailable(error);
    }
  }

  const path = pathFor(slot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
  } catch (error) {
    // EROFS, EACCES, ENOSPC — all the same answer to the caller: not here.
    throw new RequestStoreUnavailable(error);
  }
  return join(REQUESTS_DIR, fileName(slot));
}

/**
 * Replace one request in a right's list, by id.
 *
 * Read-modify-write, which is right for a reference deployment and would be a
 * row update in a production one. Returns `null` when the id is not there, so a
 * caller can answer 404 rather than writing back a list that changed nothing.
 *
 * Two answers arriving for the same week in the same instant could still have
 * the second overwrite the first. That is a narrow window — a holder answering
 * their own requests, one at a time — and closing it properly means a compare-
 * and-set on the store or a row lock in a database, not a lock this process
 * could hold. Named rather than papered over.
 */
export async function updateRequest(
  rightId: number,
  requestId: string,
  change: (request: TransferRequest) => TransferRequest,
): Promise<TransferRequest | null> {
  const all = await loadRequests(rightId);
  const index = all.findIndex((r) => r.id === requestId);
  if (index === -1) return null;

  const updated = change(all[index]!);
  all[index] = updated;
  await saveRequests(rightId, all);
  return updated;
}

/** The request this account has outstanding on a right, if any. */
export async function openRequestBy(
  rightId: number,
  account: string,
): Promise<TransferRequest | null> {
  const all = await loadRequests(rightId);
  return all.find((r) => r.by === account && r.status === "open") ?? null;
}

export type IssuanceStatus = "open" | "issued" | "declined" | "cancelled";

/** An owner's ask to have a week issued to them. */
export interface IssuanceRequest {
  id: string;
  /** The account asking — the week's first holder — proved over SEP-10. */
  by: string;
  /** `h = Poseidon(s)`, decimal. Never `s`. */
  secret_hash: string;
  /**
   * Phase 3 (D3): SHA-256 of the owner's sealed-link public key, hex. The
   * issuer's browser seals the week's record only to a link key that hashes
   * to this.
   */
  key_hash?: string;
  /**
   * Step 5 (2026-11-25): the sealed-link public key itself, base64url, whose
   * SHA-256 is `key_hash`. With it the issuer's browser seals the record as
   * soon as it issues, and no request link has to travel. Public by nature.
   */
  public_key?: string;
  /**
   * D3 as amended 2026-11-25: the week's record, sealed in the issuer's
   * browser to `public_key`, waiting for the owner's browser to pick it up.
   * Ciphertext only: the server cannot open it. Removed when the owner's
   * browser confirms it kept the record, or after SEALED_TTL_DAYS.
   */
  sealed_record?: { blob: string; delivered_at: string };
  /**
   * D16 (2026-11-26): the week's details as the owner entered them, sealed in
   * the owner's browser to the issuer's intake key (`key_hash`). Ciphertext
   * only: the server cannot open it. It fills in the issuer's form.
   */
  sealed_details?: { blob: string; key_hash: string };
  requested_at: string;
  status: IssuanceStatus;
  /** Set when issued. */
  right_id?: number;
  tx?: string;
  issued_at?: string;
  /**
   * Set when the issuer declined it (2026-11-27), with their reason if they
   * gave one. Its sealed details are dropped then: nobody needs them.
   */
  declined_at?: string;
  reason?: string;
  /**
   * A renewal (2026-11-27): the next year's week of right #`renew_of`, asked
   * by its title holder (checked on chain when asked). The contract cannot
   * change a right's dates, so a renewal is a new right the issuer issues.
   */
  renew_of?: number;
  /** Renew every year: when this one is issued, the owner's browser files the next. */
  auto_renew?: boolean;
  /**
   * The asking price the owner means to list the renewed week at (2026-11-27),
   * USDC base units as a decimal string. Off chain, like every asking price;
   * it fills in the renewed week's listing form. The owner may change it, or
   * cancel the renewal, while it waits.
   */
  price?: string;
  cancelled_at?: string;
  /**
   * Not shown to the issuer before this time (ISO): an automatic renewal is
   * filed in advance and opens when the week it renews has ended.
   */
  open_from?: string;
  /**
   * Not an ask: the issuer issued directly, with an h typed in. Recorded only so
   * that h is known to be spent; hidden from every list of requests.
   */
  direct?: true;
}

/** Every issuance request this deployment has taken, newest last. */
export function loadIssuanceRequests(): Promise<IssuanceRequest[]> {
  return loadSlot<IssuanceRequest>("issuance");
}

export function saveIssuanceRequests(requests: IssuanceRequest[]): Promise<string> {
  return saveSlot("issuance", requests);
}

/**
 * The issued week, if any, that an h already secures.
 *
 * One secret per week: the same h on two weeks ties both to one secret file,
 * so losing or leaking it costs every one of them. Not a matter of soundness —
 * each week's commitment and nullifier still differ — but of keeping a lost
 * key to one week. Compared as numbers, so decimal and hex spellings agree.
 */
export async function weekSecuredBy(h: bigint): Promise<IssuanceRequest | null> {
  const all = await loadIssuanceRequests();
  return all.find((r) => r.status === "issued" && sameHash(r.secret_hash, h)) ?? null;
}

function sameHash(stored: string, h: bigint): boolean {
  try {
    return BigInt(stored) === h;
  } catch {
    return false;
  }
}

/** Note an h the issuer used directly, so a later ask or issuance cannot reuse it. */
export async function recordDirectIssuance(issued: {
  owner: string;
  secret_hash: string;
  right_id: number;
  tx: string;
}): Promise<void> {
  const all = await loadIssuanceRequests();
  const now = new Date().toISOString();
  all.push({
    id: crypto.randomUUID(),
    by: issued.owner,
    secret_hash: issued.secret_hash,
    requested_at: now,
    status: "issued",
    right_id: issued.right_id,
    tx: issued.tx,
    issued_at: now,
    direct: true,
  });
  await saveIssuanceRequests(all);
}

/** Close an issuance request once its week is on chain. Same read-modify-write caveat as above. */
/** Whether the issuer may see an ask yet: an automatic renewal waits for its week to end. */
export function askIsDue(r: IssuanceRequest, now = Date.now()): boolean {
  return !r.open_from || Date.parse(r.open_from) <= now;
}

/** Unix seconds: 1 January of the use year that a validity window ending at `until` belongs to. */
export function startOfUseYear(validityUntil: number): number {
  const year = new Date((validityUntil - 1) * 1000).getUTCFullYear();
  return Date.UTC(year, 0, 1) / 1000;
}

/**
 * Why week `renewOf` may not be renewed now, or `null` (2026-11-27).
 *
 * Once per week: a week already renewed has its next year, and renewing it
 * again would stack a further year on it. A manual renewal only from the
 * week's own use year: a week for next year is renewed next year, not now,
 * so renewals cannot run years ahead. An automatic one may be filed at any
 * time, as it opens only when the use year is over (`renewalOpensFrom`).
 */
export function renewalProblem(opts: {
  renewOf: number;
  auto: boolean;
  validityUntil: number;
  asks: Pick<IssuanceRequest, "renew_of" | "status">[];
  now?: number;
}): string | null {
  const now = opts.now ?? Date.now() / 1000;
  const same = opts.asks.filter((r) => r.renew_of === opts.renewOf);
  if (same.some((r) => r.status === "issued")) return `week #${opts.renewOf} has already been renewed; renew the new week when its year comes`;
  if (same.some((r) => r.status === "open")) return `week #${opts.renewOf} already has a renewal waiting`;
  if (opts.validityUntil <= now) return null;
  const opens = startOfUseYear(opts.validityUntil);
  if (!opts.auto && now < opens) {
    return `week #${opts.renewOf} is for ${new Date(opens * 1000).getUTCFullYear()}; it can be renewed from ${new Date(opens * 1000).toISOString().slice(0, 10)}, or now automatically`;
  }
  return null;
}

/** When an automatic renewal opens to the issuer: when the week's use year is over. `undefined` if it already is. */
export function renewalOpensFrom(validityUntil: number, now = Date.now() / 1000): string | undefined {
  return validityUntil > now ? new Date(validityUntil * 1000).toISOString() : undefined;
}

/**
 * The owner changes a waiting renewal's price, or cancels it (2026-11-27).
 * Only their own, only while it waits. `null` when there is no such renewal.
 */
export async function changeRenewal(
  requestId: string,
  by: string,
  change: { price: string } | { cancel: true },
): Promise<IssuanceRequest | null> {
  const all = await loadIssuanceRequests();
  const index = all.findIndex((r) => r.id === requestId && r.by === by && r.status === "open" && r.renew_of !== undefined);
  if (index === -1) return null;
  if ("cancel" in change) {
    const { sealed_details: _dropped, ...rest } = all[index]!;
    void _dropped;
    all[index] = { ...rest, status: "cancelled", cancelled_at: new Date().toISOString() };
  } else {
    all[index] = { ...all[index]!, price: change.price };
  }
  await saveIssuanceRequests(all);
  return all[index]!;
}

/** Decline an open ask, with an optional reason. `null` when there is no such open ask. */
export async function markDeclined(requestId: string, reason: string | undefined): Promise<IssuanceRequest | null> {
  const all = await loadIssuanceRequests();
  const index = all.findIndex((r) => r.id === requestId && r.status === "open" && !r.direct);
  if (index === -1) return null;
  const { sealed_details: _dropped, ...rest } = all[index]!;
  void _dropped;
  all[index] = {
    ...rest,
    status: "declined",
    declined_at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
  await saveIssuanceRequests(all);
  return all[index]!;
}

export async function markIssued(
  requestId: string,
  issued: { right_id: number; tx: string },
): Promise<IssuanceRequest | null> {
  const all = await loadIssuanceRequests();
  const index = all.findIndex((r) => r.id === requestId);
  if (index === -1) return null;
  all[index] = { ...all[index]!, status: "issued", ...issued, issued_at: new Date().toISOString() };
  await saveIssuanceRequests(all);
  return all[index]!;
}

/** How long a sealed record waits for its owner before it is dropped. */
export const SEALED_TTL_DAYS = 30;
/** A sealed record is ~1.5 KB; anything far larger is not one. */
const SEALED_MAX_CHARS = 16_384;

/** A sealed record as the issuer's browser sends it: base64url, bounded. */
export function parseSealedBlob(value: unknown): string {
  if (typeof value !== "string" || value.length < 128 || value.length > SEALED_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("blob must be a sealed record (base64url, 128 to 16384 characters)");
  }
  return value;
}

/** Drop sealed records older than SEALED_TTL_DAYS. Returns whether anything changed. */
export function expireSealed(all: IssuanceRequest[], now = Date.now()): boolean {
  let changed = false;
  for (const r of all) {
    if (r.sealed_record && now - Date.parse(r.sealed_record.delivered_at) > SEALED_TTL_DAYS * 86_400_000) {
      delete r.sealed_record;
      changed = true;
    }
  }
  return changed;
}

/** A sealed-link key hash: 64 lowercase hex characters, or absent. */
export function parseKeyHash(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("key_hash must be 64 lowercase hex characters (a SHA-256 digest)");
  }
  return value;
}
