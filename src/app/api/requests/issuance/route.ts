/**
 * Ask the issuer to issue a week to you, and read the asks that concern you.
 *
 *   POST /api/requests/issuance  { secret_hash }  → the request, as recorded
 *   GET  /api/requests/issuance                   → { requests }
 *   GET  /api/requests/issuance?id=<id>           → { request }, open or issued
 *
 * An owner's issued ask may carry `sealed_record`, the week's record sealed
 * to their browser's key, waiting to be picked up (./delivery/route.ts).
 *
 * Phase 3: the ask may carry `key_hash`, the hash of the owner's sealed-link
 * key, so the issuer's browser can send the week's record back sealed
 * (docs/PHASE3_SPEC.md §2, D3). Since 2026-11-25 it may also carry
 * `public_key`, that key itself, checked to hash to `key_hash`, so the
 * issuer's browser seals the record the moment it issues.
 *
 * The owner's side of issuance, built like an ask for a week (../route.ts). The
 * first holder is taken **from the SEP-10 session**, never from the body: a body
 * naming another account is refused, so nobody can file an `h` in someone else's
 * name. `secret_hash` is `h = Poseidon(s)`, checked exactly as /api/issue checks
 * it — a number, decimal or hex, above 0 and below the BLS12-381 scalar modulus.
 * The secret `s` itself is never sent; `h` is the only thing that reaches this
 * server.
 *
 * GET serves the issuer every open ask, and any other account only its own.
 * Issuing from an ask closes it (/api/issue, `request_id`).
 */

import { randomUUID } from "node:crypto";

