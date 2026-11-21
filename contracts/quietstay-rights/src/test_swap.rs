#![cfg(test)]
//! Phase 3 Step 4: swaps (docs/PHASE3_SPEC.md §7, D5). Every proof is a real
//! Groth16 proof from `npm run zk:test-fixtures`.
//!
//! The owner (maker) holds right 1 and wants right 2; the buyer (taker) holds
//! right 2. Each proof moves its week to the other side in mode
//! `2^64 + the week received`, with the other side's h'.
//!
//! Every refusal is checked to move nothing: both rights (holders, chain and
//! commitment), both title counts and the swap entries are compared before
//! and after.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, Env, IntoVal, Val, Vec, U256,
};

use crate::error::Error;
use crate::test::{
    buyer_commitment, issue_week, owner_commitment, setup, tx, week, Fixture, Tx, BASE_LEDGER,
    YEAR_END,
};
use crate::types::Right;

const SWAP_EXPIRES: u32 = BASE_LEDGER + 1000;

type Try<T, C> = Result<Result<T, C>, Result<Error, soroban_sdk::InvokeError>>;

fn res<T, C: core::fmt::Debug>(r: Try<T, C>) -> Result<T, Error> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Err(Ok(e)) => Err(e),
        Ok(Err(e)) => panic!("conversion error: {e:?}"),
        Err(Err(e)) => panic!("host failure: {e:?}"),
    }
}

/// The call failed in the host, not with a contract error: a missing
/// authorization.
fn host_refused<T, C>(r: Try<T, C>) -> bool {
    matches!(r, Err(Err(_)))
}

fn key_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn next_commitment(t: &Tx) -> BytesN<32> {
    let c: U256 = t.signals.get(10).unwrap();
    c.to_be_bytes().try_into().unwrap()
}

/// Everything a swap could change.
#[derive(Debug, PartialEq)]
struct Snap {
    rights: std::vec::Vec<Option<Right>>,
    titles: std::vec::Vec<i128>,
    swaps: std::vec::Vec<(bool, Option<(Address, u32)>)>,
}

fn snap(f: &Fixture) -> Snap {
    let next = f.client.next_swap_id();
    Snap {
        rights: (1..=2)
            .map(|id| f.client.try_get_right(&id).ok().and_then(|r| r.ok()))
            .collect(),
        titles: [&f.owner, &f.buyer, &f.renter, &f.stranger]
            .iter()
            .map(|a| f.client.balance(a))
            .collect(),
        swaps: (1..next)
            .map(|id| {
                (
                    f.client.get_swap(&id).is_some(),
                    f.client
                        .get_swap_acceptance(&id)
                        .map(|a| (a.taker, a.expiry_ledger)),
                )
            })
            .collect(),
    }
}

/// Right 2 to the buyer with the buyer's commitment (right 1 is the owner's,
/// from `issue_week`).
fn two_weeks(f: &Fixture) {
    assert_eq!(issue_week(f), 1);
    let (period, validity) = week();
    f.env.mock_all_auths();
    assert_eq!(
        f.client
            .issue(&f.buyer, &period, &validity, &buyer_commitment(&f.env)),
        2
    );
}

fn request(f: &Fixture, who: &Address, right: u64, byte: u8) -> u64 {
    f.env.mock_all_auths();
    f.client
        .request_record(who, &right, &key_hash(&f.env, byte), &SWAP_EXPIRES)
}

/// A swap offer from `maker` (giving `give` for `want`), with `h` as the
/// maker's h' for `want`.
fn offer(f: &Fixture, maker: &Address, give: u64, want: u64, h: &U256) -> u64 {
    let r = request(f, maker, want, 1);
    f.env.mock_all_auths();
    f.client
        .offer_swap(maker, &give, &want, h, &r, &SWAP_EXPIRES)
}

fn accept(f: &Fixture, taker: &Address, id: u64, h: &U256, proof: &Tx) -> Result<(), Error> {
    let give = f.client.get_swap(&id).unwrap().give_right;
    let r = request(f, taker, give, 2);
    f.env.mock_all_auths();
    res(f
        .client
        .try_accept_swap(taker, &id, h, &r, &proof.proof, &proof.signals))
}

fn complete(f: &Fixture, maker: &Address, id: u64, proof: &Tx) -> Result<(), Error> {
    f.env.mock_all_auths();
    res(f
        .client
        .try_complete_swap(maker, &id, &proof.proof, &proof.signals))
}

