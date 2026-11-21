//! Record requests, sale and rental offers (docs/PHASE3_SPEC.md §2, §4, §5).
//!
//! Nothing here moves a right: acceptance hands the transfer to
//! [`auth::authorize_transfer`], and nothing here moves money except through
//! [`payment`]. Requests and offers live in temporary storage until just past
//! their last ledger; an expired one is dead, so losing it is harmless. Each
//! account's ids are kept in a small persistent index (≤ 10), pruned on every
//! call by that account.

use soroban_sdk::{Address, BytesN, Env, Vec, U256};

use crate::auth::{self, TransferMode};
use crate::error::Error;
use crate::events::{
    EscrowFunded, OfferCancelled, RecordRequestCancelled, RecordRequested, RentalOffered,
    SaleOffered, SaleSettled, Transferred,
};
use crate::types::{
    DataKey, Offer, OfferTerms, RecordRequest, RentalTerms, SaleTerms, FIRST_NIGHT_SECS,
    MAX_OFFER_LEDGERS, MAX_OPEN_OFFERS_PER_BUYER, MAX_OPEN_REQUESTS_PER_BUYER,
};
use crate::verifier::Proof;
use crate::{escrow, payment, store};

// --- storage ---------------------------------------------------------------

pub(crate) fn next(env: &Env, key: &DataKey) -> u64 {
    let id: u64 = env.storage().instance().get(key).unwrap_or(1);
    env.storage().instance().set(key, &(id + 1));
    id
}

/// Write a temporary entry that stays live until just past `expires_ledger`.
pub(crate) fn put_until<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
    value: &V,
    expires_ledger: u32,
) {
    let storage = env.storage().temporary();
    storage.set(key, value);
    let ttl = expires_ledger - env.ledger().sequence() + 1;
    storage.extend_ttl(key, ttl, ttl);
}

pub fn get_request(env: &Env, id: u64) -> Option<RecordRequest> {
    env.storage().temporary().get(&DataKey::Request(id))
}

pub fn get_offer(env: &Env, id: u64) -> Option<Offer> {
    env.storage().temporary().get(&DataKey::Offer(id))
}

pub fn next_request_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextRequestId)
        .unwrap_or(1)
}

pub fn next_offer_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextOfferId)
        .unwrap_or(1)
}

/// Read an account's index, keep only the ids `live` accepts, and write it
/// back (or remove it when empty).
fn prune(env: &Env, key: &DataKey, live: impl Fn(u64) -> bool) -> Vec<u64> {
    let storage = env.storage().persistent();
    let ids: Vec<u64> = storage.get(key).unwrap_or(Vec::new(env));
    let mut kept = Vec::new(env);
    for id in ids.iter() {
        if live(id) {
            kept.push_back(id);
        }
    }
    write_index(env, key, &kept);
    kept
}

fn write_index(env: &Env, key: &DataKey, ids: &Vec<u64>) {
    let storage = env.storage().persistent();
    if ids.is_empty() {
        storage.remove(key);
    } else {
        storage.set(key, ids);
        store::extend_persistent(env, key);
    }
}

fn remove_from_index(env: &Env, key: &DataKey, id: u64) {
    let storage = env.storage().persistent();
    let ids: Vec<u64> = storage.get(key).unwrap_or(Vec::new(env));
    let mut kept = Vec::new(env);
    for x in ids.iter() {
        if x != id {
            kept.push_back(x);
        }
    }
    write_index(env, key, &kept);
}

/// `now < expires_ledger ≤ now + MAX_OFFER_LEDGERS` (D9).
pub(crate) fn check_expiry(env: &Env, expires_ledger: u32) -> Result<(), Error> {
    let now = env.ledger().sequence();
    if expires_ledger <= now || expires_ledger - now > MAX_OFFER_LEDGERS {
        return Err(Error::InvalidOfferExpiry);
    }
    Ok(())
}

fn check_price(env: &Env, price: i128) -> Result<(), Error> {
    if price <= 0 || price > store::config(env).max_payment {
        return Err(Error::InvalidPrice);
    }
    Ok(())
}

