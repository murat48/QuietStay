//! The authorization boundary.
//!
//! Every transfer of a usage right passes through this file, and nothing else in
//! the contract decides whether one is allowed. A reviewer who wants to know what
//! authorizes a transfer reads this file and stops.
//!
//! **Phase 1** required the issuer's co-signature here. **Phase 2** replaced it
//! with an on-chain check of the ownership proof specified in `docs/CIRCUIT.md`:
//! the holder proves they know the secret behind the commitment stored for the
//! right, and the proof is bound to this exact transfer. **Phase 3** turns that
//! check into one function, [`authorize_transfer`], which every flow that moves
//! a right calls (docs/PHASE3_SPEC.md §3), and lets a smart wallet (`C…`
//! address) hold a right (§1, decision D1).
//!
//! The issuer appears nowhere in this file. Each entry point obtains the
//! holder's `require_auth` before calling in, so a transfer needs the holder's
//! signature (a wallet key, or a passkey through a smart wallet) *and* the
//! holder's secret.
//!
//! The contract never computes Poseidon. Commitments and nullifiers arrive as
//! public signals and are only compared and stored.

use soroban_sdk::{address_payload::AddressPayload, Address, BytesN, Env, Vec, U256};

use crate::error::Error;
use crate::store;
use crate::types::{DataKey, Right};
use crate::verifier::{self, Proof, VerificationKey, PUBLIC_SIGNALS};

/// The longest a proof may stay valid, in ledgers: about an hour at testnet's
/// five-second ledgers (docs/CIRCUIT.md §6). Mirrored by the provers.
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

/// What kind of transfer a proof authorizes. It fixes the `mode` signal and
/// whether title moves.
///
/// Step 4 adds `Swap { counter_right_id }` (mode `2^64 + counter_right_id`,
/// docs/PHASE3_SPEC.md §7).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferMode {
    /// Open-ended: title and the commitment move to `to`. Mode signal `0`.
    Sale,
    /// `to` holds until `expires_at`, then the right reverts with no further
    /// transaction. Title and the commitment stay. Mode signal `expires_at`.
    Rental { expires_at: u64 },
}

impl TransferMode {
    /// The `mode` public signal this transfer must carry.
    fn signal(&self) -> u64 {
        match self {
            TransferMode::Sale => 0,
            // A real rental end is in the future, so it is never 0: the
            // holding-chain rules refuse one that is not.
            TransferMode::Rental { expires_at } => *expires_at,
        }
    }

    /// The term the holding-chain rules grant: `None` is title.
    fn term(&self) -> Option<u64> {
        match self {
            TransferMode::Sale => None,
            TransferMode::Rental { expires_at } => Some(*expires_at),
        }
    }
}

/// A value as a 32-byte big-endian field element.
fn to_bytes(value: &U256) -> BytesN<32> {
    value.to_be_bytes().try_into().unwrap()
}

/// A 32-byte value as a field element. Callers make sure it is below `r`.
fn to_u256(env: &Env, value: &BytesN<32>) -> U256 {
    U256::from_be_bytes(env, &value.clone().into())
}

/// `split(address)`: the address's 32-byte payload as two 128-bit halves,
/// big-endian, split at byte 16, with the address kind tagged into the high
/// half (docs/CIRCUIT.md §5, docs/PHASE3_SPEC.md §1):
///
/// ```text
/// hi = t · 2^128 + int(k[0..16])     t = 0 for a G… account, 1 for a C… contract
/// lo =             int(k[16..32])
/// ```
///
/// For a `G…` account `k` is its Ed25519 key and the encoding is Phase 2's,
/// unchanged. For a `C…` contract (a smart wallet) `k` is its contract id. The
/// tag keeps the two kinds disjoint even when their 32 bytes are equal. Any
/// other address kind is refused.
///
/// `to_payload` sits behind soroban-sdk's `hazmat-address` feature because the
/// key it returns for an account is its master key, which need not be one of
/// its signers, so it must not be used to verify signatures. It is not used
/// for that here: it is an identifier the proof is bound to, and whether the
/// address authorized the transfer is still decided by `require_auth`.
fn split_address(env: &Env, address: &Address) -> Result<(U256, U256), Error> {
    let (bytes, tag) = match address.to_payload() {
        Some(AddressPayload::AccountIdPublicKeyEd25519(key)) => (key.to_array(), 0u8),
        Some(AddressPayload::ContractIdHash(id)) => (id.to_array(), 1u8),
        _ => return Err(Error::NotAnAccount),
    };
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    // Byte 15 is bit 128 of the big-endian 256-bit value.
    hi[15] = tag;
    hi[16..].copy_from_slice(&bytes[..16]);
    lo[16..].copy_from_slice(&bytes[16..]);
    Ok((
        U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &hi)),
        U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &lo)),
    ))
}

