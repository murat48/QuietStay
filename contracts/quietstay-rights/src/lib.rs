#![no_std]
//! # QuietStay usage rights — Phase 3
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
//! ## Payments (Phase 3)
//!
//! A buyer or renter makes an on-chain offer, and the contract holds an
//! allowance equal to the sum of their live offers; the USDC stays in their
//! account. A **sale** settles in one transaction: the seller's proof moves the
//! right, and the price goes straight from buyer to seller. A **rental** also
//! settles in one transaction, but the price goes into an escrow that the owner
//! can collect only from check-in + 24 hours ([`escrow`]). A fixed arbiter can
//! act only on Disputed escrows, and only by paying the escrow's owner or
//! refunding its renter. It cannot reach any right. The USDC contract, the
//! arbiter and the payment cap are fixed in the constructor; nothing sets them
//! later and no function takes a token address.
//!
//! ## Swaps (Phase 3)
//!
//! Two title holders exchange weeks in three steps ([`swap`]): the maker
//! offers, the other holder accepts with a proof, and the maker completes with
//! theirs. Completion verifies both proofs through `authorize_transfer` in one
//! transaction, so both weeks move with new commitments, or neither does. No
//! money is involved.
//!
//! ## Relationship to SEP-41
//!
//! The token interface follows SEP-41 with one systematic substitution: usage
//! rights are non-fungible, so `right_id: u64` takes the place of SEP-41's
//! `amount: i128` wherever a specific right must be named. `decimals` is `0` and
//! `balance` counts rights held as title. The divergences are enumerated in
//! `docs/DESIGN.md`; nothing here claims drop-in fungible-token compatibility.

use soroban_sdk::{
    contract, contractimpl, contractmeta, vec, Address, BytesN, Env, IntoVal, String, Vec, U256,
};

pub mod auth;
pub mod error;
pub mod escrow;
pub mod events;
pub mod offers;
pub mod payment;
pub mod store;
pub mod swap;
pub mod types;
pub mod verifier;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_payments;
#[cfg(test)]
mod test_swap;

use auth::TransferMode;
use error::Error;
use events::{Burned, Issued, Listed, Transferred, Unlisted};
use types::{
    Config, Escrow, Holding, Listing, Offer, Outcome, Period, RecordRequest, Right, SwapAcceptance,
    SwapOffer, Validity,
};
use verifier::{Proof, VerificationKey};

contractmeta!(key = "binver", val = "0.4.0");
contractmeta!(
    key = "desc",
    val = "QuietStay Phase 3 vacation usage rights: proof-gated transfers, USDC sale and rental escrow (pilot)"
);

#[contract]
pub struct QuietStayRights;

