//! Fixtures are real: `tests/data/verification_key.soroban.json` is the committed
//! development key in the contract's byte layout (`npm run zk:encode-vk`), and
//! `tests/data/sale.json` is a proof made by the CLI prover (`npm run zk:prove`)
//! for a sale of sample week 01. If either encoding were wrong, the honest case
//! below would fail.

extern crate std;

use soroban_sdk::{
    crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine},
    Bytes, Env, Vec, U256,
};

use crate::{Error, Proof, QuietStayVerifier, QuietStayVerifierClient, VerificationKey};

const VK: &str = include_str!("../tests/data/verification_key.soroban.json");
const SALE: &str = include_str!("../tests/data/sale.json");

fn unhex<const N: usize>(s: &str) -> [u8; N] {
    assert_eq!(s.len(), N * 2, "hex length");
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
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

fn vk(env: &Env) -> VerificationKey {
    let j: serde_json::Value = serde_json::from_str(VK).unwrap();
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

fn sale(env: &Env) -> (Proof, Vec<U256>) {
    let j: serde_json::Value = serde_json::from_str(SALE).unwrap();
    let proof = Proof {
        a: g1(env, &j["proof"]["a"]),
        b: g2(env, &j["proof"]["b"]),
        c: g1(env, &j["proof"]["c"]),
    };
    let mut signals = Vec::new(env);
    for s in j["public_signals_hex"].as_array().unwrap() {
        signals.push_back(u256(env, s.as_str().unwrap()));
    }
    (proof, signals)
}

fn deploy(env: &Env) -> QuietStayVerifierClient<'_> {
    let id = env.register(QuietStayVerifier, (vk(env),));
    QuietStayVerifierClient::new(env, &id)
}

/// `r`, the scalar field modulus, as a U256.
fn r(env: &Env) -> U256 {
    u256(
        env,
        "73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001",
    )
}

#[test]
fn honest_proof_verifies() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let client = deploy(&env);
    let (proof, signals) = sale(&env);
    // Count the verify call alone, not deployment or building the fixtures.
    env.cost_estimate().budget().reset_unlimited();
    assert!(client.verify(&proof, &signals));

    let budget = env.cost_estimate().budget();
    std::println!(
        "local budget, verify call only: cpu {} instructions, mem {} bytes",
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost()
    );
}

#[test]
fn a_changed_public_signal_fails() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let client = deploy(&env);
    let (proof, signals) = sale(&env);
    // Signal 3 is right_id: the same proof presented for right #2.
    let mut moved = signals.clone();
    moved.set(2, U256::from_u32(&env, 2));
    assert!(!client.verify(&proof, &moved));
}

#[test]
fn a_tampered_proof_fails() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let client = deploy(&env);
    let (proof, signals) = sale(&env);
    // Valid curve points, wrong proof: swap A and C.
    let swapped = Proof {
        a: proof.c.clone(),
        b: proof.b.clone(),
        c: proof.a.clone(),
    };
    assert!(!client.verify(&swapped, &signals));
}

#[test]
fn a_non_canonical_signal_is_refused_before_verification() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let client = deploy(&env);
    let (proof, signals) = sale(&env);
    // The nullifier plus r: the SDK would reduce it back to the same field
    // element, so without this check it would verify — under a second encoding.
    let mut aliased = signals.clone();
    let n = signals.get(1).unwrap();
    aliased.set(1, n.add(&r(&env)));
    assert_eq!(
        client.try_verify(&proof, &aliased),
        Err(Ok(Error::NonCanonicalSignal))
    );
}

#[test]
fn the_wrong_number_of_signals_is_refused() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let client = deploy(&env);
    let (proof, signals) = sale(&env);
    let mut short = signals.clone();
    short.pop_back();
    assert_eq!(
        client.try_verify(&proof, &short),
        Err(Ok(Error::WrongSignalCount))
    );
}

#[test]
#[should_panic]
fn a_key_with_the_wrong_number_of_points_cannot_be_deployed() {
    let env = Env::default();
    let mut key = vk(&env);
    key.ic.pop_back();
    env.register(QuietStayVerifier, (key,));
}
