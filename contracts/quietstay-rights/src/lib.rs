#![no_std]
//! # QuietStay usage rights — Phase 2
//!
//! A registry of tokenized vacation usage rights on Stellar. Personal and
//! ownership records stay off-chain; the ledger holds a Poseidon commitment to
//! each record (docs/CIRCUIT.md) and nothing more of it.
//!
//! ## The one transfer primitive
//!
//! There is a single transfer function and it takes a duration:
//!
//! * `expires_at = None` — an open-ended transfer. A **sale**.
//! * `expires_at = Some(t)` — a transfer that lapses at `t`. A **rental**.
//!
//! Sale and rental are not two code paths. They are one call whose grant either
//! replaces the holding chain or extends it, and the chain is re-evaluated
//! against the ledger timestamp on every read. A rental therefore ends on its own
//! — there is no return transaction, and a lapsed renter simply stops being the
//! effective holder.
//!
//! ## What authorizes a transfer
//!
//! The holder's signature and an ownership proof verified on chain (see
//! [`auth`]): a Groth16 proof over BLS12-381 that the holder knows the secret
//! behind the stored commitment, bound to this exact transfer and usable once.
//! The issuer's co-signature, which Phase 1 required, is gone.
//!
//! ## What the issuer can and cannot do
//!
//! There is **one** privileged entry point: `issue`, which can only create
//! rights at ids a counter has never handed out. The issuer cannot move,
//! reassign, freeze, burn, or overwrite a right that someone holds, and there is
//! no seize, freeze, clawback, or admin function to find. There is no `upgrade`
//! either: the code deployed is the code that runs, and fixing a bug means a
//! fresh deployment. The verification key is fixed by the constructor and no
//! function takes or replaces one.
//!
//! What the issuer can still do is attest falsely about maintenance fees, off
//! chain. That attestation is shown to buyers and is never a condition of a
//! transfer, so withholding it cannot freeze a right.
//!
//! ## Relationship to SEP-41
//!
//! The token interface follows SEP-41 with one systematic substitution: usage
//! rights are non-fungible, so `right_id: u64` takes the place of SEP-41's
//! `amount: i128` wherever a specific right must be named. `decimals` is `0` and
//! `balance` counts rights held as title. The divergences are enumerated in
//! `docs/DESIGN.md`; nothing here claims drop-in fungible-token compatibility.

use soroban_sdk::{contract, contractimpl, contractmeta, vec, Address, BytesN, Env, String, Vec, U256};

pub mod auth;
pub mod error;
pub mod events;
pub mod store;
pub mod types;
pub mod verifier;

#[cfg(test)]
mod test;

use error::Error;
use events::{Burned, Issued, Listed, Transferred, Unlisted};
use types::{Config, Holding, Listing, Period, Right, Validity};
use verifier::{Proof, VerificationKey};

contractmeta!(key = "binver", val = "0.3.0");
contractmeta!(
    key = "desc",
    val = "QuietStay Phase 2 tokenized vacation usage rights, proof-gated transfers (testnet)"
);

#[contract]
pub struct QuietStayRights;

#[contractimpl]
impl QuietStayRights {
    /// Bind the contract to its issuer and its verification key, once, at
    /// deployment.
    ///
    /// There is deliberately no setter for either. Rotating the issuer key or
    /// replacing the verification key means deploying a new contract; a setter
    /// would be a privileged entry point the deliverable does not need.
    pub fn __constructor(
        env: Env,
        issuer: Address,
        name: String,
        symbol: String,
        verification_key: VerificationKey,
    ) -> Result<(), Error> {
        auth::set_verification_key(&env, &verification_key)?;
        store::put_config(
            &env,
            &Config {
                issuer,
                name,
                symbol,
            },
        );
        store::set_next_id(&env, 1);
        store::bump_instance(&env);
        Ok(())
    }

    // --- SEP-41 metadata -------------------------------------------------

    pub fn name(env: Env) -> String {
        store::config(&env).name
    }

    pub fn symbol(env: Env) -> String {
        store::config(&env).symbol
    }

    /// Usage rights are indivisible: a week is not a quantity.
    pub fn decimals(_env: Env) -> u32 {
        0
    }

    /// The number of rights `id` holds **title** to.
    ///
    /// Title is the open-ended holding. A rental does not change it, so a renter's
    /// balance stays `0` while they occupy a week. Use [`Self::holder`] for who is
    /// entitled to a right right now.
    pub fn balance(env: Env, id: Address) -> i128 {
        store::balance(&env, &id)
    }

    // --- issuance (the only privileged entry point) ----------------------