#[contractimpl]
impl QuietStayRights {
    /// Bind the contract to its issuer, arbiter, USDC contract, verification
    /// key and payment cap, once, at deployment.
    ///
    /// There is deliberately no setter for any of them. Changing one means
    /// deploying a new contract; a setter would be a privileged entry point the
    /// deliverable does not need. Everything that differs between testnet and
    /// mainnet is an argument here, so one WASM serves both (D7).
    ///
    /// `max_payment ≤ 0` is refused, and so is an arbiter that is the issuer:
    /// the arbiter must be a separate address.
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        issuer: Address,
        arbiter: Address,
        usdc: Address,
        name: String,
        symbol: String,
        verification_key: VerificationKey,
        max_payment: i128,
    ) -> Result<(), Error> {
        if max_payment <= 0 || arbiter == issuer {
            return Err(Error::InvalidConfig);
        }
        auth::set_verification_key(&env, &verification_key)?;
        store::put_config(
            &env,
            &Config {
                issuer,
                arbiter,
                usdc,
                name,
                symbol,
                max_payment,
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
    /// `owner` must be a `G…` account or a `C…` contract such as a smart wallet
    /// (docs/PHASE3_SPEC.md §1), or no proof could ever name it.
    pub fn issue(
        env: Env,
        owner: Address,
        period: Period,
        validity: Validity,
        commitment: BytesN<32>,
    ) -> Result<u64, Error> {
        let config = store::config(&env);
        config.issuer.require_auth();

        auth::require_holder_address(&env, &owner)?;
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

        let zero = U256::from_u32(&env, 0);
        let (mode, next_secret_hash) = match expires_at {
            Some(expires_at) => (TransferMode::Rental { expires_at }, zero),
            None => {
                // The buyer chooses their secret and signs its hash, so a seller
                // cannot plant a commitment the buyer could never prove against.
                // A zero h' is refused by the check below without asking.
                let h = public_signals.get(9).unwrap_or(zero.clone());
                if h != zero {
                    to.require_auth_for_args(vec![&env, right_id.into_val(&env), h.into_val(&env)]);
                }
                (TransferMode::Sale, h)
            }
        };

        auth::authorize_transfer(
            &env,
            &mut right,
            &from,
            &to,
            mode,
            &next_secret_hash,
            &proof,
            &public_signals,
        )?;
        store::put_right(&env, &right);

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
    ///
    /// Also refused while the right has a Funded or Disputed escrow, even after
    /// the rental term has lapsed, or while it is part of a pending swap
    /// acceptance (D11).
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
        if escrow::open_count(&env, right_id) > 0 {
            return Err(Error::EscrowOpen);
        }
        if swap::is_pending(&env, right_id) {
            return Err(Error::SwapPending);
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

    // --- record requests (D4/D4a) -----------------------------------------

    /// Ask for a right's private record, binding `key_hash` (SHA-256 of the
    /// requester's raw P-256 public key) to the requester's account first. The
    /// holder's browser seals the record only to a key that matches.
    ///
    /// Requires the requester's authorization. The right must exist, the key
    /// hash must be non-zero, `now < expires_ledger ≤ now + 120,960`, and the
    /// requester may have at most 10 live requests. It moves nothing, sets no
    /// allowance and obliges the holder to nothing: an unanswered request
    /// simply expires.
    pub fn request_record(
        env: Env,
        requester: Address,
        right_id: u64,
        key_hash: BytesN<32>,
        expires_ledger: u32,
    ) -> Result<u64, Error> {
        offers::request_record(&env, requester, right_id, key_hash, expires_ledger)
    }

    /// Withdraw a live record request. Only its requester can.
    pub fn cancel_record_request(
        env: Env,
        requester: Address,
        request_id: u64,
    ) -> Result<(), Error> {
        offers::cancel_record_request(&env, requester, request_id)
    }

    // --- offers -------------------------------------------------------------

    /// Offer to buy the right named in `request_id`, the buyer's own live
    /// record request, which this consumes. The offer copies the request's key
    /// hash and stores the buyer's `next_secret_hash` (h'); the seller's proof
    /// must carry exactly that value.
    ///
    /// Requires the buyer's authorization, which also covers the USDC
    /// `approve` this call makes: the contract's allowance from the buyer is
    /// set to the sum of the buyer's live offers, this one included, expiring
    /// with the last of them (D12, spec note 10). The USDC stays in the
    /// buyer's account.
    ///
    /// `0 < price ≤ max_payment()`; `h'` non-zero and canonical;
    /// `now < expires_ledger ≤ now + 120,960`; at most 10 live offers per buyer.
    pub fn create_sale_offer(
        env: Env,
        buyer: Address,
        request_id: u64,
        price: i128,
        next_secret_hash: U256,
        expires_ledger: u32,
    ) -> Result<u64, Error> {
        offers::create_sale_offer(
            &env,
            buyer,
            request_id,
            price,
            next_secret_hash,
            expires_ledger,
        )
    }

    /// Offer to rent `right_id` until `expires_at`, checking in at `check_in`
    /// (ledger seconds). Rentals need no record request.
    ///
    /// Check-in must be now or later, inside the week
    /// (`period.start ≤ check_in < period.end`), and at least 24 hours before
    /// `expires_at`, which must be inside the right's validity. Price, expiry
    /// and allowance rules are those of [`Self::create_sale_offer`].
    pub fn create_rental_offer(
        env: Env,
        renter: Address,
        right_id: u64,
        price: i128,
        expires_at: u64,
        check_in: u64,
        expires_ledger: u32,
    ) -> Result<u64, Error> {
        offers::create_rental_offer(
            &env,
            renter,
            right_id,
            price,
            expires_at,
            check_in,
            expires_ledger,
        )
    }

    /// Cancel a live offer and set the allowance again to the sum of the
    /// buyer's remaining live offers. Only the offer's buyer or renter can.
    pub fn cancel_offer(env: Env, buyer: Address, offer_id: u64) -> Result<(), Error> {
        offers::cancel_offer(&env, buyer, offer_id)
    }

    /// Accept a sale offer. In this one transaction, the seller's proof moves
    /// the right to the buyer through `authorize_transfer`, with the offer's
    /// h', and the price moves from the buyer to the seller with
    /// `transfer_from`. If the allowance or the balance is too low, nothing
    /// moves. `price` must equal the offer's, so the seller accepts exactly the
    /// amount they saw.
    pub fn accept_sale(
        env: Env,
        seller: Address,
        offer_id: u64,
        price: i128,
        proof: Proof,
        public_signals: Vec<U256>,
    ) -> Result<(), Error> {
        offers::accept_sale(&env, seller, offer_id, price, proof, public_signals)
    }

    /// Accept a rental offer. In this one transaction, the holder's proof
    /// grants the rental right through `authorize_transfer`, and the price
    /// moves from the renter into this contract's escrow. Returns the escrow
    /// id. Check-in must not have passed.
    pub fn accept_rental(
        env: Env,
        owner: Address,
        offer_id: u64,
        price: i128,
        proof: Proof,
        public_signals: Vec<U256>,
    ) -> Result<u64, Error> {
        offers::accept_rental(&env, owner, offer_id, price, proof, public_signals)
    }

    // --- rental escrow (§5) ---------------------------------------------------

    /// The owner collects a Funded escrow, from check-in + 24 hours.
    pub fn collect(env: Env, owner: Address, escrow_id: u64) -> Result<(), Error> {
        escrow::collect(&env, owner, escrow_id)
    }

    /// The renter releases the escrow to the owner, at any time while Funded
    /// or Disputed.
    pub fn confirm(env: Env, renter: Address, escrow_id: u64) -> Result<(), Error> {
        escrow::confirm(&env, renter, escrow_id)
    }

    /// The renter reports a problem while Funded, until check-in + 24 hours.
    /// `evidence_hash` is the SHA-256 of the report; the file stays off chain.
    pub fn report_problem(
        env: Env,
        renter: Address,
        escrow_id: u64,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        escrow::report_problem(&env, renter, escrow_id, evidence_hash)
    }

    /// The owner refunds a Disputed escrow to the renter.
    pub fn refund(env: Env, owner: Address, escrow_id: u64) -> Result<(), Error> {
        escrow::refund(&env, owner, escrow_id)
    }

    /// The owner or the renter adds a SHA-256 evidence hash to a Disputed
    /// escrow, at most four each.
    pub fn submit_evidence(
        env: Env,
        by: Address,
        escrow_id: u64,
        evidence_hash: BytesN<32>,
    ) -> Result<(), Error> {
        escrow::submit_evidence(&env, by, escrow_id, evidence_hash)
    }

    /// The arbiter resolves a Disputed escrow: pay its owner or refund its
    /// renter, recording the SHA-256 of the written decision. Only the
    /// constructor's arbiter can call it, only on a Disputed escrow, and it
    /// touches nothing but that escrow and its own amount.
    pub fn resolve(
        env: Env,
        arbiter: Address,
        escrow_id: u64,
        outcome: Outcome,
        decision_hash: BytesN<32>,
    ) -> Result<(), Error> {
        escrow::resolve(&env, arbiter, escrow_id, outcome, decision_hash)
    }

    /// Extend an escrow's TTL. Anyone can call it; it changes nothing else
    /// (§9).
    pub fn extend_escrow(env: Env, escrow_id: u64) -> Result<(), Error> {
        escrow::get(&env, escrow_id).map(|_| ())
    }

    // --- swaps (§7, D5) ------------------------------------------------------

    /// Offer to swap `give_right`, which the maker holds as title, for
    /// `want_right`. `maker_next_secret_hash` is the maker's h' for
    /// `want_right`; `maker_request_id` is the maker's own live record request
    /// for `want_right`, which this consumes (D4a). Requires the maker's
    /// authorization; `now < expires_ledger ≤ now + 120,960`. Moves nothing.
    pub fn offer_swap(
        env: Env,
        maker: Address,
        give_right: u64,
        want_right: u64,
        maker_next_secret_hash: U256,
        maker_request_id: u64,
        expires_ledger: u32,
    ) -> Result<u64, Error> {
        swap::offer_swap(
            &env,
            maker,
            give_right,
            want_right,
            maker_next_secret_hash,
            maker_request_id,
            expires_ledger,
        )
    }

    /// Cancel a live swap offer, and any acceptance of it. Only its maker can.
    pub fn cancel_swap(env: Env, maker: Address, swap_id: u64) -> Result<(), Error> {
        swap::cancel_swap(&env, maker, swap_id)
    }

    /// Accept a swap as the title holder of `want_right`, with a proof that
    /// moves `want_right` to the maker for `give_right` and carries the
    /// maker's h'. Every check but the pairing runs now, and the proof is
    /// stored until its `expiry_ledger`; nothing moves and nothing is locked.
    /// `taker_request_id` is the taker's own live record request for
    /// `give_right`, which this consumes. Requires the taker's authorization.
    pub fn accept_swap(
        env: Env,
        taker: Address,
        swap_id: u64,
        taker_next_secret_hash: U256,
        taker_request_id: u64,
        proof: Proof,
        public_signals: Vec<U256>,
    ) -> Result<(), Error> {
        swap::accept_swap(
            &env,
            taker,
            swap_id,
            taker_next_secret_hash,
            taker_request_id,
            proof,
            public_signals,
        )
    }

    /// Withdraw a live acceptance, so its stored proof can never be used.
    /// Only the taker can. The offer stays open.
    pub fn withdraw_swap_acceptance(env: Env, taker: Address, swap_id: u64) -> Result<(), Error> {
        swap::withdraw_swap_acceptance(&env, taker, swap_id)
    }

    /// Complete an accepted swap with the maker's proof for `give_right`. In
    /// this one transaction `authorize_transfer` runs for the taker's stored
    /// proof and then for the maker's, re-checking everything against the
    /// current state: both weeks move with their new commitments, or neither
    /// does. Requires the maker's authorization.
    pub fn complete_swap(
        env: Env,
        maker: Address,
        swap_id: u64,
        proof: Proof,
        public_signals: Vec<U256>,
    ) -> Result<(), Error> {
        swap::complete_swap(&env, maker, swap_id, proof, public_signals)
    }

    // --- views -----------------------------------------------------------

    /// A swap offer, while its temporary entry is live (expired ones included
    /// until it lapses).
    pub fn get_swap(env: Env, swap_id: u64) -> Option<SwapOffer> {
        swap::get_swap(&env, swap_id)
    }

    /// A swap's acceptance, with the taker's stored proof.
    pub fn get_swap_acceptance(env: Env, swap_id: u64) -> Option<SwapAcceptance> {
        swap::get_acceptance(&env, swap_id)
    }

    /// The id the next `offer_swap` will assign.
    pub fn next_swap_id(env: Env) -> u64 {
        swap::next_swap_id(&env)
    }

    /// The pilot arbiter, fixed in the constructor.
    pub fn arbiter(env: Env) -> Address {
        store::config(&env).arbiter
    }

    /// The USDC contract, fixed in the constructor. The only token moved.
    pub fn usdc(env: Env) -> Address {
        store::config(&env).usdc
    }

    /// The largest price an offer may carry, in USDC's smallest unit.
    pub fn max_payment(env: Env) -> i128 {
        store::config(&env).max_payment
    }

    pub fn get_record_request(env: Env, request_id: u64) -> Option<RecordRequest> {
        offers::get_request(&env, request_id)
    }

    /// An open offer, or `None` once it is accepted, cancelled, or its entry
    /// has expired. An offer past its `expires_ledger` may still be returned
    /// until its entry lapses, but it cannot be accepted.
    pub fn get_offer(env: Env, offer_id: u64) -> Option<Offer> {
        offers::get_offer(&env, offer_id)
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<Escrow, Error> {
        escrow::get(&env, escrow_id)
    }

    /// The ids the next request, offer and escrow will take, so a client can
    /// enumerate them like rights.
    pub fn next_request_id(env: Env) -> u64 {
        offers::next_request_id(&env)
    }

    pub fn next_offer_id(env: Env) -> u64 {
        offers::next_offer_id(&env)
    }

    pub fn next_escrow_id(env: Env) -> u64 {
        escrow::next_escrow_id(&env)
    }

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
