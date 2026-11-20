use soroban_sdk::{contracttype, Address, BytesN, String, Vec, U256};

use crate::verifier::Proof;

/// Maximum length of a right's holding chain: the title holder plus three levels
/// of sub-grant. Bounded so that reads and writes have a fixed worst-case cost.
pub const MAX_HOLDING_DEPTH: u32 = 4;

/// The longest an offer or a record request may stay open, in ledgers: about
/// seven days at five-second ledgers (decision D9). Also the expiration the
/// contract gives a buyer's USDC allowance, so one expiration covers every
/// live offer (D12).
pub const MAX_OFFER_LEDGERS: u32 = 120_960;

/// Live offers (sale and rental together) one buyer may have open at once
/// (docs/PHASE3_SPEC.md §4). Bounds the allowance recalculation.
pub const MAX_OPEN_OFFERS_PER_BUYER: u32 = 10;

/// Live record requests one requester may have open at once (D4a).
pub const MAX_OPEN_REQUESTS_PER_BUYER: u32 = 10;

/// Evidence hashes each escrow party may add while Disputed, besides the
/// renter's problem report (D10).
pub const MAX_EVIDENCE_PER_PARTY: u32 = 4;

/// Pending swap acceptances one right may be part of at once. Bounds the burn
/// guard's read (D11).
pub const MAX_PENDING_SWAPS_PER_RIGHT: u32 = 10;

/// The wait after check-in before an owner may collect, and the end of the
/// renter's problem-report window: 24 hours, in ledger seconds (§5).
pub const FIRST_NIGHT_SECS: u64 = 86_400;

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
    /// The party that issued this right. It attests maintenance-fee status off
    /// chain; under Phase 2 it has no part in any transfer.
    pub issuer: Address,
    /// The occupancy window of the week.
    pub period: Period,
    /// The lifetime of the right itself.
    pub validity: Validity,
    /// The Poseidon commitment `C` of docs/CIRCUIT.md §2, as a 32-byte
    /// big-endian field element: it wraps the SHA-256 digest of the off-chain
    /// ownership record together with the holder's account and secret hash. The
    /// record itself never touches the ledger. Replaced on every sale.
    pub commitment: BytesN<32>,
    /// Title holder first, then finite-term grants in the order they were made.
    pub holdings: Vec<Holding>,
}

/// A published availability notice (Phase 1). It records availability and term
/// only and moves nothing. Paid sales and rentals go through [`Offer`].
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
/// mutated. There is no setter: rotating any of these means deploying again.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub issuer: Address,
    /// The pilot arbiter. It can act only on Disputed escrows, and only by
    /// paying the escrow's owner or refunding its renter (§5).
    pub arbiter: Address,
    /// The USDC Stellar Asset Contract. The only token the contract moves.
    pub usdc: Address,
    pub name: String,
    pub symbol: String,
    /// The largest price an offer may carry, in USDC's smallest unit (D7):
    /// 10,000,000 (1 USDC) on mainnet, 1,000,000,000 (100 USDC) on testnet.
    pub max_payment: i128,
}

/// An on-chain request for a right's private record (D4/D4a). It binds the
/// requester's record-encryption key to their account before any offer. It
/// moves nothing, sets no allowance and obliges the holder to nothing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordRequest {
    pub id: u64,
    pub requester: Address,
    pub right_id: u64,
    /// SHA-256 of the requester's raw P-256 public key.
    pub key_hash: BytesN<32>,
    /// The last ledger at which the request can be used.
    pub expires_ledger: u32,
}

/// What a sale offer fixes besides the price.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SaleTerms {
    /// The buyer's `h'`. The seller's proof must carry exactly this value, so
    /// the seller cannot plant a commitment (D4).
    pub next_secret_hash: U256,
    /// Copied from the consumed record request: the key the record was sealed
    /// to.
    pub key_hash: BytesN<32>,
}

/// What a rental offer fixes besides the price.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RentalTerms {
    /// When the rental right lapses.
    pub expires_at: u64,
    /// Check-in, in ledger seconds. The owner may collect from
    /// `check_in + 24 h`.
    pub check_in: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OfferTerms {
    Sale(SaleTerms),
    Rental(RentalTerms),
}

/// A buyer's or renter's open offer. The USDC stays in their account; the
/// contract holds an allowance equal to the sum of their live offers (D12).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offer {
    pub id: u64,
    pub right_id: u64,
    /// The buyer of a sale offer, or the renter of a rental offer.
    pub buyer: Address,
    /// In USDC's smallest unit (7 decimals).
    pub price: i128,
    /// The last ledger at which the offer can be accepted.
    pub expires_ledger: u32,
    pub terms: OfferTerms,
}

