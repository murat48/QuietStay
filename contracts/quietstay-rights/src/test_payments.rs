#![cfg(test)]
//! Phase 3 Step 3: USDC sale, rental escrow and the pilot arbiter
//! (docs/PHASE3_SPEC.md §4, §5, §9, §10; docs/PHASE3_PROMPT.md Step 3).
//!
//! As in `test.rs`, every transfer carries a real Groth16 proof from
//! `tests/fixtures/`. USDC is a real Stellar Asset Contract in the test
//! ledger, and the fixtures' `G…` accounts get real account and trustline
//! entries, so the token enforces allowances, balances and trustlines exactly
//! as on chain.
//!
//! "Nothing moves" is checked with [`Snap`]: every USDC balance, every right,
//! every escrow and the contract's own balance, before and after.

extern crate std;

use std::rc::Rc;

use soroban_sdk::{
    testutils::{
        storage::{Persistent as _, Temporary as _},
        Address as _, Ledger as _, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec, xdr, Address, BytesN, ConversionError, Env, IntoVal, InvokeError, Val, Vec, U256,
};

use crate::error::Error;
use crate::test::*;
use crate::types::{DataKey, Escrow, EscrowState, OfferTerms, Outcome, Right, MAX_OFFER_LEDGERS};

const USDC: i128 = 10_000_000;
const CHECK_IN: u64 = WEEK_START;
/// Offers and requests in these tests stay open this many ledgers.
const OPEN_FOR: u32 = 2_000;

type Try<T, C = ConversionError> = Result<Result<T, C>, Result<Error, InvokeError>>;

/// A contract error, or a panic for anything else (a host failure).
fn res<T, C: core::fmt::Debug>(r: Try<T, C>) -> Result<T, Error> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Err(Ok(e)) => Err(e),
        Ok(Err(e)) => panic!("conversion error: {e:?}"),
        Err(Err(e)) => panic!("host failure: {e:?}"),
    }
}

/// The call failed in the host, not with a contract error: here, always a
/// missing authorization.
fn host_refused<T, C>(r: Try<T, C>) -> bool {
    matches!(r, Err(Err(_)))
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Give a `G…` account an account entry (if missing) and an authorized
/// trustline for `asset`, as a real classic account would need.
fn trust(env: &Env, asset: &xdr::Asset, who: &Address) {
    let account_id: xdr::AccountId = who.try_into().unwrap();
    let account_key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
        account_id: account_id.clone(),
    }));
    if env.host().get_ledger_entry(&account_key).unwrap().is_none() {
        let entry = xdr::LedgerEntry {
            last_modified_ledger_seq: 0,
            data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
                account_id: account_id.clone(),
                balance: 1_000_000_000,
                seq_num: xdr::SequenceNumber(0),
                num_sub_entries: 2,
                inflation_dest: None,
                flags: 0,
                home_domain: xdr::String32::default(),
                thresholds: xdr::Thresholds([1, 0, 0, 0]),
                signers: xdr::VecM::default(),
                ext: xdr::AccountEntryExt::V0,
            }),
            ext: xdr::LedgerEntryExt::V0,
        };
        env.host()
            .add_ledger_entry(&account_key, &Rc::new(entry), None)
            .unwrap();
    }
    let tl_asset = match asset {
        xdr::Asset::CreditAlphanum4(a) => xdr::TrustLineAsset::CreditAlphanum4(a.clone()),
        xdr::Asset::CreditAlphanum12(a) => xdr::TrustLineAsset::CreditAlphanum12(a.clone()),
        xdr::Asset::Native => panic!("native needs no trustline"),
    };
    let key = Rc::new(xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
        account_id: account_id.clone(),
        asset: tl_asset.clone(),
    }));
    let entry = xdr::LedgerEntry {
        last_modified_ledger_seq: 0,
        data: xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
            account_id,
            asset: tl_asset,
            balance: 0,
            limit: i64::MAX,
            flags: 1, // AUTHORIZED_FLAG
            ext: xdr::TrustLineEntryExt::V0,
        }),
        ext: xdr::LedgerEntryExt::V0,
    };
    env.host()
        .add_ledger_entry(&key, &Rc::new(entry), None)
        .unwrap();
}

/// Everything that could move: USDC balances, rights and escrows.
#[derive(Debug, PartialEq)]
struct Snap {
    usdc: std::vec::Vec<i128>,
    rights: std::vec::Vec<Option<Right>>,
    escrows: std::vec::Vec<Escrow>,
}

struct P {
    f: Fixture<'static>,
    token: TokenClient<'static>,
    /// An account the builder does not control.
    outsider: Address,
}

/// Rights 1–3 issued to the owner, each with the owner's commitment (the
/// fixtures prove rights 1, 2 and 3 against it). Buyer and renter hold 100
/// USDC each. Trustlines for every fixture account.
fn pay_setup() -> P {
    pay_setup_on(setup())
}

/// `pay_setup` on a given fixture (Step 5: the WASM fixture, with a network's
/// TTL rules applied first).
fn pay_setup_on(f: Fixture<'static>) -> P {
    f.env.mock_all_auths();
    for who in [&f.owner, &f.renter, &f.buyer, &f.stranger] {
        trust(&f.env, &f.usdc_asset, who);
    }
    let admin = StellarAssetClient::new(&f.env, &f.usdc);
    admin.mint(&f.buyer, &(100 * USDC));
    admin.mint(&f.renter, &(100 * USDC));
    let (period, validity) = week();
    for _ in 0..3 {
        f.client
            .issue(&f.owner, &period, &validity, &owner_commitment(&f.env));
    }
    let token = TokenClient::new(&f.env, &f.usdc);
    let outsider = Address::generate(&f.env);
    P { f, token, outsider }
}

impl P {
    fn env(&self) -> &Env {
        &self.f.env
    }

    fn bal(&self, who: &Address) -> i128 {
        self.token.balance(who)
    }

    fn allowance(&self, who: &Address) -> i128 {
        self.token.allowance(who, &self.f.contract_id)
    }

    fn now(&self) -> u32 {
        self.env().ledger().sequence()
    }

    fn at_time(&self, t: u64) {
        self.env().ledger().set_timestamp(t);
    }

    fn snap(&self) -> Snap {
        let f = &self.f;
        let accounts = [
            &f.owner,
            &f.renter,
            &f.buyer,
            &f.stranger,
            &self.outsider,
            &f.arbiter,
            &f.issuer,
            &f.contract_id,
        ];
        Snap {
            usdc: accounts.iter().map(|a| self.bal(a)).collect(),
            rights: (1..f.client.next_id())
                .map(|id| f.client.try_get_right(&id).ok().and_then(|r| r.ok()))
                .collect(),
            escrows: (1..f.client.next_escrow_id())
                .map(|id| f.client.get_escrow(&id))
                .collect(),
        }
    }

    /// The sum of Funded and Disputed escrows.
    fn escrowed(&self) -> i128 {
        (1..self.f.client.next_escrow_id())
            .map(|id| self.f.client.get_escrow(&id))
            .filter(|e| matches!(e.state, EscrowState::Funded | EscrowState::Disputed))
            .map(|e| e.amount)
            .sum()
    }

    /// The Step 3 invariant: the contract's USDC balance equals the sum of
    /// Funded and Disputed escrows.
    fn assert_invariant(&self) {
        assert_eq!(
            self.bal(&self.f.contract_id),
            self.escrowed(),
            "USDC invariant"
        );
    }

    /// D12: the allowance equals the sum of the buyer's live open offers.
    fn assert_allowance_matches(&self, buyer: &Address) {
        let f = &self.f;
        let now = self.now();
        let ids: Vec<u64> = f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .persistent()
                .get(&DataKey::BuyerOffers(buyer.clone()))
                .unwrap_or(Vec::new(&f.env))
        });
        let sum: i128 = ids
            .iter()
            .filter_map(|id| f.client.get_offer(&id))
            .filter(|o| o.expires_ledger >= now)
            .map(|o| o.price)
            .sum();
        assert_eq!(self.allowance(buyer), sum, "allowance = sum of live offers");
    }

    fn request(&self, who: &Address, right_id: u64) -> u64 {
        self.env().mock_all_auths();
        self.f.client.request_record(
            who,
            &right_id,
            &hash(self.env(), 7),
            &(self.now() + OPEN_FOR),
        )
    }

    /// The buyer's `h'`, as the sale fixtures prove it.
    fn buyer_h(&self) -> U256 {
        tx(self.env(), "sale").next_secret_hash
    }

    fn sale_offer(&self, who: &Address, right_id: u64, price: i128) -> u64 {
        let request = self.request(who, right_id);
        self.f.client.create_sale_offer(
            who,
            &request,
            &price,
            &self.buyer_h(),
            &(self.now() + OPEN_FOR),
        )
    }

    fn try_rental_offer(
        &self,
        who: &Address,
        right_id: u64,
        price: i128,
        expires_at: u64,
        check_in: u64,
    ) -> Result<u64, Error> {
        self.env().mock_all_auths();
        res(self.f.client.try_create_rental_offer(
            who,
            &right_id,
            &price,
            &expires_at,
            &check_in,
            &(self.now() + OPEN_FOR),
        ))
    }

    /// A rental matching the fixtures: until WEEK_END, checking in at
    /// WEEK_START.
    fn rental_offer(&self, who: &Address, right_id: u64, price: i128) -> u64 {
        self.try_rental_offer(who, right_id, price, WEEK_END, CHECK_IN)
            .unwrap()
    }

    fn accept_sale(&self, seller: &Address, offer: u64, price: i128, t: &str) -> Result<(), Error> {
        self.env().mock_all_auths();
        let t = tx(self.env(), t);
        res(self
            .f
            .client
            .try_accept_sale(seller, &offer, &price, &t.proof, &t.signals))
    }

    fn accept_rental(
        &self,
        owner: &Address,
        offer: u64,
        price: i128,
        t: &str,
    ) -> Result<u64, Error> {
        self.env().mock_all_auths();
        let t = tx(self.env(), t);
        res(self
            .f
            .client
            .try_accept_rental(owner, &offer, &price, &t.proof, &t.signals))
    }

    /// The renter's 3 USDC rental of right 1, accepted by the owner: escrow 1.
    fn funded(&self) -> u64 {
        let f = &self.f;
        let offer = self.rental_offer(&f.renter, 1, 3 * USDC);
        self.accept_rental(&f.owner, offer, 3 * USDC, "rental")
            .unwrap()
    }

    /// Escrow 1, Disputed by the renter with report hash 0x11….
    fn disputed(&self) -> u64 {
        let id = self.funded();
        self.env().mock_all_auths();
        self.f
            .client
            .report_problem(&self.f.renter, &id, &hash(self.env(), 0x11));
        id
    }

    fn state(&self, id: u64) -> EscrowState {
        self.f.client.get_escrow(&id).state
    }

    /// Only `who` signs, for exactly this call.
    fn only_signs(&self, who: &Address, fn_name: &'static str, args: Vec<Val>) {
        self.env().mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.f.contract_id,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }
}

