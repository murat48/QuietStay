# QuietStay Phase 3 — Pre-launch checklist (Step 5)

The GO or NO-GO decision is the project owner's, in writing. Nothing has been
sent to mainnet. The only mainnet calls in this step were read-only: protocol
and settings reads, account and contract reads, and two `simulateTransaction`
calls that nothing signed.

- **Date:** 2026-11-21 (UTC; every command below was run that day).
- **Branch / commit tested:** `phase3` @ `cb4e220` (code and evidence).
- **Final testnet deployment:**
  [`CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM`](https://stellar.expert/explorer/testnet/contract/CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM).
  - It runs WASM `76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde`,
    which is the WASM for mainnet. The swap is included.
  - Deployed by `scripts/deploy.sh` (tx
    [`12d4baaf…dcb7`](https://stellar.expert/explorer/testnet/tx/12d4baaf277be6d55f67f5616e95ea06bb3ceb41c36a4cd8ae705afb2d1bdcb7)).
    The WASM was already on testnet from Step 4, so there was no upload
    transaction.
  - Every flow was run on it once (§5).
- **Evidence files:** `evidence/checklist/`, `evidence/network/` and
  `evidence/privacy/2026-11-21-*CATUBRZZ*`.

Status words: **PASS** (checked, with evidence below); **OPEN — yours** (needs
the owner's action or decision before GO); **Step 6** (can only be done once
the mainnet contracts exist, and is a gate inside Step 6 before the first
flow).

## Summary

| # | Item | Status |
| --- | --- | --- |
| 1 | Permissions: the spec §10 table against the code and the deployed interface | **PASS** |
| 2 | Money movement: every USDC path, the invariant, the allowance and outside-account tests | **PASS** |
| 3 | Proof, offer and escrow reuse | **PASS** |
| 4 | Storage: the TTL plan, and every extend/restore command run on testnet | **PASS** |
| 5 | Transaction costs: each flow on testnet, against mainnet limits and fees | **PASS**, with a funding note (§5.3) |
| 5a | Swap cost on mainnet (the open Medium) | **PASS by parameters**; the live `--send=no` is a Step 6 gate (§5.2) |
| 6 | Configuration, testnet and mainnet side by side | **PASS** for every value that exists; mainnet ids are **OPEN — yours** / **Step 6** (§6) |
| 7 | Tests: every suite passes, no known serious bug | **PASS** (§7) |
| 8 | Spec §14 additions | see §8, item by item |
| 9 | Open issues: the High network issue | **proposed: close** (§9) |

**What GO still needs from you:** the list in §10. None of it is a code
change.

---

## 1. Permissions — PASS

**Interface = table.** The deployed contract has 50 functions
(`stellar contract info interface --id CATUBRZZ… --network testnet --output
json`, saved as `evidence/checklist/interface-functions-CATUBRZZ.json`). Every
one is in the spec §10 table, and the table names no function the contract
lacks. Its only other names, `give_right` and `want_right`, are arguments.

**Who signs, and in which state, read from the code** (`require_auth` calls
and state guards):

| Function | Code | Signs | State guard |
| --- | --- | --- | --- |
| `issue` | lib.rs:199 | `config.issuer` | fresh id |
| `list` / `unlist` | lib.rs:260 / 304 | `by`, who must be the effective holder | right active |
| `transfer` | lib.rs:358, 371 | `from`; on a sale also `to`, over `(right_id, h')` | proof, through `authorize_transfer` |
| `burn` | lib.rs:409 | `from` (title holder) | D11 guards |
| `request_record` / `cancel_record_request` | offers.rs:137 / 200 | requester | live request, ≤ 10 |
| `create_sale_offer` / `create_rental_offer` | offers.rs:264 / 338 | buyer / renter | limits |
| `cancel_offer` | offers.rs:384, 387 | the offer's buyer (`NotRequester` otherwise) | live |
| `accept_sale` / `accept_rental` | offers.rs:425 / 477 | seller / owner, plus the proof | live offer, matching price |
| `collect` | escrow.rs:169–176 | escrow owner | Funded, `now ≥ check_in + 24 h` |
| `confirm` | escrow.rs:183–188 | escrow renter | Funded or Disputed |
| `report_problem` | escrow.rs:199–206 | escrow renter | Funded, before check-in + 24 h |
| `refund` | escrow.rs:221–226 | escrow owner | Disputed |
| `submit_evidence` | escrow.rs:237–243 | owner or renter | Disputed |
| `resolve` | escrow.rs:272–277 | the arbiter (`NotArbiter` otherwise) | Disputed |
| `extend_escrow` | lib.rs:625 | anyone | TTL only |
| `offer_swap` / `cancel_swap` | swap.rs:158 / 209 | maker (title holder) | right active / swap live |
| `accept_swap` / `withdraw_swap_acceptance` | swap.rs:229 / 286 | taker, plus the proof | swap live / acceptance live |
| `complete_swap` | swap.rs:310 | maker, plus the proof | acceptance live, both proofs in window |

This matches the table row for row. There is no `upgrade`, no admin and no
setter. Only `issue` uses the issuer, and only `resolve` uses the arbiter.

**On chain, on the final deployment:**
- outsiders were refused for `resolve` (#51), `submit_evidence` (#47),
  `collect` (#47) and `confirm` (#47);
- the arbiter was refused for an undisputed escrow (#46), and for burning a
  right either naming its owner (`Error(Auth, InvalidAction)`) or as itself
  (#4).

The hashes are in `evidence/step3-testnet-CATUBRZZ.json`.

## 2. Money movement — PASS

**Every path that moves USDC.** `payment.rs` is the only module that calls the
token. Its callers (`grep -rn "payment::" src`):

| Path | Call | Moves | Preconditions |
| --- | --- | --- | --- |
| `accept_sale` | offers.rs:446 `pull(buyer → seller)` | price, buyer to seller | seller's proof, live offer, exact price, allowance ≥ price (#53), balance ≥ price (#54) |
| `accept_rental` | offers.rs:503 `pull(renter → contract)` | price into escrow | owner's proof, live offer, check-in rules, allowance, balance |
| `collect`, `confirm`, `resolve(PayOwner)` | escrow.rs:145 `pay(owner)` | escrow amount to the owner | per §1 states |
| `refund`, `resolve(RefundRenter)` | escrow.rs:155 `pay(renter)` | escrow amount to the renter | Disputed |
| offer calls | offers.rs:252, 399 `set_allowance` | nothing (an allowance) | the buyer's own signature, a sub-invocation of the offer call |

No function takes a token argument. The USDC address is fixed in the
constructor (`usdc()`), and the D7 cap is fixed too (`max_payment()`).

**Invariant: the contract's USDC equals its Funded and Disputed escrows**
(`evidence/checklist/usdc-invariant-testnet-2026-11-21.txt`, read with
`stellar contract invoke --send=no`):
- `CATUBRZZ…` (final): 10,000,000 = escrow #1 Funded; #2 Refunded, #3
  PaidOut. **Holds.**
- `CA4B3MIZ…` (Step 3): 10,000,000 = escrow #1 Funded. **Holds.**
- `CCSL6J5X…` (Step 4): 0, no escrows. **Holds.**
- Unit test: `the_contracts_usdc_always_equals_the_funded_and_disputed_escrows`, which passes.

**Allowance tests**, all passing (`cargo test`):
- `five_offers_share_one_allowance_through_accept_cancel_and_a_balance_drop`;
- `an_allowance_that_expires_before_its_offer_moves_nothing`;
- `an_offer_that_outlives_its_allowance_completes_once_an_offer_call_resets_it`;
- `the_allowance_expires_with_the_last_live_offer`;
- `the_allowance_is_set_inside_the_offer_call_not_by_a_separate_usdc_call`;
- the four `real_signature_*` tests.

On the final deployment, low allowance (#53), low balance (#54), wrong amount
(#32) and an expired offer (#34) were each refused on chain, and nothing
moved.

**Outside-account tests**, passing:
- `an_outside_account_cannot_move_usdc_or_a_right_without_a_builder_action`;
- `an_outsiders_offer_moves_money_only_when_a_builder_accepts_it`;
- `an_outside_account_cannot_move_a_right_through_any_swap_function`.

## 3. Proof, offer and escrow reuse — PASS

| Reuse | Guard | Evidence |
| --- | --- | --- |
| Proof (nullifier) | temporary entry that outlives the proof's `expiry_ledger` (auth.rs:256–269) | `a_replayed_proof_is_rejected`, `a_proof_spent_on_its_last_valid_ledger_cannot_be_replayed`, `a_nullifier_spent_at_the_start_of_the_window_outlives_the_proof`, `a_swap_proof_replayed_after_a_swap_back_is_refused_by_its_nullifier`; on chain #27 `5902f48a…dc15` (Step 4, same WASM) |
| Offer | removed on acceptance; a second accept gets `OfferNotFound` | `a_one_step_sale_moves_the_right_and_the_usdc_together` (its last assert) |
| Record request | consumed by the offer or the swap | `a_sale_offer_consumes_the_buyers_own_live_record_request`, `an_expired_or_cancelled_record_request_cannot_be_used` |
| Escrow | final states are final | `double_payout_double_refund_and_refund_after_payout_are_rejected`; on the final deployment: double payout `fa595342…`, refund after payout `44650834…`, report after payout `b93a479e…`, double refund `4442ec90…`, the arbiter resolving again `c50642cb…`, payout after refund `8ac6df50…`, all #46 |
| Swap | removed on completion | `a_completed_swap_cannot_be_completed_again` (#55) |

## 4. Storage and TTL — PASS

**The plan** (spec §9; the code is `store.rs`, `auth.rs:269` and
`escrow.rs`):
- the instance and persistent rights extend to 518,400 ledgers when below
  17,280;
- nullifiers live past their proof's window;
- offers, requests and swaps are temporary, until they expire;
- escrows are persistent, extended to check-in + 24 h + 30 days.

The minimum TTLs differ by network:

| | testnet | mainnet |
| --- | --- | --- |
| Minimum persistent TTL | 120,960 | 2,073,600 |
| Minimum temporary TTL | 720 | 17,280 |
| Maximum TTL | 3,110,400 | 3,110,400 |

On mainnet every new entry lives longer than the plan needs, so nothing is
archived sooner than on testnet.

**Every command, run on testnet** (`evidence/checklist/ttl-dry-runs-2026-11-21.txt`):

| Command | Result |
| --- | --- |
| `stellar contract invoke … --send=yes -- extend_escrow --escrow_id 1` (anyone may call) | [`4f597e4d…787b`](https://stellar.expert/explorer/testnet/tx/4f597e4d66edfe15cb85db7ab12f41f6750692f7f4c6cb000b13bfdeb0d5787b). Without `--send=yes` the CLI calls it read-only while the escrow is already at its target (534,682 ledgers left) |
| `stellar contract extend --id CATUBRZZ… --durability persistent --key-xdr AAAAEAAAAAEAAAACAAAADwAAAAZFc2Nyb3cAAAAAAAUAAAAAAAAAAQ== --ledgers-to-extend 700000` | [`a27094dd…467c`](https://stellar.expert/explorer/testnet/tx/a27094dd1d358f3afb560e5a67fce2005a9ff19e8c55265aa95f42f2c3f1467c): escrow #1 live until 6,384,764 → 6,550,089 |
| `stellar contract restore --id CC3URR3U… --durability persistent --key-xdr AAAAFA==` (an archived entry: the Phase 1 contract's instance) | [`38a3a0e3…3c86`](https://stellar.expert/explorer/testnet/tx/38a3a0e342ad80e0eeb5c6c11356ae81dab47d460b3059e64996f97d53a83c86): live until 0 (archived) → 5,971,133. The first attempt got the CLI's `Request timeout` and sent nothing |

**Mainnet note: who pays for the code's TTL.** The rights WASM and the
instance start with 2,073,600 ledgers on mainnet, about 120 days at 5 s.

- When fewer than 17,280 remain (after about 119 days), the next call extends
  both to 518,400 ledgers. That call pays the code entry's rent for those
  ledgers.
- That is about **17 XLM**, scaled from the upload simulation in §5.3. It is
  an estimate.
- This falls after the 30-day pilot. You can avoid it landing on a pilot
  account by running `stellar contract extend` on the code entry yourself
  beforehand.

## 5. Transaction costs — PASS

### 5.1 Each flow, measured on the final testnet deployment

Sources:
- `npx tsx scripts/flow-costs.ts --contract CATUBRZZ… --extra …` reads every
  accepted transaction's fee, its parts and its declared resources from the
  ledger (`evidence/checklist/flow-resources-testnet-CATUBRZZ.json`);
- the swap simulation is in `evidence/step4-testnet-CATUBRZZ.json`.

The limits are read from both networks and are identical on both
(`evidence/network-settings-{testnet,mainnet}-2026-11-21.json`, unchanged
since 2026-11-20): 400,000,000 instructions; 41,943,040 bytes of memory; 200
entries / 200,000 bytes read; 200 entries / 132,096 bytes written; a
132,096-byte transaction; 16,384 bytes of events.

| Flow (call) | Tx | Instructions (declared) | % of 400 M | Write B | Tx B | Testnet fee charged | Mainnet fee estimate (§5.3) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| issue (the first right on a new contract) | `792223d2…` | 1,425,629 | 0.4% | 3,244 | 1,032 | 91,239 | 1,151,705 |
| issue | `cf49406b…` | 1,443,393 | 0.4% | 3,244 | 1,032 | 72,765 | 903,774 |
| request_record | `0f83e9d6…` | 1,492,812 | 0.4% | 3,168 | 924 | 53,820 | 373,329 |
| create_sale_offer (+ USDC approve) | `094c9061…` | 2,064,888 | 0.5% | 3,604 | 1,588 | 81,530 | 316,225 |
| accept_sale (proof + USDC) | `f01dda8d…` | 88,328,535 | 22.1% | 1,496 | 3,432 | 71,297 | 301,651 |
| create_rental_offer (+ approve) | `7ef308d2…` | 1,790,517 | 0.4% | 3,460 | 1,356 | 80,338 | 383,746 |
| accept_rental (proof + escrow), the first escrow | `88c73f2e…` | 88,522,893 | 22.1% | 4,772 | 3,448 | 511,926 | 1,867,061 |
| accept_rental (proof + escrow) | `b1c48866…` | 88,547,772 | 22.1% | 4,820 | 3,408 | 393,045 | 1,418,249 |
| confirm | `7efa759e…` | 1,551,522 | 0.4% | 944 | 936 | 10,555 | 10,555 |
| report_problem | `6111325f…` | 1,179,924 | 0.3% | 640 | 700 | 23,186 | 64,646 |
| submit_evidence | `0d21f5f8…` | 1,188,733 | 0.3% | 680 | 700 | 25,266 | 71,333 |
| resolve (RefundRenter) | `45919dee…` | 1,651,607 | 0.4% | 1,096 | 1,064 | 30,121 | 71,582 |
| cancel_offer | `0995cf68…` | 1,581,779 | 0.4% | 296 | 1,236 | 9,246 | 9,246 |
| request_record (swap) | `d939b806…` | 1,503,024 | 0.4% | 3,168 | 924 | 30,404 | 280,332 |
| offer_swap | `6e870e75…` | 1,740,807 | 0.4% | 3,156 | 1,120 | 17,754 | 88,459 |
| accept_swap (stores the proof) | `e7edf1e0…` | 2,175,309 | 0.5% | 1,512 | 3,108 | 20,137 | 30,115 |
| **complete_swap (2 proofs)** | `e27478f4…` | **174,820,830** | **43.7%** | 1,640 | 3,412 | 81,232 | 83,026 |
| smart wallet deploy (passkey) | `6dfa709f…` | 3,051,892 | 0.8% | 1,040 | 1,636 | 132,669 | 1,627,651 |
| transfer, rental, passkey-authorized | `4a20d086…` | 92,579,414 | 23.1% | 844 | 3,692 | 292,327 | 1,176,668 |

Fees are in stroops (1 XLM = 10,000,000 stroops).

- The largest transaction is `complete_swap`, at 43.7% of the instruction
  limit.
- Across all 37 transactions: writes are at most 4,820 bytes (3.6%), size at
  most 3,692 bytes (2.8%), and footprints at most 14 entries (7%).
- `complete_swap` emitted 3 events, 944 bytes (5.8%).
- Memory is from the local host budget: 2,411,392 bytes (5.7%) for
  `complete_swap` run from the WASM.

### 5.2 Swap cost on mainnet (the open Medium item)

**No mainnet `--send=no` of `complete_swap` is possible before the contract is
on mainnet**, and this step does not touch mainnet. What was measured
instead:

1. **The cost parameters are identical for everything this WASM can use.**
   - Mainnet has 86 CPU and 86 memory cost parameters, and the first 86 on
     testnet are byte-identical to them.
   - Testnet's extra 9 (indices 86–94) are protocol-30 host functions.
   - This WASM imports 48 host functions, the newest needing protocol 22
     (BLS12-381), so it cannot reach any of those 9.
   - Command: a Python diff of `contract_cost_params_*` in the two saved
     settings files.
2. **The same metered work, priced with each network's parameters, gives the
   same count.**
   - `cargo test -p quietstay-rights swap_cost_network_priced -- --ignored
     --nocapture` runs the built WASM (sha256 `76d69e79…dddde`) in the VM
     through a full swap.
   - Each of the 86 cost types' metered iterations and inputs are then
     priced with each network's own parameters: testnet 167,615,462,
     mainnet 167,615,462. The ratio is 1.0000.
   - The RPC's testnet simulation of the real `complete_swap` (174,820,830)
     is higher. The local run does not model the transaction's own
     authorization and storage setup, but neither does that difference
     depend on the network's parameters.
3. **The upload of this exact WASM simulated on mainnet** (§5.3), which shows
   mainnet accepts it. It used 60,999,798 instructions to upload.

**Proposal:** close the Medium as measured, and keep one gate in Step 6: right
after the mainnet deploy, before any swap transaction, a mainnet `--send=no`
of `complete_swap`. If it is ever above 400 M, the swap stays testnet-only,
as the SOW says. Based on the above, the expectation is about 175 M, 44%.

### 5.3 Mainnet fees: the same transactions, priced for mainnet

**Method** (`cargo test -p quietstay-rights mainnet_fees -- --ignored
--nocapture`; output `evidence/checklist/flow-fees-mainnet-estimate-CATUBRZZ.{json,txt}`):
- Every fee rate is the same on both networks except rent.
- The instruction count is the same (§5.2).
- So mainnet fee = testnet charged − testnet rent + mainnet rent.
- Mainnet rent is the host's own `compute_rent_fee` over each transaction's
  real rent changes (entry sizes and live-until, read from the meta), with
  two changes for mainnet:
  - every new entry lives at least mainnet's minimum TTL;
  - the rent rate is mainnet's: 1,000 stroops per KB, from its live state
    size of 1.565 GB against a 3 GB target. Testnet's is 1,198, at 4.72 GB
    against 7 GB.
- **Check of the method:** with testnet's settings, the same computation
  reproduces the rent testnet charged within 0.2% for 36 of the 37
  transactions. The 0.2% is the state size moving between then and now.
- The one miss is an entry that had expired before it could be read (−49%,
  flagged in the output).
- For entries that already existed, the estimate errs high.

**Result:** on mainnet the pilot flows cost **under 0.001 to 0.19 XLM each**. The most
expensive are `accept_rental` (0.14–0.19 XLM), the smart-wallet deploy
(0.16 XLM) and `issue` (0.09–0.12 XLM). The 1 USDC payment cap is
unaffected.

**Deploy costs: two real mainnet simulations** (`scripts/mainnet-simulate-upload.ts`,
which signs nothing and sends nothing; the source is `mainnet-test`'s public
key):

| Upload | WASM | Simulated minimum resource fee | Of which |
| --- | --- | ---: | --- |
| Rights contract | 71,244 B, `76d69e79…dddde` | **694,336,359 stroops = 69.43 XLM** | almost all rent: 71 KB of code for mainnet's 2,073,600-ledger minimum |
| SEP-45 web-auth | 1,547 B, `708cacdc…cbc1` | 34,403,037 stroops = 3.44 XLM | rent |

For comparison, the same rights WASM's testnet upload (`1b9ac00a…`) charged
38,127,317 stroops = 3.81 XLM.

**Funding note for GO:** the mainnet deployer identity needs **at least about
75 XLM** for the two uploads, plus the two deploys and the minimum balance.

- The deploys can only be simulated once the WASM is uploaded. Their estimate
  is about 0.5 XLM each, mostly the instance's rent, scaled the same way.
- Each pilot account needs about 1–2 XLM for its fees, plus the reserve for
  its USDC trustline.

## 6. Configuration — PASS for every value that exists

| Value | Testnet | Mainnet | Checked by |
| --- | --- | --- | --- |
| Network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` | `npx tsx scripts/check-protocol.ts` (`getNetwork` on both): PASS |
| Protocol | 30 | **29**, as the contracts were built and tested for | same: PASS |
| RPC URL | `https://soroban-testnet.stellar.org` (30.0.1) | `https://mainnet.sorobanrpc.com` (30.0.1), free, no key | same. The CLI has no mainnet RPC configured (Low issue). Every mainnet script names this URL |
| Rights WASM hash | `76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde` (on chain on `CATUBRZZ…`: `stellar contract fetch` + `sha256sum`) | the same file; upload simulated (§5.3) | build = on-chain testnet = simulated upload |
| WASM env-meta | protocol v27 | v27 ≤ 29 | `stellar contract info env-meta` |
| Host functions | 48 imports, all known; the newest needs protocol 22 (BLS12-381); none has a maximum protocol | same | `evidence/checklist/host-functions-2026-11-21.json` (the WASM's imports against soroban-env-common 27.0.1 `env.json`) |
| Verification key hash | `55ce858fea2e86e56917a114aba2dc3cdec17270c534ab9b3941743b01aeb1de` (read from `CATUBRZZ…`'s instance, equal field by field to the committed key) | the same file goes to the constructor; checked with `--network mainnet` after deploy (Step 6) | `npx tsx scripts/check-vk.ts --network testnet --contract CATUBRZZ…`: PASS. The key files match `circuits/keys/SHA256SUMS` (the `.r1cs` is in `circuits/build/`, also matching) |
| USDC contract | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | Circle issuers `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` / `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (developers.circle.com/stablecoins/usdc-contract-addresses), then `stellar contract id asset --asset USDC:<issuer>`: both re-derived today; both instances are Stellar Asset Contracts on chain |
| `usdc()` read back | `CBIELTK6…DAMA` | Step 6 | `stellar contract invoke --send=no -- usdc` |
| `max_payment()` | 1,000,000,000 (100 USDC) | 10,000,000 (1 USDC), the constructor argument (D7) | read back; mainnet in Step 6 |
| Issuer | `GBNBWXSCEGJWGMNZ2GAOFG2RBZOCTGTI6SIJH3ZSU2AEPZWCFUA7YUBE` (`qs-issuer`) | **OPEN — yours:** the mainnet issuer/deployer identity | `issuer()` |
| Arbiter | `GACLONYVHKPB4BG3QUWMKG4LAKTRYKM4CFLBF4VTBAF5773X4UYZEEZC` (`qs-arbiter`) | **OPEN — yours:** the mainnet arbiter identity (it must not be the issuer; the constructor refuses that) | `arbiter()` |
| Rights contract | `CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM` | Step 6 | |
| SEP-45 web-auth | `CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM`, WASM `708cacdc…cbc1` | Step 6 (upload simulated, §5.3) | `npx tsx scripts/check-web-auth.ts --network testnet`: 3/3 |
| Sign-in key | `GDC2YUKYIPDETC6M7QVOL4222SJF6MVYCW5ZOOVFQEZQQPYIENPLRRGQ` (exists, HTTP 200) | `GCEF3BTQVDJ473URMW4556VG67YAPS2J5OP77FBXT7T47M2DOIZ7TDAR` (`mainnet-test`, exists, **9.0001000 XLM**, 0 subentries) | Horizon `accounts/<G…>` |
| WebAuthn verifier (OZ) | `CC7EKIHQ…OM3F`, WASM `e63a030d…6b72b76` (v26) | `CB7HENHJ…Q5YR`, WASM `e63a030d…6b72b76` (v26) | `stellar contract fetch` + `sha256sum` (`evidence/checklist/oz-contracts-2026-11-21.txt`) |
| OZ account WASM | `c514d35e…4b9e1`, installed (v28) | `c514d35e…4b9e1`, installed (v28) | same |
| Fee account | `GCGDZWCL…L77Z` (`qs-fee-testnet`): no USDC, no right, not the issuer, arbiter or sign-in key | none: the route is compiled out off testnet | `npx tsx scripts/check-fee-account.ts --contract CATUBRZZ…`: PASS (new script; spec §13 named it) |
| App configuration | `src/lib/config.ts` (testnet only, by design) | Step 6 writes the mainnet build's configuration from this table | |

The WASM hash and the verification key hash cannot differ between the
networks: the same file is deployed, and the key is a constructor argument
from the same committed file. Step 6 reads both back from mainnet.

## 7. Tests — PASS; no known serious bug

All run 2026-11-21 on the final code (`evidence/checklist/tests-2026-11-21.txt`):

| Suite | Result |
| --- | --- |
| `cd contracts && cargo test` | rights **158/158** (+2 `--ignored` cost tests, both pass), verifier 6/6, measure 1/1 |
| `cargo clippy --all-targets` | 0 warnings |
| `npm run test:app` | 40/40 |
| `npm run zk:test` | 29/29 |
| `npx tsc --noEmit` | clean |
| `npm run zk:check-bundle` | passes (the GPL code is only in the worker) |
| `npm run check-privacy`, `-- --phase2` | pass |
| `next build --webpack` | passes; two warnings from dependencies (ffjavascript's dynamic require; smart-account-kit's optional wallets-kit peer, spec §12) |
| `npm run lint` | the 7 errors from before Step 2 remain (Low issue); the unused import in `verify/page.tsx`, counted with them until now, is removed |
| `npx playwright test` (all browser specs, **on the final WASM**: no-leak, passkey and passkey-app now deploy `76d69e79…`, as swap already did) | **16/16, first run** (10.6 min). The rerun after the network fix (§9): 14 passed, then no-leak failed in its set-up on the test process's own Friendbot `fetch` (`TypeError: fetch failed`, `AggregateError`; this machine's line, §9 cause 2), so the spec after it did not run. `fund()` (`e2e/lib/testnet.ts`) now retries a dropped connection, after checking whether the account was funded. Then `npx playwright test e2e/no-leak.spec.ts`: 2/2 |

**On chain, on the final deployment:** 37 accepted transactions and 19
refused, each with exactly the expected error. The 37 are 26 from the payment
driver, 7 from the swap, the arbiter's resolve, and the passkey probe's 3. Every one has a passing
privacy record (`evidence/privacy/2026-11-21-step3-CATUBRZZ-*.txt`,
`…-step4-CATUBRZZ-swap-measure.txt`, `…-final-passkey-probe-4a20d086.txt`).

**Open issues by severity:**
- no Critical;
- the one High is proposed for closing (§9);
- the Medium items are each either this checklist's own items or Step 6
  gates;
- the Lows are recorded in PHASE3_PROGRESS.md.

## 8. Spec §14 additions, item by item

| Item | Status | Evidence |
| --- | --- | --- |
| Same WASM; `max_payment`, `usdc`, `arbiter`, `issuer` read back side by side | testnet **PASS**; mainnet **Step 6** | §6 |
| Built and tested for mainnet's protocol; env-meta v27 | **PASS** | §6 |
| Mainnet `--send=no` of the deploy and of each flow | upload **PASS** (simulated); the deploy and the flows **Step 6** (they need the uploaded WASM) | §5.2, §5.3 |
| No protocol-30-only feature; host functions listed | **PASS** | §6 host functions |
| OZ account and verifier WASM on mainnet | **PASS** | §6 |
| `scripts/check-protocol` | **PASS** (new script; mainnet 29). `mainnet-sign-submit.sh` now runs it before every mainnet signature | `evidence/checklist/check-protocol-2026-11-21.txt` |
| Web-auth contract: WASM, admin, no instance at the admin, declared protocol | testnet **PASS**; mainnet **Step 6** | §6 |
| Sign-in key `mainnet-test` at the minimum balance | **OPEN — yours**: it holds 9.0001000 XLM. The minimum for 0 subentries is 1 XLM; reduce it before its secret goes to the server | `evidence/checklist/mainnet-test-balance-2026-11-21.txt` |
| Pilot funds never sent to the contract directly | testnet **PASS** (invariant, §2). `tx-review.ts` now refuses a USDC `transfer` to the rights contract, anywhere in the call tree, and on mainnet refuses without `QS_RIGHTS_CONTRACT` (rehearsed: `evidence/checklist/tx-review-refuses-usdc-to-contract-2026-11-21.txt`) | |
| Every G account receiving USDC has a trustline | **OPEN — yours**: the mainnet pilot accounts do not exist yet. New `scripts/check-pilot-accounts.ts` checks each trustline and the 5 USDC total; it is rehearsed on testnet (it caught `qs-arbiter` without one, and a total over a limit), and `mainnet-sign-submit.sh` runs it before every mainnet signature (`QS_PILOT_ACCOUNTS`) | `evidence/checklist/check-pilot-accounts-testnet-2026-11-21.txt` |
| D7: the 5 USDC total before each mainnet transaction | **PASS** (the same script; it was missing until now) | |
| One server log per test run | **PASS** (2026-11-21: two runs on port 4322 left two logs; today's full runs left one log each) | `e2e/results/logs/` |
| Submission recovery, including the "not found" path before GO | **PASS**: first send failed (testnet hook), the lookup said NOT_FOUND, and the same envelope landed: [`d4369423…ec5d`](https://stellar.expert/explorer/testnet/tx/d4369423d4a6b67785bfbb25ce327e5ef561979073bdc985cdb4b7a9577eec5d) | `evidence/checklist/submission-recovery-not-found-2026-11-21.txt` |
| Privacy evidence for every evidence transaction | **PASS** | §7 |
| The store (Upstash) for SEP-45 and the fee route | **Step 6**, for each deployment's environment | PHASE3_PROGRESS.md (Medium) |

## 9. The High network issue — proposed: close

**Measured** (`evidence/network/`). A read-only probe ran from this machine
every 3 s for 90 minutes, then two 30-minute probes side by side. It hit the
testnet RPC, testnet Horizon, Friendbot and the mainnet RPC, logging each
failure's full cause chain.

- **Cause 1 (client side, fixed).** Node's `fetch` races IPv6 and IPv4 and
  gives each address **250 ms** (`net.getDefaultAutoSelectFamilyAttemptTimeout()`).
  - This machine has **no IPv6 route** (`ip -6 route`: link-local only), so
    IPv6 fails at once (`ENETUNREACH`).
  - Any IPv4 connect slower than 250 ms also fails, so the request fails as
    `ETIMEDOUT` after about 0.5 s, although the host is up.
  - In the 90-minute run this was the dominant failure on every
    Cloudflare-fronted host (testnet RPC, Friendbot, mainnet RPC).
  - **With 2 s per attempt, in the parallel run, it went from 61 failures to
    0.**
  - The fix is one line in `src/lib/rpc-server.ts`
    (`net.setDefaultAutoSelectFamilyAttemptTimeout(2_000)`). That file is
    server-only, and is used by the app's routes, the scripts and the e2e
    helpers.
  - It is the `ETIMEDOUT` this morning's browser run logged
    (`[rpc-retry] simulateTransaction: attempt 1 of 3 failed (ETIMEDOUT
    (https://soroban-testnet.stellar.org))`), the first captured code for
    this issue.
- **Cause 2 (this machine's connection, not fixable in code).** Some outages
  showed up with and without the fix, on all four hosts, Horizon included:
  DNS failures (`EAI_AGAIN`), 10 s connect timeouts
  (`UND_ERR_CONNECT_TIMEOUT`) and 30 s hangs.
  - In the 15:08–15:38 window: 3.7–7.6% of requests to Horizon, which had
    almost none of cause 1's failures.
  - The bounded read retry covers the reads.
  - A submission is never retried blindly: the CLI and
    `mainnet-sign-submit.sh` look the transaction up by hash, and resend only
    the same signed envelope.
- **The app's 500/502s** were these failures, passed on by routes that read
  the ledger. Nothing points to a bug in QuietStay or in the networks' servers.

**Proposal:** close the High, because the cause is found. Record a Low: "this
machine's connection drops at times (DNS, connect timeouts); the reads retry,
the sends recover by hash". The decision is yours.

## 10. Before GO: what is yours

1. **Mainnet identities**, created by you in the CLI keystore. I create none.
   - the issuer/deployer, funded with at least about 75 XLM (§5.3);
   - the arbiter (not the issuer);
   - the fee identity for the mainnet CLI signing flow (spec §13);
   - the pilot owner, buyer and renter.

   Then give me their public keys.
2. **USDC trustlines** on every mainnet G account that will receive USDC.
   After that, `scripts/check-pilot-accounts.ts --network mainnet --accounts …`
   must pass, total ≤ 5 USDC.
3. **`mainnet-test`'s balance** reduced to the minimum (it holds 9.0001000
   XLM).
4. **Decisions:**
   - close the High (§9);
   - close the swap Medium with the Step 6 gate (§5.2);
   - accept the about-75 XLM deploy cost (§5.3), and the about-17 XLM code
     extension after about 119 days (§4).
5. **Step 3 still open:** the escrow #1 collect on `CA4B3MIZ…`, which you run
   after 2026-11-21T20:28:30Z.
   - Separately, the final deployment's wait rental (escrow #1 on `CATUBRZZ…`)
     can be collected from **2026-11-22T13:50:56Z** with `npx tsx
     scripts/step3-evidence.ts collect-wait --contract
     CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM`.
   - That is the one flow on the final WASM that needs the 24 h wait. Its
     refusal before the window is already on chain: #48, `396deb7b…`.

**Step 6 gates**, before the first flow on mainnet:
- the upload and the deploy, each simulated before it is sent;
- `usdc()`, `max_payment()`, `arbiter()`, `issuer()` and the WASM and key
  hashes read back from mainnet;
- `check-web-auth --network mainnet`;
- a `--send=no` of each flow, the swap included;
- the store configured;
- the sign-in key at its minimum balance.

Each needs your confirmation of the exact command first.
