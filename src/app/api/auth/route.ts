/**
 * SEP-10 web authentication endpoint.
 *
 *   GET  /api/auth?account=G...   → a challenge transaction to sign
 *   POST /api/auth {transaction}  → a session token
 *
 * The shape follows SEP-10's `WEB_AUTH_ENDPOINT` so a standard wallet or the
 * reference client can talk to it unchanged.
 */

import { ConfigurationError } from "@/lib/config";
import { buildChallenge, serverAccount, Sep10Error, verifyChallenge } from "@/lib/sep10";

/**
 * A deployment without its SEP-10 keys, told apart from a bad request.
 *
 * Both used to end up as 400 "could not build a challenge", which blames the
 * caller for something only the operator can fix and names nothing they could
 * act on. A missing key is a 502 in SEP-10's terms — the server cannot do its
 * part — and the message says which variable, because the person who sees it in
 * a browser console is usually the one who forgot to set it.
 *
 * Safe to repeat: the message names variables, never values.
 */
function configurationFault(error: unknown): Response | null {
  if (!(error instanceof ConfigurationError)) return null;
  return Response.json(
    { error: `this deployment is not configured for sign-in: ${error.message}` },
    { status: 502 },
  );
}

export async function GET(request: Request): Promise<Response> {
  const account = new URL(request.url).searchParams.get("account");
  if (!account) {
    return Response.json({ error: "account query parameter is required" }, { status: 400 });
  }

  try {
    return Response.json({ ...buildChallenge(account), server_account: serverAccount() });
  } catch (error) {
    const misconfigured = configurationFault(error);
    if (misconfigured) return misconfigured;

    const message = error instanceof Sep10Error ? error.message : "could not build a challenge";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: { transaction?: string };
  try {
    body = (await request.json()) as { transaction?: string };
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  if (!body.transaction) {
    return Response.json({ error: "transaction is required" }, { status: 400 });
  }

  try {
    const { account, token } = await verifyChallenge(body.transaction);
    return Response.json({ token, account });
  } catch (error) {
    // Reachable here too: the session key is only touched once a challenge comes
    // back signed, so a deployment missing it gets this far before failing.
    const misconfigured = configurationFault(error);
    if (misconfigured) return misconfigured;

    const message = error instanceof Sep10Error ? error.message : "authentication failed";
    return Response.json({ error: message }, { status: 401 });
  }
}
