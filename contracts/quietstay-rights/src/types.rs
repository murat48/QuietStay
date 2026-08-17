use soroban_sdk::{contracttype, Address, BytesN, String, Vec};

/// Maximum length of a right's holding chain: the title holder plus three levels
/// of sub-grant. Bounded so that reads and writes have a fixed worst-case cost.
pub const MAX_HOLDING_DEPTH: u32 = 4;

/// The occupancy window of the underlying week: check-in and check-out as Unix
/// seconds. This is the *stay*, not the token's lifetime.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Period {
    pub start: u64,
    pub end: u64,
}

/// The window during which the right exists and may be transferred. Must enclose
/// the `Period`. After `until`, the right is inert: nothing can be transferred,
/// listed, or burned.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Validity {
    pub from: u64,
    pub until: u64,
}

/// One link in a right's holding chain.
///
/// `expires_at == None` means an open-ended holding — title. `Some(t)` means the
/// holding lapses when the ledger timestamp reaches `t`, at which point the term
/// below it in the chain becomes effective again with no return transaction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Holding {
    pub holder: Address,
    pub expires_at: Option<u64>,
}

/// A tokenized vacation usage right.
///
/// `holdings[0]` always carries `expires_at == None` and identifies the title
/// holder. Entries above it are finite-term grants with non-increasing expiries,
/// so the last non-lapsed entry is the effective holder.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Right {
    pub id: u64,
    /// The party that issued this right and whose approval a transfer requires.
    pub issuer: Address,
    /// The occupancy window of the week.
    pub period: Period,
    /// The lifetime of the right itself.
    pub validity: Validity,
    /// SHA-256 over the canonical serialization of the off-chain ownership record.
    /// The record itself never touches the ledger.
    pub commitment: BytesN<32>,
    /// Title holder first, then finite-term grants in the order they were made.
    pub holdings: Vec<Holding>,
}

/// A published offer. Phase 1 records availability and term only: price, payment,
/// escrow, and settlement of consideration are out of scope for this phase, so no
/// price field exists on the ledger.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Listing {
    pub right_id: u64,
    /// The effective holder at the time of listing.
    pub by: Address,
    /// `None` offers the right open-ended (a sale). `Some(n)` offers it for a term
    /// of `n` seconds (a rental).
    pub term_secs: Option<u64>,
    pub listed_at: u64,
}

/// Contract-wide configuration, written once by the constructor and never
/// mutated. There is no setter: rotating the issuer key means deploying again.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub issuer: Address,
    pub name: String,
    pub symbol: String,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: `Config`.
    Config,
    /// Instance: `u64`, the id the next `issue` will assign.
    NextId,
    /// Persistent: `Right`, keyed by right id.
    Right(u64),
    /// Persistent: `Listing`, keyed by right id.
    Listing(u64),
    /// Persistent: `i128`, the number of rights an address holds title to.
    Balance(Address),
}
