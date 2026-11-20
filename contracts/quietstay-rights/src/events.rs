//! Contract events.
//!
//! Two rules govern what may appear here, and they are the reason the events are
//! defined in one file rather than inline at each call site:
//!
//! 1. **No off-chain record contents.** Never a name, a document, a resort, or a
//!    unit number — only account addresses, right ids, the commitment hash and,
//!    from Phase 3, USDC amounts, ledger times and SHA-256 hashes of evidence
//!    files. Amounts and addresses are public on chain by design.
//! 2. **The commitment travels with every state change.** A verifier reading the
//!    event stream can bind each transfer to the exact off-chain record that was
//!    committed, without a second lookup.
//!
//! Defined with `#[contractevent]` so the shapes land in the contract's interface
//! specification and explorers render the data fields by name.

use soroban_sdk::{contractevent, Address, BytesN, Symbol, U256};

use crate::types::Outcome;

/// A new usage right was created and title assigned.
#[contractevent(topics = ["issue"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Issued {
    #[topic]
    pub issuer: Address,
    #[topic]
    pub owner: Address,
    pub right_id: u64,
    pub commitment: BytesN<32>,
}

/// A right was published as available.
#[contractevent(topics = ["list"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Listed {
    #[topic]
    pub by: Address,
    pub right_id: u64,
    /// `None` — offered open-ended (sale). `Some(n)` — offered for `n` seconds.
    pub term_secs: Option<u64>,
    pub commitment: BytesN<32>,
}

/// A listing was withdrawn.
#[contractevent(topics = ["unlist"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Unlisted {
    #[topic]
    pub by: Address,
    pub right_id: u64,
}

/// A right was transferred. `expires_at = None` is a sale; `Some(t)` is a rental
/// that lapses at `t`.
#[contractevent(topics = ["transfer"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Transferred {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub right_id: u64,
    pub expires_at: Option<u64>,
    pub commitment: BytesN<32>,
}

/// A title holder destroyed their own right.
#[contractevent(topics = ["burn"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Burned {
    #[topic]
    pub from: Address,
    pub right_id: u64,
    pub commitment: BytesN<32>,
}

// --- Phase 3: record requests, offers, escrow ---------------------------

/// A prospective buyer bound a record-encryption key to their account (D4a).
#[contractevent(topics = ["rec_req"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordRequested {
    #[topic]
    pub requester: Address,
    pub right_id: u64,
    pub request_id: u64,
    pub key_hash: BytesN<32>,
    pub expires_ledger: u32,
}

/// A requester withdrew a record request.
#[contractevent(topics = ["rec_cncl"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordRequestCancelled {
    #[topic]
    pub requester: Address,
    pub request_id: u64,
}

/// A buyer opened a sale offer. The USDC stays in the buyer's account.
#[contractevent(topics = ["sale_off"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SaleOffered {
    #[topic]
    pub buyer: Address,
    pub right_id: u64,
    pub offer_id: u64,
    pub price: i128,
    pub expires_ledger: u32,
    pub next_secret_hash: U256,
    pub key_hash: BytesN<32>,
}

/// A renter opened a rental offer. The USDC stays in the renter's account.
#[contractevent(topics = ["rent_off"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RentalOffered {
    #[topic]
    pub renter: Address,
    pub right_id: u64,
    pub offer_id: u64,
    pub price: i128,
    pub expires_ledger: u32,
    pub expires_at: u64,
    pub check_in: u64,
}

/// A buyer or renter cancelled an open offer.
#[contractevent(topics = ["off_cncl"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OfferCancelled {
    #[topic]
    pub buyer: Address,
    pub offer_id: u64,
}

/// The contract's allowance from a buyer was set to the sum of their live
/// offers (D12).
#[contractevent(topics = ["allow"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceSet {
    #[topic]
    pub buyer: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

/// A sale settled: the right went to the buyer and the price to the seller,
/// in one transaction.
#[contractevent(topics = ["sale"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SaleSettled {
    #[topic]
    pub seller: Address,
    #[topic]
    pub buyer: Address,
    pub right_id: u64,
    pub offer_id: u64,
    pub price: i128,
    pub commitment: BytesN<32>,
}

/// A rental was accepted: the rental right went to the renter and the price
/// into escrow, in one transaction.
#[contractevent(topics = ["funded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowFunded {
    #[topic]
    pub owner: Address,
    #[topic]
    pub renter: Address,
    pub right_id: u64,
    pub offer_id: u64,
    pub escrow_id: u64,
    pub amount: i128,
    pub check_in: u64,
    pub expires_at: u64,
}

/// An escrow paid its owner. `via` is `collect`, `confirm` or `resolve`.
#[contractevent(topics = ["paid_out"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowPaidOut {
    #[topic]
    pub owner: Address,
    pub escrow_id: u64,
    pub amount: i128,
    pub via: Symbol,
}

/// An escrow refunded its renter. `via` is `refund` or `resolve`.
#[contractevent(topics = ["refunded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub renter: Address,
    pub escrow_id: u64,
    pub amount: i128,
    pub via: Symbol,
}

/// The renter reported a problem: the escrow is Disputed.
#[contractevent(topics = ["dispute"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProblemReported {
    #[topic]
    pub renter: Address,
    pub escrow_id: u64,
    pub evidence_hash: BytesN<32>,
}

/// A party added an evidence hash to a Disputed escrow.
#[contractevent(topics = ["evidence"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceSubmitted {
    #[topic]
    pub by: Address,
    pub escrow_id: u64,
    pub evidence_hash: BytesN<32>,
}

/// The arbiter resolved a dispute.
#[contractevent(topics = ["resolve"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolved {
    #[topic]
    pub arbiter: Address,
    pub escrow_id: u64,
    pub outcome: Outcome,
    pub decision_hash: BytesN<32>,
}
