/**
 * A bounded retry for **read-only** RPC and Horizon calls (Step 3 review,
 * the High issue in docs/PHASE3_PROGRESS.md).
 *
 * Retried: simulations, ledger and account reads, transaction-status polls,
 * and Horizon reads. Never retried: `sendTransaction`, or anything else that
 * submits. A submission that may have reached the network is not sent again.
 *
 * Only a connection-level failure is retried: Node's `fetch failed` and the
 * codes under it (ECONNRESET, ETIMEDOUT, …), or a 429/502/503/504 from the
 * endpoint. A contract refusal is not an exception here at all: simulation
 * returns it as a result. Every retry is logged with the network code, so the
 * next occurrence of the High issue names its cause.
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/** The network codes under an error: its own, its cause's, and an AggregateError's members'. */
export function networkCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 4) return [];
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown; status?: unknown; response?: { status?: unknown } };
  const out: string[] = [];
  if (typeof e.code === "string") out.push(e.code);
  const status = typeof e.status === "number" ? e.status : typeof e.response?.status === "number" ? e.response.status : null;
  if (status !== null) out.push(`HTTP ${status}`);
  if (Array.isArray(e.errors)) for (const x of e.errors) out.push(...networkCodes(x, depth + 1));
  if (e.cause) out.push(...networkCodes(e.cause, depth + 1));
  return [...new Set(out)];
}

/**
 * Where a code can come from when the error itself carries none (the SDK's
 * HTTP layer drops it). Set by `rpc-server.ts` on the server; `null` elsewhere.
 */
let recentNetworkError: () => string | null = () => null;
export function setRecentNetworkError(source: () => string | null): void {
  recentNetworkError = source;
}

export function isTransient(error: unknown): boolean {
  const codes = networkCodes(error);
  if (codes.some((c) => TRANSIENT_CODES.has(c) || /^HTTP (429|502|503|504)$/.test(c))) return true;
  const message = (error as { message?: unknown } | null)?.message;
  // Node: "fetch failed". Chrome: "Failed to fetch". Firefox: "NetworkError
  // when attempting to fetch resource."
  return (
    typeof message === "string" &&
    /^fetch failed$|^failed to fetch$|^networkerror when attempting to fetch|socket hang up/i.test(message)
  );
}

/**
 * Run a read-only call, retrying a transient failure up to `attempts` times in
 * all, after 300 ms and then 900 ms. Anything else, and the last failure, is
 * thrown as it came.
 */
export async function readOnly<T>(
  what: string,
  call: () => Promise<T>,
  { attempts = 3, log = console.warn, pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      const codes = networkCodes(error);
      const detail = codes.join(", ") || recentNetworkError() || (error as Error).message;
      log(`[rpc-retry] ${what}: attempt ${attempt} of ${attempts} failed (${detail}); retrying`);
      await pause(300 * 3 ** (attempt - 1));
    }
  }
}
