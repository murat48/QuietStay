/**
 * The off-chain ownership record.
 *
 * This is the document that never reaches the ledger. It holds the owner's
 * identity, the resort and unit, the deed reference, and the maintenance fee
 * history — everything a buyer needs to see once and nobody else should see at
 * all. The ledger holds only `SHA-256(canonical(record))`.
 *
 * Two fields exist purely to make the commitment safe:
 *
 * - `salt` — 32 random bytes. Without it, the record's contents are low entropy
 *   (a date, a resort from a short list, a name) and anyone could confirm a guess
 *   by hashing it. The salt turns the commitment from "reversible by brute force"
 *   into "reveals nothing".
 * - `record_id` — makes each record unique, so one document cannot be committed
 *   for two different rights and re-presented interchangeably.
 */

import { canonicalText, commit, type JsonValue } from "./canonical";

export const RECORD_SCHEMA = "quietstay.ownership-record.v1";

export interface OwnershipRecord {
  schema: typeof RECORD_SCHEMA;
  /** Unique per record. Two rights never share a record. */
  record_id: string;
  /** 32 random bytes as 64 lowercase hex characters. Blinds the commitment. */
  salt: string;
  owner: {
    /** Legal name as it appears on the deed. */
    name: string;
    /** Contact of record. */
    email: string;
    /** The Stellar account the owner will hold the right with. */
    stellar_account: string;
  };
  resort: {
    name: string;
    /**
     * Town or city the resort is in.
     *
     * Optional in the type, required by the issue form. A record's commitment can
     * never be recomputed once it is on the ledger, so records committed before
     * this field existed cannot gain it — requiring it here would make those
     * records fail validation and stop verifying, which is precisely the outcome
     * the commitment exists to prevent. Everything issued from now on has one.
     */
    city?: string;
    country: string;
    /** Unit or villa identifier. */
    unit: string;
    bedrooms: number;
    /**
     * How many the unit sleeps. Optional, for the same reason `city` is.
     *
     * Bedrooms alone does not answer the question anyone booking actually asks,
     * because a two-bedroom villa may sleep four or eight.
     */
    sleeps?: number;
    /**
     * Short public descriptors — `["sea view", "pool", "wifi"]`.
     *
     * What the place offers, never where it is: no address, no building name, no
     * unit number. These are published, so anything that narrows the property to
     * one apartment does not belong here.
     */
    features?: string[];
  };
  week: {
    /** ISO date, first night. */
    check_in: string;
    /** ISO date, departure. */
    check_out: string;
    /** The use year this week belongs to. */
    use_year: number;
    /** Resort calendar week number. */
    week_number: number;
  };
  title: {
    /** Deed or membership certificate reference. */
    deed_reference: string;
    registry: string;
    /** ISO date the interest was recorded. */
    recorded_on: string;
  };
  /**
   * Fee position **as at issuance**, not the live figure.
   *
   * Owed by whoever holds title — `holdings[0].holder` — to the resort, because
   * the charge follows the deed. A renter holds a finite term granted from that
   * title and never became a party to it, so arrears are never theirs; the
   * issuer neither owes nor collects, and `settle-fees` moves no money. A buyer
   * would inherit them, which is why a transfer is declined until they are
   * cleared: that protects the buyer, and gives the seller the reason to pay.
   *
   * The commitment is immutable, so nothing in this record can ever be edited
   * without it ceasing to hash to what the ledger holds. That makes this block a
   * snapshot by construction: it says what was owed on the day the right was
   * issued, and it goes on saying that forever.
   *
   * The current position lives in the issuer's attestation, which is re-signable
   * and expires. A verifier and the approval service both read fee status from
   * there — see `maintenance_fees_current` in `src/lib/attestation.ts` — so a week
   * whose arrears are later settled becomes transferable without reissuing
   * anything.
   */
  maintenance_fees: {
    annual_amount: string;
    currency: string;
    /** ISO date fees were paid through at issuance. */
    paid_through: string;
    /** Amount owed at issuance. "0.00" means the week was clean then. */
    outstanding: string;
  };
}

/** Unix seconds for an ISO date at 00:00:00 UTC. */
export function isoDateToUnix(isoDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`expected an ISO date (YYYY-MM-DD), got: ${isoDate}`);
  }
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`not a valid date: ${isoDate}`);
  return Math.floor(ms / 1000);
}

