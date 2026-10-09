#![cfg(test)]
//! Every transfer below carries a real Groth16 proof, made with the committed
//! development keys by `npm run zk:test-fixtures` (scripts/zk/make-test-fixtures.ts)
//! and stored in `tests/fixtures/`. The contract verifies them exactly as the
//! deployed one does; nothing about verification is stubbed.
//!
//! Accounts are fixed `G…` keys, because a proof binds the sender's and
//! recipient's Ed25519 keys. Fixture scenarios are named after what they prove.

extern crate std;

use soroban_sdk::{
    crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine},
    testutils::{
        storage::Temporary as _, Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke,
    },
    vec, Address, Bytes, BytesN, Env, Event, IntoVal, String, Symbol, Val, Vec, U256,
};

use crate::error::Error;
use crate::events::Transferred;
use crate::store;
use crate::types::{DataKey, Holding, Period, Right, Validity, MAX_HOLDING_DEPTH};
use crate::verifier::{Proof, VerificationKey};
use crate::{QuietStayRights, QuietStayRightsClient};

// 2026-01-01T00:00:00Z — the start of the use year.
const YEAR_START: u64 = 1_767_225_600;
// 2027-01-01T00:00:00Z — the end of it.
const YEAR_END: u64 = 1_798_761_600;
// 2026-07-04T00:00:00Z → 2026-07-11T00:00:00Z — the week itself.
const WEEK_START: u64 = 1_783_123_200;
const WEEK_END: u64 = 1_783_728_000;

const DAY: u64 = 86_400;

/// The ledger every test starts at. Fixture proofs are valid through
/// `BASE_LEDGER + 360` (and `rental_edge` through `BASE_LEDGER + 720`).
const BASE_LEDGER: u32 = 1000;

const COMMON: &str = include_str!("../tests/fixtures/common.json");
const VK: &str = include_str!("../tests/fixtures/verification_key.soroban.json");

fn fixture_json(name: &str) -> &'static str {
    match name {
        "rental" => include_str!("../tests/fixtures/rental.json"),
        "sale" => include_str!("../tests/fixtures/sale.json"),
        "sale_planted" => include_str!("../tests/fixtures/sale_planted.json"),
        "resale" => include_str!("../tests/fixtures/resale.json"),
        "old_owner_resale" => include_str!("../tests/fixtures/old_owner_resale.json"),
        "renter_sale" => include_str!("../tests/fixtures/renter_sale.json"),
        "rental_edge" => include_str!("../tests/fixtures/rental_edge.json"),
        "rental_again" => include_str!("../tests/fixtures/rental_again.json"),
        _ => panic!("no fixture {name}"),
    }
}

// -------------------------------------------------------------------------
// fixtures
// -------------------------------------------------------------------------

fn unhex<const N: usize>(s: &str) -> [u8; N] {
    assert_eq!(s.len(), N * 2, "hex length");
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

fn json(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap()
}

fn g1(env: &Env, v: &serde_json::Value) -> Bls12381G1Affine {
    Bls12381G1Affine::from_array(env, &unhex::<96>(v.as_str().unwrap()))
}

fn g2(env: &Env, v: &serde_json::Value) -> Bls12381G2Affine {
    Bls12381G2Affine::from_array(env, &unhex::<192>(v.as_str().unwrap()))
}

fn u256(env: &Env, hex: &str) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &unhex::<32>(hex)))
}

fn account(env: &Env, name: &str) -> Address {
    let common = json(COMMON);
    Address::from_str(env, common["accounts"][name].as_str().unwrap())
}

fn vk(env: &Env) -> VerificationKey {
    let j = json(VK);
    let mut ic = Vec::new(env);
    for p in j["ic"].as_array().unwrap() {
        ic.push_back(g1(env, p));
    }
    VerificationKey {
        alpha: g1(env, &j["alpha"]),
        beta: g2(env, &j["beta"]),
        gamma: g2(env, &j["gamma"]),
        delta: g2(env, &j["delta"]),
        ic,
    }
}

/// `C` for the owner, as issued: `Poseidon(d, owner, h_owner)`.
fn owner_commitment(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &unhex::<32>(json(COMMON)["owner_commitment"].as_str().unwrap()))
}

/// `C'` for the buyer, as a sale with the buyer's `h'` leaves it.
fn buyer_commitment(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &unhex::<32>(json(COMMON)["buyer_commitment"].as_str().unwrap()))
}

/// A canonical stand-in commitment for tests that never transfer.
fn commitment(env: &Env, byte: u8) -> BytesN<32> {
    assert!(byte < 0x73, "keep stand-in commitments below r");
    BytesN::from_array(env, &[byte; 32])
}

/// One transfer, exactly as a fixture proved it.
#[derive(Clone)]
struct Tx {
    from: Address,
    to: Address,
    right_id: u64,
    expires_at: Option<u64>,
    next_secret_hash: U256,
    proof: Proof,
    signals: Vec<U256>,
}

fn tx(env: &Env, name: &str) -> Tx {
    let j = json(fixture_json(name));
    let mut signals = Vec::new(env);
    for s in j["signals"].as_array().unwrap() {
        signals.push_back(u256(env, s.as_str().unwrap()));
    }
    Tx {
        from: Address::from_str(env, j["from"].as_str().unwrap()),
        to: Address::from_str(env, j["to"].as_str().unwrap()),
        right_id: j["right_id"].as_u64().unwrap(),
        expires_at: j["expires_at"].as_u64(),
        next_secret_hash: u256(env, j["next_secret_hash"].as_str().unwrap()),
        proof: Proof {
            a: g1(env, &j["proof"]["a"]),
            b: g2(env, &j["proof"]["b"]),
            c: g1(env, &j["proof"]["c"]),
        },
        signals,
    }
}

