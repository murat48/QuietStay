#![no_std]
//! # QuietStay Phase 2 — standalone Groth16 verifier (Step 2)
//!
//! The verifier from `stellar/soroban-examples`
//! (`groth16_verifier/contracts/bls12_381_verifier`, commit `03d42aa`, Apache-2.0),
//! adapted in the two ways the Phase 2 brief requires and no others:
//!
//! 1. **The verification key is fixed at deployment.** The constructor stores it
//!    in instance storage. No function takes a key as an argument, and none can
//!    replace it — there is no setter and no `upgrade`.
//! 2. **Public signals must be canonical.** They arrive as `U256` and anything
//!    `>= r` is refused *before* conversion. `Bls12381Fr::from(U256)` in
//!    soroban-sdk 27.0.6 silently reduces modulo `r`, so `N` and `N + r` would
//!    verify identically while being different values to store — one nullifier
//!    under two encodings.
//!
//! The pairing equation and the `vk_x` accumulation are the example's, unchanged.
//!
//! This contract exists to measure verification on testnet and to give Week 1 its
//! first on-chain verification. Step 3 moves the same code into the rights
//! contract, behind `auth.rs`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Bls12381Fr, Bls12381G1Affine, Bls12381G2Affine},
    Bytes, Env, Vec, U256,
};

#[cfg(test)]
mod test;

/// The ownership proof has exactly this many public signals (docs/CIRCUIT.md §7).
pub const PUBLIC_SIGNALS: u32 = 11;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The key's `ic` does not have one point per public signal plus one.
    MalformedVerifyingKey = 1,
    /// Not exactly `PUBLIC_SIGNALS` public signals.
    WrongSignalCount = 2,
    /// A public signal is `>= r`.
    NonCanonicalSignal = 3,
}

#[derive(Clone)]
#[contracttype]
pub struct VerificationKey {
    pub alpha: Bls12381G1Affine,
    pub beta: Bls12381G2Affine,
    pub gamma: Bls12381G2Affine,
    pub delta: Bls12381G2Affine,
    pub ic: Vec<Bls12381G1Affine>,
}

#[derive(Clone)]
#[contracttype]
pub struct Proof {
    pub a: Bls12381G1Affine,
    pub b: Bls12381G2Affine,
    pub c: Bls12381G1Affine,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    VerificationKey,
}

// r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
const FR_MODULUS_BE: [u8; 32] = [
    0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48, 0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1, 0xd8, 0x05,
    0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
];

/// Each public signal as an `Fr`, after refusing any that is not below `r`.
pub fn canonical_signals(env: &Env, signals: &Vec<U256>) -> Result<Vec<Bls12381Fr>, Error> {
    let r = U256::from_be_bytes(env, &Bytes::from_array(env, &FR_MODULUS_BE));
    let mut out = Vec::new(env);
    for s in signals.iter() {
        if s >= r {
            return Err(Error::NonCanonicalSignal);
        }
        out.push_back(Bls12381Fr::from_u256(s));
    }
    Ok(out)
}

/// The soroban-examples pairing check, against a key the caller does not choose.
pub fn groth16_verify(
    env: &Env,
    vk: &VerificationKey,
    proof: &Proof,
    public_inputs: &Vec<Bls12381Fr>,
) -> Result<bool, Error> {
    if public_inputs.len() + 1 != vk.ic.len() {
        return Err(Error::MalformedVerifyingKey);
    }

    let bls = env.crypto().bls12_381();
    let mut vk_x = vk.ic.get(0).unwrap();
    for (signal, point) in public_inputs.iter().zip(vk.ic.iter().skip(1)) {
        let term = bls.g1_mul(&point, &signal);
        vk_x = bls.g1_add(&vk_x, &term);
    }

    let neg_a = -proof.a.clone();
    let lhs = soroban_sdk::vec![env, neg_a, vk.alpha.clone(), vk_x, proof.c.clone()];
    let rhs = soroban_sdk::vec![
        env,
        proof.b.clone(),
        vk.beta.clone(),
        vk.gamma.clone(),
        vk.delta.clone()
    ];

    Ok(bls.pairing_check(lhs, rhs))
}

#[contract]
pub struct QuietStayVerifier;

#[contractimpl]
impl QuietStayVerifier {
    /// Fix the verification key, once. There is no other way to set it.
    pub fn __constructor(env: Env, verification_key: VerificationKey) -> Result<(), Error> {
        if verification_key.ic.len() != PUBLIC_SIGNALS + 1 {
            return Err(Error::MalformedVerifyingKey);
        }
        env.storage()
            .instance()
            .set(&DataKey::VerificationKey, &verification_key);
        Ok(())
    }

    /// Verify one ownership proof against the key fixed at deployment.
    pub fn verify(env: Env, proof: Proof, public_signals: Vec<U256>) -> Result<bool, Error> {
        if public_signals.len() != PUBLIC_SIGNALS {
            return Err(Error::WrongSignalCount);
        }
        let inputs = canonical_signals(&env, &public_signals)?;
        let vk: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::VerificationKey)
            .unwrap();
        groth16_verify(&env, &vk, &proof, &inputs)
    }
}
