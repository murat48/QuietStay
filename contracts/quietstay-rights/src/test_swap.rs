#![cfg(test)]
//! Phase 3 Step 4: swaps (docs/PHASE3_SPEC.md §7). Both sides carry real
//! Groth16 proofs from `npm run zk:test-fixtures` (`swap_taker`, `swap_maker`).
//!
//! The owner (maker) holds right 1 and wants right 2; the buyer (taker) holds
//! right 2. Each proof moves its week to the other side in mode
//! `2^64 + the week received`, with the other side's h'.

extern crate std;

use soroban_sdk::{BytesN, Env, U256};

use crate::test::{buyer_commitment, issue_week, owner_commitment, setup, tx, week, Fixture, Tx};

const SWAP_EXPIRES: u32 = crate::test::BASE_LEDGER + 1000;

fn key_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

struct Swap {
    id: u64,
    taker: Tx,
    maker: Tx,
}

/// Right 1 to the owner (issued by `issue_week`), right 2 to the buyer with
/// the buyer's commitment, then the two record requests and the offer.
fn offered(f: &Fixture) -> Swap {
    let taker = tx(&f.env, "swap_taker");
    let maker = tx(&f.env, "swap_maker");
    assert_eq!(issue_week(f), 1);
    let (period, validity) = week();
    f.env.mock_all_auths();
    assert_eq!(
        f.client
            .issue(&f.buyer, &period, &validity, &buyer_commitment(&f.env)),
        2
    );
    let maker_request = f
        .client
        .request_record(&f.owner, &2, &key_hash(&f.env, 1), &SWAP_EXPIRES);
    let id = f.client.offer_swap(
        &f.owner,
        &1,
        &2,
        &taker.next_secret_hash,
        &maker_request,
        &SWAP_EXPIRES,
    );
    Swap { id, taker, maker }
}

fn accepted(f: &Fixture) -> Swap {
    let s = offered(f);
    f.env.mock_all_auths();
    let taker_request = f
        .client
        .request_record(&f.buyer, &1, &key_hash(&f.env, 2), &SWAP_EXPIRES);
    f.client.accept_swap(
        &f.buyer,
        &s.id,
        &s.maker.next_secret_hash,
        &taker_request,
        &s.taker.proof,
        &s.taker.signals,
    );
    s
}

fn next_commitment(t: &Tx) -> BytesN<32> {
    let c: U256 = t.signals.get(10).unwrap();
    c.to_be_bytes().try_into().unwrap()
}

#[test]
fn a_swap_moves_both_rights_with_their_new_commitments_in_one_call() {
    let f = setup();
    let s = accepted(&f);
    // Accepting moved nothing.
    assert_eq!(f.client.holder(&1), f.owner);
    assert_eq!(f.client.holder(&2), f.buyer);
    assert_eq!(f.client.commitment(&1), owner_commitment(&f.env));

    f.env.mock_all_auths();
    f.client
        .complete_swap(&f.owner, &s.id, &s.maker.proof, &s.maker.signals);

    assert_eq!(f.client.holder(&1), f.buyer);
    assert_eq!(f.client.holder(&2), f.owner);
    assert_eq!(f.client.commitment(&1), next_commitment(&s.maker));
    assert_eq!(f.client.commitment(&2), next_commitment(&s.taker));
    assert_eq!(f.client.balance(&f.owner), 1);
    assert_eq!(f.client.balance(&f.buyer), 1);
    assert!(f.client.get_swap(&s.id).is_none());
    assert!(f.client.get_swap_acceptance(&s.id).is_none());
}

/// Step 4's first measurement, locally: the host budget of `complete_swap`
/// alone (two pairing checks, two transfers, the swap entries). The RPC's
/// simulation reports CPU but not memory, so memory comes from here, as in
/// Step 1. Printed with `cargo test -p quietstay-rights swap_cost -- --nocapture`.
#[test]
fn swap_cost_of_complete_swap_on_the_local_host_budget() {
    let f = setup();
    let s = accepted(&f);
    f.env.mock_all_auths();
    f.env.cost_estimate().budget().reset_unlimited();
    f.client
        .complete_swap(&f.owner, &s.id, &s.maker.proof, &s.maker.signals);
    let budget = f.env.cost_estimate().budget();
    std::println!(
        "local budget, complete_swap call only: cpu {} instructions, mem {} bytes",
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost()
    );
    assert_eq!(f.client.holder(&1), f.buyer);
}
