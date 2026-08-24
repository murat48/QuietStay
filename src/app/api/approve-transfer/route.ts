/**
 * The issuer's approval service — QuietStay's SEP-8 analogue.
 *
 *   POST /api/approve-transfer  { from, to, rightId, expiresAt }
 *     → { xdr }   a transfer transaction carrying the issuer's authorization,
 *                 for the holder to sign and submit
 *
 * SEP-8 regulated assets put an approval server between a payer and the network:
 * the client presents a transaction, the server applies its policy, and if the
 * policy is satisfied it signs. This does the same for usage rights, with two
 * differences that both matter:
 *
 *   - The signature is a Soroban **authorization entry**, not a second signature on
 *     the envelope. It is bound to one invocation of `transfer` with one exact
 *     argument list, so it cannot be reused for another right, recipient, or term.
 *   - The requirement is enforced by the contract. This service being unavailable,
 *     compromised, or bypassed does not let an unapproved transfer through, and
 *     does not let the issuer move anything on its own.
 *
 * ## The policy
 *
 * The issuer approves a transfer only when it can still stand behind the week:
 *
 *   1. the right exists and is inside its validity window;
 *   2. `from` is the effective holder, as the contract sees it;
 *   3. a valid, unexpired issuer attestation is on file whose commitment matches
 *      the commitment the ledger holds for that right;
 *   4. the requested term is one the contract would accept.
 *
 * Rule 3 is the one with teeth. Week 04 of the sample inventory carries unpaid
 * maintenance fees, so no clean attestation exists for it, so the issuer declines.
 * That is a decline, not a seizure — the holder keeps the week and may keep trying.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { verifyAttestation } from "@/lib/attestation";
import { loadAttestation } from "@/lib/attestation-store";
import { digestsMatch } from "@/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, hasIssuerSecret, issuerSecret } from "@/lib/config";
import {
  ContractCallError,
  approveTransferAsIssuer,
  buildTransferTx,
  readHolding,
  readIsActive,
  readRight,
} from "@/lib/contract";
import { authenticatedAccount } from "@/lib/sep10";

interface ApprovalRequest {
  from?: string;
  to?: string;
  rightId?: number;
  /** Unix seconds for a rental; `null` or absent for a sale. */
  expiresAt?: number | null;
}

function decline(reason: string, detail?: unknown): Response {
  return Response.json({ error: reason, detail }, { status: 403 });
}

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

  // Who is asking. The approval is for a transfer *this* account initiates, so an
  // unauthenticated caller cannot have one issued in someone else's name.
  const caller = await authenticatedAccount(request);
  if (!caller) {
    return Response.json(
      { error: "not authenticated — complete the SEP-10 handshake first" },
      { status: 401 },
    );
  }

  let body: ApprovalRequest;
  try {
    body = (await request.json()) as ApprovalRequest;
  } catch {
    return Response.json({ error: "expected a JSON body" }, { status: 400 });
  }

  const { from, to, rightId } = body;
  const expiresAt = body.expiresAt ?? null;

  if (!from || !to || typeof rightId !== "number") {
    return Response.json({ error: "from, to, and rightId are required" }, { status: 400 });
  }
  if (from !== caller) {
    return decline(
      "you can only request approval for a transfer you are making yourself",
      { authenticated_as: caller, requested_from: from },
    );
  }
  if (from === to) {
    return Response.json({ error: "sender and recipient are the same account" }, { status: 400 });
  }

  const issuer = Keypair.fromSecret(issuerSecret());

  try {
    // --- 1. the right exists and is live ----------------------------------
    const right = await readRight(rightId);
    if (!(await readIsActive(rightId))) {
      return decline(
        `right #${rightId} is outside its validity window, so it cannot be transferred`,
      );
    }

    // --- 2. the requester is the effective holder -------------------------
    const holding = await readHolding(rightId);
    if (holding.holder !== from) {
      return decline(`right #${rightId} is currently held by another account`, {
        effective_holder: holding.holder,
      });
    }

    // --- 3. the term is one the contract would accept ---------------------
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt !== null) {
      if (expiresAt <= now) return decline("a rental cannot end in the past");
      if (expiresAt > right.validity.until) {
        return decline("a rental cannot run past the end of the right's use year", {
          validity_until: right.validity.until,
        });
      }
    }

    // --- 3b. only the title holder may grant ------------------------------
    //
    // Issuer policy, not a contract rule. The contract permits a renter to
    // sub-let inside their own term, and enforces that the sub-grant cannot
    // outlast it — so the title holder's week always comes back on the date they
    // set, however many hands it passed through. What the contract does not do is
    // ask the title holder whether they wanted it passed on at all: `transfer`
    // consults the effective holder and the issuer, and nobody else.
    //
    // This deployment declines to approve that. Sub-letting was never part of
    // what the contract was specified to do; it fell out of modelling holdings as
    // a chain, and with it came a consent question nobody had answered. Declining
    // is a power the issuer openly has (see `docs/DESIGN.md`), so exercising it
    // here is policy rather than a claim about what the contract permits — the
    // contract still permits it, and a different issuer could approve it.
    if (holding.expiresAt !== null) {
      return decline(
        expiresAt !== null
          ? "this issuer does not approve sub-lets: a week you hold on a term is not yours to " +
              "pass on, because the account that holds title to it is not party to that decision"
          : "a rented week is not yours to sell; only the title holder can",
        { your_term_ends: holding.expiresAt, title_holder: right.holdings[0]?.holder ?? null },
      );
    }

    // --- 4. the week is one the issuer still stands behind -----------------
    const attestation = loadAttestation(rightId);
    if (!attestation) {
      return decline(
        `the issuer has no attestation on file for right #${rightId} and will not approve a ` +
          "transfer of a week it cannot vouch for",
      );
    }

    const verification = verifyAttestation(attestation, {
      contract: CONTRACT_ID,
      network: NETWORK_PASSPHRASE,
      rightId,
      contractIssuer: right.issuer,
      onChainCommitment: right.commitment,
    });

    if (!verification.ok) {
      const failures = verification.checks.filter((check) => !check.ok);
      // Say what actually went wrong. A decline the holder cannot understand is
      // indistinguishable from an arbitrary refusal, which is exactly the
      // accusation Phase 1 has to be careful about.
      //
      // Use each check's `detail`, not its `label`: a label states the condition
      // that should hold ("issuer attests maintenance fees are current"), so
      // listing labels as reasons would report the opposite of the problem. The
      // detail is the failure.
      return decline(
        `the issuer will not approve this transfer: ${failures
          .map((check) => check.detail)
          .join("; ")}`,
        { failed_checks: failures },
      );
    }
    if (!digestsMatch(attestation.payload.commitment, right.commitment)) {
      return decline("the attestation commits to a different record than the ledger holds");
    }

    // --- approve -----------------------------------------------------------
    const unsigned = await buildTransferTx({ from, to, rightId, expiresAt });
    const approved = await approveTransferAsIssuer(unsigned, issuer);

    return Response.json({
      xdr: approved.tx.toXDR(),
      network_passphrase: NETWORK_PASSPHRASE,
      approved_by: issuer.publicKey(),
      valid_until_ledger: approved.validUntilLedger,
      terms: { from, to, right_id: rightId, expires_at: expiresAt },
      note:
        "The issuer's authorization is bound to exactly these terms. Sign the envelope with the " +
        "holder's key and submit; the contract checks both signatures.",
    });
  } catch (error) {
    if (error instanceof ContractCallError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "approval failed" },
      { status: 500 },
    );
  }
}
