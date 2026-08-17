/**
 * Who someone is on this deployment, and what that lets them do.
 *
 * **Roles are read off the ledger, never declared.** There is no "I am a lessor"
 * option anywhere, because a self-declared role would be decoration: the contract
 * would still refuse whatever the account was not entitled to, and the interface
 * would have promised something it could not deliver. Instead an account's standing
 * is computed from the registry:
 *
 * | Role | Turkish | Derived from |
 * | --- | --- | --- |
 * | `issuer`  | ihraççı      | the account equals `issuer()` on the contract |
 * | `lessor`  | kiraya veren | the account holds **title** to at least one right |
 * | `lessee`  | kiracı       | the account is the effective holder of at least one right on a **finite term** |
 * | `visitor` | ziyaretçi    | none of the above |
 *
 * These are not exclusive. Somebody who owns one week and is renting another is
 * both a lessor and a lessee, and the interface has to handle that rather than
 * forcing a choice — it is the ordinary case for an active account.
 *
 * A role changes what the app *offers*. It never changes what the contract
 * *allows*: every restriction expressed here is independently enforced on chain,
 * and this module exists so the interface stops offering actions that would be
 * refused, not so it can grant any.
 */

import type { Holding, Listing, Right } from "./contract";

export type Role = "issuer" | "lessor" | "lessee" | "visitor";

/** A right, reduced to what a panel needs to show about it. */
export interface RightSummary {
  id: number;
  week: { start: number; end: number };
  validity: { from: number; until: number };
  commitment: string;
  /** The open-ended holder. */
  titleHolder: string | null;
  /** Who is entitled to it right now. */
  effectiveHolder: string;
  /** Unix seconds the current term ends, or `null` when held outright. */
  termEnds: number | null;
  active: boolean;
  listing: { by: string; termSecs: number | null; listedAt: number } | null;
}

export interface AccountStanding {
  account: string;
  roles: Role[];
  isIssuer: boolean;
  /** Weeks the account holds title to and can rent out or sell. */
  owned: RightSummary[];
  /** Weeks the account is currently renting from someone else. */
  renting: RightSummary[];
  /**
   * Weeks the account owns that are out on rental right now. Title is theirs but
   * they are not the effective holder, so they cannot transfer until the term
   * lapses — and this is the set that explains why.
   */
  rentedOut: RightSummary[];
}

export function summarize(row: {
  right: Right;
  listing: Listing | null;
  holding: Holding;
  active: boolean;
}): RightSummary {
  return {
    id: row.right.id,
    week: row.right.period,
    validity: row.right.validity,
    commitment: row.right.commitment,
    titleHolder: row.right.holdings[0]?.holder ?? null,
    effectiveHolder: row.holding.holder,
    termEnds: row.holding.expiresAt,
    active: row.active,
    listing: row.listing
      ? { by: row.listing.by, termSecs: row.listing.termSecs, listedAt: row.listing.listedAt }
      : null,
  };
}

/**
 * Work out an account's standing from the registry.
 *
 * `issuerAccount` comes from the contract, not from configuration, so a
 * misconfigured deployment cannot promote anyone to issuer in the interface.
 */
export function deriveStanding(
  account: string,
  issuerAccount: string,
  rights: RightSummary[],
): AccountStanding {
  const owned: RightSummary[] = [];
  const renting: RightSummary[] = [];
  const rentedOut: RightSummary[] = [];

  for (const right of rights) {
    const holdsTitle = right.titleHolder === account;
    const isEffectiveHolder = right.effectiveHolder === account;
    const onATerm = right.termEnds !== null;

    if (holdsTitle) {
      if (isEffectiveHolder) owned.push(right);
      // Title is theirs, but someone else is in the week right now.
      else rentedOut.push(right);
    }

    // Renting means holding someone else's week on a term. A title holder who
    // somehow appears above their own title is still not a tenant of themselves.
    if (isEffectiveHolder && onATerm && !holdsTitle) renting.push(right);
  }

  const roles: Role[] = [];
  if (account === issuerAccount) roles.push("issuer");
  if (owned.length > 0 || rentedOut.length > 0) roles.push("lessor");
  if (renting.length > 0) roles.push("lessee");
  if (roles.length === 0) roles.push("visitor");

  return {
    account,
    roles,
    isIssuer: account === issuerAccount,
    owned,
    renting,
    rentedOut,
  };
}

// --- what the interface should offer -------------------------------------

export const ROLE_LABELS: Record<Role, { en: string; tr: string; blurb: string }> = {
  issuer: {
    en: "Issuer",
    tr: "İhraççı",
    blurb: "Creates usage rights and attests that weeks are valid and free of arrears.",
  },
  lessor: {
    en: "Owner",
    tr: "Kiraya veren",
    blurb: "Holds title to a week. Can rent it out for a term, or sell it outright.",
  },
  lessee: {
    en: "Renter",
    tr: "Kiracı",
    blurb: "Holds a week on a term. Can sublet within that term — but cannot sell it.",
  },
  visitor: {
    en: "Visitor",
    tr: "Ziyaretçi",
    blurb: "Holds nothing on this deployment. Can browse the registry and verify any week.",
  },
};

/** Whether the account may reach the issue screen at all. */
export function canIssue(standing: AccountStanding | null): boolean {
  return standing?.isIssuer === true;
}

/** Whether the account has anything it could transfer right now. */
export function canTransfer(standing: AccountStanding | null): boolean {
  if (!standing) return false;
  return standing.owned.some((r) => r.active) || standing.renting.some((r) => r.active);
}

/**
 * Everything the account could transfer, with the terms it may offer.
 *
 * A title holder may sell or rent. A tenant may only sublet, and only up to their
 * own checkout — so `maxTermEnds` is their term rather than the end of the use
 * year. Both limits are enforced by the contract; naming them here is what stops
 * the form offering something that would be refused.
 */
export function transferableRights(
  standing: AccountStanding | null,
): { right: RightSummary; maySell: boolean; maxTermEnds: number; as: "lessor" | "lessee" }[] {
  if (!standing) return [];

  const fromTitle = standing.owned
    .filter((right) => right.active)
    .map((right) => ({
      right,
      maySell: true,
      maxTermEnds: right.validity.until,
      as: "lessor" as const,
    }));

  const fromTerm = standing.renting
    .filter((right) => right.active)
    .map((right) => ({
      right,
      maySell: false,
      maxTermEnds: right.termEnds ?? right.validity.until,
      as: "lessee" as const,
    }));

  return [...fromTitle, ...fromTerm].sort((a, b) => a.right.id - b.right.id);
}