    /// Create a usage right and assign initial title to `owner`.
    ///
    /// Requires the issuer's authorization. It can only write to an id that has
    /// never been used, so it cannot overwrite, reassign, or otherwise reach an
    /// existing right — the id comes from a monotonic counter, not the caller.
    ///
    /// `commitment` is `C = Poseidon(d, owner, h)` (docs/CIRCUIT.md §2), computed
    /// off chain from the owner's secret hash; the issuer never learns the secret.
    /// It must be a canonical field element, or no proof could ever match it, and
    /// `owner` must be a `G…` account, or no proof could ever name it.
    pub fn issue(
        env: Env,
        owner: Address,
        period: Period,
        validity: Validity,
        commitment: BytesN<32>,
    ) -> Result<u64, Error> {
        let config = store::config(&env);
        config.issuer.require_auth();

        auth::require_account(&owner)?;
        if !auth::is_canonical(&env, &commitment) {
            return Err(Error::NonCanonicalSignal);
        }
        if period.start >= period.end {
            return Err(Error::InvalidPeriod);
        }
        if validity.from > period.start
            || period.end > validity.until
            || validity.from >= validity.until
        {
            return Err(Error::InvalidValidity);
        }

        let id = store::next_id(&env);
        store::set_next_id(&env, id + 1);

        let right = Right {
            id,
            issuer: config.issuer.clone(),
            period,
            validity,
            commitment: commitment.clone(),
            holdings: vec![
                &env,
                Holding {
                    holder: owner.clone(),
                    expires_at: None,
                },
            ],
        };
        store::put_right(&env, &right);
        store::adjust_balance(&env, &owner, 1);
        store::bump_instance(&env);

        Issued {
            issuer: config.issuer,
            owner,
            right_id: id,
            commitment,
        }
        .publish(&env);

        Ok(id)
    }

    // --- listing ---------------------------------------------------------

    /// Publish a right as available. `term_secs = None` offers it open-ended (a
    /// sale); `Some(n)` offers a term of `n` seconds (a rental).
    ///
    /// `by` must be the effective holder, and the right must be inside its
    /// validity window. The caller is named explicitly rather than inferred, so
    /// that a lapsed renter's attempt to re-list a week they no longer hold is
    /// rejected as `NotHolder` instead of silently asking someone else to sign.
    ///
    /// Price and settlement are out of scope for Phase 1, so no consideration is
    /// recorded on the ledger.
    pub fn list(env: Env, by: Address, right_id: u64, term_secs: Option<u64>) -> Result<(), Error> {
        by.require_auth();

        let right = store::get_right(&env, right_id)?;
        store::require_active(&env, &right)?;

        let current = store::effective_holding(&env, &right);
        if current.holder != by {
            return Err(Error::NotHolder);
        }

        if let Some(term) = term_secs {
            if term == 0 {
                return Err(Error::InvalidTerm);
            }
        } else if current.expires_at.is_some() {
            // A renter cannot offer what they do not hold open-ended.
            return Err(Error::NotTitleHolder);
        }

        if store::get_listing(&env, right_id).is_some() {
            return Err(Error::AlreadyListed);
        }

        let listing = Listing {
            right_id,
            by: current.holder.clone(),
            term_secs,
            listed_at: env.ledger().timestamp(),
        };
        store::put_listing(&env, &listing);

        Listed {
            by: current.holder,
            right_id,
            term_secs,
            commitment: right.commitment,
        }
        .publish(&env);

        Ok(())
    }

    /// Withdraw a listing. Only the current effective holder may do so.
    pub fn unlist(env: Env, by: Address, right_id: u64) -> Result<(), Error> {
        by.require_auth();

        let right = store::get_right(&env, right_id)?;
        if store::get_listing(&env, right_id).is_none() {
            return Err(Error::NotListed);
        }

        let current = store::effective_holding(&env, &right);
        if current.holder != by {
            return Err(Error::NotHolder);
        }

        store::remove_listing(&env, right_id);
        Unlisted { by, right_id }.publish(&env);

        Ok(())
    }

    pub fn get_listing(env: Env, right_id: u64) -> Option<Listing> {
        store::get_listing(&env, right_id)
    }

    // --- the transfer primitive -----------------------------------------

