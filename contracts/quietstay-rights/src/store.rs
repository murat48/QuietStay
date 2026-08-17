//! Storage access, TTL upkeep, and the holding-chain rules.
//!
//! Kept separate from the entry points so that the reviewable question "can any
//! caller reach someone else's holding record?" has a single, short answer: only
//! through the functions below, and only via `put_right`, which every caller
//! reaches through an authorization check first.

use soroban_sdk::{vec, Address, Env, Vec};

use crate::error::Error;
use crate::types::{Config, DataKey, Holding, Listing, Right, MAX_HOLDING_DEPTH};

/// ~1 day of 5s ledgers. Below this, extend.
const TTL_THRESHOLD: u32 = 17_280;
/// ~30 days of 5s ledgers.
const TTL_EXTEND_TO: u32 = 518_400;

pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("contract not constructed")
}

pub fn put_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn next_id(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::NextId).unwrap_or(1)
}

pub fn set_next_id(env: &Env, id: u64) {
    env.storage().instance().set(&DataKey::NextId, &id);
}

pub fn get_right(env: &Env, right_id: u64) -> Result<Right, Error> {
    let key = DataKey::Right(right_id);
    let right: Right = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::RightNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Ok(right)
}

pub fn put_right(env: &Env, right: &Right) {
    let key = DataKey::Right(right.id);
    env.storage().persistent().set(&key, right);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn remove_right(env: &Env, right_id: u64) {
    env.storage().persistent().remove(&DataKey::Right(right_id));
    env.storage().persistent().remove(&DataKey::Listing(right_id));
}

pub fn get_listing(env: &Env, right_id: u64) -> Option<Listing> {
    let key = DataKey::Listing(right_id);
    let listing: Option<Listing> = env.storage().persistent().get(&key);
    if listing.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    listing
}

pub fn put_listing(env: &Env, listing: &Listing) {
    let key = DataKey::Listing(listing.right_id);
    env.storage().persistent().set(&key, listing);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

pub fn remove_listing(env: &Env, right_id: u64) {
    env.storage().persistent().remove(&DataKey::Listing(right_id));
}

pub fn balance(env: &Env, owner: &Address) -> i128 {
    let key = DataKey::Balance(owner.clone());
    let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if balance != 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    balance
}

/// Adjust an address's title count. `delta` is always -1 or +1; `checked_add`
/// keeps the contract honest even so.
pub fn adjust_balance(env: &Env, owner: &Address, delta: i128) {
    let key = DataKey::Balance(owner.clone());
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let updated = current.checked_add(delta).expect("balance overflow");
    if updated == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &updated);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

// --- holding chain -------------------------------------------------------

/// Drop every finite-term holding that has reached its expiry.
///
/// Terms are non-increasing from title upwards (enforced on every grant), so the
/// lapsed entries are exactly a suffix of the chain and popping from the top is
/// sufficient. This is what makes a rental lapse without a return transaction:
/// nobody has to call anything, the chain is re-evaluated on the next read.
pub fn prune_lapsed(env: &Env, holdings: &Vec<Holding>) -> Vec<Holding> {
    let now = env.ledger().timestamp();
    let mut live = holdings.clone();
    while live.len() > 1 {
        let top = live.last().expect("chain is never empty");
        match top.expires_at {
            Some(expires_at) if expires_at <= now => {
                live.pop_back();
            }
            _ => break,
        }
    }
    live
}

/// The holding in force right now, after lapsed terms are discarded.
pub fn effective_holding(env: &Env, right: &Right) -> Holding {
    prune_lapsed(env, &right.holdings)
        .last()
        .expect("chain is never empty")
}

/// Build the chain that results from `from` granting `to` a term of `expires_at`.
///
/// This is the whole of the sale/rental distinction, and it is a branch on data,
/// not two code paths: an open-ended grant replaces the chain, a finite grant
/// extends it.
pub fn grant(
    env: &Env,
    right: &Right,
    from: &Address,
    to: &Address,
    expires_at: &Option<u64>,
) -> Result<Vec<Holding>, Error> {
    let now = env.ledger().timestamp();

    if from == to {
        return Err(Error::SelfTransfer);
    }

    let mut chain = prune_lapsed(env, &right.holdings);
    let current = chain.last().expect("chain is never empty");

    if &current.holder != from {
        return Err(Error::NotHolder);
    }

    match expires_at {
        // Open-ended grant — a sale. Only an open-ended holder can make one, so
        // this can only happen when the chain is just the title holder. The buyer
        // replaces the chain outright.
        None => {
            if current.expires_at.is_some() {
                return Err(Error::ExpiryBeyondSenderTerm);
            }
            Ok(vec![
                env,
                Holding {
                    holder: to.clone(),
                    expires_at: None,
                },
            ])
        }
        // Finite grant — a rental. The term must be in the future, must end
        // within the right's own validity window, and must not outlast the
        // grantor's own term.
        Some(expiry) => {
            if *expiry <= now {
                return Err(Error::ExpiryInThePast);
            }
            if *expiry > right.validity.until {
                return Err(Error::ExpiryBeyondValidity);
            }
            if let Some(own_expiry) = current.expires_at {
                if *expiry > own_expiry {
                    return Err(Error::ExpiryBeyondSenderTerm);
                }
            }
            if chain.len() >= MAX_HOLDING_DEPTH {
                return Err(Error::HoldingDepthExceeded);
            }
            chain.push_back(Holding {
                holder: to.clone(),
                expires_at: Some(*expiry),
            });
            Ok(chain)
        }
    }
}

/// Reject the call unless the right's validity window is open right now.
pub fn require_active(env: &Env, right: &Right) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    if now < right.validity.from {
        return Err(Error::RightNotYetValid);
    }
    if now >= right.validity.until {
        return Err(Error::RightExpired);
    }
    Ok(())
}
