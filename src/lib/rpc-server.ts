/**
 * The Stellar RPC client for server code, scripts and tests, with the
 * read-only retry built in (Step 3 review, the High issue).
 *
 * Its read methods (`getLatestLedger`, `getAccount`, `getTransaction`,
 * `simulateTransaction`, `getEvents`, `getLedgerEntries`, `getNetwork`,
 * `getHealth`) go through `readOnly`. `sendTransaction` is inherited
 * unchanged and is never retried: a submission that may have reached the
 * network is not sent twice.
 *
 * The SDK's HTTP layer drops the cause of a failed request, so the error it
 * throws says only "fetch failed". Node publishes the real error, with its
 * code, on undici's diagnostics channels; this module listens, so the retry
 * log names the code (ECONNRESET, ETIMEDOUT, ENOTFOUND, …). Server-only: it
 * imports `node:diagnostics_channel`.
 */

import dc from "node:diagnostics_channel";

import { rpc } from "@stellar/stellar-sdk";

import { readOnly, setRecentNetworkError } from "./rpc-retry";

let recent: { code: string; host: string; at: number } | null = null;
const record = (message: unknown) => {
  const m = message as { error?: { code?: unknown; message?: unknown }; connectParams?: { host?: string }; request?: { origin?: string } };
  const code = typeof m.error?.code === "string" ? m.error.code : typeof m.error?.message === "string" ? m.error.message : "unknown";
  recent = { code, host: m.connectParams?.host ?? m.request?.origin ?? "?", at: Date.now() };
};
dc.subscribe("undici:client:connectError", record);
dc.subscribe("undici:request:error", record);
// Only an error from the last few seconds is attributed to a failure.
setRecentNetworkError(() => (recent && Date.now() - recent.at < 5_000 ? `${recent.code} (${recent.host})` : null));

export class RetryingServer extends rpc.Server {
  override getLatestLedger(...a: Parameters<rpc.Server["getLatestLedger"]>) {
    return readOnly("getLatestLedger", () => super.getLatestLedger(...a));
  }
  override getAccount(...a: Parameters<rpc.Server["getAccount"]>) {
    return readOnly("getAccount", () => super.getAccount(...a));
  }
  override getTransaction(...a: Parameters<rpc.Server["getTransaction"]>) {
    return readOnly("getTransaction", () => super.getTransaction(...a));
  }
  override simulateTransaction(...a: Parameters<rpc.Server["simulateTransaction"]>) {
    return readOnly("simulateTransaction", () => super.simulateTransaction(...a));
  }
  override getEvents(...a: Parameters<rpc.Server["getEvents"]>) {
    return readOnly("getEvents", () => super.getEvents(...a));
  }
  override getLedgerEntries(...a: Parameters<rpc.Server["getLedgerEntries"]>) {
    return readOnly("getLedgerEntries", () => super.getLedgerEntries(...a));
  }
  override getNetwork(...a: Parameters<rpc.Server["getNetwork"]>) {
    return readOnly("getNetwork", () => super.getNetwork(...a));
  }
  override getHealth(...a: Parameters<rpc.Server["getHealth"]>) {
    return readOnly("getHealth", () => super.getHealth(...a));
  }
}
