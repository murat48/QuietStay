//! The authorization boundary.
//!
//! Every transfer of a usage right passes through exactly one function here, and
//! nothing else in the contract consults the issuer. Two consequences follow, and
//! both are load-bearing:
//!
//! 1. **Phase 1's trust assumption is visible in one place.** A reviewer who
//!    wants to know what the issuer can do reads this file and stops.
//! 2. **Phase 2 substitutes here.** Replacing the issuer's signature with
//!    verification of a cryptographic proof means rewriting the body of
//!    `require_transfer_approval` and nothing else. That is a structuring note,
//!    not a Phase 1 feature: no proof machinery exists in this contract.
//!
//! What this is *not*: a way for the issuer to reach a holder's right. The issuer
//! co-signs a transfer that the holder has already authorized. It cannot originate
//! one, because `Contract::transfer` independently calls `from.require_auth()`,
//! and no other entry point mutates a holding record.

use soroban_sdk::{Address, Env};

use crate::types::Right;

/// Require the issuer's approval for a transfer the holder has initiated.
///
/// This follows the approval model of SEP-8 regulated assets, expressed with
/// Stellar's native authorization framework instead of a custom scheme: the
/// issuer's approval is a `SorobanAuthorizationEntry` carried by the very
/// transaction that performs the transfer.
///
/// `require_auth()` binds that entry to the invocation it appears in — this
/// contract's address, the function name `transfer`, and the complete argument
/// list `(from, to, right_id, expires_at)`. An approval therefore cannot be
/// replayed against a different right, a different counterparty, or a different
/// term, and the host's nonce handling stops it being replayed against the same
/// one twice.
///
/// Enforcement is at the contract level. A transfer submitted without the
/// issuer's entry fails inside this call, before any state is written — the UI
/// has no part in it.
pub fn require_transfer_approval(
    env: &Env,
    right: &Right,
    from: &Address,
    to: &Address,
    expires_at: &Option<u64>,
) {
    // Named to document what the invocation-scoped signature covers. The issuer
    // approves this exact transfer; these are the terms it is bound to.
    let _ = (env, from, to, expires_at);

    right.issuer.require_auth();
}
