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
    /// The sender, recipient, or owner at issuance is a contract address. A proof
    /// binds an Ed25519 account key, so only `G…` accounts can hold a right.
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
}
