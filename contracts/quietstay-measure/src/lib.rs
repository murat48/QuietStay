#![no_std]
//! # Measurement only — two proof verifications in one transaction
//!
//! Phase 3 Step 1, item 11 of docs/PHASE3_PROMPT.md: does a swap, which must
//! verify two ownership proofs in one transaction, fit within Soroban's
//! per-transaction limits? This contract runs the rights contract's own
//! verifier module (included by path, not copied) twice in one call, so a
//! `--send=no` simulation reports the cost of exactly that.
//!
//! It is not part of the product: it moves nothing, stores only the
//! verification key, and is deployed to testnet once for the measurement.
//! Step 4 repeats the measurement on the integrated contract.

use soroban_sdk::{contract, contractimpl, contracttype, Env, Vec, U256};

#[path = "../../quietstay-rights/src/verifier.rs"]
mod verifier;

use verifier::{Proof, VerificationKey};

#[contracttype]
#[derive(Clone)]
enum DataKey {
    VerificationKey,
}

#[contract]
pub struct QuietStayMeasure;

#[contractimpl]
impl QuietStayMeasure {
    pub fn __constructor(env: Env, verification_key: VerificationKey) {
        assert!(verification_key.ic.len() == verifier::PUBLIC_SIGNALS + 1);
        env.storage()
            .instance()
            .set(&DataKey::VerificationKey, &verification_key);
    }

    /// Verify two proofs against the fixed key, with the same canonical-signal
    /// check `auth.rs` applies. Returns whether both verified.
    pub fn verify_two(
        env: Env,
        proof_a: Proof,
        signals_a: Vec<U256>,
        proof_b: Proof,
        signals_b: Vec<U256>,
    ) -> bool {
        let vk: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::VerificationKey)
            .unwrap();
        let r = verifier::modulus(&env);
        for s in signals_a.iter().chain(signals_b.iter()) {
            assert!(s < r);
        }
        let a = verifier::verify(&env, &vk, &proof_a, &signals_a);
        let b = verifier::verify(&env, &vk, &proof_b, &signals_b);
        a && b
    }
}

#[cfg(test)]
mod test {
    //! Local host budget for the same two-proof call: the RPC does not report
    //! memory, so memory comes from here (`cargo test -p quietstay-measure -- --nocapture`).
    extern crate std;
    use super::*;
    use soroban_sdk::{
        crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine},
        Bytes,
    };

    const VK: &str = include_str!("../../quietstay-rights/tests/fixtures/verification_key.soroban.json");
    const SALE: &str = include_str!("../../quietstay-rights/tests/fixtures/sale.json");
    const RENTAL: &str = include_str!("../../quietstay-rights/tests/fixtures/rental.json");

    fn unhex<const N: usize>(s: &str) -> [u8; N] {
        let mut out = [0u8; N];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }
    fn g1(env: &Env, v: &serde_json::Value) -> Bls12381G1Affine {
        Bls12381G1Affine::from_array(env, &unhex::<96>(v.as_str().unwrap()))
    }
    fn g2(env: &Env, v: &serde_json::Value) -> Bls12381G2Affine {
        Bls12381G2Affine::from_array(env, &unhex::<192>(v.as_str().unwrap()))
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
    fn fixture(env: &Env, text: &str) -> (Proof, Vec<U256>) {
        let j: serde_json::Value = serde_json::from_str(text).unwrap();
        let proof = Proof {
            a: g1(env, &j["proof"]["a"]),
            b: g2(env, &j["proof"]["b"]),
            c: g1(env, &j["proof"]["c"]),
        };
        let mut signals = Vec::new(env);
        for s in j["signals"].as_array().unwrap() {
            signals.push_back(U256::from_be_bytes(
                env,
                &Bytes::from_array(env, &unhex::<32>(s.as_str().unwrap())),
            ));
        }
        (proof, signals)
    }

    #[test]
    fn two_proofs_in_one_call() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let id = env.register(QuietStayMeasure, (vk(&env),));
        let client = QuietStayMeasureClient::new(&env, &id);
        let (pa, sa) = fixture(&env, SALE);
        let (pb, sb) = fixture(&env, RENTAL);
        env.cost_estimate().budget().reset_unlimited();
        assert!(client.verify_two(&pa, &sa, &pb, &sb));
        let budget = env.cost_estimate().budget();
        std::println!(
            "local budget, verify_two call only: cpu {} instructions, mem {} bytes",
            budget.cpu_instruction_cost(),
            budget.memory_bytes_cost()
        );
    }
}