// --- record requests (D4/D4a) ------------------------------------------------

fn live_requests(env: &Env, requester: &Address) -> Vec<u64> {
    let now = env.ledger().sequence();
    prune(env, &DataKey::BuyerRequests(requester.clone()), |id| {
        get_request(env, id).is_some_and(|r| r.expires_ledger >= now)
    })
}

pub fn request_record(
    env: &Env,
    requester: Address,
    right_id: u64,
    key_hash: BytesN<32>,
    expires_ledger: u32,
) -> Result<u64, Error> {
    requester.require_auth();
    store::get_right(env, right_id)?;
    if key_hash == BytesN::from_array(env, &[0u8; 32]) {
        return Err(Error::InvalidKeyHash);
    }
    check_expiry(env, expires_ledger)?;

    let mut ids = live_requests(env, &requester);
    if ids.len() >= MAX_OPEN_REQUESTS_PER_BUYER {
        return Err(Error::TooManyRequests);
    }

    let id = next(env, &DataKey::NextRequestId);
    let request = RecordRequest {
        id,
        requester: requester.clone(),
        right_id,
        key_hash: key_hash.clone(),
        expires_ledger,
    };
    put_until(env, &DataKey::Request(id), &request, expires_ledger);
    ids.push_back(id);
    write_index(env, &DataKey::BuyerRequests(requester.clone()), &ids);

    RecordRequested {
        requester,
        right_id,
        request_id: id,
        key_hash,
        expires_ledger,
    }
    .publish(env);
    Ok(id)
}

/// A request that is live and belongs to `requester`.
pub(crate) fn live_request(
    env: &Env,
    requester: &Address,
    id: u64,
) -> Result<RecordRequest, Error> {
    let request = get_request(env, id).ok_or(Error::RequestNotFound)?;
    if &request.requester != requester {
        return Err(Error::NotRequester);
    }
    if request.expires_ledger < env.ledger().sequence() {
        return Err(Error::RequestExpired);
    }
    Ok(request)
}

pub(crate) fn consume_request(env: &Env, request: &RecordRequest) {
    env.storage()
        .temporary()
        .remove(&DataKey::Request(request.id));
    remove_from_index(
        env,
        &DataKey::BuyerRequests(request.requester.clone()),
        request.id,
    );
}

pub fn cancel_record_request(env: &Env, requester: Address, id: u64) -> Result<(), Error> {
    requester.require_auth();
    let request = live_request(env, &requester, id)?;
    consume_request(env, &request);
    live_requests(env, &requester);
    RecordRequestCancelled {
        requester,
        request_id: id,
    }
    .publish(env);
    Ok(())
}

// --- offers and the allowance (D12) -----------------------------------------

/// The buyer's live offer ids, after dropping expired, accepted and cancelled
/// ones; the sum of their prices; and the latest of their last ledgers (0 if
/// there are none).
fn live_offers(env: &Env, buyer: &Address) -> (Vec<u64>, i128, u32) {
    let now = env.ledger().sequence();
    let ids = prune(env, &DataKey::BuyerOffers(buyer.clone()), |id| {
        get_offer(env, id).is_some_and(|o| o.expires_ledger >= now)
    });
    let mut total: i128 = 0;
    let mut latest: u32 = 0;
    for id in ids.iter() {
        let offer = get_offer(env, id).expect("kept only live offers");
        total = total.checked_add(offer.price).expect("allowance overflow");
        latest = latest.max(offer.expires_ledger);
    }
    (ids, total, latest)
}