// -------------------------------------------------------------------------
// construction
// -------------------------------------------------------------------------

#[test]
fn the_constructor_fixes_arbiter_usdc_and_payment_cap() {
    let p = pay_setup();
    let f = &p.f;
    assert_eq!(f.client.arbiter(), f.arbiter);
    assert_eq!(f.client.usdc(), f.usdc);
    assert_eq!(f.client.max_payment(), TEST_MAX_PAYMENT);
}

#[test]
#[should_panic]
fn a_zero_payment_cap_cannot_be_deployed() {
    let env = Env::default();
    let (issuer, arbiter, usdc) = (
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    );
    env.register(
        crate::QuietStayRights,
        constructor_args(&env, &issuer, &arbiter, &usdc, vk(&env), 0),
    );
}

#[test]
#[should_panic]
fn the_arbiter_cannot_be_the_issuer() {
    let env = Env::default();
    let (issuer, usdc) = (Address::generate(&env), Address::generate(&env));
    env.register(
        crate::QuietStayRights,
        constructor_args(&env, &issuer, &issuer, &usdc, vk(&env), TEST_MAX_PAYMENT),
    );
}

// -------------------------------------------------------------------------
// sale
// -------------------------------------------------------------------------

#[test]
fn a_one_step_sale_moves_the_right_and_the_usdc_together() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    // The USDC stays with the buyer; the contract holds an allowance.
    assert_eq!(p.bal(&f.buyer), 100 * USDC);
    assert_eq!(p.allowance(&f.buyer), 5 * USDC);

    p.accept_sale(&f.owner, offer, 5 * USDC, "sale").unwrap();

    assert_eq!(f.client.holder(&1), f.buyer);
    assert_eq!(f.client.commitment(&1), buyer_commitment(&f.env));
    assert_eq!(f.client.balance(&f.buyer), 1);
    assert_eq!(p.bal(&f.buyer), 95 * USDC);
    assert_eq!(p.bal(&f.owner), 5 * USDC);
    // Paid seller to buyer directly: the contract never held it.
    assert_eq!(p.bal(&f.contract_id), 0);
    assert_eq!(p.allowance(&f.buyer), 0);
    assert!(f.client.get_offer(&offer).is_none());
    p.assert_allowance_matches(&f.buyer);
    // An accepted offer cannot be accepted again.
    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::OfferNotFound)
    );
}

#[test]
fn a_smart_wallet_sells_through_a_sale_offer() {
    let f = setup();
    f.env.mock_all_auths();
    trust(&f.env, &f.usdc_asset, &f.buyer);
    StellarAssetClient::new(&f.env, &f.usdc).mint(&f.buyer, &(10 * USDC));
    let holder = wallet(&f.env, "holder");
    let (period, validity) = week();
    f.client
        .issue(&holder, &period, &validity, &wallet_commitment(&f.env));
    let token = TokenClient::new(&f.env, &f.usdc);
    let p = P {
        f,
        token,
        outsider: Address::generate(&Env::default()),
    };
    let f = &p.f;

    let offer = p.sale_offer(&f.buyer, 1, 2 * USDC);
    p.accept_sale(&holder, offer, 2 * USDC, "wallet_sale")
        .unwrap();
    assert_eq!(f.client.holder(&1), f.buyer);
    // A C… address needs no trustline.
    assert_eq!(p.bal(&holder), 2 * USDC);
}

#[test]
fn an_unaccepted_offer_moves_nothing() {
    let p = pay_setup();
    let f = &p.f;
    let before = p.snap();
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    let rental = p.rental_offer(&f.renter, 2, 3 * USDC);
    assert_eq!(p.snap(), before);

    // Through the offers' whole life and past it, nothing moves.
    f.at_ledger(BASE_LEDGER + OPEN_FOR);
    assert_eq!(p.snap(), before);
    f.at_ledger(BASE_LEDGER + OPEN_FOR + 1);
    assert_eq!(p.snap(), before);
    // Expired, they can no longer be accepted.
    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::OfferExpired)
    );
    assert_eq!(
        p.accept_rental(&f.owner, rental, 3 * USDC, "rental_r2"),
        Err(Error::OfferExpired)
    );
    assert_eq!(p.snap(), before);
}

#[test]
fn an_expired_offer_cannot_be_accepted_and_its_allowance_cannot_be_pulled() {
    let p = pay_setup();
    let f = &p.f;
    let request = p.request(&f.buyer, 1);
    let offer = f.client.create_sale_offer(
        &f.buyer,
        &request,
        &(5 * USDC),
        &p.buyer_h(),
        &(BASE_LEDGER + 300),
    );
    let before = p.snap();

    // The proof is still valid at 1301; the offer is not.
    f.at_ledger(BASE_LEDGER + 301);
    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::OfferExpired)
    );
    assert_eq!(p.snap(), before);
    // The allowance expired with the buyer's last live offer: nothing is left
    // over to pull.
    assert_eq!(p.allowance(&f.buyer), 0);
    // The buyer's next offer call sets it to the live offers again.
    p.rental_offer(&f.buyer, 2, USDC);
    assert_eq!(p.allowance(&f.buyer), USDC);
    p.assert_allowance_matches(&f.buyer);
}

#[test]
fn a_low_balance_moves_nothing_and_leaves_the_proof_unspent() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    p.token.transfer(&f.buyer, &f.stranger, &(96 * USDC)); // 4 USDC left
    let before = p.snap();

    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::BalanceTooLow)
    );
    assert_eq!(p.snap(), before);

    // Nothing was consumed: the same proof settles once the balance is back.
    p.token.transfer(&f.stranger, &f.buyer, &USDC);
    p.accept_sale(&f.owner, offer, 5 * USDC, "sale").unwrap();
    assert_eq!(f.client.holder(&1), f.buyer);
}

#[test]
fn a_low_allowance_moves_nothing() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    // The buyer lowers the allowance directly with the USDC contract.
    p.token
        .approve(&f.buyer, &f.contract_id, &(4 * USDC), &(p.now() + 100));
    let before = p.snap();

    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::AllowanceTooLow)
    );
    assert_eq!(p.snap(), before);
}

#[test]
fn only_the_constructors_usdc_can_be_moved() {
    let p = pay_setup();
    let f = &p.f;
    // A second asset, which the buyer holds and approves to the contract.
    let fake = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env));
    trust(&f.env, &fake.asset(), &f.buyer);
    trust(&f.env, &fake.asset(), &f.owner);
    StellarAssetClient::new(&f.env, &fake.address()).mint(&f.buyer, &(100 * USDC));
    let fake_token = TokenClient::new(&f.env, &fake.address());
    fake_token.approve(&f.buyer, &f.contract_id, &(100 * USDC), &(p.now() + 1000));

    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    // The buyer has no USDC left, only the other token.
    p.token.transfer(&f.buyer, &f.stranger, &(100 * USDC));
    let before = p.snap();

    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::BalanceTooLow)
    );
    assert_eq!(p.snap(), before);
    assert_eq!(fake_token.balance(&f.buyer), 100 * USDC);
    assert_eq!(fake_token.balance(&f.owner), 0);
    // No function takes a token address; the only one is fixed.
    assert_eq!(f.client.usdc(), f.usdc);
}

#[test]
fn a_seller_must_accept_exactly_the_offered_amount() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    let before = p.snap();
    for wrong in [5 * USDC - 1, 5 * USDC + 1, 0, -1] {
        assert_eq!(
            p.accept_sale(&f.owner, offer, wrong, "sale"),
            Err(Error::PriceMismatch)
        );
    }
    assert_eq!(p.snap(), before);
}

