/**
 * Contract error codes, mirroring `contracts/quietstay-rights/src/error.rs`.
 *
 * The contract is the authority on what is allowed; this file only translates its
 * refusals into something a person can read. Every message says what the contract
 * enforced, never something softer — the whole point of enforcing a rule in the
 * contract is spoiled by a UI that describes it as a suggestion.
 */

export const CONTRACT_ERRORS: Record<number, { name: string; message: string }> = {
  1: {
    name: "RightNotFound",
    message: "No usage right exists with that id.",
    },
  2: {
    name: "InvalidPeriod",
    message: "The week's check-out must fall after its check-in.",
  },
  3: {
    name: "InvalidValidity",
    message: "The use year must enclose the week it contains.",
  },
  4: {
    name: "NotHolder",
    message:
      "You are not the holder of this week right now. If you rented it out, you get it back when the term lapses; if you rented it, your term has ended.",
  },
  5: {
    name: "RightNotYetValid",
    message: "This right's use year has not started yet, so it cannot be transferred.",
  },
  6: {
    name: "RightExpired",
    message: "This right's use year has closed. It can no longer be transferred or listed.",
  },
  7: {
    name: "ExpiryInThePast",
    message: "A rental cannot end in the past.",
  },
  8: {
    name: "ExpiryBeyondValidity",
    message: "A rental cannot run past the end of the right's use year.",
  },
  9: {
    name: "ExpiryBeyondSenderTerm",
    message:
      "You cannot grant a longer term than you hold. A renter cannot sell the week, and cannot sublet past their own checkout.",
  },
  10: { name: "SelfTransfer", message: "Sender and recipient are the same account." },
  11: {
    name: "HoldingDepthExceeded",
    message: "This week has been sublet as many times as the contract allows.",
  },
  12: {
    name: "NotTitleHolder",
    message: "This action needs open-ended title. A rented week is not yours to sell or destroy.",
  },
  13: { name: "AlreadyListed", message: "This right is already listed. Withdraw the offer first." },
  14: { name: "NotListed", message: "This right is not currently listed." },
  15: { name: "InvalidTerm", message: "A rental term must be longer than zero seconds." },
};

/**
 * Pull a contract error out of an RPC simulation or submission failure.
 *
 * Host errors arrive as text like `Error(Contract, #4)`; auth failures arrive
 * without a contract code at all, which is itself informative — a transfer that
 * fails on authorization rather than on a contract rule is one where a required
 * signature was missing.
 */
export function contractErrorCode(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw : ((raw as Error)?.message ?? JSON.stringify(raw));
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Whether a failed read means "there is no such right" rather than "the read did
 * not work".
 *
 * The difference is the whole of it. A caller sweeping the registry has to omit
 * the first and must never omit the second: a week dropped because an RPC call
 * timed out is a week nobody can find, and nothing anywhere says it is missing.
 */
export function isRightNotFound(raw: unknown): boolean {
  return contractErrorCode(raw) === 1;
}

export function describeContractFailure(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ((raw as Error)?.message ?? JSON.stringify(raw));

  const contractCode = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  if (contractCode?.[1]) {
    const code = Number(contractCode[1]);
    const known = CONTRACT_ERRORS[code];
    if (known) return `${known.message} (contract error #${code} ${known.name})`;
    return `The contract rejected this call with error #${code}.`;
  }

  if (/InvalidAction|Auth, InvalidAction|authorization|Unauthorized/i.test(text)) {
    return (
      "The contract rejected this transfer because a required authorization was missing. " +
      "A transfer needs both the holder's signature and the issuer's approval."
    );
  }

  if (/ExistingValue|AlreadyExists/i.test(text)) {
    return "That value already exists on the ledger.";
  }

  return text;
}
