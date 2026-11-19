# QuietStay Phase 3 — specification

Status: **revised after the first review (Step 1). No Phase 3 product code
exists until this is approved.** D1 is approved; D4, D5 and D12 are waiting.

Written 2026-11-19 against `main` at `66cdf13`. Every measured number below
names the command that produced it. Anything marked *estimate* is derived from
measured numbers, and the derivation is shown.

---

## One page, in plain language

**What QuietStay is today.** A vacation week is a token on Stellar. To rent it
out or sell it, the owner needs two things: their wallet, and a secret that only
the owner knows. The owner proves they know the secret with a small mathematical
proof, and the contract checks that proof. Nobody else, not even the company
that issued the week, can move it. Today the owner makes the secret and the
proof with command-line tools. Nobody pays anyone: the contract moves weeks,
not money.

**What Phase 3 adds.**

1. **No command line.** The website makes the secret and the proof itself,
   inside the owner's browser. The secret and the ownership record never leave
   that browser; an automated test watches every network request to prove it.
2. **Passkeys.** Instead of a wallet extension, a user can approve with a
   passkey (Face ID, fingerprint or device PIN). Behind the passkey is a
   "smart wallet", a small contract account. The existing wallets keep working.
3. **Paying in USDC, safely.**
   - *Sale:* the buyer makes an on-chain offer and lets the contract take up to
     the price from their account. Nothing moves until the owner accepts. When
     the owner accepts, the money goes to the owner and the week goes to the
     buyer in **one** transaction. Either both happen or neither does.
   - *Rental:* when the owner accepts, the renter's money goes into the
     contract (an *escrow*), not to the owner. The owner can collect it only
     **24 hours after check-in**. Until then the renter can release it early, or
     report a problem. A reported problem is settled by the two parties or,
     failing that, by a fixed *arbiter* address. The arbiter can only send the
     escrowed money to the owner or back to the renter. It cannot touch any week.
4. **Swaps.** Two owners can exchange weeks. Both weeks move in one transaction,
   or neither does.
5. **A small live pilot on Stellar Mainnet**, with sample weeks and at most
   1 USDC per payment (5 USDC in total), all in the builder's own accounts. It
   starts only after a written checklist and your GO.

**What does not change.** One proof circuit, the same cryptography, the same
verification key, no admin key and no upgrade function. The trusted setup is
still the builder's development setup and is labeled non-production
everywhere. This is a controlled pilot, not an audited launch.