#[test]
fn offer_prices_must_be_positive_and_within_the_cap() {
    let p = pay_setup();
    let f = &p.f;
    for bad in [0, -USDC, TEST_MAX_PAYMENT + 1] {
        let request = p.request(&f.buyer, 1);
        assert_eq!(
            res(f.client.try_create_sale_offer(
                &f.buyer,
                &request,
                &bad,
                &p.buyer_h(),
                &(p.now() + OPEN_FOR)
            )),
            Err(Error::InvalidPrice)
        );
        assert_eq!(
            p.try_rental_offer(&f.renter, 1, bad, WEEK_END, CHECK_IN),
            Err(Error::InvalidPrice)
        );
    }
    // The cap itself is allowed.
    p.rental_offer(&f.renter, 1, TEST_MAX_PAYMENT);
}

#[test]
fn a_sale_offer_needs_a_nonzero_canonical_next_secret_hash() {
    let p = pay_setup();
    let f = &p.f;
    let r = U256::from_be_bytes(
        &f.env,
        &soroban_sdk::Bytes::from_array(
            &f.env,
            &[
                0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48, 0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1,
                0xd8, 0x05, 0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0xff, 0xff, 0xff,
                0x00, 0x00, 0x00, 0x01,
            ],
        ),
    );
    for bad in [U256::from_u32(&f.env, 0), r] {
        let request = p.request(&f.buyer, 1);
        assert_eq!(
            res(f.client.try_create_sale_offer(
                &f.buyer,
                &request,
                &USDC,
                &bad,
                &(p.now() + OPEN_FOR)
            )),
            Err(Error::InvalidNextSecretHash)
        );
    }
}

#[test]
fn offer_expiry_must_be_in_the_future_and_within_seven_days() {
    let p = pay_setup();
    let f = &p.f;
    let now = p.now();
    for bad in [now, now - 1, now + MAX_OFFER_LEDGERS + 1] {
        let request = p.request(&f.buyer, 1);
        assert_eq!(
            res(f
                .client
                .try_create_sale_offer(&f.buyer, &request, &USDC, &p.buyer_h(), &bad)),
            Err(Error::InvalidOfferExpiry)
        );
        assert_eq!(
            res(f
                .client
                .try_create_rental_offer(&f.renter, &1, &USDC, &WEEK_END, &CHECK_IN, &bad)),
            Err(Error::InvalidOfferExpiry)
        );
        assert_eq!(
            res(f
                .client
                .try_request_record(&f.buyer, &1, &hash(&f.env, 7), &bad)),
            Err(Error::InvalidOfferExpiry)
        );
    }
    let request = p.request(&f.buyer, 1);
    f.client.create_sale_offer(
        &f.buyer,
        &request,
        &USDC,
        &p.buyer_h(),
        &(now + MAX_OFFER_LEDGERS),
    );
}

#[test]
fn a_sale_offer_cannot_be_accepted_as_a_rental_or_the_other_way_round() {
    let p = pay_setup();
    let f = &p.f;
    let sale = p.sale_offer(&f.buyer, 1, USDC);
    let rental = p.rental_offer(&f.renter, 1, USDC);
    assert_eq!(
        p.accept_rental(&f.owner, sale, USDC, "rental"),
        Err(Error::WrongOfferKind)
    );
    assert_eq!(
        p.accept_sale(&f.owner, rental, USDC, "sale"),
        Err(Error::WrongOfferKind)
    );
}

#[test]
fn a_seller_cannot_plant_a_different_next_secret_hash() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, USDC);
    let before = p.snap();
    // The proof carries an h' the seller chose; the offer fixes the buyer's.
    assert_eq!(
        p.accept_sale(&f.owner, offer, USDC, "sale_planted"),
        Err(Error::NextSecretHashMismatch)
    );
    assert_eq!(p.snap(), before);
}

#[test]
fn a_buyer_cancels_an_offer_and_only_the_buyer_can() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    assert_eq!(
        res(f.client.try_cancel_offer(&f.stranger, &offer)),
        Err(Error::NotRequester)
    );
    f.client.cancel_offer(&f.buyer, &offer);
    assert!(f.client.get_offer(&offer).is_none());
    assert_eq!(p.allowance(&f.buyer), 0);
    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::OfferNotFound)
    );
    assert_eq!(
        res(f.client.try_cancel_offer(&f.buyer, &offer)),
        Err(Error::OfferNotFound)
    );
}

#[test]
fn a_buyer_has_at_most_ten_live_offers() {
    let p = pay_setup();
    let f = &p.f;
    for _ in 0..10 {
        p.rental_offer(&f.buyer, 1, USDC);
    }
    assert_eq!(
        p.try_rental_offer(&f.buyer, 1, USDC, WEEK_END, CHECK_IN),
        Err(Error::TooManyOffers)
    );
    // An expired offer frees its slot.
    f.at_ledger(BASE_LEDGER + OPEN_FOR + 1);
    p.rental_offer(&f.buyer, 1, USDC);
    assert_eq!(p.allowance(&f.buyer), USDC);
}

// -------------------------------------------------------------------------
// record requests (D4/D4a)
// -------------------------------------------------------------------------

#[test]
fn a_sale_offer_consumes_the_buyers_own_live_record_request() {
    let p = pay_setup();
    let f = &p.f;
    let request = p.request(&f.buyer, 1);
    let stored = f.client.get_record_request(&request).unwrap();
    assert_eq!(stored.key_hash, hash(&f.env, 7));
    assert_eq!(stored.right_id, 1);

    // Someone else's request cannot be used.
    assert_eq!(
        res(f.client.try_create_sale_offer(
            &f.stranger,
            &request,
            &USDC,
            &p.buyer_h(),
            &(p.now() + OPEN_FOR)
        )),
        Err(Error::NotRequester)
    );
    let offer = f.client.create_sale_offer(
        &f.buyer,
        &request,
        &USDC,
        &p.buyer_h(),
        &(p.now() + OPEN_FOR),
    );
    // The offer copies the key hash; the request is gone.
    let OfferTerms::Sale(terms) = f.client.get_offer(&offer).unwrap().terms else {
        panic!("a sale offer");
    };
    assert_eq!(terms.key_hash, hash(&f.env, 7));
    assert!(f.client.get_record_request(&request).is_none());
    assert_eq!(
        res(f.client.try_create_sale_offer(
            &f.buyer,
            &request,
            &USDC,
            &p.buyer_h(),
            &(p.now() + OPEN_FOR)
        )),
        Err(Error::RequestNotFound)
    );
}

#[test]
fn an_expired_or_cancelled_record_request_cannot_be_used() {
    let p = pay_setup();
    let f = &p.f;
    let request = f
        .client
        .request_record(&f.buyer, &1, &hash(&f.env, 7), &(p.now() + 10));
    f.at_ledger(p.now() + 11);
    assert_eq!(
        res(f.client.try_create_sale_offer(
            &f.buyer,
            &request,
            &USDC,
            &p.buyer_h(),
            &(p.now() + OPEN_FOR)
        )),
        Err(Error::RequestExpired)
    );

    let request = p.request(&f.buyer, 1);
    assert_eq!(
        res(f.client.try_cancel_record_request(&f.stranger, &request)),
        Err(Error::NotRequester)
    );
    f.client.cancel_record_request(&f.buyer, &request);
    assert!(f.client.get_record_request(&request).is_none());
}

#[test]
fn record_requests_are_checked_and_capped_at_ten() {
    let p = pay_setup();
    let f = &p.f;
    assert_eq!(
        res(f
            .client
            .try_request_record(&f.buyer, &99, &hash(&f.env, 7), &(p.now() + 10))),
        Err(Error::RightNotFound)
    );
    assert_eq!(
        res(f
            .client
            .try_request_record(&f.buyer, &1, &hash(&f.env, 0), &(p.now() + 10))),
        Err(Error::InvalidKeyHash)
    );
    for _ in 0..10 {
        p.request(&f.buyer, 1);
    }
    assert_eq!(
        res(f
            .client
            .try_request_record(&f.buyer, &1, &hash(&f.env, 7), &(p.now() + 10))),
        Err(Error::TooManyRequests)
    );
    // Another requester is not affected.
    p.request(&f.stranger, 1);
}

#[test]
fn a_record_request_obliges_the_holder_to_nothing() {
    let p = pay_setup();
    let f = &p.f;
    let before = p.snap();
    p.request(&f.buyer, 1);
    p.request(&f.stranger, 1);
    // A request moves nothing and sets no allowance.
    assert_eq!(p.snap(), before);
    assert_eq!(p.allowance(&f.buyer), 0);
    // The holder can still list, sell to someone else and burn.
    f.client.list(&f.owner, &1, &None);
    f.client.unlist(&f.owner, &1);
    f.client.burn(&f.owner, &2);
    let offer = p.sale_offer(&f.buyer, 1, USDC);
    p.accept_sale(&f.owner, offer, USDC, "sale").unwrap();
}

// -------------------------------------------------------------------------
// rental and escrow
// -------------------------------------------------------------------------