struct Fixture<'a> {
    env: Env,
    contract_id: Address,
    client: QuietStayRightsClient<'a>,
    issuer: Address,
    owner: Address,
    renter: Address,
    buyer: Address,
    stranger: Address,
}

impl Fixture<'_> {
    /// Submit a transfer with every signature it might need available. Tests
    /// about *which* signatures are needed use `mock_auths` instead.
    fn send(&self, t: &Tx) -> Result<(), Error> {
        self.env.mock_all_auths();
        match self.client.try_transfer(
            &t.from,
            &t.to,
            &t.right_id,
            &t.expires_at,
            &t.proof,
            &t.signals,
        ) {
            Ok(Ok(())) => Ok(()),
            Err(Ok(e)) => Err(e),
            other => panic!("unexpected host failure: {other:?}"),
        }
    }

    fn at_ledger(&self, sequence: u32) {
        self.env.ledger().set_sequence_number(sequence);
    }
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().set_timestamp(YEAR_START + DAY);
    env.ledger().set_sequence_number(BASE_LEDGER);

    // The issuer is bound by no proof, so it can be any address; a generated one
    // lets the tests mock its signature alone, which the host cannot do for a G…
    // account.
    let issuer = Address::generate(&env);
    let contract_id = env.register(
        QuietStayRights,
        (
            issuer.clone(),
            String::from_str(&env, "QuietStay Usage Right"),
            String::from_str(&env, "QSTAY"),
            vk(&env),
        ),
    );
    let client = QuietStayRightsClient::new(&env, &contract_id);

    Fixture {
        owner: account(&env, "owner"),
        renter: account(&env, "renter"),
        buyer: account(&env, "buyer"),
        stranger: account(&env, "stranger"),
        env,
        contract_id,
        client,
        issuer,
    }
}

fn week() -> (Period, Validity) {
    (
        Period {
            start: WEEK_START,
            end: WEEK_END,
        },
        Validity {
            from: YEAR_START,
            until: YEAR_END,
        },
    )
}

/// Issue right #1 to the owner, committed to the owner's secret as the fixtures
/// were proved against.
fn issue_week(f: &Fixture) -> u64 {
    f.env.mock_all_auths();
    let (period, validity) = week();
    f.client
        .issue(&f.owner, &period, &validity, &owner_commitment(&f.env))
}

/// The holding-chain rules on their own, for cases no honest proof reaches.
fn grant(
    f: &Fixture,
    holdings: &[(Address, Option<u64>)],
    from: &Address,
    to: &Address,
    expires_at: Option<u64>,
) -> Result<std::vec::Vec<(Address, Option<u64>)>, Error> {
    let (period, validity) = week();
    let mut chain = Vec::new(&f.env);
    for (holder, exp) in holdings {
        chain.push_back(Holding {
            holder: holder.clone(),
            expires_at: *exp,
        });
    }
    let right = Right {
        id: 1,
        issuer: f.issuer.clone(),
        period,
        validity,
        commitment: commitment(&f.env, 1),
        holdings: chain,
    };
    f.env.as_contract(&f.contract_id, || {
        store::grant(&f.env, &right, from, to, &expires_at)
            .map(|c| c.iter().map(|h| (h.holder, h.expires_at)).collect())
    })
}

// -------------------------------------------------------------------------
// construction and issuance
// -------------------------------------------------------------------------

#[test]
fn constructor_records_issuer_and_sep41_metadata() {
    let f = setup();
    assert_eq!(f.client.issuer(), f.issuer);
    assert_eq!(f.client.name(), String::from_str(&f.env, "QuietStay Usage Right"));
    assert_eq!(f.client.symbol(), String::from_str(&f.env, "QSTAY"));
    // Rights are indivisible: a week is not a quantity.
    assert_eq!(f.client.decimals(), 0);
    assert_eq!(f.client.next_id(), 1);
}

#[test]
#[should_panic]
fn a_verification_key_with_the_wrong_number_of_points_cannot_be_deployed() {
    let env = Env::default();
    let mut key = vk(&env);
    key.ic.pop_back();
    env.register(
        QuietStayRights,
        (
            account(&env, "issuer"),
            String::from_str(&env, "QuietStay Usage Right"),
            String::from_str(&env, "QSTAY"),
            key,
        ),
    );
}

#[test]
fn issue_assigns_title_and_sequential_ids() {
    let f = setup();
    f.env.mock_all_auths();
    let (period, validity) = week();

    let first = f
        .client
        .issue(&f.owner, &period, &validity, &commitment(&f.env, 1));
    let second = f
        .client
        .issue(&f.owner, &period, &validity, &commitment(&f.env, 2));

    assert_eq!(first, 1);
    assert_eq!(second, 2);
    assert_eq!(f.client.next_id(), 3);
    assert_eq!(f.client.balance(&f.owner), 2);
    assert_eq!(f.client.holder(&first), f.owner);
    assert_eq!(f.client.commitment(&first), commitment(&f.env, 1));

    let right = f.client.get_right(&first);
    assert_eq!(right.issuer, f.issuer);
    assert_eq!(right.period, period);
    assert_eq!(right.validity, validity);
    assert_eq!(right.holdings.len(), 1);
    assert_eq!(
        right.holdings.get_unchecked(0),
        Holding {
            holder: f.owner.clone(),
            expires_at: None,
        }
    );
}