**Review status (2026-11-19).** The circuit does **not** need to change
(item 1), and a smart-wallet proof has been made and verified to show it. D1,
D2 and D6 are approved with conditions, which this version records. D4, D5
and the new D12 are waiting for approval. See
[Decisions for approval](#decisions-for-approval).

---

## Step 0 findings that shape this spec

- **No Phase 3 code exists.** The only Phase 3 material is
  `docs/PHASE3_PROMPT.md` and `docs/PHASE3_PROGRESS.md`, plus the one-off
  measurement contract added for item 11 (`contracts/quietstay-measure`, not
  product code). The two side branches, `feat/premium-marketplace-ui` and
  `phase1-upgrade-and-fee-settlement`, hold UI and Phase 1 work only.
- **The circuit has 11 public signals:** `commitment, nullifier, right_id,
  from_hi, from_lo, to_hi, to_lo, mode, expiry_ledger, next_secret_hash,
  next_commitment` (`circuits/gpl/transfer.circom`, docs/CIRCUIT.md §7).
- **How the holder's account is bound today.** `C = Poseidon5(d_hi, d_lo,
  from_hi, from_lo, h)`, where `(from_hi, from_lo)` are the two 16-byte halves
  of the holder's 32-byte Ed25519 key. `auth.rs::split_account` takes the key
  from `Address::to_payload()` and refuses anything but a `G…` account
  (`NotAnAccount`, error 18). `issue` refuses a contract address as owner for
  the same reason. A C-address cannot hold a right today.

---

## 1. Account binding for passkeys (blocking)

**The problem.** A smart wallet is a contract address (`C…`). The Phase 2 proof
binds 32 bytes of the holder's Ed25519 key, and a contract address has no such
key.

**Design: bind the 32-byte payload of either address kind, with a kind tag in
the high half. No circuit change.**

`Address::to_payload()` returns 32 bytes for both kinds:

| Address | Payload | Tag `t` |
| --- | --- | --- |
| `G…` account | `AccountIdPublicKeyEd25519(k)`, the Ed25519 key | `0` |
| `C…` contract (smart wallet) | `ContractIdHash(k)`, the contract id | `1` |

```
hi = t · 2^128 + int(k[0..16], big-endian)
lo =             int(k[16..32], big-endian)
```

- **For `G…` accounts nothing changes** (`t = 0`). Every Phase 2 commitment,
  proof, fixture and test stays valid.
- **The circuit already accepts this.** `from_hi`, `from_lo`, `to_hi` and
  `to_lo` are plain field elements (BLS12-381 `r` is about 2^255), and the
  circuit hashes them without range checks. A value up to 2^129 is a valid
  input. So the circuit, the proving key and the verification key all stay
  unchanged.
- **Kinds cannot be confused.** Without the tag, a `G…` key and a `C…` id with
  the same 32 bytes would encode the same way. Making that happen would already
  require a SHA-256 preimage or an Ed25519 key for a chosen value. With the tag,
  the encodings are disjoint by construction, so no argument about hardness is
  needed.
- **The contract still never computes Poseidon.** `auth.rs` builds `(hi, lo)`
  from the `Address` it was given, then compares them with the signals.
- **Who authorizes stays separate from what is proved.** For a smart wallet,
  `from.require_auth()` invokes the wallet's `__check_auth`, which checks the
  passkey signature via the OpenZeppelin WebAuthn verifier. The proof still
  says "this address's record secret is known". A transfer from a smart wallet
  therefore needs the passkey **and** the secret, just as a `G…` holder needs
  the wallet key **and** the secret.

Code changes, for after approval:

- `split_account` becomes `split_address`, and it adds `2^128` to `hi` for a
  contract.
- `require_account` accepts both kinds and still rejects anything else.
- `issue` accepts a `C…` owner.
- The prover's `split` (`scripts/lib/zk-encode.ts`) and its browser version
  apply the same tag. docs/CIRCUIT.md §5 is updated.
- New tests: a proof from a C-address holder, a proof to a C-address
  recipient, a G-key/C-id collision (same 32 bytes, different kind) that must
  be rejected, and every Phase 2 test unchanged.

**Review condition (D1), checked 2026-11-19.**

- **No range check exists on the account halves.**
  - `transfer.circom` instantiates only `Poseidon(1)`, `Poseidon(5)` and
    `Poseidon(6)`.
  - `poseidon.circom` builds those from the round-constant, S-box and mix
    templates only.
  - Neither file contains `Num2Bits`, a comparator or any other bit
    decomposition (`grep -nE "Num2Bits|LessThan|GreaterThan|Bits"
    circuits/gpl/*.circom`).
  - `from_hi`, `from_lo`, `to_hi` and `to_lo` are used only as Poseidon inputs.
- **Proved and verified end to end for a C-address holder** with the committed
  `transfer.wasm`, `transfer.zkey` and `verification_key.json`, unchanged. The
  test is `circuits/test/c-address.test.ts`, run with `npm run zk:test`; 18/18
  pass, including the 11 Phase 2 tests. It covers:
  - a sale from a C holder to a G account;
  - a sale from a G account to a C recipient;
  - a rental from a C holder;
  - the same 32 bytes as G and as C give different encodings and commitments;
  - a witness claiming the untagged encoding of a C holder's commitment fails
    at the circuit's commitment constraint (`transfer.circom` line 50).
- **The C-holder proof also verifies on chain.** The Phase 2 verifier
  `CDMUMMOF3TM453RY4QZL6UWV2FT2QP3JUWW24SFIH5ICWSVGRB4IK5BK` returns `true`;
  with one public signal changed it returns `false`. Commands:
  - `QS_WRITE_PROOF_DIR=proofs/phase3-c-address npx tsx --test circuits/test/c-address.test.ts`
  - `stellar contract invoke --id CDMUMM…K5BK --network testnet --send=no -- verify --proof "$(cat proofs/phase3-c-address/proof.json)" --public_signals "$(cat proofs/phase3-c-address/public.json)"`
- **No circuit change is needed.** The contract-level test (a C-address holder
  transferring through `authorize_transfer` with a real passkey-signed auth
  entry) is part of Step 2, because it needs the `auth.rs` change.

**Honest limit.** In the browser, the passkey and the record secret live on the
same device. A stolen *unlocked device* gives both. Phase 2's "a stolen wallet
key alone cannot transfer" still holds for a stolen *passkey* (a passkey cannot
be exported) and for a stolen G-key.

## 2. Browser proving

**Where things are kept.** The data lives in IndexedDB, in the app's own
origin. Records are keyed by `(network, contract id, right id)`:

| Entry | Contents | Created |
| --- | --- | --- |
| `secret` | `s` (32 random bytes from `crypto.getRandomValues`, reduced below `r`), `h` | when the user asks for a week, or when a buyer makes an offer |
| `record` | the canonical ownership record (JSON) and its digest `d` | imported once (below) |
| `pending` | for a buyer: `s'`, `h'`, the offer id | when the offer is made; becomes `secret` once the chain shows the buyer holding title with the matching commitment |

The secret is stored as-is. Encrypting it at rest with a key derived from the
passkey (WebAuthn PRF) would be scope creep, and it would not protect against
the same-device case anyway. A backup export is decision D3.

**How they get there the first time, for a sample right.** Phase 3 deploys a
new contract, so the sample weeks are issued again:

1. The owner opens *Request a week*. The prover worker generates `s` and
   computes `h = Poseidon(s)`. The request sends only `h`, exactly as the
   Phase 2 `/issue?h=…` flow does.
2. The issuer issues as in Phase 2. The server computes `C` from the record
   and `h`, and it never sees `s`.
3. The record reaches the owner's browser through the **sealed link**
   described below. The owner's request link goes to the issuer, and the
   issuer's browser sends back the encrypted record. The worker computes `d`
   and `C = Poseidon(d, owner, h)` and refuses the record unless `C` equals
   the commitment on chain. This is decision D3; no file is involved.

From then on, proving needs no file and no command line.

**A buyer's new secret, after a sale or a swap.**

1. When making an offer, the buyer's worker generates `s'` and stores it as
   `pending` **before** the offer transaction is signed. The offer carries only
   `h'`.
2. Before offering, the buyer has already received the record from the seller,
   through the sealed link below, and checked it against the current `C` with
   the seller's `h`. That is the Phase 2 verification step, now in the
   browser. The record is kept.
3. When the chain shows the buyer holding title and
   `commitment == Poseidon(d, buyer, h')`, the `pending` entry becomes the
   buyer's `secret`.

A swap works the same way for both sides.

**How the buyer's browser receives the private record: a sealed link, with no
files and no server storage (review of D4).** The buyer needs `d` to prove
later, and wants the whole record to check what they are buying. Two
browser-made links carry it. Each link carries its data only after `#`.
Browsers never send the part after `#` in any HTTP request, so the server
neither receives nor stores it.

1. **Request link.** The buyer presses *Ask for the record*. Their browser
   makes an ECDH P-256 key pair with WebCrypto. The private key is
   non-extractable and kept in IndexedDB. The browser shows
   `…/receive#req=<right id>.<buyer public key>`, which the buyer sends to the
   seller through any channel the two already use (a message, an email).
2. **Reply link.** The seller opens it in their own QuietStay browser and
   confirms. Their app encrypts `{record, h, right id, contract id}` to the
   buyer's public key: ECDH, then HKDF-SHA-256, then AES-256-GCM, with an
   ephemeral seller key. It shows `…/receive#rec=<ciphertext>`. The record is
   about 900 bytes, so the link is about 1.5 KB.
3. **Import.** The buyer opens the reply link. The app does the following
   before anything else:
   - reads the fragment and removes it from the address bar
     (`history.replaceState`);
   - decrypts it;
   - computes `d` and `C = Poseidon(d, seller, h)` in the worker;
   - keeps the record only if `C` equals the commitment on chain.

   After the sale or swap, nothing more has to travel. The buyer's browser
   already holds the record and checks the new commitment against `s'` as in
   step 3 above.

This design has these properties:

- An intercepted link is useless without the buyer's browser, because only
  that browser holds the private key.
- No QuietStay server sees the record, the link or `d`.
- No file is picked or saved.
- Renters need none of this, because they never prove.
- One risk is that page analytics may report full URLs. The `/receive` page
  removes the fragment before the analytics component loads, and the
  analytics `beforeSend` hook drops any `#…` from reported URLs. The Step 2
  no-leak test opens both kinds of link and fails if any part of a fragment
  appears in any request.

The same sealed link also replaces the D3 local-file import: the issuer's
browser sends the record to the first owner the same way.

**If browser storage is lost** (cleared data, a new device, a private window),
**the holder can no longer prove for that week.** The week stays theirs, and
they can still use a rental they hold, but they can never rent it out or sell
it again. Nobody can recover it: not the issuer, not the builder. This is the
Phase 2 limitation 4, now tied to browser storage. A buyer who loses `s'`
before acceptance should cancel the offer, and the app warns about this. It is
stated in DESIGN.md "Known limitations".

**Proving runs in a Web Worker.** The worker loads `transfer.wasm` (1,971,529
bytes) and `transfer.zkey` (1,973,682 bytes) from the app's own static path. It
computes SHA-256 with `crypto.subtle.digest` and refuses to prove unless both
hashes equal the committed ones in `circuits/keys/SHA256SUMS`
(`5db51d96…91ea`, `a4d547d3…6ebf`). The hashes are compiled into the app, not
fetched. The worker uses snarkjs 0.7.5's browser build. It is the same version
as the CLI, so it produces the same proofs as the CLI and the existing tests
still apply. Inputs and outputs pass only through `postMessage` inside the
page.

**Licensing: decision D2.** snarkjs, the circuit and Poseidon are GPL-3.0
(`circuits/gpl/README.md`). Phase 2 kept every bit of GPL code out of the
browser (`npm run zk:check-bundle`). Browser proving cannot avoid it, because
the compiled circuit itself derives from circomlib's GPL Poseidon. Proposal:

- Put all GPL code in one separately built worker script
  (`public/zk/prover.worker.js`), licensed GPL-3.0 with its source in this
  repository.
- The Apache-2.0 app talks to it only by `postMessage`.
- Change `zk:check-bundle` so that GPL markers may appear **only** in that
  worker file and nowhere else.

D2 was approved with two additions:

- **A `LICENSE` file in the worker's folder.** The worker's source and build
  live in `prover-worker/`, which holds:
  - `prover-worker/LICENSE`: the GPL-3.0 text;
  - `prover-worker/README.md`: what is GPL, what it derives from, and how to
    rebuild it.

  The build output is `public/zk/prover.worker.js`. Its first comment line
  names the license and the source path, and a copy of the license is served
  as `public/zk/LICENSE`.
- **A license notice in the app.** It appears in the footer and on the screens
  that prove. The text: "Proofs are made by an in-browser prover licensed
  under the GPL-3.0 (source: `prover-worker/`, built from snarkjs and
  circomlib). The rest of QuietStay is Apache-2.0." It links to the license
  and the source. `zk:check-bundle` also checks that the notice and
  `public/zk/LICENSE` exist.

**No-leak test (Step 2).** A Playwright end-to-end test records every request
the page and the worker make (URL, headers, body) while it proves and submits
a sale and a rental. It fails if any request contains `s`, `s'`, the record
text, `d`, or `d_hi`/`d_lo` in decimal or hex.

## 3. The reusable transfer check

One function in `auth.rs` replaces today's `check_transfer_proof` +
`store::grant` + `consume_transfer_proof` sequence. Every flow calls it, and
nothing else writes `Right.holdings` or `Right.commitment`:

```rust
pub enum TransferMode {
    Sale,                         // mode signal = 0
    Rental { expires_at: u64 },   // mode signal = expires_at
    Swap { counter_right_id: u64 },// mode signal = 2^64 + counter_right_id
}

/// Checks that `proof` authorizes exactly this transfer, then applies it.
/// It does not call `require_auth`: each entry point obtains the holder's
/// authorization first, as Phase 2's `transfer` does (see the table below).
pub fn authorize_transfer(
    env: &Env,
    right: &mut Right,
    from: &Address,
    to: &Address,
    mode: TransferMode,
    next_secret_hash: &U256,      // expected h'; 0 for a rental
    proof: &Proof,
    signals: &Vec<U256>,
) -> Result<(), Error>
```

It runs, in order:

1. **Signals.** There must be 11 signals, all canonical. `commitment` must be
   the stored one. `right_id`, `from` and `to` must match (with item 1's
   encoding). `mode` must match the `TransferMode`. `expiry_ledger` must be
   within `[now, now + 720]`. `next_secret_hash` must equal the expected one:
   non-zero for a sale or swap, zero for a rental. The nullifier must be
   unused.
2. **Holding-chain rules:** the existing `store::grant`, with
   `expires_at = None` for a sale or swap and `Some(t)` for a rental.
3. **The pairing check** against the constructor's key. Then the nullifier is
   spent, with its TTL past `expiry_ledger`, as in Phase 2.
4. **Applied to `right`.** The new chain is written. For a sale or swap,
   `commitment = next_commitment` and the title balances move. The listing is
   removed.

The caller then calls `store::put_right` and emits its event. The caller never
has to remember a step. The only thing it supplies is the expected
`next_secret_hash`, which comes from on-chain state, never from the caller's
arguments:

| Flow | Holder auth (in the entry point) | `to` | `mode` | expected `h'` comes from |
| --- | --- | --- | --- | --- |
| `transfer` (Phase 2, no payment) | `from.require_auth()` | argument | Sale / Rental | buyer's `require_auth_for_args(right_id, h')`, as Phase 2 |
| `accept_sale` | seller `require_auth()` | `offer.buyer` | Sale | `offer.next_secret_hash` (the buyer set it when making the offer) |
| `accept_rental` | owner `require_auth()` | `offer.renter` | Rental { `offer.expires_at` } | `0` |
| `complete_swap`, maker's half | maker `require_auth()` | `acceptance.taker` | Swap { want_right } | `acceptance.taker_next_secret_hash` |
| `complete_swap`, taker's half | taker's `require_auth()` in `accept_swap`, covering this proof (see 7) | `offer.maker` | Swap { give_right } | `offer.maker_next_secret_hash` |

The Phase 2 `ModeMismatch` and `NextSecretHashMismatch` errors cover the new
modes. The Phase 2 unit tests move onto this function unchanged in substance.

## 4. Sale offer

Your default works, with one refinement (decision D4): **the offer stores the
buyer's next secret hash `h'`, not the next commitment `C'`.**

- `C' = Poseidon(d, buyer, h')` needs the record digest `d`. The contract
  cannot compute it, because it never computes Poseidon.
- The seller's proof already outputs `C'`, bound to `h'` and the buyer.
- Storing `h'` and requiring `proof.next_secret_hash == offer.h'` gives the
  same guarantee, "the seller cannot plant a commitment", that Phase 2 got
  from the buyer's signature. The difference is that the buyer signs once, at
  offer time, and need not be online when the seller accepts.

**Why `C'` cannot be brute-forced now that `h'` is public (review of D4).**

- `C' = Poseidon5(d_hi, d_lo, to_hi, to_lo, h')`. Of its inputs, `to` and `h'`
  are public; `d` is not.
- `d = SHA-256(canonical record)`, and every record carries a `salt` of 32
  random bytes (docs/COMMITMENT.md, "The two fields that exist for the
  commitment's sake").
- Everything else in a record is low-entropy: dates, a resort, a name. The
  salt alone puts 256 bits of entropy into `d`. Guessing `d` from public data
  is therefore a 2^256 search, the same as for `C` today.
- `h'` was already public in Phase 2, where it travels in the buyer's
  authorization arguments, so D4 discloses nothing new.
- `d` is the same in every commitment of a week's history, by design (Phase 2
  §4). People who have held or been shown the record (past owners, buyers it
  was disclosed to) can compute `C'`. That gives them nothing: a proof needs
  `s'`.

```
create_sale_offer(buyer, right_id, price: i128, next_secret_hash: U256, expires_ledger: u32) -> offer_id
cancel_offer(buyer, offer_id)
accept_sale(seller, offer_id, price: i128, proof, public_signals)
```

- **Create.** Requires `buyer.require_auth()`. Checks:
  - the right exists and is active;
  - `0 < price ≤ max_payment` (D7);
  - `h'` is non-zero and canonical;
  - `now < expires_ledger ≤ now + MAX_OFFER_LEDGERS` (D9).

  The buyer also gives the contract a USDC allowance with
  `expiration_ledger ≥ expires_ledger`; the USDC stays in the buyer's account.
  How the allowance is set is **D12**:
  - proposed: inside `create_sale_offer`, as a buyer-authorized
    `usdc.approve` sub-invocation;
  - your original default: a separate `approve` transaction.
- **Accept.** Requires `seller.require_auth()`, covering `offer_id` and
  `price`. Then:
  - the offer must be live, and `price` must equal `offer.price`, so a seller
    accepts exactly the amount they saw (the "wrong amount" test);
  - `authorize_transfer(…, Sale, offer.h')`;
  - `usdc.transfer_from(spender = contract, from = buyer, to = seller, price)`;
  - the offer is deleted and a `SaleSettled` event is emitted.

  Soroban transactions are atomic. If the allowance or the balance is too low,
  `transfer_from` traps and **nothing moves**: not the right, not the
  nullifier, not the offer.
- **Wrong token.** No function takes a token address. The USDC contract is
  fixed in the constructor (see the table below), so another token cannot be
  named at all.
- **Cancel.** Only the buyer can cancel, and only while the offer is live. It
  removes the offer. The contract cannot lower the buyer's allowance, so the
  app offers a second step that calls `approve` with the new total.
- **Expiry.** After `expires_ledger`, acceptance is refused (`OfferExpired`).
  The entry sits in temporary storage and disappears once its TTL ends.
- **Several open offers on one allowance.** The token keeps **one** allowance
  per (buyer, contract). It is not a reservation per offer.
  - Each acceptance pulls exactly its own offer's price, and the allowance
    falls by that amount. The app suggests an allowance equal to the sum of
    the buyer's open offers.
  - Whichever offer is accepted first is paid first. Any later acceptance that
    finds the allowance or the balance too low fails completely.
  - An offer that outlives its allowance (`expires_ledger` later than the
    allowance's expiration) fails completely when accepted. The token does not
    expose the allowance's expiration ledger, so the contract cannot check it
    at offer time; the app sets it.

  In every case, an offer either completes in full or moves nothing. The
  Step 3 allowance tests check exactly this.
- **Why the leftover allowance is safe.** The contract spends it only inside
  `accept_sale` or `accept_rental`, only for an offer this buyer created, and
  only when the holder accepts with a valid proof.

Constructor-fixed USDC addresses:

| Network | USDC issuer (Circle) | Stellar Asset Contract | Source |
| --- | --- | --- | --- |
| Testnet | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | issuer: <https://developers.circle.com/stablecoins/usdc-contract-addresses> (read 2026-11-19); contract: `stellar contract id asset --asset USDC:GBBD…LLA5 --network testnet` |
| Mainnet | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | same Circle page; `stellar contract id asset --asset USDC:GA5Z…KZVN --network-passphrase "Public Global Stellar Network ; September 2015"` |

Circle's page lists only the issuer form (`USDC-G…`). The contract address is
derived from it deterministically by the CLI command shown, and Step 5
double-checks it against the network.

## 5. Rental offer and escrow

```
create_rental_offer(renter, right_id, price, expires_at: u64, check_in: u64, expires_ledger) -> offer_id
accept_rental(owner, offer_id, price, proof, public_signals) -> escrow_id
```

**Acceptance is one transaction.** Requires `owner.require_auth()`. Then:

- `authorize_transfer(…, Rental { expires_at }, 0)` grants the rental right;
- `usdc.transfer_from(contract, renter, contract, price)` pulls the money into
  escrow;
- an `Escrow { right_id, owner, renter, amount, check_in, state: Funded,
  evidence }` is written.

If any part fails, nothing happens.

**Answers to your questions:**

- **Can check-in be earlier than acceptance? No.** Both creation and
  acceptance require `check_in ≥ now`.
- **Must check-in fall inside the rented period? Yes:**
  `right.period.start ≤ check_in < right.period.end` and
  `check_in + 24 h ≤ expires_at`. That way the first night is inside the term
  being paid for. `expires_at ≤ validity.until` holds already.
- **The problem-report window: confirmed as you expected,** from funding until
  `check_in + 24 h`.
  - It is the exact complement of the collect window: `report_problem` is
    allowed while `now < check_in + 86 400`, and `collect` only once
    `now ≥ check_in + 86 400`. There is no moment when both are possible, and
    no moment when neither is.
  - Both use ledger timestamps (seconds), not ledger counts.
- **The rental right after a refund stays until `expires_at`.** Nothing can
  touch a right: not the arbiter, not the owner, not the contract. A refunded
  renter therefore keeps the week until the term lapses. Stated plainly as a
  limitation, with the "future design" note in Step 7.

**State machine.** It has these transitions and no others:

```
               confirm (renter, any time)            ┌──────────┐
          ┌────────────────────────────────────────▶│ PaidOut  │
          │    collect (owner, now ≥ check_in+24h)   └──────────┘
 ┌────────┴┐                                           ▲    ▲
 │ Funded  │                                 confirm   │    │ resolve(PayOwner)
 └────┬────┘                                 (renter)  │    │ (arbiter)
      │ report_problem (renter, now < check_in+24h) ┌──┴────┴──┐
      └────────────────────────────────────────────▶│ Disputed │
                                                    └──┬────┬──┘
                                   refund (owner)      │    │ resolve(RefundRenter)
                                                       ▼    ▼ (arbiter)
                                                    ┌──────────┐
                                                    │ Refunded │
                                                    └──────────┘
```

| Function | Caller | Allowed when | Effect |
| --- | --- | --- | --- |
| `collect(owner, id)` | `escrow.owner` | Funded and `now ≥ check_in + 86 400` | pay owner → PaidOut |
| `confirm(renter, id)` | `escrow.renter` | Funded or Disputed | pay owner → PaidOut |
| `report_problem(renter, id, evidence_hash)` | `escrow.renter` | Funded and `now < check_in + 86 400` | → Disputed; hash recorded |
| `refund(owner, id)` | `escrow.owner` | Disputed | pay renter → Refunded |
| `submit_evidence(by, id, hash)` | `escrow.owner` or `escrow.renter` | Disputed | hash recorded (bounded, D10) |
| `resolve(arbiter, id, outcome, decision_hash)` | the constructor's arbiter | Disputed | PayOwner → PaidOut or RefundRenter → Refunded; decision hash recorded |
| `extend_escrow(id)` | anyone | any state | TTL only, no state change (item 9) |

- PaidOut and Refunded are final, so double payout, double refund and refund
  after payout are all rejected (`EscrowNotInState`).
- The arbiter has exactly one function. It takes an escrow id and an outcome.
  There is no address and no amount to choose. It can pay only `escrow.owner`
  or `escrow.renter`, and only `escrow.amount`.
- It cannot reach a right, because nothing in `resolve` reads or writes
  `Right`. A test checks that, and Step 5 checks it against the code.
- A dispute has no timeout, exactly as specified. If neither party gives way
  and the arbiter never acts, the money stays in escrow. That is a pilot
  limitation.
- A payout to a `G…` account needs a USDC trustline. If it is missing, the
  payout fails and can be retried after the trustline is added. A `C…`
  account needs none.

**Invariant (Step 3 test):** the contract's USDC balance always equals the sum
of the amounts of Funded and Disputed escrows. Sales never touch the contract's
balance, because `transfer_from` pays the seller directly.

## 6. Evidence files

- The browser hashes the chosen file with `crypto.subtle.digest('SHA-256')`
  and submits only the 32-byte hash. The file is not uploaded anywhere, and
  there is no server storage.
- On chain, each escrow keeps the hashes in its own entry: the problem report,
  up to 4 from each party, and the arbiter's decision. They are also emitted as
  events. Storage is used because public RPC event history is short-lived, and
  a reviewer must be able to read the hashes from current state.
- **Pilot:** the sample evidence files are committed under `pilot/evidence/`,
  and `sha256sum pilot/evidence/*` reproduces every on-chain hash. Real upload
  storage is not needed.

## 7. Swap

**Mode encoding.** `mode = 2^64 + counter_right_id`. Sales use `0` and rentals
use a `u64` timestamp, which is below 2^64, so the three ranges never overlap.
Each proof therefore names the week it is swapped **for**, and a swap proof
cannot be used as a sale proof or for a different swap. The nullifier includes
`mode`, so the same `s` produces different nullifiers for different
transfers. **The circuit expresses this without changes:** `mode` is already a
free public field element, constrained only by the nullifier.

**Flow: three on-chain steps (decision D5).** Every step is signed by its own
party, and no off-chain coordination channel is needed:

1. **`offer_swap(maker, give_right, want_right, maker_next_secret_hash, expires_ledger) -> swap_id`.**
   Requires the maker's auth. The maker must be the effective title holder of
   `give_right` at this point (this is checked again later).
2. **`accept_swap(taker, swap_id, taker_next_secret_hash, proof_t, signals_t)`.**
   Requires the taker's auth, covering this exact proof. The cheap signal
   checks run now, with `want_right` moving to the maker under
   `Swap { give_right }` and `h' = maker_next_secret_hash`. The proof and the
   taker's `h'` are stored in a temporary entry that lives until the proof's
   `expiry_ledger`, at most 720 ledgers (about an hour).
3. **`complete_swap(maker, swap_id, proof_m, signals_m)`.** Requires the
   maker's auth. `authorize_transfer` runs twice, in one transaction:
   - first for the taker's stored proof (`want_right` → maker,
     `Swap { give_right }`, `h' = maker_next_secret_hash`);
   - then for the maker's proof (`give_right` → taker, `Swap { want_right }`,
     `h' = taker_next_secret_hash`).

   Both rights take their new commitments, and the swap entries are deleted.
   Any failure, such as a side that is expired, rented out, already
   transferred, held by someone else, or carrying a reused proof, reverts both.

The maker can cancel the offer at any time, and the taker can withdraw an
acceptance. An acceptance that is never completed simply expires with its
proof.

**Confirmations requested in review (D5):**

- **The taker's right is not locked between accept and complete.**
  `accept_swap` writes only the acceptance entry (`Swap(id)` /
  `SwapAcceptance(id)`) and never writes `Right(want_right)`. The taker can
  still rent out, sell or burn `want_right`, or accept a different offer for
  it. If they do, `complete_swap` fails, as listed below, and nothing moves.
  The same holds for the maker's `give_right`. A Step 4 test sells the taker's
  right between accept and complete and checks that complete is refused and
  both rights are unchanged.
- **The taker can withdraw.** `withdraw_swap_acceptance(taker, swap_id)`
  requires the taker's auth and deletes the acceptance, so the stored proof
  can no longer be used. The proof's nullifier was never spent, because
  `accept_swap` only checks and stores. The offer stays open for a new
  acceptance. A second `accept_swap` is refused while a live acceptance
  exists, and allowed once that acceptance is withdrawn or expired.
- **`complete_swap` re-checks every refusal condition. Nothing checked in
  `accept_swap` is trusted.**
  - The offer must exist, be live (`now ≤ expires_ledger`) and not be
    cancelled. The acceptance must exist and not be withdrawn.
  - Both proofs run the full `authorize_transfer` against the current state:
    - commitment equal to the one stored now (refuses a right already sold,
      including by its other owner);
    - `from` is the current effective title holder with no live rental (refuses
      a right rented out, held by someone else, or never theirs);
    - right inside its validity window (refuses an expired right);
    - `right_id`, recipient and `Swap { counter_right_id }` match;
    - `expiry_ledger` within `[now, now + 720]` (refuses an expired proof);
    - `next_secret_hash` equal to the other side's stored `h'`;
    - nullifier unused (refuses a reused proof);
    - the pairing check.
  - `give_right ≠ want_right` and `maker ≠ taker` (`SelfTransfer`), checked
    again.

  Each refusal reverts the whole transaction: neither right, neither
  nullifier and neither entry changes. Step 4's tests cover each case on both
  sides.

The alternative is one transaction carrying both parties' auth entries and both
proofs. It saves a step but needs the two browsers to exchange signed
authorization entries off chain. The three-step flow keeps that exchange on
the ledger.

## 8. Contract layout

**One contract, `quietstay-rights`, with modules:**

- `auth.rs`: the boundary, item 3;
- `store.rs`;
- `offers.rs`: sale and rental offers;
- `escrow.rs`: the state machine;
- `swap.rs`;
- `payment.rs`: the only module that calls the USDC token.

Why one contract:

- A separate escrow or swap contract would have to move rights in the rights
  contract. That needs exactly the privileged cross-contract call the SOW
  forbids, or a second code path.
- With everything inside one contract, every right movement goes through
  `authorize_transfer`, and every USDC movement goes through `payment.rs`.

The only cross-contract calls are to the fixed USDC contract. The size budget
is comfortable: the Phase 2 rights WASM is 27,490 bytes, and both networks
allow 131,072 bytes (`stellar network settings`, 2026-11-19).

Constructor:
`__constructor(issuer, arbiter, usdc, name, symbol, verification_key, max_payment)`.
It has no setter for any of these, no `upgrade` and no admin.

## 9. Storage and TTL

The limits below were read on 2026-11-19 with `stellar network settings`
(mainnet through `--rpc-url https://mainnet.sorobanrpc.com`):

| Setting | Testnet | Mainnet |
| --- | --- | --- |
| max entry TTL | 3,110,400 ledgers | 3,110,400 ledgers |
| min persistent TTL | 120,960 | 2,073,600 |
| min temporary TTL | 720 | 17,280 |

| Data | Storage | TTL rule |
| --- | --- | --- |
| Config, verification key, arbiter, USDC, id counters | instance | extended on every call (Phase 2 `bump_instance`) |
| Rights, title balances | persistent | extended on every read and write (Phase 2) |
| Nullifiers | temporary | live-until > `expiry_ledger` (Phase 2 rule, unchanged) |
| Sale and rental offers | temporary | live-until > `expires_ledger`. An expired offer is dead, so losing it is harmless |
| Swap offers and acceptances | temporary | until `expires_ledger` / the stored proof's `expiry_ledger` |
| **Escrows** | **persistent** | see below |

**Escrows** are extended at funding and on every call that touches them, to
`min(max entry TTL, ledgers until check_in + 24 h + 30 days)`.

- A persistent entry is never deleted. When its TTL lapses it is *archived*,
  and it can be restored. On current protocols a transaction that touches an
  archived persistent entry restores it automatically.
- The documented ways to keep one live are:
  - `extend_escrow(id)`, which anyone can call, changes nothing else, and is
    listed in the permissions table;
  - `stellar contract extend --durability persistent --key-xdr <Escrow(id)> --ledgers-to-extend <n>`;
  - `stellar contract restore` if one was archived.
- The pre-launch checklist (Step 5) records the commands and a dry run of each.

## 10. Permissions

"State" is the condition under which the call succeeds. Every other caller or
state is rejected.

| Function | Who can call | When |
| --- | --- | --- |
| `__constructor` | deployer, once | deployment |
| `name`, `symbol`, `decimals`, `balance`, `issuer`, `arbiter`, `usdc`, `next_id`, `get_right`, `commitment`, `holder`, `holding`, `holdings`, `is_active`, `get_listing`, `get_offer`, `get_escrow`, `get_swap` | anyone (read-only) | always |
| `issue` | issuer | always; fresh ids only |
| `list`, `unlist` | effective holder | right active |
| `transfer` (no payment) | effective holder + valid proof (+ buyer's signature on a sale) | right active |
| `burn` | title holder, no live sub-grant | as Phase 2 |
| `create_sale_offer`, `create_rental_offer` | anyone, as buyer or renter (own auth) | right active; limits in items 4–5 |
| `cancel_offer` | the offer's buyer or renter | offer live |
| `accept_sale` | effective title holder + valid proof | offer live, price matches |
| `accept_rental` | effective holder + valid proof | offer live, check-in rules |
| `collect` | escrow owner | Funded, `now ≥ check_in + 24 h` |
| `confirm` | escrow renter | Funded or Disputed |
| `report_problem` | escrow renter | Funded, `now < check_in + 24 h` |
| `refund` | escrow owner | Disputed |
| `submit_evidence` | escrow owner or renter | Disputed |
| `resolve` | arbiter | Disputed |
| `extend_escrow` | anyone | any (TTL only) |
| `offer_swap` | effective title holder of `give_right` | right active |
| `cancel_swap` | the swap's maker | swap live |
| `accept_swap` | effective title holder of `want_right` (own auth) | swap live |
| `withdraw_swap_acceptance` | the taker | acceptance live |
| `complete_swap` | the swap's maker + valid proof (taker's proof stored) | acceptance live, both proofs within their window |

**Outside accounts.** No allowlist is needed. Money moves only in
`accept_sale`, `accept_rental`, `collect`, `confirm`, `refund` and `resolve`.
Rights move only through `authorize_transfer`.

- An outsider can make an offer, but nothing moves unless a builder-held
  right's holder accepts it with that holder's proof.
- An outsider can be an escrow's renter only if a builder owner accepted their
  offer.
- An outsider can complete a swap only for a swap whose maker is that
  outsider, and a swap moves a builder right only if the builder accepted with
  a proof.
- `resolve` is the arbiter's alone, and the arbiter is a builder account.

I found **no path where an outside account moves USDC or a right without a
builder-account action.** The Step 3 outside-account tests check this for
every function.

## 11. Early swap cost estimate

**Measurement.** One `--send=no` simulation on testnet of a transaction that
verifies two existing Phase 2 proofs (`tests/fixtures/sale.json` and
`rental.json`, both made by `npm run zk:test-fixtures`) in one call:

- Contract: `contracts/quietstay-measure`. It runs the rights contract's own
  `verifier.rs`, included by path, twice. Measurement only.
- Deployed: [`CCKL74S5L57GZ32K2AWIIRGKNED3CZNWFCM62BMVASLMSHJXOYK4ZLY4`](https://stellar.expert/explorer/testnet/contract/CCKL74S5L57GZ32K2AWIIRGKNED3CZNWFCM62BMVASLMSHJXOYK4ZLY4),
  in tx [`5ffde55c…74aa`](https://stellar.expert/explorer/testnet/tx/5ffde55c074ad7a5e8c2daebbd9645b7dbdf86c43bfec1405fee8f6300b574aa),
  with the committed verification key.

| | Value | % of per-tx limit | Command |
| --- | --- | --- | --- |
| Result | `true`: both proofs verified | | `stellar contract invoke --id CCKL…ZLY4 --network testnet --send=no -- verify_two …` |
| CPU, simulated (WASM) | **171,992,473** instructions | **43.0%** of 400,000,000 | RPC `simulateTransaction`, ledger 5,811,197 |
| Minimum resource fee, simulated | 61,546 stroops | | same |
| Ledger bytes read / written | 0 / 0 | | same |
| Memory, local host budget | **648,933** bytes | **1.5%** of 41,943,040 | `cargo test -p quietstay-measure -- --nocapture` |
| CPU, local host budget (native, no VM) | 150,094,049 instructions | | same |
| Transaction size | ~1,890 bytes (two proofs) | 1.4% of 132,096 | from the simulated envelope |

Both networks have the same per-transaction CPU and memory limits (400,000,000
instructions; 41,943,040 bytes), read with `stellar network settings` on
2026-11-19. The RPC's simulation response does not report memory, so memory
comes from the local budget, as in Phase 2.

**Estimate for the integrated swap.** The two pairings above (172.0 M) plus two
transfers' bookkeeping. Phase 2 measured that bookkeeping at 1.46 M instructions
per transfer: the sale simulation, 80,352,655, minus the verify-only
simulation, 78,896,206 (docs/CIRCUIT.md). Adding the stored acceptance and the
offer reads (*estimate:* a few million more), the total is **about 175–180 M
instructions, about 45% of the limit**. Memory stays under 2%, and storage
reads stay well inside 200 entries and 200,000 bytes. **A two-proof swap fits
with room to spare.** Step 4 measures it again on the integrated contract, by
simulation and then with one real transaction, as planned.

## 12. Pinned versions

| Component | Version | Why / compatibility check |
| --- | --- | --- |
| Smart Account Kit (`smart-account-kit`, npm, Apache-2.0) | **0.10.0** | latest (published 2026-10-27). Needs `@stellar/stellar-sdk ^16.4.1` and `@simplewebauthn/browser ^13.3.0`. Its `@creit-tech/stellar-wallets-kit` peer dependency is **optional**. Indexer and relayer are optional (`indexerUrl: false`, no `relayerUrl`), so no hosted service is used. Wallets are deployed with `createWallet(…, { autoSubmit: false })` and submitted from a funded source we control |
| OpenZeppelin smart account | **stellar-accounts v0.8.0** (OpenZeppelin/stellar-contracts `ddc327eb`), account WASM `c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1` | the build the kit recommends for new wallets. Built by the kit's maintainers with soroban-sdk 28.0.0. QuietStay does not compile it; it is a separate contract. WebAuthn verifier: testnet `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F`, mainnet `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` (kit deployment manifests in github.com/stellar/smart-account-kit `docs/`). Step 2 checks these on chain before use |
| `@stellar/stellar-sdk` | **16.4.1** (from 16.2.0) | the kit's range is `^16.4.1`; 17.x is outside it. `@creit.tech/stellar-wallets-kit` 2.5.0 needs `^16.0.0`, so the SDK dedupes. Checked: `npm install --dry-run smart-account-kit@0.10.0 @stellar/stellar-sdk@16.4.1` resolves with no conflicts |
| `@creit.tech/stellar-wallets-kit` | **2.5.0** (unchanged) | the fallback wallet |
| soroban-sdk (QuietStay contracts) | **27.0.6** (unchanged) | Phase 2's tested base. Latest stable is 29.0.1 and 30.0.0 is an RC. A 27.0.6 build runs on testnet's protocol 30 today (the item 11 contract). Mainnet runs protocol 29 (RPC `getNetwork`), and the Step 5 checklist confirms deployment there by simulation |
| circom | **2.2.2** (unchanged) | the circuit and keys are unchanged |
| snarkjs | **0.7.5** (unchanged) | the same version in the CLI and the browser worker (its `build/browser.esm.js`), so both produce the same proofs. 0.7.6 exists, but nothing needs it |
| Stellar CLI | **30.0.1** (from 27.0.0) | 27.0.0 warns: "Network protocol version is 30 but the stellar-cli supports 27". Upgrade before Step 2 |

The versions are pinned exactly in `package.json`/`package-lock.json` and
`contracts/Cargo.lock`, and recorded in `docs/SETUP.md`, in Step 2. The real
proof that they work together is the first passkey-authorized testnet contract
call, which Step 2 makes before building any screen.

**Supported browser target (Step 2 confirms):** current desktop Chrome with a
platform passkey (Google Password Manager, or Windows Hello on Windows). The
app checks `PublicKeyCredential` and
`isUserVerifyingPlatformAuthenticatorAvailable()`. If either is missing, it
says so and points to the regular wallet.

---

## 13. Fees for passkey transactions (D6, approved with conditions)

A smart wallet cannot be a transaction's source, so a `G…` account pays every
fee.

### Testnet: the fee route

`POST /api/tx/sponsor` takes a transaction or `{func, auth}` built and
passkey-signed in the browser. It signs the envelope with
`QUIETSTAY_TESTNET_FEE_SECRET` and submits. The route enforces the following.

**It refuses every transaction except:**

- exactly one `InvokeHostFunction` operation that either:
  - **calls a QuietStay contract** (the configured rights contract id; the
    function name is not restricted, since the contract does its own auth);
    or
  - **deploys a smart wallet**: `CreateContractV2` whose executable is the
    pinned OpenZeppelin account WASM `c514d35e…`, via the kit's deployer;
- every sub-invocation in the auth entries stays inside the QuietStay
  contract, the fixed USDC contract (only the `approve` / `transfer` the
  rights contract itself calls, see D12) and the smart wallet's own
  `__check_auth`;
- the fee account appears nowhere except as source and fee payer: not in any
  argument, not as an auth address, not as a holder;
- fee ≤ 10,000,000 stroops (1 XLM) per transaction, and source = the fee
  account.

**Rate limits**, kept in the deployment's existing Upstash store
(`src/lib/kv.ts`, so no new infrastructure):

- 10 sponsored transactions per IP per hour;
- 20 per smart-wallet address per day;
- 300 per day in total.

When the store is unreachable, the route refuses rather than signing
unlimited. The account is funded with a small testnet balance (Friendbot), so
the balance is a hard bound as well.

**The key has no other role.**

- It is a new identity, `qs-testnet-fee`, that you create.
- At startup the route refuses to run if the fee address equals the issuer,
  the arbiter, the SEP-10 key, or any holder named in the inventory.
- `scripts/check-fee-account` checks on chain that it holds no rights and no
  USDC.
- The route is compiled out of the mainnet deployment: it refuses whenever
  the network passphrase is not testnet's. On testnet only, it is the one
  server-side signing key Phase 3 adds.

### Mainnet: the CLI signing flow (no server key)

1. **Build and sign the auth entry in the browser.**
   - The app builds the transaction with the source set to the address of the
     mainnet fee identity, which you type in once; the app keeps the public
     key only.
   - It simulates the transaction, and the passkey signs the smart wallet's
     auth entry with
     `signatureExpirationLedger = min(proof.expiry_ledger, latest + 720)`.
     That is up to 720 ledgers, about an hour at mainnet's roughly 5–6 s
     ledgers, which is long enough to sign and submit by hand.
   - It re-simulates with the real signature, because a WebAuthn signature is
     larger than the placeholder.
   - The transaction's time bound is the same one hour.
   - The app shows the unsigned envelope XDR, with a copy button.
2. **Sign and submit with `scripts/mainnet-sign-submit.sh <xdr-file> <identity>`.**
   The script:
   1. refuses unless `--network mainnet` and the identity are given explicitly;
   2. decodes and prints, in plain words, the operation, the contract, the
      function, the arguments, every auth address and the USDC amount
      (`stellar tx decode`);
   3. re-simulates and prints the fee and resources, then refuses if any
      payment exceeds the D7 cap or the auth entry expires within the next 60
      ledgers;
   4. asks you to type `SEND`;
   5. runs `stellar tx sign --sign-with-key <identity> --network mainnet` and
      `stellar tx send --network mainnet`;
   6. prints the hash and the Stellar Expert link.

   The script never reads the secret key itself; the CLI keystore signs.
3. **If the source's sequence number moved** (any other transaction from the
   same identity in between), sending fails. The script says so, and you
   rebuild in the browser.

The same script is exercised on testnet in Step 2, with a testnet identity, so
its first mainnet use in Step 6 is not its first run.

## 14. Pre-launch checklist additions from the review

These are added to `docs/PRELAUNCH_CHECKLIST.md` (Step 5), each with a command
and its output.

- **Built and tested for mainnet's current protocol.**
  - Mainnet runs protocol **29** and testnet **30** (RPC `getNetwork` /
    `getVersionInfo`, 2026-11-19).
  - The contracts are built with soroban-sdk 27.0.6. The WASM's environment
    metadata declares **protocol v27**
    (`stellar contract info env-meta --wasm …quietstay_rights.wasm` →
    `Protocol: v27`, checked today for the Phase 2 and measurement WASMs),
    which mainnet's protocol 29 accepts.
  - The checklist records that output for the final WASM.
  - It also records a mainnet `--send=no` simulation of the deploy and of
    each flow, run before GO.
- **No protocol-30-only features.**
  - The SDK pinned at 27.0.6 cannot emit host functions newer than protocol 27.
  - The checklist also lists every host function and SDK feature the
    contracts use, from `stellar contract info interface` and the source, and
    confirms each exists on protocol 29.
  - The OpenZeppelin account and verifiers are already deployed on mainnet by
    their maintainers; the checklist records their on-chain WASM hashes.
- **Re-checked if mainnet upgrades during the sprint.**
  - A pinned check, `scripts/check-protocol`, prints both networks' protocol
    versions and fails if mainnet is not 29.
  - It runs at Step 5 and again immediately before every mainnet transaction
    in Steps 6–7.
  - If mainnet has moved, mainnet work stops. The checklist's protocol,
    simulation and cost items are re-run, and the result is reported to you
    before anything else is sent.

## Decisions for approval

| # | Decision | Status |
| --- | --- | --- |
| D1 | Account binding: kind tag in `hi`, no circuit change | **Approved** with conditions. Range check: none (§1). C-address prove and verify: done, off-chain and on chain (§1). Contract-level test: Step 2 |
| D2 | GPL prover worker | **Approved**. `LICENSE` in the worker folder and an in-app notice added (§2) |
| D4 | Offer stores `h'` | **Waiting for approval**. Salt confirmed and record delivery added (§2, §4) |
| D5 | Three-step swap | **Waiting for approval**. Confirmations added (§7) |
| D6 | Fees | **Approved** with conditions (§13). Its conditions raise **D12** below |

**D3 and D7–D12 in full:**

| # | Question | Recommendation | Alternative(s) | What it affects | Reversible later? |
| --- | --- | --- | --- | --- | --- |
| **D3** | How the private record first reaches the holder's browser, and whether there is a backup | **The sealed link (§2):** request and reply links carrying data only after `#`, encrypted to a browser-held key, verified against `C` on import. No file, no server storage, **no backup export**. A lost browser means a lost ability to prove; this is stated as a known limitation | (a) A "save backup" button that writes `{record, s}` to a local file. It reduces loss, but it creates a plaintext secret file and adds scope. (b) The issuer's server stores records and serves them to the signed-in holder. This needs new server storage of personal data, so it is not recommended | Step 2 screens and the no-leak test; DESIGN.md limitations | Yes: a backup button can be added later without a contract change |
| **D7** | Enforce the pilot payment cap in the contract? | **Yes:** `max_payment` is fixed in the constructor. Mainnet: 10,000,000 units = 1.0000000 USDC. Testnet: 1,000,000,000 units = 100 USDC, enough for demos. Offers above it are refused (`PriceAboveCap`). The 5 USDC total across accounts is an operating rule: `scripts/check-pilot-funds` sums the USDC of every pilot account and the contract, fails above 5 USDC, and runs before each mainnet transaction | Enforce the cap only in the app and the scripts. That is weaker: a direct contract call would bypass it | Constructor signature, the offer functions, Step 5 checklist | Raising the cap means a new deployment (no setter, by design) |
| **D8** | Versions | soroban-sdk **27.0.6** (unchanged); Stellar CLI **27.0.0 → 30.0.1**; `@stellar/stellar-sdk` **16.2.0 → 16.4.1**; Smart Account Kit **0.10.0**; OZ stellar-accounts **v0.8.0**; circom **2.2.2**; snarkjs **0.7.5**; wallets-kit **2.5.0** (§12) | soroban-sdk 29.0.1 (latest stable). That is churn in a tested base for no feature we need, and it targets protocol 29+ | Lockfiles, `docs/SETUP.md` | Yes, before mainnet deployment |
| **D9** | Maximum offer lifetime | **120,960 ledgers (~7 days)** for sale, rental and swap offers, checked at creation. Offers live in temporary storage until then | 17,280 (~1 day), which lowers stale-offer risk but is clumsy for the demo; 518,400 (~30 days) | Offer functions; with D12, the allowance expiration | Only by redeploying (it is a contract constant) |
| **D10** | How dispute evidence is kept on chain | The renter's report hash, **up to 4 hashes per party**, and the arbiter's decision hash, stored in the escrow entry and also emitted as events. More than 4 from one party is refused (`EvidenceLimit`) | Events only. That is cheaper, but public RPCs keep events only for a short window, so reviewers could lose them | Escrow entry size (≤ 9 × 32 bytes) and the evidence tests | Only by redeploying |
| **D11** | Phase 2 `transfer` and `burn` | **Keep both.** `transfer` (no payment) is routed through `authorize_transfer`. `burn` stays wallet-only: binding it to the proof (Phase 2 limitation 7) is not in the SOW, so it is not built unless you add it | Remove `transfer`, so every right movement is paid. That loses the free gift/transfer path and the Phase 2 evidence continuity. Bind `burn` to the proof: a small change, but it adds scope | Contract surface, the permissions table, DESIGN.md | Only by redeploying |
| **D12** *(new, from D6's conditions)* | How the buyer or renter gives the USDC allowance | The fee route may sign only QuietStay calls, and a standalone USDC `approve` is a call to the USDC contract. **Proposal:** the offer functions set the allowance themselves, as a sub-invocation the buyer authorizes in the same transaction:<br>• `create_*_offer` calls `usdc.approve(buyer, this, allowance(buyer, this) + price, now + 120,960)`;<br>• `cancel_offer` lowers it by the price (floor 0).<br>Because every offer expires within 120,960 ledgers (D9), each new expiration covers every open offer. The allowance then always equals what the open offers can pull, and offers call only QuietStay. Item 4's allowance rules are otherwise unchanged; a buyer can still lower the allowance directly with USDC, which the "offer outlives its allowance" test covers | Keep the separate `approve` transaction (your original default), and allow the fee route to also sign exactly one USDC `approve` whose spender is the QuietStay contract | Item 4, the fee-route allowlist, the allowance tests | Only by redeploying |

Nothing in Steps 2–4 starts until D4, D5 and D12 are approved. D1, D2 and D6
are approved; their conditions are recorded above.