#[test]
fn accepting_a_rental_grants_the_right_and_funds_the_escrow_in_one_transaction() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.rental_offer(&f.renter, 1, 3 * USDC);
    assert_eq!(p.bal(&f.contract_id), 0);

    let id = p
        .accept_rental(&f.owner, offer, 3 * USDC, "rental")
        .unwrap();

    assert_eq!(id, 1);
    let holding = f.client.holding(&1);
    assert_eq!(holding.holder, f.renter);
    assert_eq!(holding.expires_at, Some(WEEK_END));
    // Title and the commitment stay with the owner.
    assert_eq!(f.client.balance(&f.owner), 3);
    assert_eq!(f.client.commitment(&1), owner_commitment(&f.env));
    assert_eq!(p.bal(&f.renter), 97 * USDC);
    assert_eq!(p.bal(&f.contract_id), 3 * USDC);
    assert_eq!(p.bal(&f.owner), 0);
    let e = f.client.get_escrow(&id);
    assert_eq!(e.state, EscrowState::Funded);
    assert_eq!((e.owner, e.renter), (f.owner.clone(), f.renter.clone()));
    assert_eq!(
        (e.amount, e.check_in, e.expires_at),
        (3 * USDC, CHECK_IN, WEEK_END)
    );
    assert_eq!((e.right_id, e.offer_id), (1, offer));
    assert!(f.client.get_offer(&offer).is_none());
    p.assert_invariant();
}

#[test]
fn a_failed_rental_acceptance_neither_grants_nor_funds() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.rental_offer(&f.renter, 1, 3 * USDC);
    p.token.transfer(&f.renter, &f.stranger, &(98 * USDC)); // 2 USDC left
    let before = p.snap();
    assert_eq!(
        p.accept_rental(&f.owner, offer, 3 * USDC, "rental"),
        Err(Error::BalanceTooLow)
    );
    assert_eq!(p.snap(), before);
    assert_eq!(f.client.holder(&1), f.owner);
    assert_eq!(f.client.next_escrow_id(), 1);
}

#[test]
fn check_in_must_be_in_the_future_inside_the_week_and_a_night_before_the_end() {
    let p = pay_setup();
    let f = &p.f;
    let now = f.env.ledger().timestamp();
    let cases = [
        (WEEK_END, now - 1),                // in the past
        (WEEK_END, WEEK_START - 1),         // before the week
        (WEEK_END + DAY, WEEK_END),         // at the week's end
        (WEEK_START + DAY - 1, WEEK_START), // less than a night before the end
    ];
    for (expires_at, check_in) in cases {
        assert_eq!(
            p.try_rental_offer(&f.renter, 1, USDC, expires_at, check_in),
            Err(Error::InvalidCheckIn),
            "check-in {check_in}"
        );
    }
    assert_eq!(
        p.try_rental_offer(&f.renter, 1, USDC, YEAR_END + 1, CHECK_IN),
        Err(Error::ExpiryBeyondValidity)
    );
    // Exactly one night is enough.
    p.try_rental_offer(&f.renter, 1, USDC, WEEK_START + DAY, WEEK_START)
        .unwrap();
}

#[test]
fn a_rental_cannot_be_accepted_after_check_in() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.rental_offer(&f.renter, 1, 3 * USDC);
    p.at_time(CHECK_IN + 1);
    assert_eq!(
        p.accept_rental(&f.owner, offer, 3 * USDC, "rental"),
        Err(Error::InvalidCheckIn)
    );
}

#[test]
fn the_owner_collects_only_from_check_in_plus_24_hours() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();

    p.at_time(CHECK_IN + DAY - 1);
    assert_eq!(
        res(f.client.try_collect(&f.owner, &id)),
        Err(Error::TooEarlyToCollect)
    );
    assert_eq!(p.state(id), EscrowState::Funded);

    p.at_time(CHECK_IN + DAY);
    f.client.collect(&f.owner, &id);
    assert_eq!(p.state(id), EscrowState::PaidOut);
    assert_eq!(p.bal(&f.owner), 3 * USDC);
    assert_eq!(p.bal(&f.contract_id), 0);
    p.assert_invariant();
}

#[test]
fn the_renter_can_confirm_early() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    // Before check-in even.
    f.client.confirm(&f.renter, &id);
    assert_eq!(p.state(id), EscrowState::PaidOut);
    assert_eq!(p.bal(&f.owner), 3 * USDC);
    // Only the renter confirms.
    let id2 = {
        let o = p.rental_offer(&f.renter, 2, USDC);
        p.accept_rental(&f.owner, o, USDC, "rental_r2").unwrap()
    };
    assert_eq!(
        res(f.client.try_confirm(&f.owner, &id2)),
        Err(Error::NotEscrowParty)
    );
}

#[test]
fn a_problem_can_be_reported_until_check_in_plus_24_hours() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    p.at_time(CHECK_IN + DAY - 1);
    f.client.report_problem(&f.renter, &id, &hash(&f.env, 0x11));
    let e = f.client.get_escrow(&id);
    assert_eq!(e.state, EscrowState::Disputed);
    assert_eq!(e.report_hash, Some(hash(&f.env, 0x11)));
    // Not twice.
    assert_eq!(
        res(f
            .client
            .try_report_problem(&f.renter, &id, &hash(&f.env, 0x12))),
        Err(Error::EscrowNotInState)
    );
}

#[test]
fn a_problem_report_after_the_window_is_rejected() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    p.at_time(CHECK_IN + DAY);
    assert_eq!(
        res(f
            .client
            .try_report_problem(&f.renter, &id, &hash(&f.env, 0x11))),
        Err(Error::ReportWindowClosed)
    );
    assert_eq!(p.state(id), EscrowState::Funded);
    // At that same moment the owner can collect: the windows meet exactly.
    f.client.collect(&f.owner, &id);
}

#[test]
fn only_the_renter_reports_a_problem() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    for who in [&f.owner, &f.stranger, &f.arbiter] {
        assert_eq!(
            res(f.client.try_report_problem(who, &id, &hash(&f.env, 0x11))),
            Err(Error::NotEscrowParty)
        );
    }
}

#[test]
fn collect_is_rejected_during_a_dispute() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    p.at_time(CHECK_IN + 2 * DAY);
    assert_eq!(
        res(f.client.try_collect(&f.owner, &id)),
        Err(Error::EscrowNotInState)
    );
    assert_eq!(p.bal(&f.contract_id), 3 * USDC);
}

#[test]
fn in_a_dispute_the_renter_can_still_pay_out() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    f.client.confirm(&f.renter, &id);
    assert_eq!(p.state(id), EscrowState::PaidOut);
    assert_eq!(p.bal(&f.owner), 3 * USDC);
}

#[test]
fn in_a_dispute_the_owner_can_refund_and_only_in_a_dispute() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    assert_eq!(
        res(f.client.try_refund(&f.owner, &id)),
        Err(Error::EscrowNotInState)
    );
    f.client.report_problem(&f.renter, &id, &hash(&f.env, 0x11));
    assert_eq!(
        res(f.client.try_refund(&f.renter, &id)),
        Err(Error::NotEscrowParty)
    );
    f.client.refund(&f.owner, &id);
    assert_eq!(p.state(id), EscrowState::Refunded);
    assert_eq!(p.bal(&f.renter), 100 * USDC);
    assert_eq!(p.bal(&f.contract_id), 0);
}

#[test]
fn double_payout_double_refund_and_refund_after_payout_are_rejected() {
    // Double payout.
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    p.at_time(CHECK_IN + DAY);
    f.client.collect(&f.owner, &id);
    let after = p.snap();
    assert_eq!(
        res(f.client.try_collect(&f.owner, &id)),
        Err(Error::EscrowNotInState)
    );
    assert_eq!(
        res(f.client.try_confirm(&f.renter, &id)),
        Err(Error::EscrowNotInState)
    );
    // Refund after payout.
    assert_eq!(
        res(f.client.try_refund(&f.owner, &id)),
        Err(Error::EscrowNotInState)
    );
    assert_eq!(
        res(f
            .client
            .try_resolve(&f.arbiter, &id, &Outcome::RefundRenter, &hash(&f.env, 9))),
        Err(Error::EscrowNotInState)
    );
    assert_eq!(p.snap(), after);

    // Double refund.
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    f.client.refund(&f.owner, &id);
    let after = p.snap();
    assert_eq!(
        res(f.client.try_refund(&f.owner, &id)),
        Err(Error::EscrowNotInState)
    );
    assert_eq!(
        res(f
            .client
            .try_resolve(&f.arbiter, &id, &Outcome::RefundRenter, &hash(&f.env, 9))),
        Err(Error::EscrowNotInState)
    );
    // Payout after refund.
    assert_eq!(
        res(f.client.try_confirm(&f.renter, &id)),
        Err(Error::EscrowNotInState)
    );
    p.at_time(CHECK_IN + DAY);
    assert_eq!(
        res(f.client.try_collect(&f.owner, &id)),
        Err(Error::EscrowNotInState)
    );
    assert_eq!(p.snap(), after);
}

// -------------------------------------------------------------------------
// the arbiter
// -------------------------------------------------------------------------

#[test]
fn the_arbiter_resolves_a_dispute_either_way_and_records_the_decision() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    f.client
        .resolve(&f.arbiter, &id, &Outcome::PayOwner, &hash(&f.env, 0xd1));
    let e = f.client.get_escrow(&id);
    assert_eq!(e.state, EscrowState::PaidOut);
    assert_eq!(e.decision_hash, Some(hash(&f.env, 0xd1)));
    assert_eq!(p.bal(&f.owner), 3 * USDC);

    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    f.client
        .resolve(&f.arbiter, &id, &Outcome::RefundRenter, &hash(&f.env, 0xd2));
    assert_eq!(p.state(id), EscrowState::Refunded);
    assert_eq!(p.bal(&f.renter), 100 * USDC);
    p.assert_invariant();
}