/// Record a new offer for `buyer` and set the allowance to the sum of their
/// live offers, this one included, expiring with the last of them.
///
/// The expiration is the latest `expires_ledger` among those offers, never
/// "now + n": the buyer signs the `approve` arguments, expiration included,
/// when the call is simulated, and the transaction lands some ledgers later. A
/// value read from the ledger sequence would differ by then and the signature
/// would no longer match (found on testnet, Step 3 deployment). Every live
/// offer expires by `now + MAX_OFFER_LEDGERS`, so this is never later.
fn open_offer(env: &Env, mut offer: Offer) -> Result<Offer, Error> {
    let (mut ids, total, latest) = live_offers(env, &offer.buyer);
    if ids.len() >= MAX_OPEN_OFFERS_PER_BUYER {
        return Err(Error::TooManyOffers);
    }
    offer.id = next(env, &DataKey::NextOfferId);
    put_until(env, &DataKey::Offer(offer.id), &offer, offer.expires_ledger);
    ids.push_back(offer.id);
    write_index(env, &DataKey::BuyerOffers(offer.buyer.clone()), &ids);

    let total = total.checked_add(offer.price).expect("allowance overflow");
    payment::set_allowance(env, &offer.buyer, total, latest.max(offer.expires_ledger));
    Ok(offer)
}

pub fn create_sale_offer(
    env: &Env,
    buyer: Address,
    request_id: u64,
    price: i128,
    next_secret_hash: U256,
    expires_ledger: u32,
) -> Result<u64, Error> {
    buyer.require_auth();
    let request = live_request(env, &buyer, request_id)?;
    let right = store::get_right(env, request.right_id)?;
    store::require_active(env, &right)?;
    check_price(env, price)?;
    if next_secret_hash == U256::from_u32(env, 0)
        || !auth::is_canonical_u256(env, &next_secret_hash)
    {
        return Err(Error::InvalidNextSecretHash);
    }
    check_expiry(env, expires_ledger)?;

    consume_request(env, &request);
    let offer = open_offer(
        env,
        Offer {
            id: 0,
            right_id: right.id,
            buyer: buyer.clone(),
            price,
            expires_ledger,
            terms: OfferTerms::Sale(SaleTerms {
                next_secret_hash: next_secret_hash.clone(),
                key_hash: request.key_hash.clone(),
            }),
        },
    )?;

    SaleOffered {
        buyer,
        right_id: right.id,
        offer_id: offer.id,
        price,
        expires_ledger,
        next_secret_hash,
        key_hash: request.key_hash,
    }
    .publish(env);
    Ok(offer.id)
}

/// Check-in is now or later, inside the week, and at least 24 hours before
/// the rental ends, which is inside the right's validity (§5).
fn check_rental_terms(
    env: &Env,
    right: &crate::types::Right,
    terms: &RentalTerms,
) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    if terms.check_in < now
        || terms.check_in < right.period.start
        || terms.check_in >= right.period.end
        || terms
            .check_in
            .checked_add(FIRST_NIGHT_SECS)
            .is_none_or(|t| t > terms.expires_at)
    {
        return Err(Error::InvalidCheckIn);
    }
    if terms.expires_at > right.validity.until {
        return Err(Error::ExpiryBeyondValidity);
    }
    Ok(())
}

pub fn create_rental_offer(
    env: &Env,
    renter: Address,
    right_id: u64,
    price: i128,
    expires_at: u64,
    check_in: u64,
    expires_ledger: u32,
) -> Result<u64, Error> {
    renter.require_auth();
    let right = store::get_right(env, right_id)?;
    store::require_active(env, &right)?;
    check_price(env, price)?;
    let terms = RentalTerms {
        expires_at,
        check_in,
    };
    check_rental_terms(env, &right, &terms)?;
    check_expiry(env, expires_ledger)?;

    let offer = open_offer(
        env,
        Offer {
            id: 0,
            right_id,
            buyer: renter.clone(),
            price,
            expires_ledger,
            terms: OfferTerms::Rental(terms),
        },
    )?;

    RentalOffered {
        renter,
        right_id,
        offer_id: offer.id,
        price,
        expires_ledger,
        expires_at,
        check_in,
    }
    .publish(env);
    Ok(offer.id)
}

/// An offer that exists and whose last ledger has not passed.
fn live_offer(env: &Env, id: u64) -> Result<Offer, Error> {
    let offer = get_offer(env, id).ok_or(Error::OfferNotFound)?;
    if offer.expires_ledger < env.ledger().sequence() {
        return Err(Error::OfferExpired);
    }
    Ok(offer)
}

