//! Swaps: two holders exchange weeks, both or neither (docs/PHASE3_SPEC.md §7,
//! decision D5).
//!
//! Three on-chain steps, each signed by its own party:
//!
//! 1. `offer_swap`: the maker, title holder of `give_right`, offers it for
//!    `want_right`, with the maker's `h'` for `want_right`. Consumes the
//!    maker's record request for `want_right` (D4a).
//! 2. `accept_swap`: the title holder of `want_right` accepts with a proof
//!    that moves `want_right` to the maker. Every check but the pairing runs
//!    now ([`auth::precheck_transfer`]); the proof is stored until its own
//!    `expiry_ledger`. Consumes the taker's record request for `give_right`.
//!    Nothing moves, and neither right is locked: the taker can still sell or
//!    rent it, which makes `complete_swap` fail.
//! 3. `complete_swap`: the maker proves for `give_right`, and
//!    [`auth::authorize_transfer`] runs twice in this one transaction, the
//!    taker's stored proof first. Nothing checked at acceptance is trusted.
//!    Any failure reverts both.
//!
//! Nothing here moves a right except through `authorize_transfer`, and nothing
//! here touches USDC. Offers and acceptances live in temporary storage until
//! just past their last ledger.

use soroban_sdk::{Address, Env, Vec, U256};

use crate::auth::{self, TransferMode};
use crate::error::Error;
use crate::events::{
    SwapAccepted, SwapCancelled, SwapCompleted, SwapOffered, SwapWithdrawn, Transferred,
};
use crate::offers;
use crate::store;
use crate::types::{DataKey, SwapAcceptance, SwapOffer, MAX_PENDING_SWAPS_PER_RIGHT};
use crate::verifier::Proof;

// --- storage ---------------------------------------------------------------

pub fn get_swap(env: &Env, id: u64) -> Option<SwapOffer> {
    env.storage().temporary().get(&DataKey::Swap(id))
}

pub fn get_acceptance(env: &Env, id: u64) -> Option<SwapAcceptance> {
    env.storage().temporary().get(&DataKey::SwapAcceptance(id))
}

pub fn next_swap_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextSwapId)
        .unwrap_or(1)
}

/// A swap offer that exists and whose last ledger has not passed.
fn live_swap(env: &Env, id: u64) -> Result<SwapOffer, Error> {
    let swap = get_swap(env, id).ok_or(Error::SwapNotFound)?;
    if swap.expires_ledger < env.ledger().sequence() {
        return Err(Error::SwapExpired);
    }
    Ok(swap)
}

/// An acceptance that exists and whose proof has not expired.
fn live_acceptance(env: &Env, id: u64) -> Option<SwapAcceptance> {
    get_acceptance(env, id).filter(|a| a.expiry_ledger >= env.ledger().sequence())
}

fn require_h(env: &Env, h: &U256) -> Result<(), Error> {
    if *h == U256::from_u32(env, 0) || !auth::is_canonical_u256(env, h) {
        return Err(Error::InvalidNextSecretHash);
    }
    Ok(())
}

// --- the burn guard (D11) ----------------------------------------------------

/// The swaps with a live acceptance on `right_id`. Read only.
fn pending_ids(env: &Env, right_id: u64) -> Vec<u64> {
    let ids: Vec<u64> = env
        .storage()
        .temporary()
        .get(&DataKey::SwapPending(right_id))
        .unwrap_or(Vec::new(env));
    let mut live = Vec::new(env);
    for id in ids.iter() {
        if live_acceptance(env, id).is_some() {
            live.push_back(id);
        }
    }
    live
}

/// Whether `right_id` is part of a pending swap acceptance; `burn` is refused
/// while it is.
pub fn is_pending(env: &Env, right_id: u64) -> bool {
    !pending_ids(env, right_id).is_empty()
}

fn write_pending(env: &Env, right_id: u64, ids: &Vec<u64>) {
    let key = DataKey::SwapPending(right_id);
    if ids.is_empty() {
        env.storage().temporary().remove(&key);
    } else {
        env.storage().temporary().set(&key, ids);
    }
}