struct Swap {
    id: u64,
    taker: Tx,
    maker: Tx,
}

fn offered(f: &Fixture) -> Swap {
    let taker = tx(&f.env, "swap_taker");
    let maker = tx(&f.env, "swap_maker");
    two_weeks(f);
    let id = offer(f, &f.owner, 1, 2, &taker.next_secret_hash);
    Swap { id, taker, maker }
}

fn accepted(f: &Fixture) -> Swap {
    let s = offered(f);
    accept(f, &f.buyer, s.id, &s.maker.next_secret_hash, &s.taker).unwrap();
    s
}

/// `call` must fail with `expected` and leave everything as it was.
fn refused(f: &Fixture, expected: Error, call: impl FnOnce() -> Result<(), Error>) {
    let before = snap(f);
    assert_eq!(call(), Err(expected));
    assert_eq!(snap(f), before, "a refused call changed state");
}

// -------------------------------------------------------------------------
// the valid swap, and the cost measurement
// -------------------------------------------------------------------------

#[test]
fn a_swap_moves_both_rights_with_their_new_commitments_in_one_call() {
    let f = setup();
    let s = accepted(&f);
    // Accepting moved nothing.
    assert_eq!(f.client.holder(&1), f.owner);
    assert_eq!(f.client.holder(&2), f.buyer);
    assert_eq!(f.client.commitment(&1), owner_commitment(&f.env));

    complete(&f, &f.owner, s.id, &s.maker).unwrap();

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

/// Step 5: `complete_swap` priced with **each network's own cost parameters**.
///
/// Mainnet cannot be simulated before the contract is deployed there, and
/// mainnet (protocol 29) prices host work differently from testnet
/// (protocol 30). So the built WASM runs here in the VM, through the same
/// swap as Step 4; the host meters every cost type's iterations and inputs;
/// and the same metered work is priced with the `contract_cost_params_*`
/// read from each network (`stellar network settings --output json`, saved in
/// evidence/). Each charge is `const × n + (linear × input × n) >> 7`, as in
/// soroban-env-host's `MeteredCostComponent::evaluate`.
///
/// What it cannot show: a code path that differs between host versions. It
/// prices the protocol-27 host's metered work. The testnet figure is compared
/// with the RPC simulation, and the real mainnet `--send=no` simulation of
/// `complete_swap` is still run right after the Step 6 deployment, before any
/// swap transaction.
///
/// Needs the built WASM: `cd contracts && stellar contract build`, then
/// `cargo test -p quietstay-rights network_priced -- --ignored --nocapture`.
#[test]
#[ignore = "needs the built WASM and the saved network settings; run with --ignored"]
fn swap_cost_network_priced_from_the_wasm() {
    use sha2::{Digest, Sha256};
    use soroban_sdk::xdr::ContractCostType;

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let wasm = crate::test::built_wasm();
    let hash: std::string::String = Sha256::digest(wasm)
        .iter()
        .map(|b| std::format!("{b:02x}"))
        .collect();
    let date = std::env::var("QS_SETTINGS_DATE").unwrap_or_else(|_| "2026-11-21".into());
    let params = |net: &str, key: &str| -> std::vec::Vec<(u64, u64)> {
        let file = root.join(std::format!("evidence/network-settings-{net}-{date}.json"));
        let j: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let entry = j["updated_entry"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|e| e.get(key))
            .unwrap_or_else(|| panic!("{key} missing in {}", file.display()));
        let num = |v: &serde_json::Value| -> u64 {
            v.as_str()
                .map(|s| s.parse().unwrap())
                .or_else(|| v.as_u64())
                .unwrap()
        };
        entry
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (num(&p["const_term"]), num(&p["linear_term"])))
            .collect()
    };

    let f = crate::test::setup_wasm(wasm);
    let s = accepted(&f);
    f.env.mock_all_auths();
    let mut budget = f.env.cost_estimate().budget();
    budget.reset_unlimited();
    f.client
        .complete_swap(&f.owner, &s.id, &s.maker.proof, &s.maker.signals);
    // Read before any other call: every top-level invocation resets the budget.
    let budget = f.env.cost_estimate().budget();

    let types = ContractCostType::variants();
    let price = |p: &[(u64, u64)]| -> (u64, std::vec::Vec<(ContractCostType, u64)>) {
        let mut total = 0u64;
        let mut per = std::vec::Vec::new();
        for ty in types.iter() {
            let t = budget.tracker(*ty);
            let (c, l) = p
                .get(*ty as usize)
                .copied()
                .unwrap_or_else(|| panic!("no network parameter for cost type {ty:?}"));
            let lin = match t.inputs {
                Some(x) => ((l as u128 * x as u128) >> 7) as u64,
                None => 0,
            };
            let v = c * t.iterations + lin;
            total += v;
            per.push((*ty, v));
        }
        (total, per)
    };

    let host_cpu = budget.cpu_instruction_cost();
    let host_mem = budget.memory_bytes_cost();
    let tracked: u64 = types.iter().map(|ty| budget.tracker(*ty).cpu).sum();
    let (tn_cpu, tn_per) = price(&params("testnet", "contract_cost_params_cpu_instructions"));
    let (mn_cpu, mn_per) = price(&params("mainnet", "contract_cost_params_cpu_instructions"));
    let (tn_mem, _) = price(&params("testnet", "contract_cost_params_memory_bytes"));
    let (mn_mem, _) = price(&params("mainnet", "contract_cost_params_memory_bytes"));

    std::println!("wasm sha256 {hash} ({} bytes), settings {date}", wasm.len());
    std::println!("complete_swap in the VM, this host's own parameters: cpu {host_cpu}, mem {host_mem} (per-type sum {tracked})");
    std::println!("priced with testnet's parameters: cpu {tn_cpu}, mem {tn_mem}");
    std::println!("priced with mainnet's parameters: cpu {mn_cpu}, mem {mn_mem}");
    std::println!(
        "mainnet / testnet: cpu {:.4}, mem {:.4}",
        mn_cpu as f64 / tn_cpu as f64,
        mn_mem as f64 / tn_mem as f64
    );
    std::println!("cost types that differ (testnet → mainnet cpu):");
    for ((ty, a), (_, b)) in tn_per.iter().zip(mn_per.iter()) {
        if a != b {
            std::println!("  {ty:?}: {a} → {b}");
        }
    }
    // Both must stay inside the per-transaction limits, read from the same files.
    assert!(mn_cpu < 400_000_000 && tn_cpu < 400_000_000);
    assert!(mn_mem < 41_943_040 && tn_mem < 41_943_040);
    // The swap really happened (this call resets the budget, so it comes last).
    assert_eq!(f.client.holder(&1), f.buyer);
    assert_eq!(f.client.holder(&2), f.owner);
}

