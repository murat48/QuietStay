/**
 * Issuer-signed attestations.
 *
 * An attestation is the issuer saying, in a form anyone can check: *this usage
 * right is a real week, it carries no unpaid maintenance fees, and it is in this
 * part of the world.* It is the one place Phase 1 rests on trusting the issuer,
 * and it does so explicitly.
 *
 * ## Why the property description is here and not in the listing
 *
 * A commitment is a hash of the whole record, so revealing one field of it proves
 * nothing: a buyer cannot check `"Portugal"` against a digest without being given
 * everything the digest covers. A registry built from the ledger alone can say
 * when a week is and nothing else — not where, not how many it sleeps, not what
 * it offers. Nobody takes a week on those terms.
 *
 * So the public description rides here instead, where it is signed, bound to one
 * right, and verifiable — the same standing as the fee claim a buyer already
 * relies on. `propertyFacts()` derives it from the committed record, so what is
 * published cannot drift from the document, and a buyer later shown the record
 * can confirm the two agree.
 *
 * Where the line falls is set out on `PropertyFacts` in `record.ts`: the town but
 * not the resort, what the place is but not which apartment it is.
 *
 * Phase 2's per-field commitments would let a seller prove these against the
 * ledger without the issuer vouching for them at all; until then this is the
 * honest version, and it says out loud whose word it rests on.
 *
 * ## What it is not
 *
 * It does not say who holds the right. That question is answered by the
 * contract's `holder(right_id)`, which the issuer cannot influence, plus SEP-10
 * proof that the seller controls that account. An attestation whose subject
 * changed hands stays valid, because it was never about the holder.
 *
 * ## Signing
 *
 * Ed25519 over UTF-8 bytes, using the issuer's Stellar account key via
 * `Keypair.sign` / `Keypair.verify` — the same primitive that signs every Stellar
 * transaction. No cryptography is implemented here.
 *
 *     signing input = "QuietStay-Attestation-v1:" || canonical(payload)
 *
 * The prefix is domain separation: it makes the signed bytes unmistakably an
 * attestation and not a transaction envelope or any other payload the same key
 * might sign.
 *
 * ## Binding
 *
 * Four fields tie an attestation to exactly one thing, so it cannot be lifted
 * onto another week, another deployment, or mainnet:
 *
 * - `right_id`  — the specific right
 * - `commitment`— the specific off-chain record
 * - `contract`  — the specific deployment
 * - `network`   — the specific network passphrase
 *
 * A verifier checks all four against what the contract actually says.
 * `docs/ATTESTATION.md` states the procedure in full.
 */

import { Keypair } from "@stellar/stellar-sdk";

import { canonicalBytes, digestsMatch, type JsonValue } from "./canonical";
import type { PropertyFacts } from "./record";

export const ATTESTATION_SCHEMA = "quietstay.attestation.v1";
export const SIGNING_PREFIX = "QuietStay-Attestation-v1:";

export interface AttestationPayload {
  schema: typeof ATTESTATION_SCHEMA;
  /** Network passphrase this attestation is valid on. */
  network: string;
  /** Contract address of the rights registry it refers to. */
  contract: string;
  /** The right being attested. */
  right_id: number;
  /** Lowercase hex SHA-256 of the canonical off-chain record. */
  commitment: string;
  /** The issuer's account, which is also the signing key. */
  issuer: string;
  /** The issuer asserts the week is a real, allocated interval. */
  week_valid: boolean;
  /**
   * What a listing may publish about the property: town and country, bedrooms,
   * how many it sleeps, what it offers. Never the resort, the unit, or the deed.
   *
   * Optional because attestations signed before this field existed must keep
   * verifying: absence is authentic — stripping the key from a payload that had
   * one breaks the signature.
   */
  property?: PropertyFacts;
  /** The issuer asserts no maintenance fees are outstanding. */
  maintenance_fees_current: boolean;
  /** ISO date fees are settled through. */
  fees_paid_through: string;
  /** RFC 3339 timestamps bounding when this attestation may be relied on. */
  issued_at: string;
  not_before: string;
  expires_at: string;
}

export interface Attestation {
  payload: AttestationPayload;
  signature: {
    alg: "ed25519";
    /** The signing key, as a Stellar public key. Must equal `payload.issuer`. */
    key: string;
    /** Base64 Ed25519 signature over the signing input. */
    value: string;
  };
}

