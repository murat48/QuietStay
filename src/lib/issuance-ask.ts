/**
 * Filing an issuance ask from the browser, for a renewal (2026-11-27).
 *
 * As the owner's own ask on /issue: the week's secret and a sealed-link key
 * are made and kept in this browser's vault, and only `h` and the key's
 * public half leave it. The details go sealed to the issuer's intake key,
 * checked against the issuer on chain first (./issuer-intake.ts).
 */

import type { OwnerDetails } from "./issuer-key";
import { sealDetails, verifiedIntakeKey } from "./issuer-intake";
import { b64u } from "./sealed";
import { newSealKey, newSecret } from "./vault";

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function fileRenewal(opts: {
  address: string;
  rightId: number;
  details: OwnerDetails;
  auto: boolean;
  authFetch: AuthFetch;
}): Promise<void> {
  const intake = await verifiedIntakeKey();
  if (!intake) {
    throw new Error("the issuer cannot receive details yet, so a renewal cannot carry this week's record; ask the issuer to turn it on");
  }
  // Sealed first, so a refused key stops it before a secret is made.
  const sealed = await sealDetails(intake, opts.address, opts.details);
  const h = await newSecret(`renewal of week #${opts.rightId}`);
  const key = await newSealKey(`renewal of week #${opts.rightId}`);
  const res = await opts.authFetch("/api/requests/issuance", {
    method: "POST",
    body: JSON.stringify({
      secret_hash: h.toString(),
      key_hash: key.keyHash,
      public_key: b64u(key.publicRaw),
      sealed_details: sealed,
      renew_of: opts.rightId,
      auto_renew: opts.auto,
    }),
  });
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "the renewal was not recorded");
}