#[test]
fn the_arbiter_cannot_act_on_an_undisputed_escrow() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    for outcome in [Outcome::PayOwner, Outcome::RefundRenter] {
        assert_eq!(
            res(f
                .client
                .try_resolve(&f.arbiter, &id, &outcome, &hash(&f.env, 9))),
            Err(Error::EscrowNotInState)
        );
    }
    assert_eq!(p.state(id), EscrowState::Funded);
}

#[test]
fn only_the_arbiter_resolves() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    for who in [&f.issuer, &f.owner, &f.renter, &f.stranger, &p.outsider] {
        assert_eq!(
            res(f
                .client
                .try_resolve(who, &id, &Outcome::RefundRenter, &hash(&f.env, 9))),
            Err(Error::NotArbiter)
        );
    }
    // Naming the arbiter without the arbiter's signature fails too.
    let args: Vec<Val> = vec![
        &f.env,
        f.arbiter.into_val(&f.env),
        id.into_val(&f.env),
        Outcome::RefundRenter.into_val(&f.env),
        hash(&f.env, 9).into_val(&f.env),
    ];
    p.only_signs(&p.outsider, "resolve", args);
    assert!(host_refused(f.client.try_resolve(
        &f.arbiter,
        &id,
        &Outcome::RefundRenter,
        &hash(&f.env, 9)
    )));
    assert_eq!(p.state(id), EscrowState::Disputed);
}

#[test]
fn the_arbiter_cannot_move_a_right() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    let right_before = f.client.get_right(&1);

    // Resolving touches the escrow only. A refunded renter keeps the rental
    // right until it lapses (a stated limitation).
    f.client
        .resolve(&f.arbiter, &id, &Outcome::RefundRenter, &hash(&f.env, 9));
    assert_eq!(f.client.get_right(&1), right_before);
    assert_eq!(f.client.holder(&1), f.renter);

    // With its own signature, as `from`, the arbiter holds nothing.
    let sale = tx(&f.env, "sale_r2");
    f.env.mock_all_auths();
    assert_eq!(
        res(f
            .client
            .try_transfer(&f.arbiter, &f.buyer, &2, &None, &sale.proof, &sale.signals)),
        Err(Error::WrongAccount)
    );
    assert_eq!(
        res(f.client.try_burn(&f.arbiter, &2)),
        Err(Error::NotHolder)
    );
    assert_eq!(
        res(f.client.try_list(&f.arbiter, &2, &None)),
        Err(Error::NotHolder)
    );
    let offer = p.sale_offer(&f.buyer, 2, USDC);
    assert_eq!(
        p.accept_sale(&f.arbiter, offer, USDC, "sale_r2"),
        Err(Error::WrongAccount)
    );

    // Naming the owner, with only the arbiter's signature, fails in the host.
    let r2 = tx(&f.env, "sale_r2");
    p.only_signs(
        &f.arbiter,
        "accept_sale",
        vec![
            &f.env,
            f.owner.into_val(&f.env),
            offer.into_val(&f.env),
            USDC.into_val(&f.env),
            r2.proof.into_val(&f.env),
            r2.signals.into_val(&f.env),
        ],
    );
    assert!(host_refused(f.client.try_accept_sale(
        &f.owner,
        &offer,
        &USDC,
        &r2.proof,
        &r2.signals
    )));
    p.only_signs(
        &f.arbiter,
        "burn",
        vec![&f.env, f.owner.into_val(&f.env), 2u64.into_val(&f.env)],
    );
    assert!(host_refused(f.client.try_burn(&f.owner, &2)));
    assert_eq!(f.client.holder(&2), f.owner);
}

// -------------------------------------------------------------------------
// evidence
// -------------------------------------------------------------------------

#[test]
fn evidence_hashes_are_recorded_and_bounded() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    // Only while Disputed.
    assert_eq!(
        res(f
            .client
            .try_submit_evidence(&f.owner, &id, &hash(&f.env, 0x21))),
        Err(Error::EscrowNotInState)
    );
    f.client.report_problem(&f.renter, &id, &hash(&f.env, 0x11));

    for i in 0..4u8 {
        f.client
            .submit_evidence(&f.owner, &id, &hash(&f.env, 0x21 + i));
        f.client
            .submit_evidence(&f.renter, &id, &hash(&f.env, 0x31 + i));
    }
    for who in [&f.owner, &f.renter] {
        assert_eq!(
            res(f.client.try_submit_evidence(who, &id, &hash(&f.env, 0x40))),
            Err(Error::EvidenceLimit)
        );
    }
    for who in [&f.stranger, &f.arbiter] {
        assert_eq!(
            res(f.client.try_submit_evidence(who, &id, &hash(&f.env, 0x40))),
            Err(Error::NotEscrowParty)
        );
    }
    let e = f.client.get_escrow(&id);
    assert_eq!(e.report_hash, Some(hash(&f.env, 0x11)));
    assert_eq!(
        e.owner_evidence,
        vec![
            &f.env,
            hash(&f.env, 0x21),
            hash(&f.env, 0x22),
            hash(&f.env, 0x23),
            hash(&f.env, 0x24)
        ]
    );
    assert_eq!(e.renter_evidence.len(), 4);
    assert_eq!(e.renter_evidence.get_unchecked(3), hash(&f.env, 0x34));

    f.client
        .resolve(&f.arbiter, &id, &Outcome::PayOwner, &hash(&f.env, 0xd1));
    assert_eq!(
        f.client.get_escrow(&id).decision_hash,
        Some(hash(&f.env, 0xd1))
    );
    // Closed after resolution.
    assert_eq!(
        res(f
            .client
            .try_submit_evidence(&f.renter, &id, &hash(&f.env, 0x41))),
        Err(Error::EscrowNotInState)
    );
}

// -------------------------------------------------------------------------
// burn guards (D11, escrow cases)
// -------------------------------------------------------------------------

#[test]
fn a_right_with_a_funded_escrow_cannot_be_burned_even_after_the_term_lapses() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    // While rented out: the Phase 2 rule (the renter is the effective holder).
    assert_eq!(res(f.client.try_burn(&f.owner, &1)), Err(Error::NotHolder));
    // After the term, the escrow is still Funded.
    p.at_time(WEEK_END);
    assert_eq!(f.client.holder(&1), f.owner);
    assert_eq!(res(f.client.try_burn(&f.owner, &1)), Err(Error::EscrowOpen));
    // PaidOut: burning is possible again.
    f.client.collect(&f.owner, &id);
    f.client.burn(&f.owner, &1);
}

#[test]
fn a_right_with_a_disputed_escrow_cannot_be_burned() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    p.at_time(WEEK_END);
    assert_eq!(res(f.client.try_burn(&f.owner, &1)), Err(Error::EscrowOpen));
    f.client.refund(&f.owner, &id);
    f.client.burn(&f.owner, &1);
}

#[test]
fn after_a_refund_the_right_can_be_burned_once_the_renters_term_lapses() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.disputed();
    f.client.refund(&f.owner, &id);
    assert_eq!(res(f.client.try_burn(&f.owner, &1)), Err(Error::NotHolder));
    p.at_time(WEEK_END);
    f.client.burn(&f.owner, &1);
}

// -------------------------------------------------------------------------
// the USDC invariant
// -------------------------------------------------------------------------

#[test]
fn the_contracts_usdc_always_equals_the_funded_and_disputed_escrows() {
    let p = pay_setup();
    let f = &p.f;
    p.assert_invariant();

    // Three escrows, on rights 1, 2 and 3, and a sale offer that stays open.
    let o1 = p.rental_offer(&f.renter, 1, 3 * USDC);
    let o2 = p.rental_offer(&f.renter, 2, 2 * USDC);
    let o3 = p.rental_offer(&f.buyer, 3, 4 * USDC);
    p.assert_invariant();
    let e1 = p.accept_rental(&f.owner, o1, 3 * USDC, "rental").unwrap();
    p.assert_invariant();
    let e2 = p
        .accept_rental(&f.owner, o2, 2 * USDC, "rental_r2")
        .unwrap();
    p.assert_invariant();
    let e3 = p
        .accept_rental(&f.owner, o3, 4 * USDC, "rental_r3")
        .unwrap();
    p.assert_invariant();
    assert_eq!(p.bal(&f.contract_id), 9 * USDC);

    f.client.report_problem(&f.renter, &e2, &hash(&f.env, 0x11));
    p.assert_invariant();
    f.client.report_problem(&f.buyer, &e3, &hash(&f.env, 0x12));
    p.assert_invariant();
    f.client.submit_evidence(&f.owner, &e2, &hash(&f.env, 0x21));
    p.assert_invariant();
    // A rejected call changes nothing.
    assert!(f.client.try_collect(&f.owner, &e1).is_err());
    p.assert_invariant();
    f.client.confirm(&f.buyer, &e3);
    p.assert_invariant();
    f.client
        .resolve(&f.arbiter, &e2, &Outcome::RefundRenter, &hash(&f.env, 0xd1));
    p.assert_invariant();
    p.at_time(CHECK_IN + DAY);
    f.client.collect(&f.owner, &e1);
    p.assert_invariant();
    assert_eq!(p.bal(&f.contract_id), 0);
    assert_eq!(p.bal(&f.owner), 7 * USDC);
    // Paid 3 + 2, refunded 2.
    assert_eq!(p.bal(&f.renter), 97 * USDC);
}

