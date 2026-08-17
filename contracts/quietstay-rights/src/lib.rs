#![no_std]
//! # QuietStay usage rights — Phase 1
//!
//! A registry of tokenized vacation usage rights on Stellar. Personal and
//! ownership records stay off-chain; the ledger holds a SHA-256 commitment to
//! each record and nothing more of it.
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
//! ## What the issuer can and cannot do
//!
//! The issuer approves transfers that holders initiate, following the approval
//! model of SEP-8 regulated assets (see [`auth`]). It cannot move, reassign,
//! freeze, or burn a right that a holder already holds. `issue` is the only
//! privileged entry point in this contract, it can only create rights at unused
//! ids, and there is no upgrade, admin, seize, freeze, or clawback function to
//! find — `docs/DESIGN.md` enumerates the privileged surface in full.
//!
//! ## Relationship to SEP-41
//!
//! The token interface follows SEP-41 with one systematic substitution: usage
//! rights are non-fungible, so `right_id: u64` takes the place of SEP-41's
//! `amount: i128` wherever a specific right must be named. `decimals` is `0` and
//! `balance` counts rights held as title. The divergences are enumerated in
//! `docs/DESIGN.md`; nothing here claims drop-in fungible-token compatibility.

use soroban_sdk::{contract, contractimpl, contractmeta, vec, Address, BytesN, Env, String, Vec};

pub mod auth;
pub mod error;
pub mod events;
pub mod store;
pub mod types;

#[cfg(test)]
mod test;

use error::Error;
use events::{Burned, Issued, Listed, Transferred, Unlisted};
use types::{Config, Holding, Listing, Period, Right, Validity};

contractmeta!(key = "binver", val = "0.1.0");
contractmeta!(
    key = "desc",
    val = "QuietStay Phase 1 tokenized vacation usage rights (testnet)"
);

#[contract]
pub struct QuietStayRights;

#[contractimpl]
impl QuietStayRights {
    /// Bind the contract to its issuer, once, at deployment.
    ///
    /// There is deliberately no setter. Rotating the issuer key in Phase 1 means
    /// deploying a new contract; a `set_issuer` function would be a privileged
    /// entry point that the deliverable does not need, so it does not exist.
    pub fn __constructor(env: Env, issuer: Address, name: String, symbol: String) {
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
    pub fn issue(
        env: Env,
        owner: Address,
        period: Period,
        validity: Validity,
        commitment: BytesN<32>,
    ) -> Result<u64, Error> {
        let config = store::config(&env);
        config.issuer.require_auth();

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
    /// Requires two independent authorizations:
    ///
    /// 1. `from` — the effective holder, who initiates.
    /// 2. the issuer — who approves, and can do nothing else (see [`auth`]).
    ///
    /// A term may never outlast the grantor's own term or the right's validity
    /// window, so a renter cannot sell and cannot sublet past their own checkout.
    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        right_id: u64,
        expires_at: Option<u64>,
    ) -> Result<(), Error> {
        from.require_auth();

        let mut right = store::get_right(&env, right_id)?;
        store::require_active(&env, &right)?;

        // Validate the grant before consulting the issuer, so that an approval is
        // never spent on a transfer that could not have happened anyway.
        let chain = store::grant(&env, &right, &from, &to, &expires_at)?;

        auth::require_transfer_approval(&env, &right, &from, &to, &expires_at);

        // Title moves only on an open-ended grant.
        if expires_at.is_none() {
            store::adjust_balance(&env, &from, -1);
            store::adjust_balance(&env, &to, 1);
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

    /// The address whose approval a transfer of any right in this contract needs.
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

    /// The commitment alone, for a verifier that only needs to match a hash.
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
