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
import net from "node:net";

import { rpc } from "@stellar/stellar-sdk";

// The High issue's cause (Step 5, evidence/network/): Node's fetch races IPv6
// and IPv4 and gives each address only 250 ms to connect. On a machine with
// no IPv6 route, IPv6 fails at once (ENETUNREACH), and any IPv4 connect slower
// than 250 ms fails too, so the whole request fails with ETIMEDOUT after about
// half a second while the host is up. In two 30-minute probes run side by
// side, 2 s per attempt removed that class (61 failures under 2 s → 0). It
// cannot help a real outage (DNS failures, 10 s connect timeouts), which the
// read-only retry covers and which a submission never retries.
net.setDefaultAutoSelectFamilyAttemptTimeout(2_000);

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
