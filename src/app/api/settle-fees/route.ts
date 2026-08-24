/**
 * Record that a week's maintenance fees have been settled.
 *
 *   POST /api/settle-fees  { right_id, paid_through, fees_current? }
 *     → the newly signed attestation
 *
 * ## Why this exists
 *
 * An ownership record mixes two kinds of fact. The resort, the unit, the deed and
 * the week's dates are permanent — committing to them once is exactly right. Fee
 * status is not: it changes every time somebody pays. Because the commitment is
 * immutable, a record that said "410.00 outstanding" at issuance says it forever,
 * and no edit can ever be made to it without invalidating the commitment the
 * ledger holds.
 *
 * The attestation is the layer that is allowed to change. It is re-signable, it
 * expires, and it already carries `maintenance_fees_current` and
 * `fees_paid_through` as its own fields. This route makes them what they should
 * always have been — the issuer's *current* statement — rather than a copy of a
 * frozen snapshot.
 *
 * ## What it does not do
 *
 * It moves no money. Maintenance fees are settled with the resort the way they
 * always have been, and the issuer records that it happened — which is why this
 * stays inside Phase 1's "no payment, no escrow" boundary rather than crossing it.
 *
 * It also touches neither the record nor the ledger. The commitment stands, the
 * right is untouched, and its id, week, and holder are exactly as they were. The
 * only thing that changes is what the issuer currently vouches for.
 *
 * ## Why the issuer, and only the issuer
 *
 * An attestation is the issuer's assertion, so nobody else can make one — the
 * signature would not verify against `issuer()` read from the contract. The
 * SEP-10 session here stops the deployment's key being driven by whoever finds
 * the URL; the cryptography is what actually enforces it.
 *
 * Note the shape of the power this grants: the issuer can already decline any
 * transfer, so being able to lift its own objection adds nothing it did not have.
 * It still cannot move, freeze, or seize a right.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { signAttestation } from "@/lib/attestation";
import { loadAttestation, saveAttestation } from "@/lib/attestation-store";
import { digestsMatch } from "@/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, hasIssuerSecret, issuerSecret } from "@/lib/config";
import { ContractCallError, readRight } from "@/lib/contract";
import { authenticatedAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // A deployment without the issuer key cannot sign, and says so rather than
  // failing on a missing environment variable. See `hasIssuerSecret`.
  if (!hasIssuerSecret()) {
    return Response.json(
      {
        error:
          "this deployment is read-only: it does not hold the issuer key, so it cannot " +
          "issue, attest, or approve a transfer. Browsing and verification need no key.",
        read_only: true,
      },
      { status: 503 },
    );
  }

  const issuer = Keypair.fromSecret(issuerSecret());

  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json(
      { error: "not authenticated — connect the issuer's wallet and sign in" },
      { status: 401 },
    );
  }
  if (caller !== issuer.publicKey()) {
    return Response.json(
      {
        error: "only the issuer can record a fee settlement",
        authenticated_as: caller,
        issuer: issuer.publicKey(),
      },
      { status: 403 },
    );
  }

  let body: { right_id?: unknown; paid_through?: unknown; fees_current?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const rightId = Number(body.right_id);
  if (!Number.isInteger(rightId) || rightId < 1) {
    return Response.json({ error: "right_id must be a positive integer" }, { status: 400 });
  }

  const paidThrough = body.paid_through;
  if (typeof paidThrough !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(paidThrough)) {
    return Response.json(
      { error: "paid_through must be an ISO date (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  // Defaults to settling. The reverse — an issuer that has discovered arrears on
  // a week it previously attested clean — goes through the same door, because a
  // one-way switch would let a stale clean attestation stand for a year.
  const feesCurrent = body.fees_current === undefined ? true : body.fees_current === true;

  // Re-signing means restating an attestation that already exists. Creating the
  // first one is issuance's job (or `npm run attest`), because `week_valid` is a
  // claim about the week itself that this route has no basis to originate.
  const existing = loadAttestation(rightId);
  if (existing === null) {
    return Response.json(
      {
        error:
          `no attestation exists for right #${rightId} to update — ` +
          "issue or attest the week first",
      },
      { status: 404 },
    );
  }

  try {
    const right = await readRight(rightId);

    if (right.issuer !== issuer.publicKey()) {
      return Response.json(
        { error: `right #${rightId} was issued by ${right.issuer}, not by this issuer` },
        { status: 403 },
      );
    }

    // The attestation on file must be about the record the ledger committed to.
    // If it is not, the store is out of step with the chain and re-signing would
    // launder the discrepancy into a fresh, valid-looking signature.
    if (!digestsMatch(existing.payload.commitment, right.commitment)) {
      return Response.json(
        {
          error:
            "the attestation on file commits to a different record than the ledger holds; " +
            "re-attest from the record with `npm run attest` before settling fees",
          on_file: existing.payload.commitment,
          on_chain: right.commitment,
        },
        { status: 409 },
      );
    }

    const attestation = signAttestation(issuer, {
      contract: CONTRACT_ID,
      network: NETWORK_PASSPHRASE,
      rightId,
      commitment: right.commitment,
      // Carried over rather than re-asserted: this route knows nothing new about
      // whether the week is a real, allocated interval, or what the property
      // is. Dropping either would quietly un-attest it on the way through.
      weekValid: existing.payload.week_valid,
      property: existing.payload.property,
      feesCurrent,
      feesPaidThrough: paidThrough,
      validForDays: 365,
    });

    const path = saveAttestation(rightId, attestation);

    return Response.json({
      right_id: rightId,
      fees_current: feesCurrent,
      paid_through: paidThrough,
      previous: {
        fees_current: existing.payload.maintenance_fees_current,
        paid_through: existing.payload.fees_paid_through,
      },
      attestation,
      attestation_path: path,
      note: feesCurrent
        ? "The issuer now attests this week carries no unpaid maintenance fees. A transfer of " +
          "it will be approved, and anyone verifying it will see that check pass. The ownership " +
          "record and the on-chain commitment are unchanged."
        : "The issuer now attests this week carries unpaid maintenance fees. Transfers of it " +
          "will be declined until they are settled; the holder keeps the week either way.",
    });
  } catch (error) {
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "could not record the settlement" },
      { status: 500 },
    );
  }
}
