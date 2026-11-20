//! The rental escrow state machine (docs/PHASE3_SPEC.md §5).
//!
//! ```text
//! Funded ──collect (owner, now ≥ check_in + 24 h)──▶ PaidOut
//! Funded ──confirm (renter, any time)──────────────▶ PaidOut
//! Funded ──report_problem (renter, now < check_in + 24 h)──▶ Disputed
//! Disputed ──confirm (renter)───────────▶ PaidOut
//! Disputed ──refund (owner)─────────────▶ Refunded
//! Disputed ──resolve(PayOwner) (arbiter)──────▶ PaidOut
//! Disputed ──resolve(RefundRenter) (arbiter)──▶ Refunded
//! ```
//!
//! There are no other transitions. PaidOut and Refunded are final. Nothing in
//! this file reads or writes a `Right`: an escrow holds money, and the only
//! addresses it can pay are its own owner and renter, the only amount its own.
//! The money leaves only through [`payment::pay`].

use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol, Vec};

use crate::error::Error;
use crate::events::{EscrowPaidOut, EscrowRefunded, EvidenceSubmitted, ProblemReported, Resolved};
use crate::types::{
    DataKey, Escrow, EscrowState, Offer, Outcome, RentalTerms, FIRST_NIGHT_SECS,
    MAX_EVIDENCE_PER_PARTY,
};
use crate::{payment, store};

/// Escrows stay live at least until 30 days after the collect window opens.
const KEEP_AFTER_COLLECT_SECS: u64 = 30 * 86_400;
/// Ledgers are about 5 s on testnet and 5–6 s on mainnet. Dividing by 5
/// overestimates the ledgers needed, which only keeps an escrow longer.
const SECS_PER_LEDGER: u64 = 5;

pub fn next_escrow_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextEscrowId)
        .unwrap_or(1)
}

/// The TTL an escrow is extended to: enough ledgers to reach
/// `check_in + 24 h + 30 days`, never less than 30 days, and never more than
/// the network's maximum (§9).
fn ttl_for(env: &Env, escrow: &Escrow) -> u32 {
    let horizon = escrow.check_in + FIRST_NIGHT_SECS + KEEP_AFTER_COLLECT_SECS;
    let secs = horizon.saturating_sub(env.ledger().timestamp());
    let ledgers = (secs / SECS_PER_LEDGER + 1).min(u32::MAX as u64) as u32;
    ledgers
        .max(store::PERSISTENT_EXTEND_TO)
        .min(env.storage().max_ttl())
}

fn put(env: &Env, escrow: &Escrow) {
    let key = DataKey::Escrow(escrow.id);
    let ttl = ttl_for(env, escrow);
    env.storage().persistent().set(&key, escrow);
    env.storage().persistent().extend_ttl(&key, ttl, ttl);
}

/// Read an escrow and extend its TTL, so every call that touches it keeps it
/// live.
pub fn get(env: &Env, id: u64) -> Result<Escrow, Error> {
    let key = DataKey::Escrow(id);
    let escrow: Escrow = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::EscrowNotFound)?;
    let ttl = ttl_for(env, &escrow);
    env.storage().persistent().extend_ttl(&key, ttl, ttl);
    Ok(escrow)
}

pub fn open_count(env: &Env, right_id: u64) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::OpenEscrows(right_id))
        .unwrap_or(0)
}

fn set_open_count(env: &Env, right_id: u64, count: u32) {
    let key = DataKey::OpenEscrows(right_id);
    if count == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage().persistent().set(&key, &count);
        store::extend_persistent(env, &key);
    }
}

/// Write a Funded escrow for an accepted rental. Called only by
/// `accept_rental`, after the renter's USDC has been pulled into the contract.
pub fn open(env: &Env, offer: &Offer, owner: &Address, terms: &RentalTerms) -> u64 {
    let id = next_escrow_id(env);
    env.storage()
        .instance()
        .set(&DataKey::NextEscrowId, &(id + 1));
    put(
        env,
        &Escrow {
            id,
            right_id: offer.right_id,
            offer_id: offer.id,
            owner: owner.clone(),
            renter: offer.buyer.clone(),
            amount: offer.price,
            check_in: terms.check_in,
            expires_at: terms.expires_at,
            funded_at: env.ledger().timestamp(),
            state: EscrowState::Funded,
            report_hash: None,
            owner_evidence: Vec::new(env),
            renter_evidence: Vec::new(env),
            decision_hash: None,
        },
    );
    set_open_count(env, offer.right_id, open_count(env, offer.right_id) + 1);
    id
}

fn collect_opens_at(escrow: &Escrow) -> u64 {
    escrow.check_in + FIRST_NIGHT_SECS
}

fn require_state(escrow: &Escrow, allowed: &[EscrowState]) -> Result<(), Error> {
    if allowed.contains(&escrow.state) {
        Ok(())
    } else {
        Err(Error::EscrowNotInState)
    }
}

