//! Contract events.
//!
//! Two rules govern what may appear here, and they are the reason the events are
//! defined in one file rather than inline at each call site:
//!
//! 1. **No off-chain record contents.** Never a name, a document, a resort, or a
//!    unit number — only account addresses, right ids, and the commitment hash.
//! 2. **The commitment travels with every state change.** A verifier reading the
//!    event stream can bind each transfer to the exact off-chain record that was
//!    committed, without a second lookup.
//!
//! Defined with `#[contractevent]` so the shapes land in the contract's interface
//! specification and explorers render the data fields by name.

use soroban_sdk::{contractevent, Address, BytesN};

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
