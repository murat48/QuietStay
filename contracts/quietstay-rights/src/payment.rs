//! The only module that calls the USDC token (docs/PHASE3_SPEC.md §8).
//!
//! The token is the USDC Stellar Asset Contract fixed in the constructor. No
//! function in the contract takes a token address, so no other token can be
//! named. Three calls exist, and nothing else in the contract moves money:
//!
//! - [`set_allowance`]: the buyer's allowance to this contract, set by the
//!   buyer's own offer calls to the sum of their live offers (D12);
//! - [`pull`]: `transfer_from` a buyer, inside `accept_sale` (to the seller)
//!   and `accept_rental` (into escrow), for exactly the accepted offer's price;
//! - [`pay`]: from this contract's own balance, only out of an escrow, to that
//!   escrow's owner or renter.

use soroban_sdk::{token::TokenClient, Address, Env};

use crate::error::Error;
use crate::events::AllowanceSet;
use crate::store;
use crate::types::MAX_OFFER_LEDGERS;

fn usdc(env: &Env) -> TokenClient<'_> {
    TokenClient::new(env, &store::config(env).usdc)
}

/// Set the contract's allowance from `buyer` to `amount`, expiring
/// `MAX_OFFER_LEDGERS` from now. Every live offer expires by then. The USDC
/// contract asks for the buyer's authorization of this call, which the buyer
/// gives as part of the offer call that makes it.
pub fn set_allowance(env: &Env, buyer: &Address, amount: i128) {
    let expiration_ledger = env.ledger().sequence() + MAX_OFFER_LEDGERS;
    usdc(env).approve(
        buyer,
        &env.current_contract_address(),
        &amount,
        &expiration_ledger,
    );
    AllowanceSet {
        buyer: buyer.clone(),
        amount,
        expiration_ledger,
    }
    .publish(env);
}

/// Move `amount` from `from` to `to` under the allowance. If the allowance or
/// the balance is too low, or the allowance has expired, the call fails and
/// the whole transaction reverts. Both are checked first so the failure
/// carries this contract's error code; `transfer_from` enforces them again.
pub fn pull(env: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), Error> {
    let token = usdc(env);
    let this = env.current_contract_address();
    if token.allowance(from, &this) < amount {
        return Err(Error::AllowanceTooLow);
    }
    if token.balance(from) < amount {
        return Err(Error::BalanceTooLow);
    }
    token.transfer_from(&this, from, to, &amount);
    Ok(())
}

/// Pay `amount` out of the contract's own balance.
pub fn pay(env: &Env, to: &Address, amount: i128) {
    usdc(env).transfer(&env.current_contract_address(), to, &amount);
}