/** The exact bytes a signer signs and a verifier verifies. */
export function signingInput(payload: AttestationPayload): Uint8Array {
  const prefix = new TextEncoder().encode(SIGNING_PREFIX);
  const body = canonicalBytes(payload as unknown as JsonValue);
  const input = new Uint8Array(prefix.length + body.length);
  input.set(prefix, 0);
  input.set(body, prefix.length);
  return input;
}

export interface AttestationTerms {
  contract: string;
  network: string;
  rightId: number;
  commitment: string;
  weekValid: boolean;
  /** Public property description. Omitted, not blank, when there is none. */
  property?: PropertyFacts;
  feesCurrent: boolean;
  feesPaidThrough: string;
  /** How long the attestation may be relied on. */
  validForDays?: number;
  /** Overridable so scripts can produce reproducible fixtures. */
  now?: Date;
}

/** Sign an attestation with the issuer's Stellar key. */
export function signAttestation(issuer: Keypair, terms: AttestationTerms): Attestation {
  const now = terms.now ?? new Date();
  const expires = new Date(now.getTime() + (terms.validForDays ?? 90) * 86_400_000);

  const payload: AttestationPayload = {
    schema: ATTESTATION_SCHEMA,
    network: terms.network,
    contract: terms.contract,
    right_id: terms.rightId,
    commitment: terms.commitment.toLowerCase(),
    issuer: issuer.publicKey(),
    week_valid: terms.weekValid,
    // Spread rather than assigned: canonical JSON has no representation for
    // `undefined`, so an absent description has to be an absent key.
    ...(terms.property ? { property: terms.property } : {}),
    maintenance_fees_current: terms.feesCurrent,
    fees_paid_through: terms.feesPaidThrough,
    issued_at: now.toISOString(),
    not_before: now.toISOString(),
    expires_at: expires.toISOString(),
  };

  const signature = issuer.sign(Buffer.from(signingInput(payload)));
  return {
    payload,
    signature: { alg: "ed25519", key: issuer.publicKey(), value: signature.toString("base64") },
  };
}

/** What the verifier must be told about the world in order to check an attestation. */
export interface AttestationExpectation {
  /** The contract address the verifier is actually talking to. */
  contract: string;
  /** The network passphrase the verifier is actually on. */
  network: string;
  /** The right the verifier is actually looking at. */
  rightId: number;
  /** `issuer()` as read from the contract — not from the attestation. */
  contractIssuer: string;
  /** `commitment(right_id)` as read from the contract. */
  onChainCommitment: string;
  /** Recomputed from the off-chain record the counterparty disclosed, if any. */
  recomputedCommitment?: string;
  now?: Date;
}

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface AttestationVerification {
  ok: boolean;
  checks: Check[];
}

/**
 * Run every check that stands between "someone handed me a JSON file" and "this
 * week is what it claims to be".
 *
 * Returns each check individually rather than a bare boolean, because the verify
 * screen shows the reasoning — a counterparty should be able to see *which* leg
 * of the verification failed, not just that something did.
 */
