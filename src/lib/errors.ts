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
  // --- Phase 2: the ownership proof ---
  16: { name: "WrongSignalCount", message: "No ownership proof was attached — a transfer needs one." },
  17: {
    name: "NonCanonicalSignal",
    message: "The proof's values are not in the form the contract accepts. Make the proof again with `npm run zk:prove`.",
  },
  18: { name: "NotAnAccount", message: "Weeks can only be held by Stellar accounts (G…) or smart wallets (C…)." },
  19: {
    name: "CommitmentMismatch",
    message:
      "This proof is for a different record secret than the one this week is committed to. After a sale only the buyer can prove; a renter never can.",
  },
  20: { name: "RightMismatch", message: "This proof was made for a different week." },
  21: { name: "WrongAccount", message: "This proof names a different account than the one sending the week." },
  22: { name: "RecipientMismatch", message: "This proof was made for a different recipient." },
  23: {
    name: "ModeMismatch",
    message:
      "This proof was made for a different kind of transfer: a sale instead of a rental, a rental ending at another time, or a swap for another week.",
  },
  24: { name: "ProofExpired", message: "This proof's window has passed. Make a fresh one with `npm run zk:prove`." },
  25: { name: "ExpiryBeyondWindow", message: "This proof claims to stay valid for longer than the contract allows (about an hour)." },
  26: {
    name: "NextSecretHashMismatch",
    message: "A sale needs the buyer's secret hash in the proof, and a rental must not carry one.",
  },
  27: { name: "NullifierUsed", message: "This proof has already been used. Each proof is good for one transfer." },
  28: { name: "InvalidProof", message: "The ownership proof did not verify. The week did not move." },
  29: { name: "MalformedVerifyingKey", message: "The contract was deployed with a malformed verification key." },
  // --- Phase 3: offers, record requests and the escrow ---
  30: { name: "InvalidConfig", message: "The contract was deployed with an unusable payment cap or arbiter." },
  31: { name: "InvalidPrice", message: "A price must be above zero and at most this deployment's payment cap." },
  32: { name: "PriceMismatch", message: "The amount you accepted is not the offer's amount. Nothing moved." },
  33: { name: "OfferNotFound", message: "That offer no longer exists: it was accepted, cancelled, or never made." },
  34: { name: "OfferExpired", message: "That offer has expired and can no longer be accepted." },
  35: { name: "InvalidOfferExpiry", message: "An offer or record request must end after now and within seven days." },
  36: { name: "TooManyOffers", message: "You already have ten open offers. Cancel one, or wait for one to expire." },
  37: { name: "RequestNotFound", message: "That record request no longer exists: it was used, cancelled, or never made." },
  38: { name: "RequestExpired", message: "That record request has expired. Ask for the record again." },
  39: { name: "NotRequester", message: "That request or offer belongs to another account." },
  40: { name: "TooManyRequests", message: "You already have ten open record requests. Cancel one, or wait for one to expire." },
  41: { name: "InvalidKeyHash", message: "The record request carries no key." },
  42: { name: "InvalidNextSecretHash", message: "The offer's new secret hash is missing or out of range. Make the offer again." },
  43: { name: "WrongOfferKind", message: "That is a sale offer where a rental was expected, or the other way round." },
  44: {
    name: "InvalidCheckIn",
    message: "Check-in must be in the future, inside the week, and at least 24 hours before the rental ends.",
  },
  45: { name: "EscrowNotFound", message: "No escrow exists with that id." },
  46: {
    name: "EscrowNotInState",
    message: "The escrow is not in a state that allows this. A paid-out or refunded escrow is final.",
  },
  47: { name: "NotEscrowParty", message: "Only this escrow's owner or renter can do that, as the rules say." },
  48: { name: "TooEarlyToCollect", message: "The owner can collect only from 24 hours after check-in." },
  49: { name: "ReportWindowClosed", message: "A problem can be reported only until 24 hours after check-in." },
  50: { name: "EvidenceLimit", message: "Each party can add at most four evidence hashes." },
  51: { name: "NotArbiter", message: "Only this deployment's arbiter can resolve a dispute." },
  52: { name: "EscrowOpen", message: "This week has a rental payment still in escrow, so it cannot be destroyed yet." },
  53: {
    name: "AllowanceTooLow",
    message:
      "The buyer's USDC allowance to the contract is below the price or has expired. Nothing moved; the buyer can renew it by making or cancelling an offer.",
  },
  54: { name: "BalanceTooLow", message: "The buyer's USDC balance is below the price. Nothing moved." },
  // --- Phase 3 Step 4: swaps ---
  55: { name: "SwapNotFound", message: "That swap no longer exists: it was completed, cancelled, or never made." },
  56: { name: "SwapExpired", message: "That swap offer has expired. Neither week moved." },
  57: { name: "NotSwapParty", message: "Only the swap's maker can complete or cancel it, and only its taker can withdraw an acceptance." },
  58: {
    name: "SwapAlreadyAccepted",
    message: "This swap already has a live acceptance. It must be withdrawn, or lapse with its proof, before another.",
  },
  59: {
    name: "AcceptanceNotFound",
    message: "This swap has no live acceptance: it was withdrawn, or its proof's hour passed. Neither week moved.",
  },
  60: { name: "SwapPending", message: "This week is part of a pending swap acceptance, so it cannot be destroyed yet." },
  61: {
    name: "RequestRightMismatch",
    message: "That record request is for a different week. Each side asks for the record of the week it receives.",
  },
  62: { name: "TooManyPendingSwaps", message: "This week is already part of ten pending swap acceptances." },
};

