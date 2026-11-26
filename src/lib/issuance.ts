/**
 * The checks and the commitment of one issuance, shared by the two ways a
 * week is issued (src/app/api/issue):
 *
 * - signed on the server with the issuer key, where the deployment holds one
 *   (the testnet demo);
 * - as an unsigned envelope the issuer signs with the Stellar CLI
 *   (scripts/mainnet-sign-submit.sh), then confirmed here by its hash: the
 *   only way on mainnet, where the server holds no issuer key (Step 5 plan,
 *   item 3, 2026-11-27).
 *
 * Server only: it reaches the GPL-3.0 Poseidon code through scripts/lib/zk.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { commitment as poseidonCommitment, splitRecordDigest } from "../../scripts/lib/zk";
import { fr } from "../../scripts/lib/zk-encode";

import { signAttestation } from "./attestation";
import { saveAttestation } from "./attestation-store";
import { canonicalText, type JsonValue } from "./canonical";
import { parseSecretHash } from "./consent";
import { CONTRACT_ID, FEE_ACCOUNT, NETWORK_PASSPHRASE } from "./config";
import { reservedOwnerReason } from "./issue-guard";
import {
  feesAreCurrent,
  onChainWindows,
  propertyFacts,
  recordCommitment,
  validateRecord,
  type OwnershipRecord,
} from "./record";
import { RequestStoreUnavailable, loadIssuanceRequests, weekSecuredBy } from "./requests";
import { serverAccount } from "./sep10";

export interface PreparedIssuance {
  record: OwnershipRecord;
  canonicalBytes: number;
  /** d, what the attestation binds. */
  recordDigest: string;
  h: bigint;
  requestId: string | null;
  /** C = Poseidon(d, owner, h), hex. */
  commitment: string;
  windows: ReturnType<typeof onChainWindows>;
}

/** A refusal, with the HTTP status to answer it with. */
export class IssuanceRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "IssuanceRefused";
  }
}

/**
 * Everything that must hold before a week goes on chain, checked here because
 * an issuance cannot be undone, and the commitment it will carry.
 */
export async function prepareIssuance(
  body: { record?: unknown; secret_hash?: unknown; request_id?: unknown },
  issuer: string,
): Promise<PreparedIssuance> {
  const record = validateRecord(body.record);
  // Never to the fee account, the issuer or the sign-in key.
  let signIn: string | null = null;
  try {
    signIn = serverAccount();
  } catch {
    signIn = null;
  }
  const reserved = reservedOwnerReason(record.owner.stellar_account, { feeAccount: FEE_ACCOUNT, issuer, signIn });
  if (reserved) throw new IssuanceRefused(reserved, 400);
  const canonical = canonicalText(record as never);
  const recordDigest = await recordCommitment(record);

  let h: bigint;
  let requestId: string | null = null;
  if (body.request_id !== undefined) {
    // From an owner's ask: h is theirs, and so is the week.
    const ask = (await loadIssuanceRequests()).find((r) => r.id === body.request_id);
    if (!ask) throw new IssuanceRefused("no such issuance request", 404);
    if (ask.status !== "open") throw new IssuanceRefused(`this request was already ${ask.status}`, 409, { request: ask });
    if (record.owner.stellar_account !== ask.by) {
      throw new IssuanceRefused(`the record's first holder must be the account that asked, ${ask.by}`, 400);
    }
    h = parseSecretHash(ask.secret_hash);
    requestId = ask.id;
  } else {
    try {
      h = parseSecretHash(body.secret_hash);
    } catch (caught) {
      throw new IssuanceRefused(`secret_hash: ${caught instanceof Error ? caught.message : "not valid"}`, 400);
    }
    // Typed in rather than picked, but the same ask: close it too.
    try {
      const same = (await loadIssuanceRequests()).find(
        (r) => r.status === "open" && r.by === record.owner.stellar_account && parseSecretHash(r.secret_hash) === h,
      );
      if (same) requestId = same.id;
    } catch {
      // No readable store: nothing to close.
    }
  }
  // One secret per week (see `weekSecuredBy`).
  try {
    const spent = await weekSecuredBy(h);
    if (spent && spent.id !== requestId) {
      throw new IssuanceRefused(
        `this h already secures week #${spent.right_id} — the owner should ask again, which makes a new secret`,
        409,
      );
    }
  } catch (caught) {
    if (!(caught instanceof RequestStoreUnavailable)) throw caught;
  }
  const d = await splitRecordDigest(record as unknown as JsonValue);
  const commitment = fr(await poseidonCommitment(d, record.owner.stellar_account, h));
  return {
    record,
    canonicalBytes: canonical.length,
    recordDigest,
    h,
    requestId,
    commitment,
    windows: onChainWindows(record),
  };
}

/** Sign and keep the attestation, where the deployment holds the issuer key. */
export async function attestIssued(issuer: Keypair, prepared: PreparedIssuance, rightId: number) {
  const clean = feesAreCurrent(prepared.record);
  const attestation = signAttestation(issuer, {
    contract: CONTRACT_ID,
    network: NETWORK_PASSPHRASE,
    rightId,
    recordDigest: prepared.recordDigest,
    weekValid: true,
    property: propertyFacts(prepared.record),
    feesCurrent: clean,
    feesPaidThrough: prepared.record.maintenance_fees.paid_through,
    validForDays: 365,
  });
  const attestationPath = await saveAttestation(rightId, attestation);
  return { clean, attestation, attestationPath };
}
