//! The authorization boundary.
//!
//! Every transfer of a usage right passes through this file, and nothing else in
//! the contract decides whether one is allowed. A reviewer who wants to know what
//! authorizes a transfer reads this file and stops.
//!
//! **Phase 1** required the issuer's co-signature here. **Phase 2** replaces it
//! with an on-chain check of the ownership proof specified in `docs/CIRCUIT.md`:
//! the holder proves they know the secret behind the commitment stored for the
//! right, and the proof is bound to this exact transfer. The issuer appears
//! nowhere in this file. `Contract::transfer` still calls `from.require_auth()`
//! first, so a transfer needs the holder's wallet *and* the holder's secret.
//!
//! The check comes in two halves, both here:
//!
//! 1. [`check_transfer_proof`] — every public signal compared with the
//!    contract's own state and the call's arguments, the buyer's signature over
//!    the next secret hash, and the nullifier looked up. Cheap, and run before
//!    the holding-chain rules, so a replayed proof is refused as a replay.
//! 2. [`consume_transfer_proof`] — the pairing check, then the nullifier
//!    recorded. Run after the holding-chain rules, so verification is only paid
//!    for on a transfer that can actually happen.
//!
//! The contract never computes Poseidon. Commitments and nullifiers arrive as
//! public signals and are only compared and stored.

use soroban_sdk::{address_payload::AddressPayload, vec, Address, BytesN, Env, IntoVal, Vec, U256};

use crate::error::Error;
use crate::types::{DataKey, Right};
use crate::verifier::{self, Proof, VerificationKey, PUBLIC_SIGNALS};

/// The longest a proof may stay valid, in ledgers: about an hour at testnet's
/// five-second ledgers (docs/CIRCUIT.md §6). Mirrored by the CLI prover.
pub const MAX_PROOF_WINDOW: u32 = 720;

// Positions of the public signals, in the order the verifier receives them
// (docs/CIRCUIT.md §7).
const COMMITMENT: u32 = 0;
const NULLIFIER: u32 = 1;
const RIGHT_ID: u32 = 2;
const FROM_HI: u32 = 3;
const FROM_LO: u32 = 4;
const TO_HI: u32 = 5;
const TO_LO: u32 = 6;
const MODE: u32 = 7;
const EXPIRY_LEDGER: u32 = 8;
const NEXT_SECRET_HASH: u32 = 9;
const NEXT_COMMITMENT: u32 = 10;

/// A proof whose signals all match this transfer, not yet verified.
pub struct CheckedProof {
    signals: Vec<U256>,
    nullifier: BytesN<32>,
    expiry_ledger: u32,
    /// The commitment to store after a sale; `None` for a rental.
    pub next_commitment: Option<BytesN<32>>,
}

/// A value as a 32-byte big-endian field element.
fn to_bytes(value: &U256) -> BytesN<32> {
    value.to_be_bytes().try_into().unwrap()
}

/// A 32-byte value as a field element. Callers make sure it is below `r`.
fn to_u256(env: &Env, value: &BytesN<32>) -> U256 {
    U256::from_be_bytes(env, &value.clone().into())
}

/// `split(key)`: the account's Ed25519 key as two 128-bit halves, big-endian,
/// split at byte 16 (docs/CIRCUIT.md §5). Contract addresses are refused.
///
/// `to_payload` sits behind soroban-sdk's `hazmat-address` feature because the
/// key it returns is the account's master key, which need not be one of the
/// account's signers — so it must not be used to verify signatures. It is not
/// used for that here: it is an identifier the proof is bound to, and whether
/// the account authorized the transfer is still decided by `require_auth`.
fn split_account(env: &Env, account: &Address) -> Result<(U256, U256), Error> {
    let key = match account.to_payload() {
        Some(AddressPayload::AccountIdPublicKeyEd25519(key)) => key,
        _ => return Err(Error::NotAnAccount),
    };
    let bytes = key.to_array();
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..].copy_from_slice(&bytes[..16]);
    lo[16..].copy_from_slice(&bytes[16..]);
    Ok((
        U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &hi)),
        U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &lo)),
    ))
}

/// Refuse anything but a `G…` account as a holder. Used by `issue`, so a right
/// is never created in the hands of an address no proof could name — such a
/// right could never be transferred.
pub fn require_account(account: &Address) -> Result<(), Error> {
    match account.to_payload() {
        Some(AddressPayload::AccountIdPublicKeyEd25519(_)) => Ok(()),
        _ => Err(Error::NotAnAccount),
    }
}

/// The verification key fixed in the constructor.
pub fn verification_key(env: &Env) -> VerificationKey {
    env.storage()
        .instance()
        .get(&DataKey::VerificationKey)
        .expect("contract not constructed")
}

/// Store the verification key, once, from the constructor. Nothing else writes
/// it, and no entry point takes a key as an argument.
pub fn set_verification_key(env: &Env, vk: &VerificationKey) -> Result<(), Error> {
    if vk.ic.len() != PUBLIC_SIGNALS + 1 {
        return Err(Error::MalformedVerifyingKey);
    }
    env.storage().instance().set(&DataKey::VerificationKey, vk);
    Ok(())
}