/**
 * Failures raised inside the USDC token rather than by QuietStay's contract.
 * The token's own error numbers overlap QuietStay's, so they are recognised by
 * the token's diagnostic text, before any code is read.
 */
const TOKEN_FAILURES: { pattern: RegExp; message: string }[] = [
  {
    pattern: /trustline entry is missing/i,
    message:
      "The receiving account has no USDC trustline, so the token refused the payment. Add a USDC trustline to that account and try again; the escrow keeps the money until then.",
  },
  {
    pattern: /balance is deauthorized|is not authorized/i,
    message: "The USDC issuer has not authorized this account to hold USDC.",
  },
];

/**
 * The USDC token's own errors: the Stellar Asset Contract's built-in codes
 * (soroban-env-host 27, `builtin_contracts/contract_error.rs`). Their numbers
 * overlap QuietStay's, so a token error must never be read from its number
 * alone: #13 is the token's TrustlineMissingError and QuietStay's
 * AlreadyListed.
 */
export const TOKEN_ERRORS: Record<number, { name: string; message: string }> = {
  2: { name: "OperationNotSupportedError", message: "the token does not support this operation" },
  3: { name: "AlreadyInitializedError", message: "the token is already initialized" },
  4: { name: "UnauthorizedError", message: "the account is not authorized for this token operation" },
  5: { name: "AuthenticationError", message: "the token could not authenticate the account" },
  6: { name: "AccountMissingError", message: "the account does not exist on this network" },
  7: { name: "AccountIsNotClassic", message: "the account is not a classic Stellar account" },
  8: { name: "NegativeAmountError", message: "the amount is negative" },
  9: {
    name: "AllowanceError",
    message: "the buyer's allowance to the contract is too low or has expired; the buyer can renew it by making or cancelling an offer",
  },
  10: { name: "BalanceError", message: "the paying account's USDC balance is too low" },
  11: { name: "BalanceDeauthorizedError", message: "the USDC issuer has not authorized this account to hold USDC" },
  12: { name: "OverflowError", message: "the amount overflows the token's balance" },
  13: {
    name: "TrustlineMissingError",
    message:
      "the receiving account has no USDC trustline. Add a USDC trustline to that account in its wallet and try again; money in escrow stays there until then",
  },
  14: { name: "InsufficientAccountReserve", message: "the account lacks the XLM reserve for this" },
  15: { name: "TooManyAccountSubentries", message: "the account has too many subentries" },
};

/** One diagnostic event of a failed call, reduced to what classifying needs. */
export interface FailureEvent {
  /** The contract that emitted it, as `C…`; null for the host's own events. */
  contract: string | null;
  /** Whether it is an `error` event. */
  error: boolean;
  /** The contract error code it carries, if any. */
  code: number | null;
}

/**
 * Explain a failed call by the contract that raised it, not by its number.
 *
 * The first `error` event names the contract the failure started in: when
 * QuietStay calls USDC and the token refuses, the token emits the error and
 * QuietStay re-raises the same code after it. The RPC's error text alone is
 * only `HostError: Error(Contract, #13)`, with no contract, which is how a
 * missing trustline was once shown as QuietStay's "AlreadyListed" (found in
 * Step 4). So:
 *
 *   - started in the USDC token (or the call was to the token itself): the
 *     token's own message, by the token's code;
 *   - started in another contract: said so, with that contract's code;
 *   - otherwise: QuietStay's own code, as before (`describeContractFailure`).
 */
export function explainFailure(
  raw: unknown,
  ctx: { events?: FailureEvent[]; invoked: string; token: string },
): string {
  const origin = (ctx.events ?? []).find((e) => e.error && e.code !== null);
  const from = origin ? (origin.contract ?? ctx.invoked) : ctx.invoked;
  const code = origin?.code ?? contractErrorCode(raw);
  if (from === ctx.token) {
    if (code === null) return `The USDC token refused this call. ${describeContractFailure(raw)}`;
    const known = TOKEN_ERRORS[code];
    return known
      ? `The USDC token refused this: ${known.message}. Nothing moved. (USDC token error #${code} ${known.name})`
      : `The USDC token refused this with its error #${code}. Nothing moved.`;
  }
  if (origin && from !== ctx.invoked) {
    return `Another contract, ${from}, refused this call with its error #${code}. Nothing moved; QuietStay's own checks did not refuse it.`;
  }
  return describeContractFailure(raw);
}

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

  for (const failure of TOKEN_FAILURES) {
    if (failure.pattern.test(text)) return failure.message;
  }

  const contractCode = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  if (contractCode?.[1]) {
    const code = Number(contractCode[1]);
    const known = CONTRACT_ERRORS[code];
    if (known) return `${known.message} (contract error #${code} ${known.name})`;
    return `The contract rejected this call with error #${code}.`;
  }

  if (/InvalidAction|Auth, InvalidAction|authorization|Unauthorized/i.test(text)) {
    return (
      "The contract rejected this because a required signature was missing. A transfer needs " +
      "the holder's signature, and a sale the buyer's consent as well — never the issuer's."
    );
  }

  if (/ExistingValue|AlreadyExists/i.test(text)) {
    return "That value already exists on the ledger.";
  }

  return text;
}