#[test]
fn usdc_sent_to_the_contract_directly_is_outside_the_invariant_and_cannot_be_pulled() {
    // The invariant holds for every contract call. Anyone can still send USDC
    // to the contract's address with the token itself. No function pays out
    // anything but an escrow's own amount, so such a donation stays put and
    // the balance then exceeds the escrows by exactly that amount.
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    p.token.transfer(&f.renter, &f.contract_id, &USDC);
    assert_eq!(p.bal(&f.contract_id), p.escrowed() + USDC);
    f.client.confirm(&f.renter, &id);
    assert_eq!(p.bal(&f.contract_id), USDC);
    assert_eq!(p.escrowed(), 0);
}

// -------------------------------------------------------------------------
// allowances (D12)
// -------------------------------------------------------------------------

#[test]
fn five_offers_share_one_allowance_through_accept_cancel_and_a_balance_drop() {
    let p = pay_setup();
    let f = &p.f;
    let b = &f.buyer;
    let sale1 = p.sale_offer(b, 1, 2 * USDC);
    let sale2 = p.sale_offer(b, 2, 3 * USDC);
    let rent3 = p.rental_offer(b, 3, USDC);
    let rent1 = p.rental_offer(b, 1, 4 * USDC);
    let rent2 = p.rental_offer(b, 2, 5 * USDC);
    assert_eq!(p.allowance(b), 15 * USDC);
    p.assert_allowance_matches(b);

    // One accepted: exactly its price leaves, and the allowance drops by it.
    p.accept_sale(&f.owner, sale1, 2 * USDC, "sale").unwrap();
    assert_eq!(p.bal(b), 98 * USDC);
    assert_eq!(p.allowance(b), 13 * USDC);
    p.assert_allowance_matches(b);

    // One cancelled.
    f.client.cancel_offer(b, &rent1);
    assert_eq!(p.allowance(b), 9 * USDC);
    p.assert_allowance_matches(b);

    // The buyer's balance drops below the next offer's price.
    p.token.transfer(b, &f.stranger, &(96 * USDC)); // 2 USDC left
    let before = p.snap();
    assert_eq!(
        p.accept_sale(&f.owner, sale2, 3 * USDC, "sale_r2"),
        Err(Error::BalanceTooLow)
    );
    assert_eq!(p.snap(), before);
    // A cheaper offer still completes in full.
    p.accept_rental(&f.owner, rent3, USDC, "rental_r3").unwrap();
    assert_eq!(p.bal(b), USDC);
    assert_eq!(p.bal(&f.contract_id), USDC);
    assert_eq!(p.allowance(b), 8 * USDC);
    p.assert_allowance_matches(b);

    // The remaining offers are intact and complete once funds return.
    p.token.transfer(&f.stranger, b, &(2 * USDC));
    p.accept_sale(&f.owner, sale2, 3 * USDC, "sale_r2").unwrap();
    assert_eq!(f.client.holder(&2), *b);
    assert!(f.client.get_offer(&rent2).is_some());
    assert_eq!(p.allowance(b), 5 * USDC);
}

#[test]
fn an_allowance_that_expires_before_its_offer_moves_nothing() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    // The buyer replaces the allowance with one that expires at ledger 1100,
    // while the offer runs to 3000.
    p.token
        .approve(&f.buyer, &f.contract_id, &(5 * USDC), &(BASE_LEDGER + 100));
    f.at_ledger(BASE_LEDGER + 101);
    let before = p.snap();
    assert_eq!(p.allowance(&f.buyer), 0);
    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::AllowanceTooLow)
    );
    assert_eq!(p.snap(), before);
    assert_eq!(f.client.holder(&1), f.owner);
}

#[test]
fn an_offer_that_outlives_its_allowance_completes_once_an_offer_call_resets_it() {
    let p = pay_setup();
    let f = &p.f;
    let offer = p.sale_offer(&f.buyer, 1, 5 * USDC);
    p.token
        .approve(&f.buyer, &f.contract_id, &(5 * USDC), &(BASE_LEDGER + 50));
    f.at_ledger(BASE_LEDGER + 60);
    // The offer is live; its allowance is not.
    assert!(f.client.get_offer(&offer).is_some());
    let before = p.snap();
    assert_eq!(
        p.accept_sale(&f.owner, offer, 5 * USDC, "sale"),
        Err(Error::AllowanceTooLow)
    );
    assert_eq!(p.snap(), before);

    // The buyer's next offer call sets it to the sum of live offers again.
    p.rental_offer(&f.buyer, 2, USDC);
    assert_eq!(p.allowance(&f.buyer), 6 * USDC);
    p.accept_sale(&f.owner, offer, 5 * USDC, "sale").unwrap();
    assert_eq!(f.client.holder(&1), f.buyer);
    assert_eq!(p.allowance(&f.buyer), USDC);
    p.assert_allowance_matches(&f.buyer);
}

// -------------------------------------------------------------------------
// outside accounts
// -------------------------------------------------------------------------