/// The rental escrow state machine (§5). PaidOut and Refunded are final.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowState {
    Funded,
    Disputed,
    PaidOut,
    Refunded,
}

/// The arbiter's only choice.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    PayOwner,
    RefundRenter,
}

/// A rental payment held by the contract until the first night has passed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub id: u64,
    pub right_id: u64,
    /// The rental offer whose acceptance funded this escrow.
    pub offer_id: u64,
    /// The holder who accepted the rental, paid on PaidOut.
    pub owner: Address,
    /// The renter who paid, refunded on Refunded.
    pub renter: Address,
    pub amount: i128,
    pub check_in: u64,
    /// When the rental right lapses.
    pub expires_at: u64,
    pub funded_at: u64,
    pub state: EscrowState,
    /// SHA-256 of the renter's problem report, set on Disputed.
    pub report_hash: Option<BytesN<32>>,
    /// Up to four SHA-256 hashes from each party while Disputed (D10).
    pub owner_evidence: Vec<BytesN<32>>,
    pub renter_evidence: Vec<BytesN<32>>,
    /// SHA-256 of the arbiter's written decision, set by `resolve`.
    pub decision_hash: Option<BytesN<32>>,
}

/// A maker's offer to swap `give_right` for `want_right` (§7, D5). It moves
/// nothing until the holder of `want_right` accepts and the maker completes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapOffer {
    pub id: u64,
    pub maker: Address,
    /// The maker's week, which goes to the taker.
    pub give_right: u64,
    /// The week the maker wants, which goes to the maker.
    pub want_right: u64,
    /// The maker's `h'` for `want_right`: the taker's proof must carry it.
    pub maker_next_secret_hash: U256,
    /// Copied from the maker's consumed record request for `want_right`.
    pub maker_key_hash: BytesN<32>,
    /// The last ledger at which the swap can be accepted or completed.
    pub expires_ledger: u32,
}

/// The holder of `want_right` accepting a swap. Their proof is checked
/// without the pairing and stored until its own `expiry_ledger`; the maker's
/// `complete_swap` verifies it, with everything else, in full.
#[contracttype]
#[derive(Clone)]
pub struct SwapAcceptance {
    pub swap_id: u64,
    pub taker: Address,
    /// The taker's `h'` for `give_right`: the maker's proof must carry it.
    pub taker_next_secret_hash: U256,
    /// Copied from the taker's consumed record request for `give_right`.
    pub taker_key_hash: BytesN<32>,
    /// The taker's proof: `want_right` → maker, mode `Swap { give_right }`.
    pub proof: Proof,
    pub signals: Vec<U256>,
    /// The proof's last valid ledger; the acceptance lapses with it.
    pub expiry_ledger: u32,
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
    /// Instance: the Groth16 verification key, fixed by the constructor.
    VerificationKey,
    /// Temporary: a spent proof's nullifier, holding its `expiry_ledger`. Lives
    /// past that ledger, after which the proof is refused as expired anyway.
    Nullifier(BytesN<32>),
    /// Instance: `u64` counters for record requests, offers and escrows.
    NextRequestId,
    NextOfferId,
    NextEscrowId,
    /// Temporary: `RecordRequest`, live past its `expires_ledger`.
    Request(u64),
    /// Temporary: `Offer`, live past its `expires_ledger`.
    Offer(u64),
    /// Persistent: `Vec<u64>`, a requester's request ids (≤ 10, pruned).
    BuyerRequests(Address),
    /// Persistent: `Vec<u64>`, a buyer's offer ids (≤ 10, pruned) (D12).
    BuyerOffers(Address),
    /// Persistent: `Escrow`, keyed by escrow id. Never deleted.
    Escrow(u64),
    /// Persistent: `u32`, the Funded or Disputed escrows on a right (D11).
    OpenEscrows(u64),
    /// Instance: `u64`, the id the next `offer_swap` will assign.
    NextSwapId,
    /// Temporary: `SwapOffer`, live past its `expires_ledger`.
    Swap(u64),
    /// Temporary: `SwapAcceptance`, keyed by swap id, live past the stored
    /// proof's `expiry_ledger`.
    SwapAcceptance(u64),
    /// Temporary: `Vec<u64>`, the swaps with an acceptance pending on a right
    /// (≤ 10, pruned), for the burn guard (D11). Lives as long as the latest
    /// of those acceptances.
    SwapPending(u64),
}