#[test]
fn issue_requires_the_issuers_authorization() {
    let f = setup();
    let impostor = Address::generate(&f.env);
    let (period, validity) = week();

    // Only the impostor signs. `issue` demands the issuer, so this must fail.
    f.env.mock_auths(&[MockAuth {
        address: &impostor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "issue",
            args: (
                f.owner.clone(),
                period.clone(),
                validity.clone(),
                commitment(&f.env, 1),
            )
                .into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(f
        .client
        .try_issue(&f.owner, &period, &validity, &commitment(&f.env, 1))
        .is_err());
}

#[test]
fn issue_rejects_an_inverted_week() {
    let f = setup();
    f.env.mock_all_auths();
    assert_eq!(
        f.client.try_issue(
            &f.owner,
            &Period {
                start: WEEK_END,
                end: WEEK_START,
            },
            &Validity {
                from: YEAR_START,
                until: YEAR_END,
            },
            &commitment(&f.env, 1),
        ),
        Err(Ok(Error::InvalidPeriod))
    );
}

#[test]
fn issue_rejects_a_week_outside_its_validity_window() {
    let f = setup();
    f.env.mock_all_auths();
    let (period, _) = week();

    // Validity closes before the week ends.
    assert_eq!(
        f.client.try_issue(
            &f.owner,
            &period,
            &Validity {
                from: YEAR_START,
                until: WEEK_START,
            },
            &commitment(&f.env, 1),
        ),
        Err(Ok(Error::InvalidValidity))
    );

    // Validity opens after the week starts.
    assert_eq!(
        f.client.try_issue(
            &f.owner,
            &period,
            &Validity {
                from: WEEK_END,
                until: YEAR_END,
            },
            &commitment(&f.env, 1),
        ),
        Err(Ok(Error::InvalidValidity))
    );
}

#[test]
fn issue_rejects_a_commitment_no_proof_could_match() {
    let f = setup();
    f.env.mock_all_auths();
    let (period, validity) = week();
    // Not below r: no public signal can equal it, so the right would be frozen
    // from the moment it was issued.
    assert_eq!(
        f.client.try_issue(
            &f.owner,
            &period,
            &validity,
            &BytesN::from_array(&f.env, &[0xFF; 32])
        ),
        Err(Ok(Error::NonCanonicalSignal))
    );
}

#[test]
fn issuing_more_inventory_does_not_disturb_existing_rights() {
    let f = setup();
    let right_id = issue_week(&f);
    let before = f.client.get_right(&right_id);
    let (period, validity) = week();

    // The issuer's only privileged function writes to a fresh id from a counter
    // it does not control the value of, so it cannot reach right #1.
    f.client
        .issue(&f.stranger, &period, &validity, &commitment(&f.env, 0x22));

    assert_eq!(f.client.get_right(&right_id), before);
    assert_eq!(f.client.holder(&right_id), f.owner);
}

// -------------------------------------------------------------------------
// proof-authorized transfers — sale and rental
// -------------------------------------------------------------------------

#[test]
fn a_proven_sale_moves_title_and_hands_the_buyer_a_new_commitment() {
    let f = setup();
    let right_id = issue_week(&f);

    assert_eq!(f.send(&tx(&f.env, "sale")), Ok(()));

    assert_eq!(f.client.holder(&right_id), f.buyer);
    assert_eq!(f.client.balance(&f.owner), 0);
    assert_eq!(f.client.balance(&f.buyer), 1);
    // The commitment now wraps the same record for the buyer's account and
    // secret hash: only the buyer can prove next.
    assert_eq!(f.client.commitment(&right_id), buyer_commitment(&f.env));

    // The chain collapses to the buyer alone: the seller has no residual claim.
    let right = f.client.get_right(&right_id);
    assert_eq!(right.holdings.len(), 1);
    assert_eq!(
        right.holdings.get_unchecked(0),
        Holding {
            holder: f.buyer.clone(),
            expires_at: None,
        }
    );
}

#[test]
fn a_proven_rental_leaves_title_and_the_commitment_where_they_were() {
    let f = setup();
    let right_id = issue_week(&f);

    assert_eq!(f.send(&tx(&f.env, "rental")), Ok(()));

    // The renter is entitled to the week...
    assert_eq!(
        f.client.holding(&right_id),
        Holding {
            holder: f.renter.clone(),
            expires_at: Some(WEEK_END),
        }
    );
    // ...but title never moved, and no commitment rotates on a rental.
    assert_eq!(f.client.balance(&f.owner), 1);
    assert_eq!(f.client.balance(&f.renter), 0);
    assert_eq!(f.client.holdings(&right_id).len(), 2);
    assert_eq!(f.client.commitment(&right_id), owner_commitment(&f.env));
}

#[test]
fn a_rental_lapses_with_no_return_transaction() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();

    // One second before checkout the renter still holds the week.
    f.env.ledger().set_timestamp(WEEK_END - 1);
    assert_eq!(f.client.holder(&right_id), f.renter);

    // At checkout it reverts, and nobody has sent a transaction to make that
    // happen — the chain is simply re-evaluated against the ledger clock.
    f.env.ledger().set_timestamp(WEEK_END);
    assert_eq!(
        f.client.holding(&right_id),
        Holding {
            holder: f.owner.clone(),
            expires_at: None,
        }
    );
    assert_eq!(f.client.holdings(&right_id).len(), 1);
}

#[test]
fn the_new_owner_can_prove_and_sell_on() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "sale")).unwrap();

    assert_eq!(f.send(&tx(&f.env, "resale")), Ok(()));
    assert_eq!(f.client.holder(&right_id), f.stranger);
}

#[test]
fn the_holder_can_prove_again_for_the_next_rental() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();

    // The first rental lapses; later, the owner rents the week out again with the
    // same secret. A different transfer gives a different nullifier.
    f.env.ledger().set_timestamp(WEEK_END);
    f.at_ledger(2000);
    assert_eq!(f.send(&tx(&f.env, "rental_again")), Ok(()));
    assert_eq!(f.client.holder(&right_id), f.stranger);
}