/// Move to a final state and pay. The count of open escrows on the right
/// drops, so the right can be burned again (D11).
fn finish(env: &Env, mut escrow: Escrow, state: EscrowState, via: Symbol) {
    escrow.state = state;
    put(env, &escrow);
    set_open_count(
        env,
        escrow.right_id,
        open_count(env, escrow.right_id).saturating_sub(1),
    );
    match state {
        EscrowState::PaidOut => {
            payment::pay(env, &escrow.owner, escrow.amount);
            EscrowPaidOut {
                owner: escrow.owner,
                escrow_id: escrow.id,
                amount: escrow.amount,
                via,
            }
            .publish(env);
        }
        EscrowState::Refunded => {
            payment::pay(env, &escrow.renter, escrow.amount);
            EscrowRefunded {
                renter: escrow.renter,
                escrow_id: escrow.id,
                amount: escrow.amount,
                via,
            }
            .publish(env);
        }
        EscrowState::Funded | EscrowState::Disputed => unreachable!("not a final state"),
    }
}

pub fn collect(env: &Env, owner: Address, id: u64) -> Result<(), Error> {
    owner.require_auth();
    let escrow = get(env, id)?;
    if escrow.owner != owner {
        return Err(Error::NotEscrowParty);
    }
    require_state(&escrow, &[EscrowState::Funded])?;
    if env.ledger().timestamp() < collect_opens_at(&escrow) {
        return Err(Error::TooEarlyToCollect);
    }
    finish(env, escrow, EscrowState::PaidOut, symbol_short!("collect"));
    Ok(())
}

pub fn confirm(env: &Env, renter: Address, id: u64) -> Result<(), Error> {
    renter.require_auth();
    let escrow = get(env, id)?;
    if escrow.renter != renter {
        return Err(Error::NotEscrowParty);
    }
    require_state(&escrow, &[EscrowState::Funded, EscrowState::Disputed])?;
    finish(env, escrow, EscrowState::PaidOut, symbol_short!("confirm"));
    Ok(())
}

pub fn report_problem(
    env: &Env,
    renter: Address,
    id: u64,
    evidence_hash: BytesN<32>,
) -> Result<(), Error> {
    renter.require_auth();
    let mut escrow = get(env, id)?;
    if escrow.renter != renter {
        return Err(Error::NotEscrowParty);
    }
    require_state(&escrow, &[EscrowState::Funded])?;
    if env.ledger().timestamp() >= collect_opens_at(&escrow) {
        return Err(Error::ReportWindowClosed);
    }
    escrow.state = EscrowState::Disputed;
    escrow.report_hash = Some(evidence_hash.clone());
    put(env, &escrow);
    ProblemReported {
        renter,
        escrow_id: id,
        evidence_hash,
    }
    .publish(env);
    Ok(())
}

pub fn refund(env: &Env, owner: Address, id: u64) -> Result<(), Error> {
    owner.require_auth();
    let escrow = get(env, id)?;
    if escrow.owner != owner {
        return Err(Error::NotEscrowParty);
    }
    require_state(&escrow, &[EscrowState::Disputed])?;
    finish(env, escrow, EscrowState::Refunded, symbol_short!("refund"));
    Ok(())
}

pub fn submit_evidence(
    env: &Env,
    by: Address,
    id: u64,
    evidence_hash: BytesN<32>,
) -> Result<(), Error> {
    by.require_auth();
    let mut escrow = get(env, id)?;
    let is_owner = by == escrow.owner;
    if !is_owner && by != escrow.renter {
        return Err(Error::NotEscrowParty);
    }
    require_state(&escrow, &[EscrowState::Disputed])?;
    let list = if is_owner {
        &mut escrow.owner_evidence
    } else {
        &mut escrow.renter_evidence
    };
    if list.len() >= MAX_EVIDENCE_PER_PARTY {
        return Err(Error::EvidenceLimit);
    }
    list.push_back(evidence_hash.clone());
    put(env, &escrow);
    EvidenceSubmitted {
        by,
        escrow_id: id,
        evidence_hash,
    }
    .publish(env);
    Ok(())
}

/// The arbiter's one function: a Disputed escrow's id and an outcome. There
/// is no address and no amount to choose.
pub fn resolve(
    env: &Env,
    arbiter: Address,
    id: u64,
    outcome: Outcome,
    decision_hash: BytesN<32>,
) -> Result<(), Error> {
    arbiter.require_auth();
    if arbiter != store::config(env).arbiter {
        return Err(Error::NotArbiter);
    }
    let mut escrow = get(env, id)?;
    require_state(&escrow, &[EscrowState::Disputed])?;
    escrow.decision_hash = Some(decision_hash.clone());
    let state = match outcome {
        Outcome::PayOwner => EscrowState::PaidOut,
        Outcome::RefundRenter => EscrowState::Refunded,
    };
    finish(env, escrow, state, symbol_short!("resolve"));
    Resolved {
        arbiter,
        escrow_id: id,
        outcome,
        decision_hash,
    }
    .publish(env);
    Ok(())
}