/// Add `swap_id` to `right_id`'s pending list, live at least until `until`.
fn mark_pending(env: &Env, right_id: u64, swap_id: u64, until: u32) -> Result<(), Error> {
    let mut ids = Vec::new(env);
    for id in pending_ids(env, right_id).iter() {
        if id != swap_id {
            ids.push_back(id);
        }
    }
    if ids.len() >= MAX_PENDING_SWAPS_PER_RIGHT {
        return Err(Error::TooManyPendingSwaps);
    }
    ids.push_back(swap_id);
    write_pending(env, right_id, &ids);
    // Only ever extended, so the list outlives the latest acceptance on it.
    let ttl = until - env.ledger().sequence() + 1;
    env.storage()
        .temporary()
        .extend_ttl(&DataKey::SwapPending(right_id), ttl, ttl);
    Ok(())
}

fn clear_pending(env: &Env, right_id: u64, swap_id: u64) {
    let mut ids = Vec::new(env);
    for id in pending_ids(env, right_id).iter() {
        if id != swap_id {
            ids.push_back(id);
        }
    }
    write_pending(env, right_id, &ids);
}

/// Remove an acceptance and its two pending marks.
fn drop_acceptance(env: &Env, swap: &SwapOffer) {
    env.storage()
        .temporary()
        .remove(&DataKey::SwapAcceptance(swap.id));
    clear_pending(env, swap.give_right, swap.id);
    clear_pending(env, swap.want_right, swap.id);
}

// --- the three steps -----------------------------------------------------------

pub fn offer_swap(
    env: &Env,
    maker: Address,
    give_right: u64,
    want_right: u64,
    maker_next_secret_hash: U256,
    maker_request_id: u64,
    expires_ledger: u32,
) -> Result<u64, Error> {
    maker.require_auth();
    if give_right == want_right {
        return Err(Error::SelfTransfer);
    }
    let give = store::get_right(env, give_right)?;
    store::require_active(env, &give)?;
    // Checked again, in full, at completion.
    let holding = store::effective_holding(env, &give);
    if holding.holder != maker {
        return Err(Error::NotHolder);
    }
    if holding.expires_at.is_some() {
        return Err(Error::NotTitleHolder);
    }
    let want = store::get_right(env, want_right)?;
    store::require_active(env, &want)?;

    let request = offers::live_request(env, &maker, maker_request_id)?;
    if request.right_id != want_right {
        return Err(Error::RequestRightMismatch);
    }
    require_h(env, &maker_next_secret_hash)?;
    offers::check_expiry(env, expires_ledger)?;

    offers::consume_request(env, &request);
    let id = offers::next(env, &DataKey::NextSwapId);
    let swap = SwapOffer {
        id,
        maker: maker.clone(),
        give_right,
        want_right,
        maker_next_secret_hash: maker_next_secret_hash.clone(),
        maker_key_hash: request.key_hash.clone(),
        expires_ledger,
    };
    offers::put_until(env, &DataKey::Swap(id), &swap, expires_ledger);

    SwapOffered {
        maker,
        swap_id: id,
        give_right,
        want_right,
        maker_next_secret_hash,
        maker_key_hash: request.key_hash,
        expires_ledger,
    }
    .publish(env);
    Ok(id)
}

pub fn cancel_swap(env: &Env, maker: Address, swap_id: u64) -> Result<(), Error> {
    maker.require_auth();
    let swap = live_swap(env, swap_id)?;
    if swap.maker != maker {
        return Err(Error::NotSwapParty);
    }
    env.storage().temporary().remove(&DataKey::Swap(swap_id));
    drop_acceptance(env, &swap);
    SwapCancelled { maker, swap_id }.publish(env);
    Ok(())
}