#[test]
fn the_title_holder_cannot_sell_over_an_active_rental() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();

    // The owner's sale proof is valid, but the renter is the effective holder.
    let sale = tx(&f.env, "sale");
    assert_eq!(f.send(&sale), Err(Error::NotHolder));

    // Once the rental lapses, the same proof goes through: the refused attempt
    // was rolled back, nullifier and all.
    f.env.ledger().set_timestamp(WEEK_END);
    assert_eq!(f.send(&sale), Ok(()));
    assert_eq!(f.client.holder(&right_id), f.buyer);
}

#[test]
fn transferring_an_unknown_right_is_rejected() {
    let f = setup();
    let mut t = tx(&f.env, "sale");
    t.right_id = 999;
    assert_eq!(f.send(&t), Err(Error::RightNotFound));
}

#[test]
fn nothing_can_be_transferred_outside_the_validity_window() {
    let f = setup();
    let right_id = issue_week(&f);
    let sale = tx(&f.env, "sale");

    f.env.ledger().set_timestamp(YEAR_START - 1);
    assert_eq!(f.send(&sale), Err(Error::RightNotYetValid));

    f.env.ledger().set_timestamp(YEAR_END);
    assert_eq!(f.send(&sale), Err(Error::RightExpired));
    assert!(!f.client.is_active(&right_id));

    f.env.ledger().set_timestamp(YEAR_END - 1);
    assert!(f.client.is_active(&right_id));
}

// -------------------------------------------------------------------------
// what a proof is bound to — each refused before verification is paid for
// -------------------------------------------------------------------------

#[test]
fn a_tampered_proof_is_rejected() {
    let f = setup();
    issue_week(&f);
    let mut t = tx(&f.env, "rental");
    // Valid curve points, wrong proof: swap A and C.
    t.proof = Proof {
        a: t.proof.c.clone(),
        b: t.proof.b.clone(),
        c: t.proof.a.clone(),
    };
    assert_eq!(f.send(&t), Err(Error::InvalidProof));
}

#[test]
fn a_signal_the_proof_does_not_prove_is_rejected() {
    let f = setup();
    issue_week(&f);
    let mut t = tx(&f.env, "rental");
    // Every check against the contract's state passes — the commitment, right,
    // accounts, mode and deadline are untouched — but the nullifier is not the
    // one the proof was made for, so the pairing check fails.
    t.signals.set(1, U256::from_u32(&f.env, 12345));
    assert_eq!(f.send(&t), Err(Error::InvalidProof));
}

#[test]
fn a_replayed_proof_is_rejected() {
    let f = setup();
    issue_week(&f);
    let rental = tx(&f.env, "rental");
    assert_eq!(f.send(&rental), Ok(()));
    // The same proof again — by the owner or by anyone who copied it from the
    // ledger — repeats its nullifier.
    assert_eq!(f.send(&rental), Err(Error::NullifierUsed));
}

#[test]
fn a_proof_from_the_wrong_account_is_rejected() {
    let f = setup();
    issue_week(&f);
    // The stranger signs the transfer and presents the owner's proof as theirs.
    let mut t = tx(&f.env, "rental");
    t.from = f.stranger.clone();
    assert_eq!(f.send(&t), Err(Error::WrongAccount));
}

#[test]
fn a_proof_for_a_different_recipient_is_rejected() {
    let f = setup();
    issue_week(&f);
    let mut t = tx(&f.env, "rental");
    t.to = f.buyer.clone();
    assert_eq!(f.send(&t), Err(Error::RecipientMismatch));
}

#[test]
fn a_proof_for_a_different_mode_or_term_is_rejected() {
    let f = setup();
    issue_week(&f);

    // A rental's proof used for a sale.
    let mut as_sale = tx(&f.env, "rental");
    as_sale.expires_at = None;
    assert_eq!(f.send(&as_sale), Err(Error::ModeMismatch));

    // A rental's proof used for a longer rental.
    let mut longer = tx(&f.env, "rental");
    longer.expires_at = Some(YEAR_END);
    assert_eq!(f.send(&longer), Err(Error::ModeMismatch));

    // A sale's proof used for a rental.
    let mut as_rental = tx(&f.env, "sale");
    as_rental.expires_at = Some(WEEK_END);
    assert_eq!(f.send(&as_rental), Err(Error::ModeMismatch));
}

#[test]
fn a_proof_for_a_different_right_is_rejected() {
    let f = setup();
    issue_week(&f);
    // Right #2 happens to carry the very same commitment.
    f.env.mock_all_auths();
    let (period, validity) = week();
    let second = f
        .client
        .issue(&f.owner, &period, &validity, &owner_commitment(&f.env));
    let mut t = tx(&f.env, "rental");
    t.right_id = second;
    assert_eq!(f.send(&t), Err(Error::RightMismatch));
}

#[test]
fn an_expired_proof_is_rejected() {
    let f = setup();
    issue_week(&f);
    // The fixture's proof is valid through BASE_LEDGER + 360.
    f.at_ledger(BASE_LEDGER + 361);
    assert_eq!(f.send(&tx(&f.env, "rental")), Err(Error::ProofExpired));
}

#[test]
fn a_proof_valid_for_longer_than_the_window_is_rejected() {
    let f = setup();
    issue_week(&f);
    // Seen from 721 ledgers before its deadline, the proof claims too long a life.
    f.at_ledger(BASE_LEDGER + 360 - 721);
    assert_eq!(f.send(&tx(&f.env, "rental")), Err(Error::ExpiryBeyondWindow));
    // From exactly 720 before, it is fine.
    f.at_ledger(BASE_LEDGER + 360 - 720);
    assert_eq!(f.send(&tx(&f.env, "rental")), Ok(()));
}

#[test]
fn a_commitment_mismatch_is_rejected() {
    let f = setup();
    // The right is committed to something other than the owner's secret.
    f.env.mock_all_auths();
    let (period, validity) = week();
    f.client
        .issue(&f.owner, &period, &validity, &commitment(&f.env, 0x11));
    assert_eq!(f.send(&tx(&f.env, "rental")), Err(Error::CommitmentMismatch));
}