#[test]
fn an_outside_account_cannot_move_usdc_or_a_right_without_a_builder_action() {
    let p = pay_setup();
    let f = &p.f;
    let out = &p.outsider;
    // Builder state: a sale offer by the buyer, a Funded escrow and a
    // Disputed one, and the owner's rights.
    let buyer_offer = p.sale_offer(&f.buyer, 1, 2 * USDC);
    let funded = {
        let o = p.rental_offer(&f.renter, 2, USDC);
        p.accept_rental(&f.owner, o, USDC, "rental_r2").unwrap()
    };
    let disputed = {
        let o = p.rental_offer(&f.buyer, 3, USDC);
        let id = p.accept_rental(&f.owner, o, USDC, "rental_r3").unwrap();
        f.client.report_problem(&f.buyer, &id, &hash(&f.env, 0x11));
        id
    };
    // The outsider holds USDC of its own (a C… address needs no trustline).
    StellarAssetClient::new(&f.env, &f.usdc).mint(out, &(10 * USDC));
    let before = p.snap();
    let (period, validity) = week();

    // Calls made with the outsider's own signature (mock_all_auths): each is
    // refused, or (requests and offers) moves nothing.
    f.env.mock_all_auths();
    p.only_signs(
        out,
        "issue",
        vec![
            &f.env,
            out.into_val(&f.env),
            period.into_val(&f.env),
            validity.into_val(&f.env),
            owner_commitment(&f.env).into_val(&f.env),
        ],
    );
    assert!(host_refused(f.client.try_issue(
        out,
        &period,
        &validity,
        &owner_commitment(&f.env)
    )));
    f.env.mock_all_auths();
    let req = f
        .client
        .request_record(out, &1, &hash(&f.env, 7), &(p.now() + OPEN_FOR));
    let out_sale =
        f.client
            .create_sale_offer(out, &req, &USDC, &p.buyer_h(), &(p.now() + OPEN_FOR));
    let out_rental = p.rental_offer(out, 1, USDC);
    assert_eq!(p.snap(), before);

    let sale = tx(&f.env, "sale");
    let rental = tx(&f.env, "rental");
    let errs = [
        res(f
            .client
            .try_transfer(out, &f.buyer, &1, &None, &sale.proof, &sale.signals)),
        res(f
            .client
            .try_accept_sale(out, &buyer_offer, &(2 * USDC), &sale.proof, &sale.signals)),
        res(f
            .client
            .try_accept_sale(out, &out_sale, &USDC, &sale.proof, &sale.signals)),
        res(f
            .client
            .try_accept_rental(out, &out_rental, &USDC, &rental.proof, &rental.signals)
            .map(|r| r.map(|_| ()))),
        res(f.client.try_list(out, &1, &None)),
        res(f.client.try_unlist(out, &1)),
        res(f.client.try_burn(out, &1)),
        res(f.client.try_cancel_offer(out, &buyer_offer)),
        res(f.client.try_collect(out, &funded)),
        res(f.client.try_confirm(out, &funded)),
        res(f.client.try_report_problem(out, &funded, &hash(&f.env, 1))),
        res(f.client.try_refund(out, &disputed)),
        res(f.client.try_confirm(out, &disputed)),
        res(f
            .client
            .try_submit_evidence(out, &disputed, &hash(&f.env, 1))),
        res(f
            .client
            .try_resolve(out, &disputed, &Outcome::RefundRenter, &hash(&f.env, 1))),
    ];
    for (i, e) in errs.iter().enumerate() {
        assert!(e.is_err(), "outsider call {i} succeeded");
    }
    p.at_time(CHECK_IN + DAY);
    assert_eq!(
        res(f.client.try_collect(out, &funded)),
        Err(Error::NotEscrowParty)
    );
    // Anyone may extend an escrow's TTL; it changes nothing else.
    f.client.extend_escrow(&funded);
    assert_eq!(p.snap(), before);

    // Calls naming a builder account, signed only by the outsider: the host
    // refuses each for the missing signature.
    let named: [(&'static str, Vec<Val>); 6] = [
        (
            "collect",
            vec![&f.env, f.owner.into_val(&f.env), funded.into_val(&f.env)],
        ),
        (
            "confirm",
            vec![&f.env, f.renter.into_val(&f.env), funded.into_val(&f.env)],
        ),
        (
            "refund",
            vec![&f.env, f.owner.into_val(&f.env), disputed.into_val(&f.env)],
        ),
        (
            "cancel_offer",
            vec![
                &f.env,
                f.buyer.into_val(&f.env),
                buyer_offer.into_val(&f.env),
            ],
        ),
        (
            "burn",
            vec![&f.env, f.owner.into_val(&f.env), 1u64.into_val(&f.env)],
        ),
        (
            "resolve",
            vec![
                &f.env,
                f.arbiter.into_val(&f.env),
                disputed.into_val(&f.env),
                Outcome::RefundRenter.into_val(&f.env),
                hash(&f.env, 1).into_val(&f.env),
            ],
        ),
    ];
    for (fn_name, args) in named.iter() {
        p.only_signs(out, fn_name, args.clone());
        let refused = match *fn_name {
            "collect" => host_refused(f.client.try_collect(&f.owner, &funded)),
            "confirm" => host_refused(f.client.try_confirm(&f.renter, &funded)),
            "refund" => host_refused(f.client.try_refund(&f.owner, &disputed)),
            "cancel_offer" => host_refused(f.client.try_cancel_offer(&f.buyer, &buyer_offer)),
            "burn" => host_refused(f.client.try_burn(&f.owner, &1)),
            "resolve" => host_refused(f.client.try_resolve(
                &f.arbiter,
                &disputed,
                &Outcome::RefundRenter,
                &hash(&f.env, 1),
            )),
            _ => unreachable!(),
        };
        assert!(refused, "{fn_name} accepted the outsider's signature");
    }
    p.only_signs(
        out,
        "accept_sale",
        vec![
            &f.env,
            f.owner.into_val(&f.env),
            out_sale.into_val(&f.env),
            USDC.into_val(&f.env),
            sale.proof.into_val(&f.env),
            sale.signals.into_val(&f.env),
        ],
    );
    assert!(host_refused(f.client.try_accept_sale(
        &f.owner,
        &out_sale,
        &USDC,
        &sale.proof,
        &sale.signals
    )));
    assert_eq!(p.snap(), before);
    // The swap functions get the same test in test_swap.rs
    // (an_outside_account_cannot_move_a_right_through_any_swap_function).
}

#[test]
fn an_outsiders_offer_moves_money_only_when_a_builder_accepts_it() {
    let p = pay_setup();
    let f = &p.f;
    let out = &p.outsider;
    StellarAssetClient::new(&f.env, &f.usdc).mint(out, &(10 * USDC));
    let offer = p.rental_offer(out, 1, 2 * USDC);
    assert_eq!(p.bal(out), 10 * USDC);
    // The owner's acceptance, with the owner's proof, is the builder action.
    // `rental` names the fixture renter, so the outsider's offer needs its own
    // proof; with the renter's proof it is refused and nothing moves.
    let before = p.snap();
    assert_eq!(
        p.accept_rental(&f.owner, offer, 2 * USDC, "rental"),
        Err(Error::RecipientMismatch)
    );
    assert_eq!(p.snap(), before);
}

// -------------------------------------------------------------------------
// storage and TTL (§9)
// -------------------------------------------------------------------------

#[test]
fn offers_and_requests_live_past_their_last_ledger() {
    let p = pay_setup();
    let f = &p.f;
    let request = p.request(&f.buyer, 1);
    let offer = p.rental_offer(&f.renter, 1, USDC);
    f.env.as_contract(&f.contract_id, || {
        let t = f.env.storage().temporary();
        assert!(t.get_ttl(&DataKey::Request(request)) >= OPEN_FOR);
        assert!(t.get_ttl(&DataKey::Offer(offer)) >= OPEN_FOR);
    });
}

#[test]
fn an_escrow_is_kept_live_past_its_collect_window_and_anyone_can_extend_it() {
    let p = pay_setup();
    let f = &p.f;
    let id = p.funded();
    let now = f.env.ledger().timestamp();
    let needed = ((CHECK_IN + DAY + 30 * DAY - now) / 5) as u32;
    let ttl = || {
        f.env.as_contract(&f.contract_id, || {
            f.env.storage().persistent().get_ttl(&DataKey::Escrow(id))
        })
    };
    assert!(ttl() >= needed, "ttl {} < {needed}", ttl());

    // Long after, a dispute still has at least 30 days, renewed by any call.
    f.at_ledger(BASE_LEDGER + 1_000_000);
    p.at_time(CHECK_IN + 200 * DAY);
    f.env.set_auths(&[]);
    f.client.extend_escrow(&id);
    assert!(ttl() >= 518_400);
    assert_eq!(
        res(f.client.try_extend_escrow(&99)),
        Err(Error::EscrowNotFound)
    );
}

// -------------------------------------------------------------------------
// D12: the allowance is set inside the offer call
// -------------------------------------------------------------------------

/// The buyer authorizes one tree: the offer call at the root, the USDC
/// `approve` (spender = this contract, amount = the live offers' sum) as its
/// sub-invocation. No separate transaction to the USDC contract.
fn assert_offer_tree_holds_the_approve(p: &P, buyer: &Address, root_fn: &str, amount: i128) {
    use soroban_sdk::testutils::{AuthorizedFunction, AuthorizedInvocation};
    use soroban_sdk::Symbol;
    let f = &p.f;
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1, "one authorization tree, the buyer's");
    let (who, root): &(Address, AuthorizedInvocation) = &auths[0];
    assert_eq!(who, buyer);
    let AuthorizedFunction::Contract((contract, name, _)) = &root.function else {
        panic!("root is a contract call");
    };
    assert_eq!(
        (contract, name),
        (&f.contract_id, &Symbol::new(&f.env, root_fn))
    );
    assert_eq!(root.sub_invocations.len(), 1, "exactly one sub-invocation");
    let AuthorizedFunction::Contract((token, sub, args)) = &root.sub_invocations[0].function else {
        panic!("the sub-invocation is a contract call");
    };
    assert_eq!((token, sub), (&f.usdc, &Symbol::new(&f.env, "approve")));
    let from: Address = args.get_unchecked(0).into_val(&f.env);
    let spender: Address = args.get_unchecked(1).into_val(&f.env);
    let value: i128 = args.get_unchecked(2).into_val(&f.env);
    assert_eq!(
        (from, spender, value),
        (buyer.clone(), f.contract_id.clone(), amount)
    );
}

#[test]
fn the_allowance_is_set_inside_the_offer_call_not_by_a_separate_usdc_call() {
    let p = pay_setup();
    let f = &p.f;
    let request = p.request(&f.buyer, 1);
    f.client.create_sale_offer(
        &f.buyer,
        &request,
        &(2 * USDC),
        &p.buyer_h(),
        &(p.now() + OPEN_FOR),
    );
    assert_offer_tree_holds_the_approve(&p, &f.buyer, "create_sale_offer", 2 * USDC);

    f.client.create_rental_offer(
        &f.buyer,
        &2,
        &(3 * USDC),
        &WEEK_END,
        &CHECK_IN,
        &(p.now() + OPEN_FOR),
    );
    assert_offer_tree_holds_the_approve(&p, &f.buyer, "create_rental_offer", 5 * USDC);

    let offer = f.client.next_offer_id() - 1;
    f.client.cancel_offer(&f.buyer, &offer);
    assert_offer_tree_holds_the_approve(&p, &f.buyer, "cancel_offer", 2 * USDC);
}

// -------------------------------------------------------------------------
// The signed approve must not depend on the ledger the call lands in
// -------------------------------------------------------------------------

/// What happened on testnet at the Step 3 deployment: the buyer signs the
/// offer call with its `approve` sub-call when it is simulated, and the
/// transaction lands some ledgers later. The allowance's expiration is in the
/// signed arguments, so it must come from the offers, not from the ledger
/// sequence. Here the signature is fixed at ledger 1000 and the call lands at
/// 1007; with an expiration of "now + 120,960" it would be refused.
#[test]
fn an_offer_signed_at_one_ledger_still_lands_ledgers_later() {
    let p = pay_setup();
    let f = &p.f;
    // A C… address, so the host can hold it to exactly these signed arguments.
    let renter = &p.outsider;
    StellarAssetClient::new(&f.env, &f.usdc).mint(renter, &(10 * USDC));
    let expires = BASE_LEDGER + OPEN_FOR;
    let price = 3 * USDC;
    let offer_args: Vec<Val> =
        (renter.clone(), 1u64, price, WEEK_END, CHECK_IN, expires).into_val(&f.env);
    let approve_args: Vec<Val> =
        (renter.clone(), f.contract_id.clone(), price, expires).into_val(&f.env);

    f.at_ledger(BASE_LEDGER + 7);
    f.env.mock_auths(&[MockAuth {
        address: renter,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "create_rental_offer",
            args: offer_args,
            sub_invokes: &[MockAuthInvoke {
                contract: &f.usdc,
                fn_name: "approve",
                args: approve_args,
                sub_invokes: &[],
            }],
        },
    }]);
    let offer = f
        .client
        .create_rental_offer(renter, &1, &price, &WEEK_END, &CHECK_IN, &expires);
    assert_eq!(p.allowance(renter), price);

    // Cancelling the only offer: amount 0, expiring at that offer's own last
    // ledger, also fixed by what the renter signed. Lands later again.
    f.at_ledger(BASE_LEDGER + 20);
    f.env.mock_auths(&[MockAuth {
        address: renter,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_offer",
            args: (renter.clone(), offer).into_val(&f.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &f.usdc,
                fn_name: "approve",
                args: (renter.clone(), f.contract_id.clone(), 0i128, expires).into_val(&f.env),
                sub_invokes: &[],
            }],
        },
    }]);
    f.client.cancel_offer(renter, &offer);
    assert_eq!(p.allowance(renter), 0);
}

