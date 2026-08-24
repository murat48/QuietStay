/**
 * Transfer requests — the buyer's side of the marketplace.
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
 * exactly the transfer that was always there: the holder's signature, the issuer's
 * approval, the contract checking both. Nothing here can move a week.
 *
 * **The issuer is not part of it.** Requests travel between holder and requester
 * only. Putting the issuer in this path would let it suppress interest in a week
 * as well as decline its transfer — which, between them, is what freezing an asset
 * means. Its approval stays exactly where it is: at the moment of transfer, as a
 * signature the contract requires.
 *
 * ## Visibility
 *
 * A request names an account that wants a particular week, which is more than the
 * registry says about anyone. It is served only to the two parties: the account
 * that made it, and the account holding the week it is for.
 */

import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DATA_ROOT } from "./config";

export const REQUESTS_DIR = "inventory/requests";

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
function pathFor(rightId: number): string {
  return resolve(DATA_ROOT, REQUESTS_DIR, `right-${rightId}.requests.json`);
}

/** Every request ever made for one right, newest last. */
export function loadRequests(rightId: number): TransferRequest[] {
  try {
    return JSON.parse(readFileSync(pathFor(rightId), "utf8")) as TransferRequest[];
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
      "this deployment cannot record transfer requests: it has no writable store. " +
        "Browsing, verification, and publishing an offer all work here.",
    );
    this.name = "RequestStoreUnavailable";
  }
}

/** Whether a request can be recorded at all. Cheap, and does not create a file. */
export function requestStoreIsWritable(): boolean {
  try {
    mkdirSync(resolve(DATA_ROOT, REQUESTS_DIR), { recursive: true });
    accessSync(resolve(DATA_ROOT, REQUESTS_DIR), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function saveRequests(rightId: number, requests: TransferRequest[]): string {
  const path = pathFor(rightId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(requests, null, 2)}\n`, "utf8");
  } catch (error) {
    // EROFS, EACCES, ENOSPC — all the same answer to the caller: not here.
    throw new RequestStoreUnavailable(error);
  }
  return join(REQUESTS_DIR, `right-${rightId}.requests.json`);
}

/**
 * Replace one request in a right's file, by id.
 *
 * Read-modify-write on a file, which is right for a reference deployment and
 * would be a row update in a production one. Returns `null` when the id is not
 * there, so a caller can answer 404 rather than writing a file that silently
 * changed nothing.
 */
export function updateRequest(
  rightId: number,
  requestId: string,
  change: (request: TransferRequest) => TransferRequest,
): TransferRequest | null {
  const all = loadRequests(rightId);
  const index = all.findIndex((r) => r.id === requestId);
  if (index === -1) return null;

  const updated = change(all[index]!);
  all[index] = updated;
  saveRequests(rightId, all);
  return updated;
}

/** The request this account has outstanding on a right, if any. */
export function openRequestBy(rightId: number, account: string): TransferRequest | null {
  return loadRequests(rightId).find((r) => r.by === account && r.status === "open") ?? null;
}