export function unixToIsoDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/**
 * The ISO 8601 week number a date falls in.
 *
 * Derived rather than typed: a week number that disagrees with the check-in date
 * makes a record self-contradictory, and it is the one field of the week block a
 * person cannot check by eye. Every sample record already agrees with this
 * calculation, so committing to a derived value changes no existing commitment.
 *
 * ISO weeks start on Monday and are numbered by the year containing their
 * Thursday, which is why the date is shifted to its Thursday before counting —
 * a naive "days since January 1, divided by seven" is wrong for the first and
 * last week of most years.
 */
export function isoWeekNumber(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`not a valid date: ${isoDate}`);

  const thursday = new Date(ms);
  // Monday = 0 … Sunday = 6, so +3 lands on this ISO week's Thursday.
  const weekday = (thursday.getUTCDay() + 6) % 7;
  thursday.setUTCDate(thursday.getUTCDate() - weekday + 3);

  // January 4th is always in ISO week 1; walk it to its own Thursday to anchor.
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const anchorWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - anchorWeekday + 3);

  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/**
 * The on-chain period and validity window derived from a record.
 *
 * The occupancy window is the week itself. The validity window is the use year
 * that contains it: the right exists, and can be transferred, for that year. The
 * contract enforces both, and neither reveals anything the listing does not
 * already have to say — the resort, the unit, the deed, and the owner's identity
 * stay in the record.
 */
export function onChainWindows(record: OwnershipRecord): {
  period: { start: number; end: number };
  validity: { from: number; until: number };
} {
  return {
    period: {
      start: isoDateToUnix(record.week.check_in),
      end: isoDateToUnix(record.week.check_out),
    },
    validity: {
      from: isoDateToUnix(`${record.week.use_year}-01-01`),
      until: isoDateToUnix(`${record.week.use_year + 1}-01-01`),
    },
  };
}

export class RecordValidationError extends Error {}

/**
 * Check a record is well formed before it is committed. A record that is
 * malformed after the fact is a record whose commitment can never be reproduced,
 * so this runs before anything is hashed or issued.
 */
export function validateRecord(value: unknown): OwnershipRecord {
  const fail = (message: string): never => {
    throw new RecordValidationError(message);
  };
  if (typeof value !== "object" || value === null) return fail("record must be a JSON object");
  const record = value as Record<string, unknown>;

  if (record.schema !== RECORD_SCHEMA) {
    return fail(`schema must be "${RECORD_SCHEMA}", got ${JSON.stringify(record.schema)}`);
  }
  if (typeof record.record_id !== "string" || record.record_id.length === 0) {
    return fail("record_id must be a non-empty string");
  }
  if (typeof record.salt !== "string" || !/^[0-9a-f]{64}$/.test(record.salt)) {
    return fail("salt must be 64 lowercase hex characters (32 bytes)");
  }

  const owner = record.owner as OwnershipRecord["owner"] | undefined;
  if (!owner || typeof owner.name !== "string" || typeof owner.email !== "string") {
    return fail("owner.name and owner.email are required");
  }
  if (typeof owner.stellar_account !== "string" || !/^G[A-Z2-7]{55}$/.test(owner.stellar_account)) {
    return fail("owner.stellar_account must be a Stellar public key (G...)");
  }

  const resort = record.resort as OwnershipRecord["resort"] | undefined;
  if (!resort || typeof resort.name !== "string" || typeof resort.unit !== "string") {
    return fail("resort.name and resort.unit are required");
  }
  // Absent is allowed — see the note on the field. Present but empty is not: a
  // blank city would be published as "…, Portugal" with a dangling comma, and a
  // record cannot be corrected after it is committed.
  if (resort.city !== undefined && (typeof resort.city !== "string" || !resort.city.trim())) {
    return fail("resort.city, when given, must be a non-empty string");
  }
  if (
    resort.sleeps !== undefined &&
    (!Number.isInteger(resort.sleeps) || (resort.sleeps as number) < 1)
  ) {
    return fail("resort.sleeps, when given, must be a whole number of people, at least 1");
  }
  if (resort.features !== undefined) {
    if (!Array.isArray(resort.features)) return fail("resort.features, when given, must be a list");
    if (resort.features.some((f) => typeof f !== "string" || !f.trim())) {
      return fail("every entry in resort.features must be a non-empty string");
    }
  }

  const week = record.week as OwnershipRecord["week"] | undefined;
  if (!week) return fail("week is required");
  const checkIn = isoDateToUnix(week.check_in);
  const checkOut = isoDateToUnix(week.check_out);
  if (checkIn >= checkOut) return fail("week.check_out must be after week.check_in");
  if (!Number.isInteger(week.use_year)) return fail("week.use_year must be an integer");

  const yearStart = isoDateToUnix(`${week.use_year}-01-01`);
  const yearEnd = isoDateToUnix(`${week.use_year + 1}-01-01`);
  if (checkIn < yearStart || checkOut > yearEnd) {
    return fail(
      `the week ${week.check_in}..${week.check_out} falls outside use year ${week.use_year}; ` +
        "the contract requires the validity window to enclose the occupancy period",
    );
  }

  const fees = record.maintenance_fees as OwnershipRecord["maintenance_fees"] | undefined;
  if (!fees || typeof fees.outstanding !== "string") {
    return fail("maintenance_fees.outstanding is required");
  }
  const title = record.title as OwnershipRecord["title"] | undefined;
  if (!title || typeof title.deed_reference !== "string") {
    return fail("title.deed_reference is required");
  }

  return record as unknown as OwnershipRecord;
}

