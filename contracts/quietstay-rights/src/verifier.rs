//! Groth16 verification over BLS12-381.
//!
//! The pairing check from `stellar/soroban-examples`
//! (`groth16_verifier/contracts/bls12_381_verifier`, commit `03d42aa`,
//! Apache-2.0), unchanged in substance. It is the same code the standalone
//! `quietstay-verifier` contract measured on testnet in Step 2; it lives here
//! as a module rather than a dependency because a contract crate pulled in as a
//! library would export its own entry points into this WASM.
//!
//! The key is never a caller's choice: `auth.rs` passes the one fixed at
//! deployment.

use soroban_sdk::{
    contracttype,
    crypto::bls12_381::{Bls12381Fr, Bls12381G1Affine, Bls12381G2Affine},
    Bytes, Env, Vec, U256,
};

/// The ownership proof has exactly this many public signals (docs/CIRCUIT.md §7).
pub const PUBLIC_SIGNALS: u32 = 11;

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

// r = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
const FR_MODULUS_BE: [u8; 32] = [
    0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48, 0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1, 0xd8, 0x05,
    0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
];

/// The BLS12-381 scalar field modulus.
pub fn modulus(env: &Env) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &FR_MODULUS_BE))
}

/// `e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) == 1`, with
/// `vk_x = ic[0] + Σ signal_i · ic[i+1]`.
///
/// Every signal must already be canonical; `auth.rs` refuses any that is not
/// before this is reached, because `Bls12381Fr::from(U256)` reduces modulo `r`
/// without complaint.
pub fn verify(env: &Env, vk: &VerificationKey, proof: &Proof, signals: &Vec<U256>) -> bool {
    if signals.len() + 1 != vk.ic.len() {
        return false;
    }

    let bls = env.crypto().bls12_381();
    let mut vk_x = vk.ic.get(0).unwrap();
    for (signal, point) in signals.iter().zip(vk.ic.iter().skip(1)) {
        let term = bls.g1_mul(&point, &Bls12381Fr::from_u256(signal));
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

    bls.pairing_check(lhs, rhs)
}