import { parseSecretHash } from "@/lib/consent";
import { FEE_ACCOUNT } from "@/lib/config";
import { readIssuer, readRight } from "@/lib/contract";
import { reservedAskerReason } from "@/lib/issue-guard";
import {
  RequestStoreUnavailable,
  askIsDue,
  expireSealed,
  loadIssuanceRequests,
  parseKeyHash,
  parseSealedBlob,
  saveIssuanceRequests,
  type IssuanceRequest,
} from "@/lib/requests";
import { checkedAskPublicKey } from "@/lib/sealed";
import { authenticatedAccount, serverAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json(
      { error: "not authenticated — connect the wallet the week should be issued to, and sign in" },
      { status: 401 },
    );
  }

  let body: {
    secret_hash?: unknown;
    owner?: unknown;
    key_hash?: unknown;
    public_key?: unknown;
    sealed_details?: unknown;
    renew_of?: unknown;
    auto_renew?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  // The fee account, the issuer and the sign-in key never hold a week, so they
  // may not ask for one: refused here, to the asker, not later at issue time.
  let signIn: string | null = null;
  try {
    signIn = serverAccount();
  } catch {
    signIn = null;
  }
  const issuerAccount = await readIssuer().catch(() => null);
  const reserved = reservedAskerReason(caller, { feeAccount: FEE_ACCOUNT, issuer: issuerAccount, signIn });
  if (reserved) return Response.json({ error: reserved }, { status: 403 });

  // The ask is the session's account's, and only its. A body that names anyone
  // else is somebody trying to file an h for an account they have not proved.
  if (body.owner !== undefined && body.owner !== caller) {
    return Response.json(
      {
        error: "an issuance request is always for the account signed in — you cannot ask on another account's behalf",
        authenticated_as: caller,
      },
      { status: 403 },
    );
  }

  let h: bigint;
  let keyHash: string | undefined;
  let publicKey: string | undefined;
  let sealedDetails: { blob: string; key_hash: string } | undefined;
  try {
    h = parseSecretHash(body.secret_hash);
    keyHash = parseKeyHash(body.key_hash);
    publicKey = await checkedAskPublicKey(body.public_key, keyHash);
    // D16: the week's details, sealed in the owner's browser to the issuer's
    // intake key. Ciphertext only; kept with the ask for the issuer's browser.
    if (body.sealed_details !== undefined && body.sealed_details !== null) {
      const d = body.sealed_details as { blob?: unknown; key_hash?: unknown };
      const detailsKey = parseKeyHash(d.key_hash);
      if (!detailsKey) throw new Error("sealed_details.key_hash is required");
      sealedDetails = { blob: parseSealedBlob(d.blob), key_hash: detailsKey };
    }
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  // A renewal (2026-11-27): only the week's title holder, read from the chain,
  // renews it. An automatic one waits, hidden from the issuer, until the week
  // has ended; a manual one is open at once.
  let renewal: { renew_of: number; auto_renew?: true; open_from?: string } | undefined;
  if (body.renew_of !== undefined && body.renew_of !== null) {
    const rightId = Number(body.renew_of);
    if (!Number.isInteger(rightId) || rightId < 1) {
      return Response.json({ error: "renew_of must be a right id" }, { status: 400 });
    }
    let right: Awaited<ReturnType<typeof readRight>>;
    try {
      right = await readRight(rightId);
    } catch {
      return Response.json({ error: `there is no week #${rightId} to renew` }, { status: 404 });
    }
    if (right.holdings[0]?.holder !== caller) {
      return Response.json({ error: `only the title holder of week #${rightId} can renew it` }, { status: 403 });
    }
    const auto = body.auto_renew === true;
    const endsAt = new Date(right.period.end * 1000);
    renewal = {
      renew_of: rightId,
      ...(auto ? { auto_renew: true as const } : {}),
      ...(auto && endsAt.getTime() > Date.now() ? { open_from: endsAt.toISOString() } : {}),
    };
  }

  try {
    const all = await loadIssuanceRequests();
    if (renewal) {
      const already = all.find((r) => r.renew_of === renewal.renew_of && r.status === "open");
      if (already) {
        return Response.json(
          { error: `week #${renewal.renew_of} already has a renewal waiting`, request: already },
          { status: 409 },
        );
      }
    }
    const duplicate = all.find((r) => r.by === caller && r.status === "open" && r.secret_hash === h.toString());
    if (duplicate) {
      return Response.json(
        { error: "you already have an open request with this h", request: duplicate },
        { status: 409 },
      );
    }
    const spent = all.find((r) => r.status === "issued" && r.secret_hash === h.toString());
    if (spent) {
      return Response.json(
        {
          error:
            `this h already secures week #${spent.right_id} — make a new secret for each week: ` +
            "npm run zk:secret -- .secrets/<new-file>.json",
        },
        { status: 409 },
      );
    }

    const record: IssuanceRequest = {
      id: randomUUID(),
      by: caller,
      secret_hash: h.toString(),
      ...(keyHash ? { key_hash: keyHash } : {}),
      ...(publicKey ? { public_key: publicKey } : {}),
      ...(sealedDetails ? { sealed_details: sealedDetails } : {}),
      ...(renewal ?? {}),
      requested_at: new Date().toISOString(),
      status: "open",
    };
    all.push(record);
    await saveIssuanceRequests(all);

    return Response.json({
      request: record,
      note: "Asked the issuer to issue a week to this account. Keep your secret file: it is what lets you rent the week out or sell it.",
    });
  } catch (error) {
    if (error instanceof RequestStoreUnavailable) {
      return Response.json({ error: error.message, read_only: true }, { status: 503 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not record the request" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  const caller = await authenticatedAccount(request);
  if (!caller) return Response.json({ error: "not authenticated" }, { status: 401 });

  try {
    const [issuer, all] = await Promise.all([readIssuer(), loadIssuanceRequests()]);
    // A sealed record past its lifetime is not served (it is dropped from the
    // store at the next write).
    expireSealed(all);
    // One ask by id, open or issued, for the issuer or the asker: what the
    // issuer's browser reads to check a sealed-link key before sealing.
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      const ask = all.find((r) => r.id === id && !r.direct && (caller === issuer || r.by === caller));
      return ask ? Response.json({ request: ask }) : Response.json({ error: "no such request" }, { status: 404 });
    }
    // An ask from an account that can never hold a week (one recorded before
    // such asks were refused) is not offered to the issuer: issuing it would
    // be refused anyway.
    let signIn: string | null = null;
    try {
      signIn = serverAccount();
    } catch {
      signIn = null;
    }
    const reserved = { feeAccount: FEE_ACCOUNT, issuer, signIn };
    const requests =
      caller === issuer
        ? all.filter((r) => r.status === "open" && askIsDue(r) && reservedAskerReason(r.by, reserved) === null)
        : all.filter((r) => r.by === caller && !r.direct);
    return Response.json({ requests, as_issuer: caller === issuer });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not read requests" },
      { status: 502 },
    );
  }
}
