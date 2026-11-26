/**
 * The issuer's intake key: what an owner's browser seals their week's details
 * to, so the issuer's form starts filled in (decision D16, 2026-11-26).
 *
 * The details are the private record — the owner's name and email, the
 * resort and unit, the deed, the fees — so they never reach the server in the
 * clear. The issuer's browser makes an ECDH key pair (src/lib/vault.ts; the
 * private half cannot be exported) and publishes the public half with a
 * signature from the issuer's own Stellar account (SEP-53, through Freighter).
 * The owner's browser checks that signature against the issuer the contract
 * names, read from the chain, before sealing anything. A server that put its
 * own key in place would fail that check.
 *
 * The issuer checks and corrects what the owner entered: the details only fill
 * in the form. Nothing here issues, and nothing here is trusted on its own.
 */

import { hash, Keypair } from "@stellar/stellar-sdk";

export const INTAKE_PURPOSE = "issuer intake";

/** The text the issuer signs. Bound to the contract, the network and the key. */
export function intakeKeyMessage(p: { contract: string; network: string; keyHash: string }): string {
  return `QuietStay issuer intake key v1\ncontract: ${p.contract}\nnetwork: ${p.network}\nkey: ${p.keyHash}`;
}

/**
 * Whether `signature` (base64) is `issuer`'s signature of `message`.
 *
 * SEP-53, as Freighter signs: ed25519 over SHA-256("Stellar Signed Message:\n"
 * + message). Wallets that sign the bare SHA-256 of the message are accepted
 * too; the message names its purpose, so it cannot be mistaken for another.
 */
export function intakeSignatureIsValid(issuer: string, message: string, signature: string): boolean {
  let kp: Keypair;
  let sig: Buffer;
  try {
    kp = Keypair.fromPublicKey(issuer);
    sig = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const body = Buffer.from(message, "utf8");
  const sep53 = hash(Buffer.concat([Buffer.from("Stellar Signed Message:\n", "utf8"), body]));
  try {
    return kp.verify(sep53, sig) || kp.verify(hash(body), sig);
  } catch {
    return false;
  }
}

export interface IntakeKey {
  /** The issuer's account that signed. */
  issuer: string;
  /** Raw P-256 public key, base64url. */
  public_key: string;
  /** SHA-256 of the raw key, hex. */
  key_hash: string;
  /** The issuer's signature of `intakeKeyMessage`, base64. */
  signature: string;
  published_at: string;
}

/**
 * What an owner tells the issuer about their week. Every field is optional:
 * the issuer fills in or corrects whatever is missing or wrong. Each maps to
 * one path of the ownership record (src/lib/record.ts).
 */
export const DETAIL_FIELDS = [
  { key: "owner_name", path: "owner.name", label: "Name on the deed" },
  { key: "owner_email", path: "owner.email", label: "Email" },
  { key: "resort_name", path: "resort.name", label: "Resort" },
  { key: "resort_city", path: "resort.city", label: "Town or city" },
  { key: "resort_country", path: "resort.country", label: "Country" },
  { key: "resort_unit", path: "resort.unit", label: "Unit" },
  { key: "resort_bedrooms", path: "resort.bedrooms", label: "Bedrooms", type: "number" },
  { key: "resort_sleeps", path: "resort.sleeps", label: "Sleeps", type: "number" },
  { key: "resort_features", path: "resort.features", label: "Features — comma separated", type: "list" },
  { key: "week_check_in", path: "week.check_in", label: "Check in — first night", type: "date" },
  { key: "week_check_out", path: "week.check_out", label: "Check out — departure", type: "date" },
  { key: "week_use_year", path: "week.use_year", label: "Use year", type: "number" },
  { key: "title_deed", path: "title.deed_reference", label: "Deed reference" },
  { key: "title_registry", path: "title.registry", label: "Registry" },
  { key: "title_recorded", path: "title.recorded_on", label: "Recorded on", type: "date" },
  { key: "fees_annual", path: "maintenance_fees.annual_amount", label: "Annual maintenance fee" },
  { key: "fees_currency", path: "maintenance_fees.currency", label: "Currency" },
  { key: "fees_through", path: "maintenance_fees.paid_through", label: "Fees paid through", type: "date" },
  { key: "fees_outstanding", path: "maintenance_fees.outstanding", label: "Fees outstanding" },
] as const;

export type DetailKey = (typeof DETAIL_FIELDS)[number]["key"];
export type OwnerDetails = Partial<Record<DetailKey, string>>;

/** What the owner's browser seals to the issuer. */
export interface SealedDetails {
  v: 1;
  kind: "issuance details";
  contract: string;
  /** The account asking: checked by the issuer's browser against the ask. */
  owner: string;
  details: OwnerDetails;
}

const MAX_FIELD = 200;

/** Only the known fields, trimmed, and none empty or overlong. */
export function cleanDetails(input: Record<string, unknown>): OwnerDetails {
  const out: OwnerDetails = {};
  for (const f of DETAIL_FIELDS) {
    const v = input[f.key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t === "") continue;
    if (t.length > MAX_FIELD) throw new Error(`${f.label} is longer than ${MAX_FIELD} characters`);
    out[f.key] = t;
  }
  return out;
}

/** Each detail as the record value it fills in: numbers as numbers, a list as a list. */
export function detailValues(details: OwnerDetails): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = [];
  for (const f of DETAIL_FIELDS) {
    const raw = details[f.key];
    if (raw === undefined) continue;
    const type = "type" in f ? f.type : "text";
    if (type === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) out.push({ path: f.path, value: n });
    } else if (type === "list") {
      const items = raw.split(",").map((x) => x.trim()).filter(Boolean);
      if (items.length > 0) out.push({ path: f.path, value: items });
    } else {
      out.push({ path: f.path, value: raw });
    }
  }
  return out;
}