pub fn accept_swap(
    env: &Env,
    taker: Address,
    swap_id: u64,
    taker_next_secret_hash: U256,
    taker_request_id: u64,
    proof: Proof,
    signals: Vec<U256>,
) -> Result<(), Error> {
    taker.require_auth();
    let swap = live_swap(env, swap_id)?;
    if live_acceptance(env, swap_id).is_some() {
        return Err(Error::SwapAlreadyAccepted);
    }
    let request = offers::live_request(env, &taker, taker_request_id)?;
    if request.right_id != swap.give_right {
        return Err(Error::RequestRightMismatch);
    }
    require_h(env, &taker_next_secret_hash)?;

    // The taker's proof moves want_right to the maker, for give_right, with
    // the maker's h'. Everything but the pairing is checked now.
    let want = store::get_right(env, swap.want_right)?;
    let expiry_ledger = auth::precheck_transfer(
        env,
        &want,
        &taker,
        &swap.maker,
        TransferMode::Swap {
            counter_right_id: swap.give_right,
        },
        &swap.maker_next_secret_hash,
        &signals,
    )?;

    offers::consume_request(env, &request);
    let acceptance = SwapAcceptance {
        swap_id,
        taker: taker.clone(),
        taker_next_secret_hash: taker_next_secret_hash.clone(),
        taker_key_hash: request.key_hash.clone(),
        proof,
        signals,
        expiry_ledger,
    };
    offers::put_until(
        env,
        &DataKey::SwapAcceptance(swap_id),
        &acceptance,
        expiry_ledger,
    );
    mark_pending(env, swap.want_right, swap_id, expiry_ledger)?;
    mark_pending(env, swap.give_right, swap_id, expiry_ledger)?;

    SwapAccepted {
        taker,
        swap_id,
        taker_next_secret_hash,
        taker_key_hash: request.key_hash,
        expiry_ledger,
    }
    .publish(env);
    Ok(())
}

pub fn withdraw_swap_acceptance(env: &Env, taker: Address, swap_id: u64) -> Result<(), Error> {
    taker.require_auth();
    let acceptance = live_acceptance(env, swap_id).ok_or(Error::AcceptanceNotFound)?;
    if acceptance.taker != taker {
        return Err(Error::NotSwapParty);
    }
    match get_swap(env, swap_id) {
        Some(swap) => drop_acceptance(env, &swap),
        // The offer has lapsed: its pending marks are dead with the acceptance.
        None => env
            .storage()
            .temporary()
            .remove(&DataKey::SwapAcceptance(swap_id)),
    }
    SwapWithdrawn { taker, swap_id }.publish(env);
    Ok(())
}

pub fn complete_swap(
    env: &Env,
    maker: Address,
    swap_id: u64,
    proof: Proof,
    signals: Vec<U256>,
) -> Result<(), Error> {
    maker.require_auth();
    let swap = live_swap(env, swap_id)?;
    if swap.maker != maker {
        return Err(Error::NotSwapParty);
    }
    let acceptance = live_acceptance(env, swap_id).ok_or(Error::AcceptanceNotFound)?;
    if swap.give_right == swap.want_right {
        return Err(Error::SelfTransfer);
    }

    // The taker's stored proof: want_right → maker.
    let mut want = store::get_right(env, swap.want_right)?;
    auth::authorize_transfer(
        env,
        &mut want,
        &acceptance.taker,
        &maker,
        TransferMode::Swap {
            counter_right_id: swap.give_right,
        },
        &swap.maker_next_secret_hash,
        &acceptance.proof,
        &acceptance.signals,
    )?;
    // The maker's proof: give_right → taker.
    let mut give = store::get_right(env, swap.give_right)?;
    auth::authorize_transfer(
        env,
        &mut give,
        &maker,
        &acceptance.taker,
        TransferMode::Swap {
            counter_right_id: swap.want_right,
        },
        &acceptance.taker_next_secret_hash,
        &proof,
        &signals,
    )?;
    store::put_right(env, &want);
    store::put_right(env, &give);

    env.storage().temporary().remove(&DataKey::Swap(swap_id));
    drop_acceptance(env, &swap);

    Transferred {
        from: acceptance.taker.clone(),
        to: maker.clone(),
        right_id: want.id,
        expires_at: None,
        commitment: want.commitment.clone(),
    }
    .publish(env);
    Transferred {
        from: maker.clone(),
        to: acceptance.taker.clone(),
        right_id: give.id,
        expires_at: None,
        commitment: give.commitment.clone(),
    }
    .publish(env);
    SwapCompleted {
        maker,
        taker: acceptance.taker,
        swap_id,
        give_right: give.id,
        want_right: want.id,
        give_commitment: give.commitment,
        want_commitment: want.commitment,
    }
    .publish(env);
    Ok(())
}
