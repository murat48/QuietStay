<!--
  The Phase 3 part of docs/EVIDENCE.md. `npm run evidence-doc` copies this file
  into EVIDENCE.md as it is, so edit the entries here, not in EVIDENCE.md. The
  generator refuses to write EVIDENCE.md if that would remove any heading the
  current EVIDENCE.md has.
-->
## Phase 3 — browser proofs, passkeys and USDC payments

Phase 3 is in progress. These entries are on testnet; Step 7 adds the mainnet
pilot and turns this part into the full Phase 3 guide.

### Phase 3: the SEP-45 web-auth contract (passkey sign-in)

**Claim:** the one contract QuietStay reuses rather than writes has an
`upgrade` function, but nobody can ever call it. It holds no rights and no
money, and the rights contract never calls it.

| | |
| --- | --- |
| Contract (testnet) | [`CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM`](https://stellar.expert/explorer/testnet/contract/CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM), deployed in [`31f48041…`](https://stellar.expert/explorer/testnet/tx/31f480413f355f51a545a2817ccdb1a8e163eab5a49d6f59a92debda5b825ff1) |
| Source | stellar/java-stellar-anchor-sdk @ `dc5817fb`, `soroban/contracts/web-auth`, unmodified ([contracts/vendor/anchor-web-auth/](../contracts/vendor/anchor-web-auth/PINNED.md)) |
| WASM hash | `708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1`, the same as a build of the pinned source |
| Stored `Admin` | `CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2` |
| Contract at that address | **none**. Its id is SHA-256("QuietStay SEP-45 web-auth: no admin"), and putting a contract there would need a SHA-256 preimage |

**What to look for:** on the contract's Stellar Expert page, the instance
storage shows `Admin` equal to `CDA2IFOT…33G2`. The page for
[`CDA2IFOT…33G2`](https://stellar.expert/explorer/testnet/contract/CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2)
shows no contract. `upgrade` requires that address's authorization, which can
never be given.

To check from a terminal, on either network:

```
$ npx tsx scripts/check-web-auth.ts --network testnet
testnet web-auth contract CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM (2026-11-19T20:10:11.795Z)
  ✓ WASM 708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1 = the pinned build
  ✓ stored Admin CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2 = the unauthorizable CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2
  ✓ no contract instance at CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2
upgrade() can never be authorized.
```

The pre-launch checklist repeats it with `--network mainnet`.

### Phase 3: a signing bug caught on testnet, before mainnet

**Claim:** testnet did its job. The first Step 3 deployment had a bug that
made every offer call fail on chain. It was found by the first real
transaction, fixed, covered by tests with real signatures, and the contract
was redeployed. It never reached mainnet.

| | |
| --- | --- |
| Failed transaction | [`32ee3532…5f42`](https://stellar.expert/explorer/testnet/tx/32ee35321401a80e5b1e6752f275febcbcb029fa2317f7eadd74711214dc5f42): `create_rental_offer`, refused with `Error(Auth, InvalidAction)`. Nothing moved; only the fee was charged |
| Superseded contract | [`CDC6XD3WK4GZSJWNBJELDBHAHNPHLS7WL6RZG2KEACC2RGJWCRTGKMZO`](https://stellar.expert/explorer/testnet/contract/CDC6XD3WK4GZSJWNBJELDBHAHNPHLS7WL6RZG2KEACC2RGJWCRTGKMZO), WASM `db92ae3e…b38f`. Left on testnet unchanged; not used |
| Fixed contract | [`CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73`](https://stellar.expert/explorer/testnet/contract/CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73), WASM `c7473e8e…6b6b` |

**The cause.** An offer call sets the buyer's USDC allowance with a call to
`approve` inside the same transaction, and the buyer's signature covers that
call's arguments. One argument was the allowance's expiration, computed as
"the current ledger + 120,960". The buyer signs when the transaction is
simulated; it lands a few ledgers later, when that sum is a different number,
so the signed arguments no longer matched and the network refused it. The unit
tests mocked every signature, and a mock cannot notice a changed argument.

**The fix.** The expiration is now the latest last ledger among the buyer's
live offers, a value fixed by what the buyer signed and by stored state, so it
is the same at simulation and at inclusion (PHASE3_SPEC.md, Step 3
implementation note 10). The tests that would have caught it now exist: they
sign with real ed25519 keys at one ledger and land the call ledgers later
(`real_signature_*` in `contracts/quietstay-rights/src/test_payments.rs`). On
the old rule they fail with the same `Error(Auth, InvalidAction)`.

**What to look for:** on the failed transaction's page, the operation's
authorization holds `approve` with an expiration of 5,957,168, the ledger at
simulation (5,836,208) plus 120,960, and the result is `Error(Auth,
InvalidAction)`. On the fixed contract, the same kind of offer,
[`8d42b704…a529`](https://stellar.expert/explorer/testnet/tx/8d42b704495844beec607290d7f497d4be7b24679372290dbfa26ded2bc9a529),
succeeds; its `approve` expires at the offer's own last ledger.

### Phase 3: no function accepts a token, so a wrong token cannot be named

**Claim:** the contract pays and is paid only in the USDC fixed at
deployment. There is no transaction to show for "wrong token rejected",
because no function takes a token address: a caller has no way to name
another token at all.

| | |
| --- | --- |
| Contract (testnet) | [`CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73`](https://stellar.expert/explorer/testnet/contract/CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73), WASM `c7473e8e…6b6b` |
| `usdc()` read back | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, Circle's testnet USDC (source in [PHASE3_PROGRESS.md, Addresses](./PHASE3_PROGRESS.md#addresses)) |
| The only token address in the interface | `usdc`, an argument of `__constructor` alone. No setter |
| In the source | the contract builds a token client in one place, `payment.rs`, from the stored constructor value ([`payment.rs`](../contracts/quietstay-rights/src/payment.rs)) |
| Unit test | `only_the_constructors_usdc_can_be_moved` ([`test_payments.rs`](../contracts/quietstay-rights/src/test_payments.rs)): a buyer holds a second token and approves it to the contract, then holds no USDC. The seller's acceptance is refused with `BalanceTooLow` (54), nothing moves, and the second token stays in the buyer's account |

The contract's 42 functions, as the network serves them:

```
__constructor  accept_rental  accept_sale  arbiter  balance  burn  cancel_offer
cancel_record_request  collect  commitment  confirm  create_rental_offer
create_sale_offer  decimals  extend_escrow  get_escrow  get_listing  get_offer
get_record_request  get_right  holder  holding  holdings  is_active  issue
issuer  list  max_payment  name  next_escrow_id  next_id  next_offer_id
next_request_id  refund  report_problem  request_record  resolve
submit_evidence  symbol  transfer  unlist  usdc
```

Every `address` argument outside the constructor names a party, never a
token: `accept_rental(owner)`, `accept_sale(seller)`, `balance(id)`,
`burn(from)`, `cancel_offer(buyer)`, `cancel_record_request(requester)`,
`collect(owner)`, `confirm(renter)`, `create_rental_offer(renter)`,
`create_sale_offer(buyer)`, `issue(owner)`, `list(by)`, `refund(owner)`,
`report_problem(renter)`, `request_record(requester)`, `resolve(arbiter)`,
`submit_evidence(by)`, `transfer(from, to)`, `unlist(by)`.

**What to look for:** on the contract's Stellar Expert page, the contract's
code lists the same 42 functions, and only `__constructor` has a `usdc`
argument. From a terminal (2026-11-21):
`stellar contract info interface --id CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73 --network testnet --output json`,
and `stellar contract invoke --id CA4B3MIZ…PPV73 --network testnet --send=no -- usdc`.

### Phase 3: an offer nobody accepts moves no money

**Claim:** making an offer moves no USDC. The money stays in the buyer's
account until the holder accepts with a proof, and if nobody accepts, the
offer expires and nothing has moved at all.

| | |
| --- | --- |
| Record request | [`de2c9d88…0e30`](https://stellar.expert/explorer/testnet/tx/de2c9d883e3789cfba07e055ec35a5a2a8aa79303f5620f45f7aaec2f35d0e30), by `qs-buyer` for week #4 |
| Sale offer #8 | [`b8d98645…dfbb`](https://stellar.expert/explorer/testnet/tx/b8d98645606a3c57f745ef51773d9f0d025aa13692723527c4b9ec62c99adfbb): 1 USDC, open until ledger 5,838,157. Never accepted |
| Contract | [`CA4B3MIZ…PPV73`](https://stellar.expert/explorer/testnet/contract/CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73) (testnet), 2026-11-20 |

USDC balances, read from the USDC contract at each point (7 decimals, so
10,000,000 = 1 USDC):

| When | Ledger | Buyer `GB3VDHPH…UWVQ` | Owner `GBCETLZR…4AYR` | QuietStay contract | Buyer's allowance to the contract |
| --- | --- | --- | --- | --- | --- |
| Before the offer | 5,838,126 | 190,000,000 | 20,000,000 | 10,000,000 | 0 |
| Offer #8 open | 5,838,128 | 190,000,000 | 20,000,000 | 10,000,000 | 10,000,000 |
| Offer #8 expired, never accepted | 5,838,159 | 190,000,000 | 20,000,000 | 10,000,000 | 0 |

The contract's 10,000,000 throughout is escrow #1, the Funded rental from an
earlier run, which this offer does not touch.

**What to look for:** the offer transaction has three events on Stellar
Expert: USDC's `approve` from the buyer to the contract for 10,000,000,
expiring at ledger 5,838,157, and the contract's `allow` and `sale_off`.
There is no `transfer` event: the offer gave the contract permission to take
1 USDC on acceptance, and moved nothing. Neither of the buyer's two
operations changed a balance, and the buyer's account has no operation after
them (Horizon `accounts/GB3VDHPH…UWVQ/operations`, 2026-11-20). The allowance
lapses at the offer's own last ledger, so it reads 0 afterwards.

Reproduce: `npx tsx scripts/step3-evidence.ts unaccepted-offer --contract <C…>`
(the readings are kept in `evidence/step3-testnet-CA4B3MIZ.json`, under
`readings`). Privacy record:
[`evidence/privacy/2026-11-20-step3-CA4B3MIZ-unaccepted-offer.txt`](../evidence/privacy/2026-11-20-step3-CA4B3MIZ-unaccepted-offer.txt).