/// Whether a 32-byte value is a canonical field element. Used at issuance, so a
/// right is never created with a commitment no proof could match.
pub fn is_canonical(env: &Env, value: &BytesN<32>) -> bool {
    to_u256(env, value) < verifier::modulus(env)
}

/// Half one: does this proof claim to authorize exactly this transfer?
///
/// Every public signal is compared with what the contract already knows —
/// nothing in it is taken on the prover's word except the nullifier and the
/// next commitment, which are what the proof itself vouches for. Refused before
/// any verification is paid for:
///
/// * the wrong number of signals, or one that is not a canonical field element;
/// * a sender or recipient that is not an account;
/// * a commitment other than the one stored for `right`;
/// * a different right, sender, recipient, sale/rental mode or rental end;
/// * a deadline already past, or more than [`MAX_PROOF_WINDOW`] ledgers ahead;
/// * on a sale, a zero next secret hash, or one the buyer did not sign; on a
///   rental, a non-zero one;
/// * a nullifier already used.
pub fn check_transfer_proof(
    env: &Env,
    right: &Right,
    from: &Address,
    to: &Address,
    expires_at: &Option<u64>,
    signals: &Vec<U256>,
) -> Result<CheckedProof, Error> {
    if signals.len() != PUBLIC_SIGNALS {
        return Err(Error::WrongSignalCount);
    }
    let r = verifier::modulus(env);
    for s in signals.iter() {
        if s >= r {
            return Err(Error::NonCanonicalSignal);
        }
    }
    let get = |i: u32| signals.get(i).unwrap();
    let small = |x: u64| U256::from_u128(env, x as u128);

    let (from_hi, from_lo) = split_account(env, from)?;
    let (to_hi, to_lo) = split_account(env, to)?;

    if get(COMMITMENT) != to_u256(env, &right.commitment) {
        return Err(Error::CommitmentMismatch);
    }
    if get(RIGHT_ID) != small(right.id) {
        return Err(Error::RightMismatch);
    }
    if get(FROM_HI) != from_hi || get(FROM_LO) != from_lo {
        return Err(Error::WrongAccount);
    }
    if get(TO_HI) != to_hi || get(TO_LO) != to_lo {
        return Err(Error::RecipientMismatch);
    }
    // 0 for a sale; the rental's end time otherwise. A real rental end is in the
    // future, so it is never 0 — the holding-chain rules refuse one that is not.
    if get(MODE) != small(expires_at.unwrap_or(0)) {
        return Err(Error::ModeMismatch);
    }

    let now = env.ledger().sequence();
    if get(EXPIRY_LEDGER) > small(u32::MAX as u64) {
        return Err(Error::ExpiryBeyondWindow);
    }
    let expiry_ledger = get(EXPIRY_LEDGER).to_u128().unwrap() as u32;
    if expiry_ledger < now {
        return Err(Error::ProofExpired);
    }
    if expiry_ledger - now > MAX_PROOF_WINDOW {
        return Err(Error::ExpiryBeyondWindow);
    }

    let next_secret_hash = get(NEXT_SECRET_HASH);
    let zero = U256::from_u32(env, 0);
    let next_commitment = match expires_at {
        None => {
            if next_secret_hash == zero {
                return Err(Error::NextSecretHashMismatch);
            }
            // The buyer chooses their secret and signs its hash, so a seller
            // cannot plant a commitment the buyer could never prove against.
            to.require_auth_for_args(vec![
                env,
                right.id.into_val(env),
                next_secret_hash.into_val(env),
            ]);
            Some(to_bytes(&get(NEXT_COMMITMENT)))
        }
        Some(_) => {
            if next_secret_hash != zero {
                return Err(Error::NextSecretHashMismatch);
            }
            None
        }
    };

    let nullifier = to_bytes(&get(NULLIFIER));
    if env
        .storage()
        .temporary()
        .has(&DataKey::Nullifier(nullifier.clone()))
    {
        return Err(Error::NullifierUsed);
    }

    Ok(CheckedProof {
        signals: signals.clone(),
        nullifier,
        expiry_ledger,
        next_commitment,
    })
}

/// Half two: verify the proof against the key fixed at deployment, then spend
/// its nullifier.
///
/// The nullifier goes to temporary storage, and its entry is made to outlive
/// the proof's own `expiry_ledger`: there is no ledger at which the entry is
/// gone while the proof would still be accepted. That cannot be left to the
/// network's minimum TTL — on testnet it is 720 ledgers, the same as the window,
/// so an entry written at the start of a proof's window would otherwise lapse
/// just before the proof does.
pub fn consume_transfer_proof(env: &Env, checked: CheckedProof, proof: &Proof) -> Result<(), Error> {
    if !verifier::verify(env, &verification_key(env), proof, &checked.signals) {
        return Err(Error::InvalidProof);
    }

    let key = DataKey::Nullifier(checked.nullifier);
    let storage = env.storage().temporary();
    storage.set(&key, &checked.expiry_ledger);
    // live-until = now + extend_to, so this makes it at least expiry_ledger + 1.
    let extend_to = checked.expiry_ledger - env.ledger().sequence() + 1;
    storage.extend_ttl(&key, extend_to, extend_to);
    Ok(())
}
