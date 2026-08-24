/**
 * Somewhere to put what the app writes after the build.
 *
 * A serverless deployment has no disk. Its filesystem is the build output,
 * mounted read-only, so `writeFileSync` fails with `EROFS` — which is fine for
 * the attestations that shipped with the build and fatal for anything created
 * once the app is running. Two things are: an attestation for a week issued
 * from the hosted app, and a request to take a week off somebody.
 *
 * This module is the writable half. It speaks Upstash's REST API rather than the
 * Redis wire protocol, because a serverless invocation cannot hold a TCP
 * connection open between requests, and over REST there is nothing to hold.
 *
 * Chosen over blob storage deliberately. Blob storage would have done for
 * attestations, which are written once and read many times, but requests are
 * read-modify-write — two people asking for the same week seconds apart — and
 * blob reads come through a CDN whose cache cannot be set below a minute. That
 * is a window in which the second writer reads a stale list and erases the
 * first. Nobody would ever see it happen.
 *
 * ## Not a source of truth
 *
 * Nothing here is authoritative about who holds what. The contract is. This
 * stores what the issuer has vouched for and what people have asked for — both
 * recoverable, neither able to move a week. A store that vanished entirely would
 * cost the registry its verification badges and its pending asks, and cost
 * nobody their property.
 */

/**
 * Upstash injects the first pair; Vercel's own integration used to inject the
 * second under its `KV_` names. Both accepted, so a project set up either way
 * works without being told which it is.
 */
function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** Whether this deployment has a store to write to at all. */
export function kvIsConfigured(): boolean {
  return credentials() !== null;
}

export class KvError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "KvError";
  }
}

/**
 * One Redis command, as Upstash's REST API takes them.
 *
 * The command is a JSON array in the body rather than path segments, so a key or
 * value containing a slash needs no escaping and a large attestation is not
 * pushed through a URL.
 *
 * `cache: "no-store"` because the runtime will otherwise memoise `fetch` per
 * request, and an attestation written and read back in the same invocation —
 * which is exactly what issuing does — would read the value from before the
 * write.
 */
async function command(args: (string | number)[]): Promise<unknown> {
  const creds = credentials();
  if (!creds) throw new KvError("no store is configured for this deployment");

  let response: Response;
  try {
    response = await fetch(creds.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
    });
  } catch (error) {
    throw new KvError("the store could not be reached", error);
  }

  if (!response.ok) {
    // The body carries Upstash's own explanation; the status alone does not say
    // whether the token is wrong or the command was.
    const detail = await response.text().catch(() => "");
    throw new KvError(
      `the store refused the request (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const body = (await response.json()) as { result?: unknown; error?: string };
  if (body.error) throw new KvError(`the store reported an error: ${body.error}`);
  return body.result ?? null;
}

/** The value stored under `key`, or `null` if there is none. */
export async function kvGet(key: string): Promise<string | null> {
  const result = await command(["GET", key]);
  return typeof result === "string" ? result : null;
}

/** Store `value` under `key`, replacing whatever was there. */
export async function kvSet(key: string, value: string): Promise<void> {
  await command(["SET", key, value]);
}

/**
 * A cheap round trip that proves the credentials work.
 *
 * Asked before an irreversible step, so `PING` rather than a write: it costs one
 * command and cannot leave anything behind if the caller then decides not to
 * proceed.
 */
export async function kvIsReachable(): Promise<boolean> {
  if (!kvIsConfigured()) return false;
  try {
    await command(["PING"]);
    return true;
  } catch {
    return false;
  }
}