/**
 * Whether the record says the week carried no unpaid fees **at issuance**.
 *
 * This is the default an attestation is signed from, not the live answer. Once a
 * right exists, the current position is whatever the issuer has most recently
 * attested; ask the attestation, not the record.
 */
export function feesAreCurrent(record: OwnershipRecord): boolean {
  return Number.parseFloat(record.maintenance_fees.outstanding) === 0;
}

export function recordCanonicalText(record: OwnershipRecord): string {
  return canonicalText(record as unknown as JsonValue);
}

/** The commitment that goes on the ledger for this record. */
export function recordCommitment(record: OwnershipRecord): Promise<string> {
  return commit(record as unknown as JsonValue);
}

/**
 * What a listing may publish about the property, drawn from the committed record.
 *
 * Somebody deciding whether to take a week needs three things the ledger cannot
 * give them: where it is, how many it sleeps, and what it offers. None of it is
 * on chain, because a commitment hashes the whole record and no field of it can
 * be revealed and checked alone — so the issuer signs this block instead, and it
 * travels in the attestation.
 *
 * Where the line falls. `region` is the town and country, not the resort: a town
 * shares its name with thousands of owners, while the resort plus the unit names
 * one apartment and, through the members' registry, one person. `bedrooms`,
 * `sleeps` and `features` describe what the place is, which every rental listing
 * in the world says out loud and which identifies nobody. The resort name, the
 * unit, the deed and the owner stay in the record.
 *
 * Deriving it here, rather than letting an issuer type it beside the record, is
 * what keeps the published facts from drifting from the document the ledger
 * committed to: a buyer later shown the record can confirm the two agree.
 */
export interface PropertyFacts {
  /** `"Lagos, Portugal"`, or just `"Portugal"` for a record predating `city`. */
  region: string;
  bedrooms: number;
  sleeps?: number;
  features?: string[];
}

export function propertyFacts(record: OwnershipRecord): PropertyFacts {
  const city = record.resort.city?.trim();
  const features = record.resort.features?.map((f) => f.trim()).filter(Boolean);
  return {
    region: city ? `${city}, ${record.resort.country}` : record.resort.country,
    bedrooms: record.resort.bedrooms,
    // Omitted rather than sent as `undefined`: canonical JSON has no
    // representation for it, and these values are about to be signed.
    ...(record.resort.sleeps ? { sleeps: record.resort.sleeps } : {}),
    ...(features?.length ? { features } : {}),
  };
}

/**
 * The subset of a record that a listing may show publicly: the week on offer and
 * how many bedrooms. Never the resort, the unit, the deed, or the owner.
 */
export function publicSummary(record: OwnershipRecord): {
  check_in: string;
  check_out: string;
  bedrooms: number;
  use_year: number;
} {
  return {
    check_in: record.week.check_in,
    check_out: record.week.check_out,
    bedrooms: record.resort.bedrooms,
    use_year: record.week.use_year,
  };
}
