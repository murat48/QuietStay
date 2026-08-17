/**
 * SEP-10 web authentication endpoint.
 *
 *   GET  /api/auth?account=G...   → a challenge transaction to sign
 *   POST /api/auth {transaction}  → a session token
 *
 * The shape follows SEP-10's `WEB_AUTH_ENDPOINT` so a standard wallet or the
 * reference client can talk to it unchanged.
 */

import { buildChallenge, serverAccount, Sep10Error, verifyChallenge } from "@/lib/sep10";

export async function GET(request: Request): Promise<Response> {
  const account = new URL(request.url).searchParams.get("account");
  if (!account) {
    return Response.json({ error: "account query parameter is required" }, { status: 400 });
  }

  try {
    return Response.json({ ...buildChallenge(account), server_account: serverAccount() });
  } catch (error) {
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
    const message = error instanceof Sep10Error ? error.message : "authentication failed";
    return Response.json({ error: message }, { status: 401 });
  }
}
