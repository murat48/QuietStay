/**
 * The issuer's attestation for one usage right.
 *
 *   GET /api/attestation/3  → { payload, signature }   404 if none was signed
 *
 * ## Why serving this concedes nothing
 *
 * An attestation is self-verifying. The counterparty's browser checks its Ed25519
 * signature against the issuer address read from the **contract**, and checks its
 * four binding fields — `right_id`, `commitment`, `contract`, `network` — against
 * the right it claims to be about. This route holds no issuer key, so it cannot
 * forge one, and any edit breaks the signature.
 *
 * Where the file came from is therefore not part of the trust argument, which is
 * what makes handing it to a visitor a convenience rather than a concession. The
 * alternative — every counterparty first obtaining a file out of band — made the
 * verify screen unusable for anyone who had not been sent one.
 *
 * ## What is deliberately not served
 *
 * The ownership record. That document is the thing this design keeps off the
 * wire: it names the owner, the resort, the unit, and the deed. Only its holder
 * may disclose it, and the verify screen accepts it by paste alone. There is no
 * endpoint for it and there should not be one.
 */

import { loadAttestation } from "@/lib/attestation-store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const rightId = Number(id);

  if (!Number.isInteger(rightId) || rightId < 1) {
    return Response.json({ error: "right id must be a positive integer" }, { status: 400 });
  }

  const attestation = loadAttestation(rightId);
  if (attestation === null) {
    return Response.json(
      {
        error:
          `the issuer has signed no attestation for right #${rightId}` +
          " — nothing vouches that this week is free of unpaid fees",
      },
      { status: 404 },
    );
  }

  return Response.json(attestation);
}