pub fn cancel_offer(env: &Env, buyer: Address, id: u64) -> Result<(), Error> {
    buyer.require_auth();
    let offer = live_offer(env, id)?;
    if offer.buyer != buyer {
        return Err(Error::NotRequester);
    }
    env.storage().temporary().remove(&DataKey::Offer(id));
    let (_, total, latest) = live_offers(env, &buyer);
    // With no live offer left the allowance is zero; its expiration is then
    // the cancelled offer's own last ledger, which is still a value the buyer
    // signed and the same at simulation and inclusion.
    let expiration = if total > 0 {
        latest
    } else {
        offer.expires_ledger
    };
    payment::set_allowance(env, &buyer, total, expiration);
    OfferCancelled {
        buyer,
        offer_id: id,
    }
    .publish(env);
    Ok(())
}

/// Remove an accepted offer. The allowance already dropped by its price in
/// `transfer_from`, so it still equals the sum of the remaining offers.
fn settle_offer(env: &Env, offer: &Offer) {
    env.storage().temporary().remove(&DataKey::Offer(offer.id));
    remove_from_index(env, &DataKey::BuyerOffers(offer.buyer.clone()), offer.id);
}

// --- acceptance: one transaction moves the right and the money --------------

pub fn accept_sale(
    env: &Env,
    seller: Address,
    offer_id: u64,
    price: i128,
    proof: Proof,
    signals: Vec<U256>,
) -> Result<(), Error> {
    seller.require_auth();
    let offer = live_offer(env, offer_id)?;
    let OfferTerms::Sale(terms) = &offer.terms else {
        return Err(Error::WrongOfferKind);
    };
    if price != offer.price {
        return Err(Error::PriceMismatch);
    }

    let mut right = store::get_right(env, offer.right_id)?;
    auth::authorize_transfer(
        env,
        &mut right,
        &seller,
        &offer.buyer,
        TransferMode::Sale,
        &terms.next_secret_hash,
        &proof,
        &signals,
    )?;
    store::put_right(env, &right);
    payment::pull(env, &offer.buyer, &seller, offer.price)?;
    settle_offer(env, &offer);

    Transferred {
        from: seller.clone(),
        to: offer.buyer.clone(),
        right_id: right.id,
        expires_at: None,
        commitment: right.commitment.clone(),
    }
    .publish(env);
    SaleSettled {
        seller,
        buyer: offer.buyer,
        right_id: right.id,
        offer_id,
        price: offer.price,
        commitment: right.commitment,
    }
    .publish(env);
    Ok(())
}

pub fn accept_rental(
    env: &Env,
    owner: Address,
    offer_id: u64,
    price: i128,
    proof: Proof,
    signals: Vec<U256>,
) -> Result<u64, Error> {
    owner.require_auth();
    let offer = live_offer(env, offer_id)?;
    let OfferTerms::Rental(terms) = &offer.terms else {
        return Err(Error::WrongOfferKind);
    };
    if price != offer.price {
        return Err(Error::PriceMismatch);
    }

    let mut right = store::get_right(env, offer.right_id)?;
    // Check-in may not have passed between offer and acceptance.
    check_rental_terms(env, &right, terms)?;
    auth::authorize_transfer(
        env,
        &mut right,
        &owner,
        &offer.buyer,
        TransferMode::Rental {
            expires_at: terms.expires_at,
        },
        &U256::from_u32(env, 0),
        &proof,
        &signals,
    )?;
    store::put_right(env, &right);
    let this = env.current_contract_address();
    payment::pull(env, &offer.buyer, &this, offer.price)?;
    let escrow_id = escrow::open(env, &offer, &owner, terms);
    settle_offer(env, &offer);

    Transferred {
        from: owner.clone(),
        to: offer.buyer.clone(),
        right_id: right.id,
        expires_at: Some(terms.expires_at),
        commitment: right.commitment,
    }
    .publish(env);
    EscrowFunded {
        owner,
        renter: offer.buyer.clone(),
        right_id: right.id,
        offer_id,
        escrow_id,
        amount: offer.price,
        check_in: terms.check_in,
        expires_at: terms.expires_at,
    }
    .publish(env);
    Ok(escrow_id)
}
