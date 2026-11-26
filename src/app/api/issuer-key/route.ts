/**
 * The issuer's intake key (src/lib/issuer-key.ts, D16).
 *
 *   GET  /api/issuer-key                          → { key } or { key: null }
 *   POST /api/issuer-key { public_key, signature } → { key }   (issuer only)
 *
 * The key is public. What makes it the issuer's is the signature, which the
 * owner's browser checks itself against the issuer read from the chain; this
 * server checks it too, so it never serves one that fails.
 */

import { CONTRACT_ID, NETWORK_PASSPHRASE } from "@/lib/config";
import { readIssuer } from "@/lib/contract";
import { intakeKeyMessage, intakeSignatureIsValid, type IntakeKey } from "@/lib/issuer-key";
import { RequestStoreUnavailable, loadIssuerKeyStore, saveIssuerKeyStore } from "@/lib/requests";
import { sha256Hex, unb64u } from "@/lib/sealed";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const [issuer, keys] = await Promise.all([readIssuer(), loadIssuerKeyStore<IntakeKey>()]);
    const key = keys.find((k) => k.issuer === issuer) ?? null;
    return Response.json({ key });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "could not read" }, { status: 502 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });

  let body: { public_key?: unknown; signature?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  try {
    const issuer = await readIssuer();
    if (caller !== issuer) return Response.json({ error: "only the issuer publishes an intake key" }, { status: 403 });
    if (typeof body.public_key !== "string" || typeof body.signature !== "string") {
      return Response.json({ error: "public_key and signature are required" }, { status: 400 });
    }
    let raw: Uint8Array;
    try {
      raw = unb64u(body.public_key);
    } catch {
      return Response.json({ error: "public_key must be base64url" }, { status: 400 });
    }
    if (raw.length !== 65 || raw[0] !== 4) {
      return Response.json({ error: "public_key must be an uncompressed P-256 key" }, { status: 400 });
    }
    const keyHash = await sha256Hex(raw);
    const message = intakeKeyMessage({ contract: CONTRACT_ID, network: NETWORK_PASSPHRASE, keyHash });
    if (!intakeSignatureIsValid(issuer, message, body.signature)) {
      return Response.json({ error: "the signature is not the issuer's signature of this key" }, { status: 400 });
    }
    const key: IntakeKey = {
      issuer,
      public_key: body.public_key,
      key_hash: keyHash,
      signature: body.signature,
      published_at: new Date().toISOString(),
    };
    await saveIssuerKeyStore([key]);
    return Response.json({ key });
  } catch (error) {
    if (error instanceof RequestStoreUnavailable) {
      return Response.json({ error: error.message, read_only: true }, { status: 503 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "could not save" }, { status: 500 });
  }
}