    /// Transfer a usage right. **This is the sale and the rental.**
    ///
    /// * `expires_at = None` — open-ended. `to` becomes the title holder and
    ///   `from` is out. A sale.
    /// * `expires_at = Some(t)` — `to` holds until `t`, then the right reverts to
    ///   `from` with no further transaction. A rental.
    ///
    /// Requires, all in this one transaction:
    ///
    /// 1. `from`'s signature — the effective holder, who initiates. It covers
    ///    every argument, so it authorizes this recipient, this mode and this
    ///    proof and nothing else.
    /// 2. a valid ownership proof (`proof`, `public_signals`) — see [`auth`].
    /// 3. on a sale, `to`'s signature over `(right_id, next secret hash)`.
    ///
    /// No issuer signature is asked for or consulted.
    ///
    /// A sale replaces the right's commitment with the one the proof computed
    /// for the buyer, so only the buyer can prove next. A rental leaves it alone.
    /// A term may never outlast the grantor's own term or the right's validity
    /// window.
    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        right_id: u64,
        expires_at: Option<u64>,
        proof: Proof,
        public_signals: Vec<U256>,
    ) -> Result<(), Error> {
        from.require_auth();

        let mut right = store::get_right(&env, right_id)?;
        store::require_active(&env, &right)?;

        // Cheap checks first: a proof for some other transfer, or one already
        // spent, is refused as exactly that.
        let checked =
            auth::check_transfer_proof(&env, &right, &from, &to, &expires_at, &public_signals)?;

        // Then the holding-chain rules, so the pairing check is only paid for on
        // a transfer that could actually happen.
        let chain = store::grant(&env, &right, &from, &to, &expires_at)?;

        let next_commitment = checked.next_commitment.clone();
        auth::consume_transfer_proof(&env, checked, &proof)?;

        // Title moves only on an open-ended grant, and so does the commitment.
        if expires_at.is_none() {
            store::adjust_balance(&env, &from, -1);
            store::adjust_balance(&env, &to, 1);
        }
        if let Some(next) = next_commitment {
            right.commitment = next;
        }

        right.holdings = chain;
        store::put_right(&env, &right);

        // A transfer supersedes any offer that was standing.
        store::remove_listing(&env, right_id);

        Transferred {
            from,
            to,
            right_id,
            expires_at,
            commitment: right.commitment,
        }
        .publish(&env);

        Ok(())
    }

    /// Destroy a right. Holder-initiated only, and only by the title holder with
    /// no live sub-grant above them, so nobody can burn a week out from under a
    /// renter. The issuer has no part in this and no equivalent function.
    pub fn burn(env: Env, from: Address, right_id: u64) -> Result<(), Error> {
        from.require_auth();

        let right = store::get_right(&env, right_id)?;
        let chain = store::prune_lapsed(&env, &right.holdings);
        let current = chain.last().expect("chain is never empty");

        if current.holder != from {
            return Err(Error::NotHolder);
        }
        if current.expires_at.is_some() {
            return Err(Error::NotTitleHolder);
        }

        store::remove_right(&env, right_id);
        store::adjust_balance(&env, &from, -1);

        Burned {
            from,
            right_id,
            commitment: right.commitment,
        }
        .publish(&env);

        Ok(())
    }

    // --- views -----------------------------------------------------------

    /// The address that issues rights and attests fee status off chain. It has
    /// no part in transfers.
    pub fn issuer(env: Env) -> Address {
        store::config(&env).issuer
    }

    /// The id the next `issue` will assign. Rights occupy `1..next_id()`, so a
    /// client can enumerate inventory without an unbounded on-chain index.
    pub fn next_id(env: Env) -> u64 {
        store::next_id(&env)
    }

    /// The full on-chain record of a right: issuer, week, validity window,
    /// commitment, and the holding chain. No off-chain record contents are here.
    pub fn get_right(env: Env, right_id: u64) -> Result<Right, Error> {
        store::get_right(&env, right_id)
    }

    /// The commitment alone: the value a proof's first public signal must equal.
    pub fn commitment(env: Env, right_id: u64) -> Result<BytesN<32>, Error> {
        Ok(store::get_right(&env, right_id)?.commitment)
    }

    /// Who is entitled to the week right now, with lapsed terms discarded.
    pub fn holder(env: Env, right_id: u64) -> Result<Address, Error> {
        let right = store::get_right(&env, right_id)?;
        Ok(store::effective_holding(&env, &right).holder)
    }

    /// The holding in force right now: the effective holder and, if their term is
    /// finite, when it lapses.
    pub fn holding(env: Env, right_id: u64) -> Result<Holding, Error> {
        let right = store::get_right(&env, right_id)?;
        Ok(store::effective_holding(&env, &right))
    }

    /// The holding chain with lapsed terms discarded: title first, live
    /// sub-grants after it.
    pub fn holdings(env: Env, right_id: u64) -> Result<Vec<Holding>, Error> {
        let right = store::get_right(&env, right_id)?;
        Ok(store::prune_lapsed(&env, &right.holdings))
    }

    /// Whether the right is inside its validity window and can be acted on.
    pub fn is_active(env: Env, right_id: u64) -> Result<bool, Error> {
        let right = store::get_right(&env, right_id)?;
        Ok(store::require_active(&env, &right).is_ok())
    }
}