#[test]
fn the_allowance_expires_with_the_last_live_offer() {
    let p = pay_setup();
    let f = &p.f;
    let b = &f.buyer;
    let short = BASE_LEDGER + 100;
    let long = BASE_LEDGER + 900;
    f.client
        .create_rental_offer(b, &1, &USDC, &WEEK_END, &CHECK_IN, &long);
    f.client
        .create_rental_offer(b, &2, &USDC, &WEEK_END, &CHECK_IN, &short);
    assert_eq!(p.allowance(b), 2 * USDC);
    // Past the short offer, the allowance still covers the long one…
    f.at_ledger(short + 1);
    assert_eq!(p.allowance(b), 2 * USDC);
    // …through its last ledger, and lapses after it.
    f.at_ledger(long);
    assert_eq!(p.allowance(b), 2 * USDC);
    f.at_ledger(long + 1);
    assert_eq!(p.allowance(b), 0);
}

// -------------------------------------------------------------------------
// Real signatures (Step 3 deployment review)
// -------------------------------------------------------------------------
//
// The tests above mock authorization, and a mock cannot notice that a signed
// argument changed between signing and inclusion: that is how the allowance
// bug reached testnet. These sign with the fixtures' real ed25519 keys (the
// generator derives each from SHA-256("quietstay-test-account:<label>")),
// exactly as a wallet signs a simulated authorization entry, then land the
// call ledgers later. The host verifies each signature against the account's
// master key, so a signature over any other arguments is refused.

mod real {
    extern crate std;
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};
    use soroban_sdk::xdr::{
        HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs, Limits, ScMap,
        ScMapEntry, ScVal, SorobanAddressCredentials, SorobanAuthorizationEntry,
        SorobanAuthorizedFunction, SorobanAuthorizedInvocation, SorobanCredentials, WriteXdr,
    };
    use soroban_sdk::TryFromVal;

    /// The fixture account's real key, checked against its address.
    fn key(env: &Env, label: &str) -> SigningKey {
        let seed: [u8; 32] = Sha256::digest(std::format!("quietstay-test-account:{label}")).into();
        let key = SigningKey::from_bytes(&seed);
        let id: xdr::AccountId = (&account(env, label)).try_into().unwrap();
        let xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(pk)) = id.0;
        assert_eq!(
            pk,
            key.verifying_key().to_bytes(),
            "{label}'s key matches its fixture address"
        );
        key
    }

    pub fn call(
        env: &Env,
        contract: &Address,
        fn_name: &str,
        args: Vec<Val>,
        subs: std::vec::Vec<SorobanAuthorizedInvocation>,
    ) -> SorobanAuthorizedInvocation {
        let args: std::vec::Vec<ScVal> = args
            .iter()
            .map(|v| ScVal::try_from_val(env, &v).unwrap())
            .collect();
        SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: contract.into(),
                function_name: fn_name.try_into().unwrap(),
                args: args.try_into().unwrap(),
            }),
            sub_invocations: subs.try_into().unwrap(),
        }
    }

    /// Sign `root` as `label`, as a wallet signs an entry from simulation.
    pub fn signed(
        env: &Env,
        label: &str,
        nonce: i64,
        valid_until: u32,
        root: SorobanAuthorizedInvocation,
    ) -> SorobanAuthorizationEntry {
        let key = key(env, label);
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger: valid_until,
            invocation: root.clone(),
        });
        let payload = Sha256::digest(preimage.to_xdr(Limits::none()).unwrap());
        let signature = key.sign(&payload).to_bytes();
        let entry = |k: &str, v: &[u8]| ScMapEntry {
            key: ScVal::Symbol(k.try_into().unwrap()),
            val: ScVal::Bytes(v.to_vec().try_into().unwrap()),
        };
        let sig = ScVal::Vec(Some(
            std::vec![ScVal::Map(Some(ScMap(
                std::vec![
                    entry("public_key", &key.verifying_key().to_bytes()),
                    entry("signature", &signature)
                ]
                .try_into()
                .unwrap(),
            )))]
            .try_into()
            .unwrap(),
        ));
        SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: (&account(env, label)).into(),
                nonce,
                signature_expiration_ledger: valid_until,
                signature: sig,
            }),
            root_invocation: root,
        }
    }

    /// `USDC.approve(from, contract, amount, expiration)`, the offer calls' one signed sub-call.
    pub fn approve(
        p: &P,
        from: &Address,
        amount: i128,
        expiration: u32,
    ) -> SorobanAuthorizedInvocation {
        let f = &p.f;
        call(
            &f.env,
            &f.usdc,
            "approve",
            (from.clone(), f.contract_id.clone(), amount, expiration).into_val(&f.env),
            std::vec![],
        )
    }
}

/// Signed at ledger 1000, landing at 1007: create_rental_offer with its approve.
#[test]
fn real_signature_create_rental_offer_lands_ledgers_after_signing() {
    let p = pay_setup();
    let f = &p.f;
    let (r, price, expires) = (&f.renter, 3 * USDC, BASE_LEDGER + OPEN_FOR);
    let root = real::call(
        &f.env,
        &f.contract_id,
        "create_rental_offer",
        (r.clone(), 1u64, price, WEEK_END, CHECK_IN, expires).into_val(&f.env),
        std::vec![real::approve(&p, r, price, expires)],
    );
    let entry = real::signed(&f.env, "renter", 1, BASE_LEDGER + 100, root);
    f.at_ledger(BASE_LEDGER + 7);
    f.env.set_auths(&[entry]);
    f.client
        .create_rental_offer(r, &1, &price, &WEEK_END, &CHECK_IN, &expires);
    assert_eq!(p.allowance(r), price);
}

/// Signed at 1000, landing at 1007: create_sale_offer with its approve.
#[test]
fn real_signature_create_sale_offer_lands_ledgers_after_signing() {
    let p = pay_setup();
    let f = &p.f;
    let b = &f.buyer;
    let request = p.request(b, 1); // setup, mocked
    let (price, expires, h) = (2 * USDC, BASE_LEDGER + OPEN_FOR, p.buyer_h());
    let root = real::call(
        &f.env,
        &f.contract_id,
        "create_sale_offer",
        (b.clone(), request, price, h.clone(), expires).into_val(&f.env),
        std::vec![real::approve(&p, b, price, expires)],
    );
    let entry = real::signed(&f.env, "buyer", 2, BASE_LEDGER + 100, root);
    f.at_ledger(BASE_LEDGER + 7);
    f.env.set_auths(&[entry]);
    f.client
        .create_sale_offer(b, &request, &price, &h, &expires);
    assert_eq!(p.allowance(b), price);
}

/// cancel_offer, with real signatures: once leaving one live offer (the
/// allowance is that offer's price, expiring with it), then the last one
/// (zero, expiring at the cancelled offer's own last ledger).
#[test]
fn real_signature_cancel_offer_lands_ledgers_after_signing() {
    let p = pay_setup();
    let f = &p.f;
    let b = &f.buyer;
    let (early, late) = (BASE_LEDGER + 500, BASE_LEDGER + 900);
    f.env.mock_all_auths();
    let first = f
        .client
        .create_rental_offer(b, &1, &USDC, &WEEK_END, &CHECK_IN, &late);
    let second = f
        .client
        .create_rental_offer(b, &2, &(2 * USDC), &WEEK_END, &CHECK_IN, &early);

    let root = real::call(
        &f.env,
        &f.contract_id,
        "cancel_offer",
        (b.clone(), first).into_val(&f.env),
        std::vec![real::approve(&p, b, 2 * USDC, early)],
    );
    let entry = real::signed(&f.env, "buyer", 3, BASE_LEDGER + 100, root);
    f.at_ledger(BASE_LEDGER + 9);
    f.env.set_auths(&[entry]);
    f.client.cancel_offer(b, &first);
    assert_eq!(p.allowance(b), 2 * USDC);

    let root = real::call(
        &f.env,
        &f.contract_id,
        "cancel_offer",
        (b.clone(), second).into_val(&f.env),
        std::vec![real::approve(&p, b, 0, early)],
    );
    let entry = real::signed(&f.env, "buyer", 4, BASE_LEDGER + 100, root);
    f.at_ledger(BASE_LEDGER + 15);
    f.env.set_auths(&[entry]);
    f.client.cancel_offer(b, &second);
    assert_eq!(p.allowance(b), 0);
}

/// The signature is really checked: one over the old rule's expiration
/// (signing ledger + 120,960) is refused, and nothing is recorded.
#[test]
fn real_signature_over_different_approve_arguments_is_refused() {
    let p = pay_setup();
    let f = &p.f;
    let (r, price, expires) = (&f.renter, 3 * USDC, BASE_LEDGER + OPEN_FOR);
    let root = real::call(
        &f.env,
        &f.contract_id,
        "create_rental_offer",
        (r.clone(), 1u64, price, WEEK_END, CHECK_IN, expires).into_val(&f.env),
        std::vec![real::approve(&p, r, price, BASE_LEDGER + MAX_OFFER_LEDGERS)],
    );
    let entry = real::signed(&f.env, "renter", 5, BASE_LEDGER + 100, root);
    f.at_ledger(BASE_LEDGER + 7);
    f.env.set_auths(&[entry]);
    assert!(host_refused(f.client.try_create_rental_offer(
        r, &1, &price, &WEEK_END, &CHECK_IN, &expires
    )));
    assert_eq!(p.allowance(r), 0);
    assert_eq!(f.client.next_offer_id(), 1);
}