/// Refuse any address a proof could not name: anything but a `G…` account or a
/// `C…` contract. Used by `issue`, so a right is never created in hands that
/// could never transfer it.
pub fn require_holder_address(env: &Env, address: &Address) -> Result<(), Error> {
    split_address(env, address).map(|_| ())
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

/// **The one way a right moves.** Checks that `proof` authorizes exactly this
/// transfer, then applies it to `right`.
///
/// It does not call `require_auth`: each entry point obtains the holder's
/// authorization first, and any other signature its flow needs (for the
/// Phase 2 `transfer`, the buyer's over `next_secret_hash`). The caller then
/// stores `right` with `store::put_right` and emits its event.
///
/// `next_secret_hash` is the `h'` the caller expects, taken from state the
/// buyer controls (their signature, or later their on-chain offer), never from
/// the seller. It must be non-zero for a sale and zero for a rental.
///
/// In order, all before anything is written:
///
/// 1. **The right is inside its validity window, and the signals.** Exactly
///    eleven, all canonical. The commitment is the one
///    stored for `right`; the right, sender, recipient (with the tagged
///    encoding above), mode and `h'` are the ones given; `expiry_ledger` is in
///    `[now, now + MAX_PROOF_WINDOW]`; the nullifier is unspent.
/// 2. **The holding chain:** the grant allowed by `store::grant` (the Phase 1
///    rules).
/// 3. **The pairing check** against the constructor's key, then the nullifier
///    spent with a TTL past `expiry_ledger`.
///
/// Then the new chain is written to `right`, and on a sale the commitment
/// becomes `next_commitment`, title balances move and the listing is removed.
/// A rental also removes the listing, as Phase 2 did.
///
/// The cheap checks run first, so a proof for some other transfer, or one
/// already spent, is refused as exactly that, and the pairing check is paid for
/// only on a transfer that can happen.
#[allow(clippy::too_many_arguments)]
pub fn authorize_transfer(
    env: &Env,
    right: &mut Right,
    from: &Address,
    to: &Address,
    mode: TransferMode,
    next_secret_hash: &U256,
    proof: &Proof,
    signals: &Vec<U256>,
) -> Result<(), Error> {
    // --- 1. the right is live, and the signals --------------------------
    store::require_active(env, right)?;
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

    let (from_hi, from_lo) = split_address(env, from)?;
    let (to_hi, to_lo) = split_address(env, to)?;

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
    if get(MODE) != small(mode.signal()) {
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

    // A sale hands the buyer a commitment to an h' only the buyer can prove
    // against; a rental leaves the commitment where it is and carries none.
    let zero = U256::from_u32(env, 0);
    let moves_title = matches!(mode, TransferMode::Sale);
    let h_ok = if moves_title {
        *next_secret_hash != zero && get(NEXT_SECRET_HASH) == *next_secret_hash
    } else {
        *next_secret_hash == zero && get(NEXT_SECRET_HASH) == zero
    };
    if !h_ok {
        return Err(Error::NextSecretHashMismatch);
    }

    let nullifier = to_bytes(&get(NULLIFIER));
    let nullifier_key = DataKey::Nullifier(nullifier);
    if env.storage().temporary().has(&nullifier_key) {
        return Err(Error::NullifierUsed);
    }

    // --- 2. the holding chain --------------------------------------------
    let chain = store::grant(env, right, from, to, &mode.term())?;

    // --- 3. the pairing check, then the nullifier is spent ----------------
    if !verifier::verify(env, &verification_key(env), proof, signals) {
        return Err(Error::InvalidProof);
    }
    // The nullifier goes to temporary storage, made to outlive the proof's own
    // `expiry_ledger`, so there is no ledger at which the entry is gone while
    // the proof would still be accepted. That cannot be left to the network's
    // minimum TTL: on testnet it is 720 ledgers, the same as the window.
    let storage = env.storage().temporary();
    storage.set(&nullifier_key, &expiry_ledger);
    // live-until = now + extend_to, so this makes it at least expiry_ledger + 1.
    let extend_to = expiry_ledger - now + 1;
    storage.extend_ttl(&nullifier_key, extend_to, extend_to);

    // --- 4. applied --------------------------------------------------------
    if moves_title {
        store::adjust_balance(env, from, -1);
        store::adjust_balance(env, to, 1);
        right.commitment = to_bytes(&get(NEXT_COMMITMENT));
    }
    right.holdings = chain;
    // A transfer supersedes any listing that was standing.
    store::remove_listing(env, right.id);
    Ok(())
}