// -------------------------------------------------------------------------
// one side expired
// -------------------------------------------------------------------------

#[test]
fn a_swap_of_an_expired_right_is_refused_and_moves_nothing() {
    let f = setup();
    let s = accepted(&f);
    // Both weeks' validity ends at YEAR_END; the proofs are still in their
    // ledger window.
    f.env.ledger().set_timestamp(YEAR_END);
    refused(&f, Error::RightExpired, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
}

#[test]
fn an_expired_maker_proof_is_refused_and_the_taker_side_is_reverted() {
    let f = setup();
    let s = accepted(&f);
    let short = tx(&f.env, "swap_maker_short");
    f.at_ledger(BASE_LEDGER + 101);
    // The taker's leg runs first and would pass; the maker's refusal reverts it.
    refused(&f, Error::ProofExpired, || {
        complete(&f, &f.owner, s.id, &short)
    });
    assert_eq!(f.client.holder(&2), f.buyer);
}

#[test]
fn an_acceptance_lapses_with_the_takers_proof() {
    let f = setup();
    let s = accepted(&f);
    // swap_taker is valid through BASE_LEDGER + 360.
    f.at_ledger(BASE_LEDGER + 361);
    assert!(f.client.get_swap(&s.id).is_some());
    refused(&f, Error::AcceptanceNotFound, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
}

#[test]
fn an_expired_swap_offer_can_be_neither_accepted_nor_completed() {
    let f = setup();
    let s = offered(&f);
    let taker_request = request(&f, &f.buyer, 1, 2);
    f.at_ledger(SWAP_EXPIRES + 1);
    refused(&f, Error::SwapExpired, || {
        f.env.mock_all_auths();
        res(f.client.try_accept_swap(
            &f.buyer,
            &s.id,
            &s.maker.next_secret_hash,
            &taker_request,
            &s.taker.proof,
            &s.taker.signals,
        ))
    });
    refused(&f, Error::SwapExpired, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
}

// -------------------------------------------------------------------------
// rented out (D5: nothing is locked between accept and complete)
// -------------------------------------------------------------------------

#[test]
fn the_taker_renting_out_their_week_after_accepting_makes_completion_fail() {
    let f = setup();
    let s = accepted(&f);
    f.send(&tx(&f.env, "rental_by_buyer_r2")).unwrap();
    assert_eq!(f.client.holder(&2), f.renter);
    refused(&f, Error::NotHolder, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
    assert_eq!(f.client.holder(&1), f.owner);
}

#[test]
fn the_maker_renting_out_their_week_after_the_acceptance_makes_completion_fail() {
    let f = setup();
    let s = accepted(&f);
    f.send(&tx(&f.env, "rental")).unwrap();
    // The taker's leg would pass; the maker's NotHolder reverts it.
    refused(&f, Error::NotHolder, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
    assert_eq!(f.client.holder(&2), f.buyer);
}

#[test]
fn a_rented_out_week_cannot_be_offered_in_a_swap() {
    let f = setup();
    let taker = tx(&f.env, "swap_taker");
    two_weeks(&f);
    f.send(&tx(&f.env, "rental")).unwrap();
    let r = request(&f, &f.owner, 2, 1);
    refused(&f, Error::NotHolder, || {
        f.env.mock_all_auths();
        res(f
            .client
            .try_offer_swap(&f.owner, &1, &2, &taker.next_secret_hash, &r, &SWAP_EXPIRES))
        .map(|_| ())
    });
}

// -------------------------------------------------------------------------
// already transferred
// -------------------------------------------------------------------------

#[test]
fn the_taker_selling_their_week_after_accepting_makes_completion_fail() {
    let f = setup();
    let s = accepted(&f);
    f.send(&tx(&f.env, "sale_by_buyer_r2")).unwrap();
    assert_eq!(f.client.holder(&2), f.stranger);
    refused(&f, Error::CommitmentMismatch, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
}

#[test]
fn the_maker_selling_their_week_after_the_acceptance_makes_completion_fail() {
    let f = setup();
    let s = accepted(&f);
    f.send(&tx(&f.env, "sale")).unwrap();
    refused(&f, Error::CommitmentMismatch, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
    assert_eq!(f.client.holder(&2), f.buyer);
}

// -------------------------------------------------------------------------
// belonging to someone else
// -------------------------------------------------------------------------

#[test]
fn someone_else_cannot_accept_with_the_holders_proof() {
    let f = setup();
    let s = offered(&f);
    let r = request(&f, &f.stranger, 1, 3);
    refused(&f, Error::WrongAccount, || {
        f.env.mock_all_auths();
        res(f.client.try_accept_swap(
            &f.stranger,
            &s.id,
            &s.maker.next_secret_hash,
            &r,
            &s.taker.proof,
            &s.taker.signals,
        ))
    });
}

#[test]
fn someone_else_cannot_accept_with_a_proof_of_their_own() {
    let f = setup();
    let s = offered(&f);
    let own = tx(&f.env, "swap_stranger_taker");
    let r = request(&f, &f.stranger, 1, 3);
    refused(&f, Error::CommitmentMismatch, || {
        f.env.mock_all_auths();
        res(f.client.try_accept_swap(
            &f.stranger,
            &s.id,
            &s.maker.next_secret_hash,
            &r,
            &own.proof,
            &own.signals,
        ))
    });
}

#[test]
fn a_week_the_maker_does_not_hold_cannot_be_offered() {
    let f = setup();
    two_weeks(&f);
    let r = request(&f, &f.stranger, 2, 3);
    let h = tx(&f.env, "swap_taker").next_secret_hash;
    refused(&f, Error::NotHolder, || {
        f.env.mock_all_auths();
        res(f
            .client
            .try_offer_swap(&f.stranger, &1, &2, &h, &r, &SWAP_EXPIRES))
        .map(|_| ())
    });
}

#[test]
fn only_the_maker_completes_and_only_the_taker_withdraws() {
    let f = setup();
    let s = accepted(&f);
    refused(&f, Error::NotSwapParty, || {
        complete(&f, &f.buyer, s.id, &s.maker)
    });
    refused(&f, Error::NotSwapParty, || {
        f.env.mock_all_auths();
        res(f.client.try_withdraw_swap_acceptance(&f.owner, &s.id))
    });
    refused(&f, Error::NotSwapParty, || {
        f.env.mock_all_auths();
        res(f.client.try_cancel_swap(&f.buyer, &s.id))
    });
}

// -------------------------------------------------------------------------
// a reused proof
// -------------------------------------------------------------------------

#[test]
fn a_completed_swap_cannot_be_completed_again() {
    let f = setup();
    let s = accepted(&f);
    complete(&f, &f.owner, s.id, &s.maker).unwrap();
    refused(&f, Error::SwapNotFound, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
}

#[test]
fn a_swap_proof_replayed_after_a_swap_back_is_refused_by_its_nullifier() {
    // Swap, then swap back with each side's original h: both commitments are
    // what they were, so the first swap's proofs match them again. Only the
    // spent nullifier stops the replay.
    let f = setup();
    let s = accepted(&f);
    complete(&f, &f.owner, s.id, &s.maker).unwrap();

    let back_taker = tx(&f.env, "swap_back_taker");
    let back_maker = tx(&f.env, "swap_back_maker");
    let back = offer(&f, &f.owner, 2, 1, &back_taker.next_secret_hash);
    accept(
        &f,
        &f.buyer,
        back,
        &back_maker.next_secret_hash,
        &back_taker,
    )
    .unwrap();
    complete(&f, &f.owner, back, &back_maker).unwrap();
    assert_eq!(f.client.commitment(&1), owner_commitment(&f.env));
    assert_eq!(f.client.commitment(&2), buyer_commitment(&f.env));

    // The same swap again, with the first swap's taker proof.
    let again = offer(&f, &f.owner, 1, 2, &s.taker.next_secret_hash);
    let r = request(&f, &f.buyer, 1, 2);
    refused(&f, Error::NullifierUsed, || {
        f.env.mock_all_auths();
        res(f.client.try_accept_swap(
            &f.buyer,
            &again,
            &s.maker.next_secret_hash,
            &r,
            &s.taker.proof,
            &s.taker.signals,
        ))
    });
}

#[test]
fn a_swap_proof_cannot_be_used_as_a_sale() {
    // The mode separates them: a swap proof carries 2^64 + the counter week.
    let f = setup();
    two_weeks(&f);
    let maker = tx(&f.env, "swap_maker");
    let as_sale = Tx {
        expires_at: None,
        ..maker
    };
    refused(&f, Error::ModeMismatch, || f.send(&as_sale));
}

// -------------------------------------------------------------------------
// acceptances, withdrawal, the burn guard (D11), record requests (D4a)
// -------------------------------------------------------------------------

#[test]
fn a_withdrawn_acceptance_cannot_be_completed_and_the_offer_stays_open() {
    let f = setup();
    let s = accepted(&f);
    f.env.mock_all_auths();
    f.client.withdraw_swap_acceptance(&f.buyer, &s.id);
    assert!(f.client.get_swap_acceptance(&s.id).is_none());
    assert!(f.client.get_swap(&s.id).is_some());
    refused(&f, Error::AcceptanceNotFound, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
    // A new acceptance with the same, never-spent proof is allowed.
    accept(&f, &f.buyer, s.id, &s.maker.next_secret_hash, &s.taker).unwrap();
    complete(&f, &f.owner, s.id, &s.maker).unwrap();
    assert_eq!(f.client.holder(&2), f.owner);
}

#[test]
fn a_second_acceptance_is_refused_while_one_is_live() {
    let f = setup();
    let s = accepted(&f);
    let r = request(&f, &f.buyer, 1, 4);
    refused(&f, Error::SwapAlreadyAccepted, || {
        f.env.mock_all_auths();
        res(f.client.try_accept_swap(
            &f.buyer,
            &s.id,
            &s.maker.next_secret_hash,
            &r,
            &s.taker.proof,
            &s.taker.signals,
        ))
    });
}

#[test]
fn a_cancelled_swap_drops_its_acceptance() {
    let f = setup();
    let s = accepted(&f);
    f.env.mock_all_auths();
    f.client.cancel_swap(&f.owner, &s.id);
    assert!(f.client.get_swap(&s.id).is_none());
    assert!(f.client.get_swap_acceptance(&s.id).is_none());
    refused(&f, Error::SwapNotFound, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
}

#[test]
fn burn_is_refused_on_both_weeks_while_an_acceptance_is_pending() {
    let f = setup();
    let s = accepted(&f);
    for (who, right) in [(&f.buyer, 2u64), (&f.owner, 1u64)] {
        refused(&f, Error::SwapPending, || {
            f.env.mock_all_auths();
            res(f.client.try_burn(who, &right))
        });
    }
    f.env.mock_all_auths();
    f.client.withdraw_swap_acceptance(&f.buyer, &s.id);
    f.client.burn(&f.buyer, &2);
    assert!(f.client.try_get_right(&2).is_err());
}

#[test]
fn burn_is_allowed_again_once_the_acceptance_lapses() {
    let f = setup();
    accepted(&f);
    f.at_ledger(BASE_LEDGER + 361);
    f.env.mock_all_auths();
    f.client.burn(&f.owner, &1);
}

#[test]
fn each_side_must_bring_its_own_record_request_for_the_other_week() {
    let f = setup();
    let taker = tx(&f.env, "swap_taker");
    let maker = tx(&f.env, "swap_maker");
    two_weeks(&f);
    // The maker's request must be for want_right (2), and the maker's own.
    let wrong = request(&f, &f.owner, 1, 1);
    refused(&f, Error::RequestRightMismatch, || {
        f.env.mock_all_auths();
        res(f.client.try_offer_swap(
            &f.owner,
            &1,
            &2,
            &taker.next_secret_hash,
            &wrong,
            &SWAP_EXPIRES,
        ))
        .map(|_| ())
    });
    let buyers = request(&f, &f.buyer, 2, 2);
    refused(&f, Error::NotRequester, || {
        f.env.mock_all_auths();
        res(f.client.try_offer_swap(
            &f.owner,
            &1,
            &2,
            &taker.next_secret_hash,
            &buyers,
            &SWAP_EXPIRES,
        ))
        .map(|_| ())
    });

    // Both directions: the maker's request for 2 is consumed by the offer,
    // the taker's for 1 by the acceptance.
    let maker_request = request(&f, &f.owner, 2, 1);
    f.env.mock_all_auths();
    let id = f.client.offer_swap(
        &f.owner,
        &1,
        &2,
        &taker.next_secret_hash,
        &maker_request,
        &SWAP_EXPIRES,
    );
    assert!(f.client.get_record_request(&maker_request).is_none());
    assert_eq!(
        f.client.get_swap(&id).unwrap().maker_key_hash,
        key_hash(&f.env, 1)
    );

    // The taker's request must be for give_right (1).
    let wrong = request(&f, &f.buyer, 2, 2);
    refused(&f, Error::RequestRightMismatch, || {
        f.env.mock_all_auths();
        res(f.client.try_accept_swap(
            &f.buyer,
            &id,
            &maker.next_secret_hash,
            &wrong,
            &taker.proof,
            &taker.signals,
        ))
    });
    let taker_request = request(&f, &f.buyer, 1, 5);
    f.env.mock_all_auths();
    f.client.accept_swap(
        &f.buyer,
        &id,
        &maker.next_secret_hash,
        &taker_request,
        &taker.proof,
        &taker.signals,
    );
    assert!(f.client.get_record_request(&taker_request).is_none());
    assert_eq!(
        f.client.get_swap_acceptance(&id).unwrap().taker_key_hash,
        key_hash(&f.env, 5)
    );
}

#[test]
fn the_wrong_h_prime_on_either_side_is_refused() {
    let f = setup();
    let s = offered(&f);
    // The taker's proof carries the maker's h' from the offer; an offer with
    // another h' does not match it.
    let other = offer(&f, &f.owner, 1, 2, &s.maker.next_secret_hash);
    let r = request(&f, &f.buyer, 1, 2);
    refused(&f, Error::NextSecretHashMismatch, || {
        f.env.mock_all_auths();
        res(f.client.try_accept_swap(
            &f.buyer,
            &other,
            &s.maker.next_secret_hash,
            &r,
            &s.taker.proof,
            &s.taker.signals,
        ))
    });
    // The maker's proof must carry the taker's h' from the acceptance.
    accept(&f, &f.buyer, s.id, &s.taker.next_secret_hash, &s.taker).unwrap();
    refused(&f, Error::NextSecretHashMismatch, || {
        complete(&f, &f.owner, s.id, &s.maker)
    });
}

// -------------------------------------------------------------------------
// outside accounts (deferred from Step 3)
// -------------------------------------------------------------------------

fn only_signs(f: &Fixture, who: &Address, fn_name: &'static str, args: Vec<Val>) {
    f.env.mock_auths(&[MockAuth {
        address: who,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

#[test]
fn an_outside_account_cannot_move_a_right_through_any_swap_function() {
    let f = setup();
    let out = Address::generate(&f.env);
    // Builder state: an accepted swap (1 ↔ 2) and a second, open offer.
    let s = accepted(&f);
    let open = offer(&f, &f.owner, 1, 2, &s.taker.next_secret_hash);
    let before = snap(&f);

    // With the outsider's own signature: each refused, nothing moves.
    let out_req_2 = request(&f, &out, 2, 9);
    let out_req_1 = request(&f, &out, 1, 9);
    f.env.mock_all_auths();
    let errs = [
        res(f.client.try_offer_swap(
            &out,
            &1,
            &2,
            &s.taker.next_secret_hash,
            &out_req_2,
            &SWAP_EXPIRES,
        ))
        .map(|_| ()),
        res(f.client.try_cancel_swap(&out, &s.id)),
        res(f.client.try_accept_swap(
            &out,
            &open,
            &s.maker.next_secret_hash,
            &out_req_1,
            &s.taker.proof,
            &s.taker.signals,
        )),
        res(f.client.try_withdraw_swap_acceptance(&out, &s.id)),
        res(f
            .client
            .try_complete_swap(&out, &s.id, &s.maker.proof, &s.maker.signals)),
    ];
    assert_eq!(
        errs,
        [
            Err(Error::NotHolder),
            Err(Error::NotSwapParty),
            Err(Error::WrongAccount),
            Err(Error::NotSwapParty),
            Err(Error::NotSwapParty),
        ]
    );
    assert_eq!(snap(&f), before);

    // Naming a builder account, signed only by the outsider: the host
    // refuses each for the missing signature.
    let e = &f.env;
    let maker_req = request(&f, &f.owner, 2, 1);
    let taker_req = request(&f, &f.buyer, 1, 2);
    let snap_named = snap(&f);
    let h_t = s.taker.next_secret_hash.clone();
    let h_m = s.maker.next_secret_hash.clone();
    only_signs(
        &f,
        &out,
        "offer_swap",
        vec![
            e,
            f.owner.into_val(e),
            1u64.into_val(e),
            2u64.into_val(e),
            h_t.into_val(e),
            maker_req.into_val(e),
            SWAP_EXPIRES.into_val(e),
        ],
    );
    assert!(host_refused(f.client.try_offer_swap(
        &f.owner,
        &1,
        &2,
        &h_t,
        &maker_req,
        &SWAP_EXPIRES
    )));
    only_signs(
        &f,
        &out,
        "cancel_swap",
        vec![e, f.owner.into_val(e), s.id.into_val(e)],
    );
    assert!(host_refused(f.client.try_cancel_swap(&f.owner, &s.id)));
    only_signs(
        &f,
        &out,
        "accept_swap",
        vec![
            e,
            f.buyer.into_val(e),
            open.into_val(e),
            h_m.into_val(e),
            taker_req.into_val(e),
            s.taker.proof.into_val(e),
            s.taker.signals.into_val(e),
        ],
    );
    assert!(host_refused(f.client.try_accept_swap(
        &f.buyer,
        &open,
        &h_m,
        &taker_req,
        &s.taker.proof,
        &s.taker.signals
    )));
    only_signs(
        &f,
        &out,
        "withdraw_swap_acceptance",
        vec![e, f.buyer.into_val(e), s.id.into_val(e)],
    );
    assert!(host_refused(
        f.client.try_withdraw_swap_acceptance(&f.buyer, &s.id)
    ));
    only_signs(
        &f,
        &out,
        "complete_swap",
        vec![
            e,
            f.owner.into_val(e),
            s.id.into_val(e),
            s.maker.proof.into_val(e),
            s.maker.signals.into_val(e),
        ],
    );
    assert!(host_refused(f.client.try_complete_swap(
        &f.owner,
        &s.id,
        &s.maker.proof,
        &s.maker.signals
    )));
    assert_eq!(snap(&f), snap_named);

    // The builder's swap is intact and completes with the builder's action.
    complete(&f, &f.owner, s.id, &s.maker).unwrap();
    assert_eq!(f.client.holder(&2), f.owner);
}
