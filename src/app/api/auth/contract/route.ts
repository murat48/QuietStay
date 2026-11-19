/**
 * SEP-45 sign-in for smart wallets (`C…` accounts): src/lib/sep45.ts.
 *
 *   GET  /api/auth/contract?account=C…[&home_domain=…]  → { authorization_entries, network_passphrase }
 *   POST /api/auth/contract  { authorization_entries } (JSON or form-encoded) → { token, account }
 *
 * `G…` accounts sign in with SEP-10 at /api/auth. Both issue the same session
 * token. Advertised in /.well-known/stellar.toml as
 * WEB_AUTH_FOR_CONTRACTS_ENDPOINT.
 */

import { ConfigurationError } from "@/lib/config";
import { buildChallenge, Sep45Error, verifyChallenge } from "@/lib/sep45";

export const dynamic = "force-dynamic";

const cors = { "access-control-allow-origin": "*" };

function fault(error: unknown, status: number): Response {
  if (error instanceof ConfigurationError) {
    return Response.json({ error: `this deployment is not configured for sign-in: ${error.message}` }, { status: 502, headers: cors });
  }
  const message = error instanceof Sep45Error ? error.message : "authentication failed";
  return Response.json({ error: message }, { status, headers: cors });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const account = params.get("account");
  if (!account) return Response.json({ error: "account query parameter is required" }, { status: 400, headers: cors });
  try {
    return Response.json(await buildChallenge(account, params.get("home_domain")), { headers: cors });
  } catch (error) {
    return fault(error, 400);
  }
}

export async function POST(request: Request): Promise<Response> {
  let entries: string | null = null;
  try {
    if ((request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      entries = new URLSearchParams(await request.text()).get("authorization_entries");
    } else {
      entries = ((await request.json()) as { authorization_entries?: string }).authorization_entries ?? null;
    }
  } catch {
    return Response.json({ error: "expected { authorization_entries }" }, { status: 400, headers: cors });
  }
  if (!entries) return Response.json({ error: "authorization_entries is required" }, { status: 400, headers: cors });
  try {
    return Response.json(await verifyChallenge(entries), { headers: cors });
  } catch (error) {
    return fault(error, 401);
  }
}