#[test]
fn a_non_canonical_signal_is_rejected() {
    let f = setup();
    issue_week(&f);
    let mut t = tx(&f.env, "rental");
    // The nullifier plus r. soroban-sdk reduces it back to the same field
    // element, so without this check it would verify — and be stored as a
    // second, different nullifier for the same proof.
    let r = u256(
        &f.env,
        "73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001",
    );
    let n = t.signals.get(1).unwrap();
    t.signals.set(1, n.add(&r));
    assert_eq!(f.send(&t), Err(Error::NonCanonicalSignal));
}

#[test]
fn the_wrong_number_of_signals_is_rejected() {
    let f = setup();
    issue_week(&f);
    let mut t = tx(&f.env, "rental");
    t.signals.pop_back();
    assert_eq!(f.send(&t), Err(Error::WrongSignalCount));
}

#[test]
fn a_rental_carrying_a_next_secret_hash_is_rejected() {
    let f = setup();
    issue_week(&f);
    let mut t = tx(&f.env, "rental");
    t.signals.set(9, U256::from_u32(&f.env, 7));
    assert_eq!(f.send(&t), Err(Error::NextSecretHashMismatch));
}

#[test]
fn a_sale_without_a_next_secret_hash_is_rejected() {
    let f = setup();
    issue_week(&f);
    let mut t = tx(&f.env, "sale");
    t.signals.set(9, U256::from_u32(&f.env, 0));
    assert_eq!(f.send(&t), Err(Error::NextSecretHashMismatch));
}

#[test]
fn only_accounts_can_send_or_receive() {
    let f = setup();
    issue_week(&f);
    // A contract address has no Ed25519 key for a proof to bind.
    let mut t = tx(&f.env, "rental");
    t.to = f.contract_id.clone();
    assert_eq!(f.send(&t), Err(Error::NotAnAccount));
}

#[test]
fn a_right_cannot_be_issued_to_a_contract_address() {
    let f = setup();
    // `to_payload()` gives a contract address a ContractIdHash, not an Ed25519
    // key, so no proof could ever name it as the sender. Issuing to one would
    // create a week that can never be transferred; `issue` refuses instead.
    f.env.mock_all_auths();
    let (period, validity) = week();
    assert_eq!(
        f.client.try_issue(
            &Address::generate(&f.env),
            &period,
            &validity,
            &owner_commitment(&f.env)
        ),
        Err(Ok(Error::NotAnAccount))
    );
    assert_eq!(f.client.next_id(), 1);
}

// -------------------------------------------------------------------------
// who can prove — and the issuer is not among them
// -------------------------------------------------------------------------

#[test]
fn the_old_owner_cannot_prove_after_a_sale() {
    let f = setup();
    issue_week(&f);
    f.send(&tx(&f.env, "sale")).unwrap();
    // A fresh, valid proof for the commitment the old owner held — which the
    // sale replaced.
    assert_eq!(
        f.send(&tx(&f.env, "old_owner_resale")),
        Err(Error::CommitmentMismatch)
    );
}

#[test]
fn a_renter_cannot_sell() {
    let f = setup();
    issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();
    // The renter proves knowledge of a secret of their own, but the stored
    // commitment is the owner's.
    assert_eq!(
        f.send(&tx(&f.env, "renter_sale")),
        Err(Error::CommitmentMismatch)
    );
}

#[test]
fn issuer_authorization_without_a_proof_is_not_enough() {
    let f = setup();
    let right_id = issue_week(&f);
    // Phase 1's whole authorization: holder and issuer both sign. With a proof
    // that does not verify, it now moves nothing.
    let mut t = tx(&f.env, "sale");
    t.proof = Proof {
        a: t.proof.c.clone(),
        b: t.proof.b.clone(),
        c: t.proof.a.clone(),
    };
    assert_eq!(f.send(&t), Err(Error::InvalidProof));

    // With no proof material at all — zeros where the signals go.
    let mut zeros = Vec::new(&f.env);
    for _ in 0..11 {
        zeros.push_back(U256::from_u32(&f.env, 0));
    }
    let mut blank = tx(&f.env, "sale");
    blank.signals = zeros;
    assert_eq!(f.send(&blank), Err(Error::CommitmentMismatch));
    assert_eq!(f.client.holder(&right_id), f.owner);
}

