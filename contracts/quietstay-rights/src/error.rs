use soroban_sdk::contracterror;

/// Every failure mode of the contract, as a stable numeric code.
///
/// Codes are part of the contract's public surface: the reference web app maps
/// them to human-readable messages, and they appear in explorer diagnostics for
/// rejected transactions. Never renumber an existing variant.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // --- lookup ---
    /// No usage right exists with the given id.
    RightNotFound = 1,

    // --- issuance validation ---
    /// `period.start` must be strictly before `period.end`.
    InvalidPeriod = 2,
    /// Required: `validity.from <= period.start` and `period.end <= validity.until`.
    InvalidValidity = 3,

    // --- holder / term validation ---
    /// The caller is not the effective holder of this right right now.
    NotHolder = 4,
    /// The right's validity window has not opened yet.
    RightNotYetValid = 5,
    /// The right's validity window has closed; the right can no longer be acted on.
    RightExpired = 6,
    /// A transfer cannot expire at or before the current ledger timestamp.
    ExpiryInThePast = 7,
    /// A transfer cannot extend past the right's own validity window.
    ExpiryBeyondValidity = 8,
    /// A holder cannot grant a longer term than the one they hold. In particular a
    /// renter (finite term) cannot grant an open-ended term, i.e. cannot sell.
    ExpiryBeyondSenderTerm = 9,
    /// Sender and recipient are the same account.
    SelfTransfer = 10,
    /// Nesting limit for sub-grants reached; the term chain may not grow further.
    HoldingDepthExceeded = 11,
    /// The action requires open-ended title (no active finite-term holding above it).
    NotTitleHolder = 12,

    // --- listing ---
    /// This right is already listed; unlist before re-listing.
    AlreadyListed = 13,
    /// This right is not currently listed.
    NotListed = 14,
    /// A listed rental term must be greater than zero seconds.
    InvalidTerm = 15,

    // --- the ownership proof (Phase 2; docs/CIRCUIT.md) ---
    /// Not exactly eleven public signals.
    WrongSignalCount = 16,
    /// A public signal, or a commitment at issuance, is not below the BLS12-381
    /// scalar field modulus — the same value could otherwise appear in two
    /// encodings.
    NonCanonicalSignal = 17,
    /// The sender, recipient, or owner at issuance is neither a `G…` account nor
    /// a `C…` contract, so no proof could name it (docs/PHASE3_SPEC.md §1). Under
    /// Phase 2 this also refused `C…` contracts; Phase 3 accepts them.
    NotAnAccount = 18,
    /// The proof is for a different commitment than the one stored for this right.
    CommitmentMismatch = 19,
    /// The proof is for a different right.
    RightMismatch = 20,
    /// The proof names a different sending account than the one transferring.
    WrongAccount = 21,
    /// The proof names a different recipient.
    RecipientMismatch = 22,
    /// The proof is for a sale where this is a rental, a rental where this is a
    /// sale, or a rental ending at a different time.
    ModeMismatch = 23,
    /// The proof's last valid ledger has passed.
    ProofExpired = 24,
    /// The proof claims to stay valid longer than the maximum window.
    ExpiryBeyondWindow = 25,
    /// A sale's next secret hash is zero, or a rental's is not.
    NextSecretHashMismatch = 26,
    /// This proof's nullifier has been used: the proof was already spent.
    NullifierUsed = 27,
    /// The pairing check failed: the proof does not prove these signals.
    InvalidProof = 28,
    /// The verification key given at deployment does not have one point per
    /// public signal plus one.
    MalformedVerifyingKey = 29,

    // --- Phase 3: configuration, offers and record requests ---
    /// A constructor argument is unusable: `max_payment ≤ 0`, or the arbiter
    /// is the issuer.
    InvalidConfig = 30,
    /// A price must be above zero and at most the constructor's `max_payment`.
    InvalidPrice = 31,
    /// The price given at acceptance is not the offer's price.
    PriceMismatch = 32,
    /// No offer with this id exists (never made, accepted, or cancelled).
    OfferNotFound = 33,
    /// The offer's last ledger has passed.
    OfferExpired = 34,
    /// An offer's or request's last ledger must be after now and within
    /// `MAX_OFFER_LEDGERS`.
    InvalidOfferExpiry = 35,
    /// The buyer already has `MAX_OPEN_OFFERS_PER_BUYER` live offers.
    TooManyOffers = 36,
    /// No record request with this id exists (never made, used, or cancelled).
    RequestNotFound = 37,
    /// The record request's last ledger has passed.
    RequestExpired = 38,
    /// The record request, or the offer, belongs to another account.
    NotRequester = 39,
    /// The requester already has `MAX_OPEN_REQUESTS_PER_BUYER` live requests.
    TooManyRequests = 40,
    /// A record request's key hash must not be zero.
    InvalidKeyHash = 41,
    /// A sale offer's `h'` must be non-zero and canonical.
    InvalidNextSecretHash = 42,
    /// A sale offer was given to a rental function, or the other way round.
    WrongOfferKind = 43,
    /// Check-in must be now or later, inside the week, and at least 24 hours
    /// before the rental ends.
    InvalidCheckIn = 44,

    // --- Phase 3: rental escrow ---
    /// No escrow with this id exists.
    EscrowNotFound = 45,
    /// The escrow is not in a state that allows this call.
    EscrowNotInState = 46,
    /// The caller is not this escrow's owner or renter as the call requires.
    NotEscrowParty = 47,
    /// The owner can collect only from check-in + 24 hours.
    TooEarlyToCollect = 48,
    /// A problem can be reported only until check-in + 24 hours.
    ReportWindowClosed = 49,
    /// This party has already submitted `MAX_EVIDENCE_PER_PARTY` hashes.
    EvidenceLimit = 50,
    /// Only the constructor's arbiter can resolve a dispute.
    NotArbiter = 51,
    /// The right has a Funded or Disputed escrow, so it cannot be burned (D11).
    EscrowOpen = 52,
    /// The buyer's allowance to this contract is below the price, or has
    /// expired. Checked before `transfer_from`, which would refuse anyway, so
    /// the failure carries this contract's code rather than the token's.
    AllowanceTooLow = 53,
    /// The buyer's USDC balance is below the price. Checked likewise.
    BalanceTooLow = 54,
}