export function verifyAttestation(
  attestation: unknown,
  expect: AttestationExpectation,
): AttestationVerification {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => {
    checks.push({ id, label, ok, detail });
    return ok;
  };

  const shaped =
    typeof attestation === "object" &&
    attestation !== null &&
    typeof (attestation as Attestation).payload === "object" &&
    typeof (attestation as Attestation).signature === "object";

  if (!add("shape", "Attestation is well formed", shaped, shaped ? "payload and signature present" : "expected an object with `payload` and `signature`")) {
    return { ok: false, checks };
  }

  const { payload, signature } = attestation as Attestation;
  const now = expect.now ?? new Date();

  add(
    "schema",
    "Schema is recognised",
    payload.schema === ATTESTATION_SCHEMA,
    payload.schema === ATTESTATION_SCHEMA
      ? ATTESTATION_SCHEMA
      : `expected ${ATTESTATION_SCHEMA}, got ${String(payload.schema)}`,
  );

  add(
    "network",
    "Issued for this network",
    payload.network === expect.network,
    payload.network === expect.network
      ? expect.network
      : `attestation is for "${payload.network}", this app is on "${expect.network}"`,
  );

  add(
    "contract",
    "Issued for this contract",
    payload.contract === expect.contract,
    payload.contract === expect.contract
      ? expect.contract
      : `attestation names ${payload.contract}, this app is reading ${expect.contract}`,
  );

  add(
    "right",
    "Bound to this usage right",
    payload.right_id === expect.rightId,
    payload.right_id === expect.rightId
      ? `right #${expect.rightId}`
      : `attestation is for right #${payload.right_id}, not #${expect.rightId}`,
  );

  const signerIsIssuer =
    payload.issuer === expect.contractIssuer && signature.key === expect.contractIssuer;
  add(
    "signer",
    "Signed by the contract's issuer",
    signerIsIssuer,
    signerIsIssuer
      ? expect.contractIssuer
      : `contract issuer is ${expect.contractIssuer}; attestation names ${payload.issuer} and is signed by ${signature.key}`,
  );

  let signatureValid = false;
  try {
    signatureValid =
      signature.alg === "ed25519" &&
      Keypair.fromPublicKey(signature.key).verify(
        Buffer.from(signingInput(payload)),
        Buffer.from(signature.value, "base64"),
      );
  } catch {
    signatureValid = false;
  }
  add(
    "signature",
    "Ed25519 signature verifies",
    signatureValid,
    signatureValid
      ? "signature matches the canonical payload"
      : "signature does not verify against the payload — it was altered or signed by another key",
  );

  const commitmentOnChain = digestsMatch(payload.commitment, expect.onChainCommitment);
  add(
    "commitment-onchain",
    "Attested commitment matches the ledger",
    commitmentOnChain,
    commitmentOnChain
      ? `0x${expect.onChainCommitment}`
      : `attestation commits to ${payload.commitment}, the ledger holds ${expect.onChainCommitment}`,
  );

  if (expect.recomputedCommitment !== undefined) {
    const recomputedMatches = digestsMatch(expect.recomputedCommitment, expect.onChainCommitment);
    add(
      "commitment-record",
      "Disclosed record hashes to the on-chain commitment",
      recomputedMatches,
      recomputedMatches
        ? "SHA-256 over the canonical record equals the committed hash"
        : `the record hashes to ${expect.recomputedCommitment}, the ledger holds ${expect.onChainCommitment}`,
    );
  }

  const notBefore = Date.parse(payload.not_before);
  const expiresAt = Date.parse(payload.expires_at);
  const inWindow = now.getTime() >= notBefore && now.getTime() < expiresAt;
  add(
    "window",
    "Attestation is currently valid",
    inWindow,
    inWindow
      ? `valid until ${payload.expires_at}`
      : `valid from ${payload.not_before} until ${payload.expires_at}; it is now ${now.toISOString()}`,
  );

  add(
    "week",
    "Issuer attests the week is valid",
    payload.week_valid === true,
    payload.week_valid === true ? "asserted" : "the issuer did not assert the week is valid",
  );

  add(
    "fees",
    "Issuer attests maintenance fees are current",
    payload.maintenance_fees_current === true,
    payload.maintenance_fees_current === true
      ? `paid through ${payload.fees_paid_through}`
      : "the issuer did not assert fees are current — this week may carry arrears",
  );

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * The checks that answer "is this attestation genuine", as distinct from "is the
 * news good".
 *
 * `verifyAttestation` reports both in one `ok`, which is right for the verify
 * screen: a counterparty asking whether to take a week wants a single answer,
 * and an authentic attestation saying the fees are unpaid is still a no.
 *
 * The registry needs the two separated. It has to *display* what the issuer said
 * — including that fees are due, which is the whole point of sample week 04 —
 * while refusing to display anything it cannot show the issuer actually signed.
 * Using `ok` there would hide a week in arrears behind "not attested", which is
 * a different and worse claim.
 */
const PROVENANCE_CHECKS = new Set([
  "shape",
  "schema",
  "network",
  "contract",
  "right",
  "signer",
  "signature",
  "window",
]);

/**
 * Whether the issuer really signed this, for this right, on this contract and
 * network — saying nothing about what it signed.
 *
 * A file placed under the wrong name fails `right`; one edited after signing
 * fails `signature`; one from another deployment fails `contract` or `network`.
 */
export function attestationIsAuthentic(
  attestation: unknown,
  expect: AttestationExpectation,
): boolean {
  const { checks } = verifyAttestation(attestation, expect);
  const seen = checks.filter((check) => PROVENANCE_CHECKS.has(check.id));
  // Every provenance check must have run and passed. `verifyAttestation` returns
  // early on a malformed payload, so a short list means it never got far enough
  // to judge — which is not the same as passing.
  return seen.length === PROVENANCE_CHECKS.size && seen.every((check) => check.ok);
}