#[test]
fn the_issuer_cannot_seize_a_held_right() {
    let f = setup();
    let right_id = issue_week(&f);
    let t = tx(&f.env, "sale");

    // The issuer signs a transfer of the owner's week to itself. The owner has
    // not signed, so `from.require_auth()` fails before anything else runs.
    f.env.mock_auths(&[MockAuth {
        address: &f.issuer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "transfer",
            args: (
                f.owner.clone(),
                f.issuer.clone(),
                right_id,
                None::<u64>,
                t.proof.clone(),
                t.signals.clone(),
            )
                .into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    // A host-level authorization failure, not a contract error: the owner's
    // signature is missing, so nothing past `from.require_auth()` ran.
    assert!(matches!(
        f.client
            .try_transfer(&f.owner, &f.issuer, &right_id, &None, &t.proof, &t.signals),
        Err(Err(_))
    ));
    assert_eq!(f.client.holder(&right_id), f.owner);
}

#[test]
fn the_issuer_cannot_seize_a_right_that_is_out_on_rental() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();

    let t = tx(&f.env, "sale");
    let mut grab = t.clone();
    grab.from = f.renter.clone();
    grab.to = f.issuer.clone();
    f.env.mock_auths(&[MockAuth {
        address: &f.issuer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "transfer",
            args: (
                grab.from.clone(),
                grab.to.clone(),
                right_id,
                None::<u64>,
                grab.proof.clone(),
                grab.signals.clone(),
            )
                .into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(matches!(
        f.client
            .try_transfer(&grab.from, &grab.to, &right_id, &None, &grab.proof, &grab.signals),
        Err(Err(_))
    ));
    assert_eq!(f.client.holder(&right_id), f.renter);
}

#[test]
fn the_issuer_cannot_burn_a_holders_right() {
    let f = setup();
    let right_id = issue_week(&f);
    f.env.mock_auths(&[MockAuth {
        address: &f.issuer,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "burn",
            args: (f.owner.clone(), right_id).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(matches!(f.client.try_burn(&f.owner, &right_id), Err(Err(_))));
    assert_eq!(f.client.holder(&right_id), f.owner);
}

#[test]
fn a_transfer_needs_no_fee_attestation() {
    let f = setup();
    let right_id = issue_week(&f);
    // The issuer has attested nothing about this week — there is no attestation
    // anywhere in the contract or the call — and the transfer goes through. The
    // fee attestation is for the buyer to read, never a gate the issuer could
    // close.
    assert_eq!(f.send(&tx(&f.env, "rental")), Ok(()));
    assert_eq!(f.client.holder(&right_id), f.renter);
}

#[test]
fn the_contract_has_no_upgrade_function() {
    let f = setup();
    issue_week(&f);
    f.env.mock_all_auths();
    let hash = BytesN::from_array(&f.env, &[7; 32]);
    let args: Vec<Val> = vec![&f.env, hash.into_val(&f.env)];
    let result = f.env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &f.contract_id,
        &Symbol::new(&f.env, "upgrade"),
        args,
    );
    assert!(result.is_err());
}

// -------------------------------------------------------------------------
// signatures: the holder's covers the whole transfer, the buyer's covers h'
// -------------------------------------------------------------------------

fn transfer_args(env: &Env, t: &Tx) -> Vec<Val> {
    (
        t.from.clone(),
        t.to.clone(),
        t.right_id,
        t.expires_at,
        t.proof.clone(),
        t.signals.clone(),
    )
        .into_val(env)
}

/// The signatures the host required for the last invocation: each signer and
/// the arguments of the `transfer` invocation it had to authorize.
///
/// `mock_auths` cannot stand in for a `G…` account, so these tests let every
/// signature through with `mock_all_auths` and then read back exactly which
/// ones the contract demanded. Soroban enforces that list as recorded: a
/// transaction missing any entry in it fails.
fn required_signatures(f: &Fixture) -> std::vec::Vec<(Address, Vec<Val>)> {
    f.env
        .auths()
        .into_iter()
        .map(|(address, invocation)| match invocation.function {
            soroban_sdk::testutils::AuthorizedFunction::Contract((contract, name, args)) => {
                assert_eq!(contract, f.contract_id);
                assert_eq!(name, Symbol::new(&f.env, "transfer"));
                (address, args)
            }
            other => panic!("unexpected authorization: {other:?}"),
        })
        .collect()
}

#[test]
fn a_sale_needs_the_holder_and_the_buyer_and_nobody_else() {
    let f = setup();
    issue_week(&f);
    let t = tx(&f.env, "sale");
    f.send(&t).unwrap();

    let buyer_args: Vec<Val> = (t.right_id, t.next_secret_hash.clone()).into_val(&f.env);
    assert_eq!(
        required_signatures(&f),
        std::vec![
            // The holder, over every argument of the transfer.
            (f.owner.clone(), transfer_args(&f.env, &t)),
            // The buyer, over the right and the next secret hash they chose.
            (f.buyer.clone(), buyer_args),
        ]
    );
    // And no issuer anywhere in it.
    assert!(required_signatures(&f).iter().all(|(a, _)| *a != f.issuer));
}

#[test]
fn a_rental_needs_only_the_holder() {
    let f = setup();
    issue_week(&f);
    let t = tx(&f.env, "rental");
    f.send(&t).unwrap();
    assert_eq!(
        required_signatures(&f),
        std::vec![(f.owner.clone(), transfer_args(&f.env, &t))]
    );
}

#[test]
fn a_seller_cannot_plant_the_next_secret_hash() {
    let f = setup();
    issue_week(&f);
    let honest = tx(&f.env, "sale");
    let planted = tx(&f.env, "sale_planted");

    // The seller submits a valid proof built on an h' of the seller's own
    // choosing. It would leave the buyer holding a week they could never prove
    // for — so the contract asks the *buyer* to sign that very h'.
    f.send(&planted).unwrap();
    let required = required_signatures(&f);
    let (signer, args) = &required[1];
    assert_eq!(*signer, f.buyer);
    assert_eq!(
        *args,
        (planted.right_id, planted.next_secret_hash.clone()).into_val(&f.env)
    );
    // A buyer who signed only their own h' has not signed this: the two differ,
    // and Soroban refuses a transfer whose required signature is missing.
    let honest_args: Vec<Val> = (honest.right_id, honest.next_secret_hash.clone()).into_val(&f.env);
    assert_ne!(*args, honest_args);
}

#[test]
fn the_holders_signature_covers_the_proof_it_was_given_with() {
    let f = setup();
    issue_week(&f);
    let t = tx(&f.env, "rental");
    f.send(&t).unwrap();
    // The holder's required signature is over the proof and every public signal,
    // so a signature given for one proof does not authorize another.
    let (_, args) = &required_signatures(&f)[0];
    assert_eq!(args.len(), 6);
    assert_eq!(args.slice(4..6), transfer_args(&f.env, &t).slice(4..6));
}

// -------------------------------------------------------------------------
// the replay guard outlives every proof it guards
// -------------------------------------------------------------------------

/// Testnet's settings (`stellar network settings --network testnet`): the
/// minimum temporary TTL equals the proof window, which is what makes the
/// explicit extension in `consume_transfer_proof` necessary.
fn testnet_ttls(f: &Fixture) {
    f.env.ledger().with_mut(|li| {
        li.min_temp_entry_ttl = 720;
        li.min_persistent_entry_ttl = 120_960;
        li.max_entry_ttl = 3_110_400;
    });
}

fn nullifier_live_until(f: &Fixture, t: &Tx) -> Option<u32> {
    let n: BytesN<32> = t.signals.get(1).unwrap().to_be_bytes().try_into().unwrap();
    let key = DataKey::Nullifier(n);
    f.env.as_contract(&f.contract_id, || {
        let storage = f.env.storage().temporary();
        storage
            .has(&key)
            .then(|| f.env.ledger().sequence() + storage.get_ttl(&key))
    })
}

#[test]
fn a_nullifier_spent_at_the_start_of_the_window_outlives_the_proof() {
    let f = setup();
    testnet_ttls(&f);
    issue_week(&f);
    // Valid through BASE_LEDGER + 720 — the full window — and spent at once.
    let t = tx(&f.env, "rental_edge");
    assert_eq!(f.send(&t), Ok(()));
    let deadline = BASE_LEDGER + 720;
    assert!(nullifier_live_until(&f, &t).unwrap() > deadline);

    // On the proof's last valid ledger the entry is still there, so the replay
    // is refused as a replay — not let through because the guard lapsed.
    f.at_ledger(deadline);
    assert!(nullifier_live_until(&f, &t).is_some());
    assert_eq!(f.send(&t), Err(Error::NullifierUsed));

    // One ledger later the proof is simply expired.
    f.at_ledger(deadline + 1);
    assert_eq!(f.send(&t), Err(Error::ProofExpired));
}

#[test]
fn a_proof_spent_on_its_last_valid_ledger_cannot_be_replayed() {
    let f = setup();
    testnet_ttls(&f);
    issue_week(&f);
    let t = tx(&f.env, "rental_edge");
    let deadline = BASE_LEDGER + 720;

    // Spent on the last ledger of its window...
    f.at_ledger(deadline);
    assert_eq!(f.send(&t), Ok(()));
    assert!(nullifier_live_until(&f, &t).unwrap() > deadline);
    // ...and refused if submitted again in that same ledger.
    assert_eq!(f.send(&t), Err(Error::NullifierUsed));
    f.at_ledger(deadline + 1);
    assert_eq!(f.send(&t), Err(Error::ProofExpired));
}

// -------------------------------------------------------------------------
// the holding-chain rules (Phase 1, unchanged), checked directly
//
// Under Phase 2 these cases cannot be reached through `transfer` with an honest
// proof — a renter has no secret, so no renter can prove — but the rules are
// still the contract's, and still guard every grant.
// -------------------------------------------------------------------------

#[test]
fn self_transfer_is_rejected() {
    let f = setup();
    let o = f.owner.clone();
    assert_eq!(
        grant(&f, &[(o.clone(), None)], &o, &o, None),
        Err(Error::SelfTransfer)
    );
}

#[test]
fn a_term_may_not_end_in_the_past_or_outlast_the_right() {
    let f = setup();
    let (o, r) = (f.owner.clone(), f.renter.clone());
    let now = f.env.ledger().timestamp();
    let title = [(o.clone(), None)];

    assert_eq!(grant(&f, &title, &o, &r, Some(now)), Err(Error::ExpiryInThePast));
    assert_eq!(grant(&f, &title, &o, &r, Some(now - 1)), Err(Error::ExpiryInThePast));
    assert_eq!(
        grant(&f, &title, &o, &r, Some(YEAR_END + 1)),
        Err(Error::ExpiryBeyondValidity)
    );
    // Exactly at the end of the validity window is allowed.
    assert!(grant(&f, &title, &o, &r, Some(YEAR_END)).is_ok());
}

#[test]
fn a_renter_cannot_grant_what_they_only_rent() {
    let f = setup();
    let (o, r, b) = (f.owner.clone(), f.renter.clone(), f.buyer.clone());
    let chain = [(o, None), (r.clone(), Some(WEEK_END))];
    // An open-ended grant would outlast the renter's own term.
    assert_eq!(grant(&f, &chain, &r, &b, None), Err(Error::ExpiryBeyondSenderTerm));
}

#[test]
fn a_sublet_cannot_outlast_the_renters_own_term() {
    let f = setup();
    let (o, r, s) = (f.owner.clone(), f.renter.clone(), f.stranger.clone());
    let chain = [(o, None), (r.clone(), Some(WEEK_START + DAY))];
    assert_eq!(
        grant(&f, &chain, &r, &s, Some(WEEK_START + 2 * DAY)),
        Err(Error::ExpiryBeyondSenderTerm)
    );
    assert!(grant(&f, &chain, &r, &s, Some(WEEK_START + DAY)).is_ok());
}

#[test]
fn a_lapsed_renter_is_not_the_holder() {
    let f = setup();
    let (o, r, s) = (f.owner.clone(), f.renter.clone(), f.stranger.clone());
    let chain = [(o, None), (r.clone(), Some(WEEK_END))];
    f.env.ledger().set_timestamp(WEEK_END + 1);
    assert_eq!(grant(&f, &chain, &r, &s, Some(YEAR_END - 1)), Err(Error::NotHolder));
    assert_eq!(grant(&f, &chain, &r, &s, None), Err(Error::NotHolder));
}

#[test]
fn the_holding_chain_is_bounded() {
    let f = setup();
    let mut chain = std::vec![(f.owner.clone(), None)];
    for _ in 1..MAX_HOLDING_DEPTH {
        chain.push((Address::generate(&f.env), Some(WEEK_END)));
    }
    let last = chain.last().unwrap().0.clone();
    assert_eq!(
        grant(&f, &chain, &last, &Address::generate(&f.env), Some(WEEK_END)),
        Err(Error::HoldingDepthExceeded)
    );
}

// -------------------------------------------------------------------------
// listing
// -------------------------------------------------------------------------

#[test]
fn a_holder_can_list_and_unlist() {
    let f = setup();
    let right_id = issue_week(&f);

    assert_eq!(f.client.get_listing(&right_id), None);

    f.client.list(&f.owner, &right_id, &None);
    let listing = f.client.get_listing(&right_id).unwrap();
    assert_eq!(listing.right_id, right_id);
    assert_eq!(listing.by, f.owner);
    assert_eq!(listing.term_secs, None);

    assert_eq!(
        f.client.try_list(&f.owner, &right_id, &None),
        Err(Ok(Error::AlreadyListed))
    );

    f.client.unlist(&f.owner, &right_id);
    assert_eq!(f.client.get_listing(&right_id), None);
    assert_eq!(f.client.try_unlist(&f.owner, &right_id), Err(Ok(Error::NotListed)));
}

#[test]
fn a_renter_may_offer_a_term_but_not_a_sale() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();

    // Offering the week open-ended would be offering title they do not hold.
    assert_eq!(
        f.client.try_list(&f.renter, &right_id, &None),
        Err(Ok(Error::NotTitleHolder))
    );
    // A term offer is still theirs to publish, as in Phase 1 — though without
    // the owner's secret no renter can prove a transfer to fill it.
    f.client.list(&f.renter, &right_id, &Some(2 * DAY));
    assert_eq!(f.client.get_listing(&right_id).unwrap().by, f.renter);
}

#[test]
fn a_zero_length_term_is_not_an_offer() {
    let f = setup();
    let right_id = issue_week(&f);
    assert_eq!(
        f.client.try_list(&f.owner, &right_id, &Some(0)),
        Err(Ok(Error::InvalidTerm))
    );
}

#[test]
fn a_transfer_supersedes_a_standing_offer() {
    let f = setup();
    let right_id = issue_week(&f);
    f.client.list(&f.owner, &right_id, &None);
    f.send(&tx(&f.env, "sale")).unwrap();
    assert_eq!(f.client.get_listing(&right_id), None);
}

#[test]
fn a_lapsed_renter_cannot_list_or_burn_the_week() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();
    f.env.ledger().set_timestamp(WEEK_END + 1);

    assert_eq!(
        f.client.try_list(&f.renter, &right_id, &Some(DAY)),
        Err(Ok(Error::NotHolder))
    );
    assert_eq!(
        f.client.try_burn(&f.renter, &right_id),
        Err(Ok(Error::NotHolder))
    );
}

// -------------------------------------------------------------------------
// burn
// -------------------------------------------------------------------------

#[test]
fn a_title_holder_can_burn_their_own_right() {
    let f = setup();
    let right_id = issue_week(&f);

    f.client.burn(&f.owner, &right_id);

    assert_eq!(f.client.balance(&f.owner), 0);
    assert_eq!(f.client.try_get_right(&right_id), Err(Ok(Error::RightNotFound)));
}

#[test]
fn a_right_cannot_be_burned_out_from_under_a_renter() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "rental")).unwrap();

    // The renter holds the week, so the owner is not the effective holder.
    assert_eq!(
        f.client.try_burn(&f.owner, &right_id),
        Err(Ok(Error::NotHolder))
    );
    // And the renter holds only a term, not title.
    assert_eq!(
        f.client.try_burn(&f.renter, &right_id),
        Err(Ok(Error::NotTitleHolder))
    );

    // After checkout the owner can burn it.
    f.env.ledger().set_timestamp(WEEK_END);
    assert_eq!(f.client.try_burn(&f.owner, &right_id), Ok(Ok(())));
}

// -------------------------------------------------------------------------
// what reaches the ledger
// -------------------------------------------------------------------------

#[test]
fn a_transfer_publishes_only_addresses_an_id_a_term_and_the_commitment() {
    let f = setup();
    let right_id = issue_week(&f);
    f.send(&tx(&f.env, "sale")).unwrap();

    // Comparing against the whole expected event proves there is no additional
    // field carrying record contents, the secret, or the nullifier. The record
    // appears only inside the opaque commitment — the buyer's, after a sale.
    let expected = Transferred {
        from: f.owner.clone(),
        to: f.buyer.clone(),
        right_id,
        expires_at: None,
        commitment: buyer_commitment(&f.env),
    };
    let published = f.env.events().all().filter_by_contract(&f.contract_id);
    assert_eq!(
        published.events().last(),
        Some(&expected.to_xdr(&f.env, &f.contract_id))
    );
}

#[test]
fn the_commitment_is_stored_verbatim_and_is_all_the_record_the_ledger_holds() {
    let f = setup();
    f.env.mock_all_auths();
    let (period, validity) = week();

    let right_id = f
        .client
        .issue(&f.owner, &period, &validity, &owner_commitment(&f.env));

    assert_eq!(f.client.commitment(&right_id), owner_commitment(&f.env));
}

// -------------------------------------------------------------------------
// cost
// -------------------------------------------------------------------------

/// Verification and transfer together, in one invocation — the flow approved in
/// Step 2. The local host budget uses the network's cost model; the figure on
/// testnet comes from simulating the deployed contract.
#[test]
fn cost_of_one_proven_sale() {
    let f = setup();
    issue_week(&f);
    let t = tx(&f.env, "sale");
    f.env.mock_all_auths();
    f.env.cost_estimate().budget().reset_unlimited();
    f.client
        .transfer(&t.from, &t.to, &t.right_id, &t.expires_at, &t.proof, &t.signals);
    let budget = f.env.cost_estimate().budget();
    std::println!(
        "local budget, one proven sale: cpu {} instructions, mem {} bytes",
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost()
    );
    assert!(budget.cpu_instruction_cost() < 400_000_000);
}
