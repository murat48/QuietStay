# QuietStay Phase 2 — the ownership proof

> **Status: specification approved 2026-10-09**, with the three decisions recorded
> under [Decisions](#decisions). Every cost figure, transaction hash and tool
> version in this document comes from a command that was actually run, recorded
> next to it; where one is not known yet, this document says so instead of
> guessing.

## One page: what the proof does

**Today (Phase 1)**, renting or selling a week needs two signatures: the holder's
and the issuer's. The issuer's signature is a gate the issuer could close — it can
refuse to approve a transfer it should allow.

**In Phase 2**, the issuer's signature is gone. In its place, the holder attaches
a small mathematical proof to the transfer, and the contract checks it on chain.

**What the proof shows.** "I know the secret that belongs to this week's
on-chain record, and I am the account that record names." Only the person who
holds the week's secret can produce it, and only for the account that owns the
week.

**What the proof hides.** The secret itself, the ownership record, the owner's
name, the resort, the unit and the deed. None of them is in the proof or on the
ledger. What the ledger shows is the same as Phase 1: account addresses, a week
number, and opaque 32-byte values.

**What the proof prevents.**

| Attempt | Why it fails |
| --- | --- |
| Someone steals the holder's wallet key and rents out or sells the week | A stolen wallet alone cannot transfer the week: that also needs the week's secret, which never touches the ledger |
| Someone copies a proof from a past transaction and submits it again | Every proof carries a one-time code; the contract remembers used codes and refuses a second use |
| A proof made for one buyer is used for another buyer, or a rental proof for a sale | The buyer, the mode and the rental end are sealed inside the proof |
| The previous owner tries to sell the week again after selling it | The sale replaces the week's record with one only the buyer can prove |
| A renter tries to sell or sub-let the week | The renter does not have the secret, and the contract already refuses a renter's sale |
| The issuer moves a week it does not hold | The issuer has neither the holder's wallet nor the secret, and the contract has no function that lets it move, freeze or burn a week |
| An old proof is held back and used weeks later | Each proof expires after a short window, about an hour |

**What the proof does not prevent.** A stolen wallet cannot *transfer* the week,
but it can **burn** it: `burn` still asks only for the holder's signature, so a
thief could destroy the week though never take it. Binding `burn` to the proof
is Phase 3. The issuer can still *attest falsely* about
maintenance fees; that attestation is shown to the buyer but no longer decides
whether a transfer can happen. And the proving keys come from a **development
setup run by the builder — non-production**: whoever ran it could forge a proof.
A forged proof still cannot move a week without the holder's own wallet
signature, but it does remove the "secret" barrier. A production multi-party
setup ceremony is Phase 3.

---

## The detailed answers

### Field and notation

All arithmetic in the circuit is in the BLS12-381 scalar field:

```
r = 52435875175126190479447740508185965837690552500527637822603658699938581184513
  = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
```

`Poseidon_n(x1, …, xn)` is circomlib's `Poseidon(n)` template — width `t = n + 1`
— instantiated with constants generated for this field (see
[Poseidon parameters](#poseidon-parameters-over-bls12-381)). The circuit uses
exactly three widths: `n = 1`, `5` and `6`.

`split(b)` takes 32 bytes and returns two field elements:
`hi = big-endian integer of b[0..16]`, `lo = big-endian integer of b[16..32]`.
Each is below 2^128, so below `r`, and the split is injective.

### 1. What the proof proves that `holder.require_auth()` alone does not

`from.require_auth()` proves control of the Stellar account the contract lists as
the holder. The proof additionally proves **knowledge of the week's record
secret** — a value that exists only off chain, in the holder's hands — and binds
that knowledge to this exact transfer.

> **In one sentence:** transferring someone's week — renting it out or selling
> it — now requires two things an attacker would have to steal separately, the
> holder's wallet and the holder's secret, and no longer requires anyone's
> permission.

`from.require_auth()` stays. The proof replaces the issuer's signature, not the
holder's.

### 2. The commitment formula

```
d            = SHA-256( RFC 8785 canonical JSON of the ownership record )
(d_hi, d_lo) = split(d)
(a_hi, a_lo) = split(owner's 32-byte Ed25519 public key)
s            = the record secret: a uniformly random field element, s < r
h            = Poseidon_1(s)
C            = Poseidon_5(d_hi, d_lo, a_hi, a_lo, h)
```

- **The record** keeps the Phase 1 schema (`quietstay.ownership-record.v1`) and
  the Phase 1 canonicalization, so `d` is exactly what Phase 1 stored as the
  commitment. The record is not encoded field by field: the circuit never needs
  its contents, only a fixed-size digest of it, and hashing JSON inside a circuit
  would be both expensive and a custom construction.
- **The account** is inside the commitment, so the secret alone is useless to
  anyone but the account it was issued to.
- **The secret** never appears in the commitment directly; `h = Poseidon_1(s)`
  does. `h` plays the role Phase 1's `salt` played — it makes `C` impossible to
  guess from the record — and can be shown to a buyer so they can check the
  record against `C` (see §4). `s` is what proves authority, and is never shown
  to anyone.

**Who generates `s` at issuance.** The owner, in their own CLI, sending only `h`
to the issuer, which then computes `C` and calls `issue`. The issuer therefore
never learns `s`. For the fictional sample inventory the builder plays every
role; those secrets live in a gitignored file next to the account keys, never in
git.

### 3. Commitment rotation

**On a sale**, the commitment is replaced so that only the buyer can prove next.

1. The **buyer** generates a new secret `s'` in their own CLI and computes
   `h' = Poseidon_1(s')`. They send `h'` — never `s'` — to the seller.
2. The **seller** runs the prover with `h'` as an input. The *same circuit* that
   proves the seller's ownership also computes the next commitment:
   `C' = Poseidon_5(d_hi, d_lo, b_hi, b_lo, h')`, where `(b_hi, b_lo) = split(buyer's
   key)`. `C'` is a public signal of the proof.
3. The **contract** takes `C'` from the verified public signals and stores it in
   place of `C`. It compares and stores; it does not compute Poseidon.

The previous owner's proof stops working because every proof states the
commitment it was made for, and the contract rejects any proof whose commitment
is not the one currently stored. A *new* proof is impossible for them too: `C'`
contains the buyer's account and `h'`, whose preimage `s'` they never had.

**The seller cannot substitute `h'`.** If the seller put in an `h'` of their own
choosing, the buyer would receive a week they could never sell or rent out. So on
a sale the contract also requires the **buyer's signature** over `(right_id, h')`,
via `to.require_auth_for_args`. `h'` stays a public signal of the proof, and the
contract checks that the `h'` the buyer signed equals the `h'` in the proof
**before** the pairing check. A seller who plants their own `h'` therefore needs a
buyer signature over it, which the buyer never gives. A unit test covers exactly
that case. A rental needs no buyer signature, as in Phase 1.

**On a rental**, there is no rotation. The renter is added to the holding chain
with an end time exactly as in Phase 1, the term lapses on its own, and the owner
keeps `s`. The proof's `h'` input is fixed to `0` for a rental and the contract
ignores `C'`.

### 4. The link to the issuer-attested record

The link is kept, inside the one circuit. `C'` is computed from the same
`(d_hi, d_lo)` that the seller just proved is inside `C`, so every commitment in a
week's history commits to the **same record digest `d`** the issuer originally
attested. No second circuit and no second proof are involved.

What does change, stated plainly as a trust-model change:

- **The record's `owner` field becomes history.** After a sale, the attested
  record still names the original owner. The current owner is whoever the chain
  says holds title; the record describes the week, not its current holder.
- **The issuer attests fees only.** Phase 2 attestations state whether
  maintenance fees are paid. They are shown to the buyer and are **never a
  precondition** for a transfer, so withholding one cannot freeze a week.
- **A buyer checks the record against `C` with `h`.** The seller discloses the
  record and `h` (not `s`). The buyer computes `d` and `C` and compares with the
  ledger. Computing `C` is Poseidon, and Poseidon does not run in a browser, so
  this last step is `npm run verify-record`. The `/verify` page still
  computes `d` from a pasted record (SHA-256, in the browser) and shows the
  on-chain verification result; it says in one sentence why the final
  `d → C` step happens in the CLI.
- **`d` is still a plain SHA-256.** `sha256sum` over the canonical record still
  produces `d`, exactly as in Phase 1. What changed is that the ledger no longer
  stores `d` itself: it stores `C`, which wraps `d` with Poseidon together with
  the owner's account and `h`. `docs/COMMITMENT.md` says this in those terms.

### 5. Account binding

A Stellar account (`G…`) is a 32-byte Ed25519 public key. The contract obtains it
with `Address::to_payload()`, which in `soroban-sdk` 27.0.6 returns
`AddressPayload::AccountIdPublicKeyEd25519(BytesN<32>)` for a `G…` address
(checked in the crate source, `src/address_payload.rs`).

```
key bytes k[0..32]           (the same 32 bytes inside the G… strkey)
a_hi = int.from_bytes(k[0..16],  "big")
a_lo = int.from_bytes(k[16..32], "big")
```

Split point: byte 16. Byte order: big-endian within each half. The same split is
used for the recipient `(b_hi, b_lo)`.

A contract address (`C…`) has no Ed25519 key: for one, `to_payload()` returns
`AddressPayload::ContractIdHash` rather than a key, and the contract refuses the
transfer with `NotAnAccount` before any signal is compared with its state, whether
the contract address is the sender or the recipient. `issue` refuses one as
owner the same way, so no right is ever created that no proof could transfer
(tests `only_accounts_can_send_or_receive` and
`a_right_cannot_be_issued_to_a_contract_address`).

### 6. The nullifier

```
N = Poseidon_6(s, right_id, b_hi, b_lo, mode, expiry_ledger)
```

| Input | Value |
| --- | --- |
| `s` | the record secret |
| `right_id` | the right being transferred |
| `b_hi, b_lo` | the recipient's key, split |
| `mode` | `0` for a sale; for a rental, the rental's end time (`expires_at`, Unix seconds) |
| `expiry_ledger` | the last ledger sequence at which this proof is accepted |

`mode` carries the rental's end time rather than a bare "rental" flag, so a proof
for a one-week rental cannot be used for a longer one. A real rental end is
always in the future, so it is never `0`.

**Why these inputs are fixed by the transfer.** Every one of them except `s` is
also a public signal, and the contract checks each against the call it is part
of: `right_id`, recipient and `expires_at` against the arguments, and
`expiry_ledger` against the current ledger. The holder cannot pick a value that
differs from the transfer they are actually making; the only freedom left is
`expiry_ledger`, which the window below bounds.

**Why a proof is valid for one transfer only.** The contract stores `N` when it
accepts a proof and rejects any later proof carrying the same `N`. Resubmitting a
proof — by anyone — repeats `N` and fails.

**Why the holder can prove again.** The next rental or sale has a different
recipient, mode or expiry ledger, so it produces a different `N` from the same
`s`. A rental does not rotate `s`; a sale hands the week to a new secret.

**Maximum expiry window: 720 ledgers** — about one hour at testnet's roughly
five-second ledgers. The contract rejects a proof whose `expiry_ledger` is in the
past or more than 720 ledgers ahead. Proving on a laptop takes seconds, so an
hour is generous without letting a proof sit around.

**Storage.** Used nullifiers go to temporary storage. The rule, enforced in the
contract rather than assumed: **a used nullifier's entry always lives past the
proof's own `expiry_ledger`.** When it is written, its TTL is extended so the
entry's live-until ledger is strictly greater than `expiry_ledger`. Since a proof
is refused once the ledger passes `expiry_ledger`, there is no ledger at which the
entry is gone but the proof would still be accepted — so the replay guard does
not need to live forever. A unit test advances the ledger to `expiry_ledger`,
confirms the nullifier entry is still present and the replay is refused, then
advances past it and confirms the proof is refused as expired.

Different Poseidon widths give the commitment (`n = 5`), the nullifier (`n = 6`)
and `h` (`n = 1`) separate domains.

### 7. Inputs, in the order the verifier receives them

All public signals are declared as circuit **inputs** with equality constraints;
the circuit has no outputs. snarkjs then emits them in declaration order, which
is the order below — confirmed by the circuit test that reads the compiled
symbol table (`emits public signals in the order CIRCUIT.md §7 fixes`), and by
the prover, which refuses to write a proof whose signals differ.

**Public (11)** — each must be a canonical field element (`< r`); the contract
rejects any that is not, so one value cannot be stored under two encodings.

| # | Signal | Contract checks it equals |
| --- | --- | --- |
| 1 | `commitment` `C` | the commitment stored for `right_id` |
| 2 | `nullifier` `N` | — (must not be in the used set) |
| 3 | `right_id` | the `right_id` argument |
| 4 | `from_hi` | `split(from)` high half |
| 5 | `from_lo` | `split(from)` low half |
| 6 | `to_hi` | `split(to)` high half |
| 7 | `to_lo` | `split(to)` low half |
| 8 | `mode` | `0` if `expires_at` is `None`, else `expires_at` |
| 9 | `expiry_ledger` | ≥ current ledger and ≤ current ledger + 720 |
| 10 | `next_secret_hash` `h'` | sale: the value the buyer signed; rental: `0` |
| 11 | `next_commitment` `C'` | sale: stored as the new commitment; rental: ignored |

Every check above runs **before** the pairing check, so a mismatched proof is
refused without paying for verification.

**Private (3):** `d_hi`, `d_lo`, `s`.

**Constraints:**

```
h  = Poseidon_1(s)
C  === Poseidon_5(d_hi, d_lo, from_hi, from_lo, h)
N  === Poseidon_6(s, right_id, to_hi, to_lo, mode, expiry_ledger)
C' === Poseidon_5(d_hi, d_lo, to_hi, to_lo, h')
```

Eleven public signals mean twelve `ic` points in the verification key. The
on-chain cost of folding them in is measured in Step 2; if it is too high, the
fallback named in the work plan — hashing the public inputs into one — is
evaluated then, not now.

### 8. What the proof reveals and what it hides

| Reveals (public signals — already implied by the transaction) | Hides |
| --- | --- |
| Which right is being transferred | The record secret `s` |
| The sender's and recipient's accounts | The sender's secret hash `h` |
| Sale or rental, and the rental's end time | The record digest `d` |
| The deadline for this proof | Every field of the record: owner name, email, resort, unit, deed, fees |
| The current commitment and, on a sale, the next one — both opaque | Any link between the nullifier and the secret |
| A nullifier — opaque, unlinkable to the secret | |
| On a sale, the buyer's next secret hash `h'` | |

Not hidden, and not claimed to be: *that* a transfer happened, between which
accounts, for which right. That is the same public metadata Phase 1 had, and a
transaction cannot avoid it.

**`h'` is public, and an earlier draft of this table said otherwise.** On a sale
the buyer's `h'` is public signal 10, and the buyer signs it, so it is in the
transaction. That is acceptable for the reason `h` was always shareable (§2): it
proves nothing without `s`, and checks a record against `C'` only for someone who
already has the record. What keeps `C'` from being tested against guessed records
is that `d` is unguessable — which the record's 32-byte `salt` guarantees
(docs/COMMITMENT.md). The holder's own `h` before a sale never reaches the ledger:
the issuer computes `C` off chain, and the proof keeps `h` private.
`npm run check-privacy -- --phase2` searches every Phase 2 transaction for each
owner's `h`, `s` and `d` and finds none.

### Poseidon parameters over BLS12-381

circomlib's Poseidon constants were generated for BN254's scalar field. They are
**not** valid for BLS12-381, and compiling with `circom -p bls12381` does not
change them. The constants this circuit uses were generated for BLS12-381 with
the Poseidon authors' reference tooling only, by the procedure that produced
circomlib's. Generated 2026-10-09.

| | t = 2 (`Poseidon(1)`) | t = 6 (`Poseidon(5)`) | t = 7 (`Poseidon(6)`) |
| --- | --- | --- | --- |
| field prime | `r` above | `r` above | `r` above |
| S-box, alpha | x^5, 5 | x^5, 5 | x^5, 5 |
| R_F | 8 | 8 | 8 |
| R_P | 56 | 60 | 63 |
| round constants | 128 | 408 | 497 |
| command | `sage generate_parameters_grain.sage 1 0 255 2 8 56 0x73eda…0001` | `… 1 0 255 6 8 60 0x73eda…0001` | `… 1 0 255 7 8 63 0x73eda…0001` |

- **Tooling.** `generate_parameters_grain.sage` and `calc_round_numbers.py` from
  [hadeshash](https://extgit.iaik.tugraz.at/krypto/hadeshash) at commit
  `208b5a164c6a252b137997694d90931b2bb851c5`, run under SageMath 10.4
  (`sagemath/sagemath@sha256:8d657a42f33a407b8dbc9a3cb5818cb6b4df8aacc7b291ba675132ee55d4db73`).
  The authors' own file lists the BLS12-381 invocation in exactly this form.
- **Round numbers.** `calc_round_numbers.py` (x^5, 128-bit security, with
  security margin) gives `R_F = 8` and `R_P = 56, 57, 57` for `t = 2, 6, 7`;
  rounded up to a multiple of `t`, as circomlib does, that is `56, 60, 63`.
  `gcd(5, r − 1) = 1`. For BLS12-381 the values equal circomlib's BN254 table at
  every width used, so circomlib's `N_ROUNDS_P` array applies unchanged.
- **Same procedure as circomlib — checked, not claimed.** Run for BN254 with the
  same settings, the same tool and iden3's own optimizer reproduce every value
  of `POSEIDON_C`, `S`, `M` and `P` in circomlib 2.0.5's
  `poseidon_constants.circom` at `t = 2, 6, 7`.
- **Same function as the authors'.** The BLS12-381 constants, run through the
  reference permutation, give the authors' published test vectors for this
  field, `poseidonperm_x5_255_3` and `poseidonperm_x5_255_5`.
- **Circuit and CLI agree.** The circuit tests build every witness from the
  JavaScript Poseidon and check it against the R1CS, so the circuit's Poseidon
  and the CLI's are the same function at all three widths.

The optimized form circomlib's template consumes (`C`, `S`, `M`, `P`) comes from
iden3's `poseidon_optimize_constants.js`, changed only so the field is a parameter
(`circuits/gpl/optimize.mjs`). The template itself is circomlib's, with one
`include` line changed (`circuits/gpl/poseidon.circom`).

```
npm run zk:check-poseidon            # all of the above, offline, from circuits/poseidon/raw/
bash circuits/poseidon/generate.sh   # regenerate raw/ from scratch (Docker); reproduces it byte for byte
```

circomlib and circomlibjs are GPL-3.0. Everything derived from them — the circuit,
the vendored template, the generated constants, the optimizer and the JavaScript
Poseidon — lives in `circuits/gpl/` under its own GPL-3.0 LICENSE; the rest of the
repository is Apache-2.0.

### Trusted setup

Groth16 needs a per-circuit setup. Phase 2 uses a **development setup run by the
builder, non-production**, reproduced by `scripts/setup-dev.sh`. The
verification key is committed; the toxic waste is not kept. Anyone who did keep
it could forge proofs — which, as above, still cannot move a week without the
holder's wallet signature. A production multi-party ceremony is Phase 3.

Run 2026-10-09 (`npm run zk:setup`): powers of tau on bls12-381 at `2^12`, one
contribution per phase, `snarkjs zkey verify` → `ZKey Ok!`. The keys in
`circuits/keys/` and their hashes (`circuits/keys/SHA256SUMS`):

```
a4d547d3f811715705330e75652873de14ce94fc97b3e33418c3207264786ebf  transfer.zkey
e07eed7b33a25605e0493b0e595d0f1ee3d70fd61f22cccc4aac00c9c494018b  verification_key.json
5db51d96c3ddc46c8ebeb8feb28aeebc4e480d619f68b6fe9a8fa0fb826b91ea  transfer.wasm
d58ebebeeb8fbfaabc0cfea05e85cacc3dbd8830b511bdaba1b953208e2a37ea  transfer.r1cs
```

Rerunning the setup makes new, different keys; proofs made with these stop
verifying against them.

`transfer.wasm` was recompiled after the circuit moved to `circuits/gpl/` (two
comment lines added, so the line numbers in its error messages moved). The R1CS
is byte-for-byte the one the keys were made from (`d58ebebe…`), and the old and
new witness generators produce identical witnesses for the same input.

---

## Step 2: built and measured

Completed 2026-10-09. Tool versions: circom 2.2.2 (`e410b0d5`), snarkjs 0.7.5,
circomlib 2.0.5, soroban-sdk 27.0.6, stellar-cli 27.0.0.

### The circuit

`circuits/gpl/transfer.circom`, compiled with `npm run zk:compile`
(`circom … -p bls12381`): **1,221 non-linear and 1,831 linear constraints**,
11 public inputs, 3 private inputs, no outputs. `npm run zk:test` — 11 circuit
tests, all passing: an honest sale and an honest rental satisfy the R1CS; the
public signals sit at wires 1–11 in §7's order; a wrong secret, an account the
commitment does not name, a different record, a nullifier from a different
recipient, mode, rental length, right or deadline, a freely chosen nullifier, and
a next commitment for a different `h'` are all refused.

### The prover

`npm run zk:prove -- --record … --secret … --right … --from … --to … (--sale --next-secret-hash … | --rental-until …)`
proves in **1.2 s** on the builder's laptop, then runs `snarkjs groth16 verify`
before writing anything; `npx snarkjs groth16 verify` on its output also prints
`OK!`. `npm run zk:secret -- <file>` makes a secret and prints the shareable `h`.

### On-chain verification

The soroban-examples verifier, adapted so the key is fixed in the constructor and
public signals are refused unless canonical (`contracts/quietstay-verifier`,
6 unit tests passing). Its interface is `__constructor` and `verify`, nothing
else.

| | |
| --- | --- |
| Contract | [`CDMUMMOF3TM453RY4QZL6UWV2FT2QP3JUWW24SFIH5ICWSVGRB4IK5BK`](https://stellar.expert/explorer/testnet/contract/CDMUMMOF3TM453RY4QZL6UWV2FT2QP3JUWW24SFIH5ICWSVGRB4IK5BK) |
| Deployed in | [`05d90907…`](https://stellar.expert/explorer/testnet/tx/05d90907ebcda152597b4c1deb5d70a930ea3321c538bb81ec01117bd1c4ca44) |
| **First on-chain verification** | [`8e16b7cdfccd15cd475b5c2c0a58a72000546b8bbbf70068e87a1efe30c52645`](https://stellar.expert/explorer/testnet/tx/8e16b7cdfccd15cd475b5c2c0a58a72000546b8bbbf70068e87a1efe30c52645) — returned `true` |

One check of the SDK found on the way: `Bls12381Fr::from(U256)` reduces values
`>= r` modulo `r` without complaint. A contract that took public signals as `Fr`
would accept `N` and `N + r` as the same proof while storing them as different
nullifiers. So signals arrive as `U256` and are refused at `>= r` before
conversion; a unit test submits the nullifier plus `r` and gets
`NonCanonicalSignal`.

### Cost

| Measured | Value | Command |
| --- | --- | --- |
| CPU, simulated | **78,896,206** instructions | `npm run zk:measure -- CDMUMM… proofs/step2-sale` |
| Minimum resource fee, simulated | 71,341 stroops | same |
| Ledger bytes read / written | 0 / 0 | same |
| Fee charged, real transaction `8e16b7cd…` | **61,756 stroops** (0.0061756 XLM): 100 inclusion + 61,616 non-refundable + 40 refundable; 9,685 refunded | `stellar contract invoke … --send=yes --cost -- verify …` |
| CPU and memory, the `verify` call alone (local host budget) | 75,126,535 instructions, **350,344 bytes** | `cargo test -p quietstay-verifier honest -- --nocapture` |
| Testnet limits per transaction | 400,000,000 instructions, 41,943,040 bytes memory | `stellar network settings --network testnet` |
| Phase 1 approved transfer `b19b0a0a…` (for comparison) | 2,346,768 instructions declared, 45,309 stroops charged | Horizon `/transactions/b19b0a0a…` |

The RPC's simulation response does not report memory, so memory comes from the
local host budget, which uses the same cost model; the CPU figures from the two
agree to within 5%.

**Estimate, not yet measured** — verification plus transfer in one transaction:
about **82 million instructions** (78.9 M verification + 2.3 M Phase 1 transfer
logic + a little for the signal checks, the account conversions and one nullifier
write), about **21% of the per-transaction limit**; memory well under 1 MB of
40 MB; a fee of roughly **0.011 XLM**. Step 3 measured it on the deployed
contract (below): 80.4 million instructions for a sale, as estimated, but a fee
of 0.018 XLM — higher than estimated, because the estimate left out the ledger
writes a transfer makes (the right, the nullifier entry, the buyer's balance).

**Decision (approved 2026-10-09): the one-transaction flow.** Verification uses a fifth of the
CPU a transaction may spend, so verification and transfer fit together with
room to spare. One transaction means no recorded-but-unconsumed authorization,
no second ledger window to reason about, and one place for every rejection test.
The two-transaction flow solves a cost problem this circuit does not have, and
the hashed-public-input fallback would add a SHA-256 step to save about ten of
the eleven `g1_mul`s — a saving the margin does not call for. Neither is built.
The mainnet per-transaction limit is checked in Phase 3, with mainnet itself.

**Testnet's minimum temporary TTL is 720 ledgers** — the same as the proof
window. A nullifier entry left at the minimum TTL could therefore lapse just before
a proof made at the edge of the window does, so Step 3 extends each
nullifier's TTL explicitly past its `expiry_ledger`, as §6 requires.

---

## Step 3: integrated and deployed

Completed 2026-10-09. The proof check lives in the rights contract, behind
`auth.rs`, in one transaction with the transfer. Tests: `cargo test` in
`contracts/` — 62 for the rights contract, every transfer carrying a real proof
from `npm run zk:test-fixtures`, and 6 for the standalone verifier.

| | |
| --- | --- |
| Contract | [`CBET7IDGZQKG2Q3KPUDNKWLFAVDJ2YQJTCKPIS5I55KTTDF7WIX45FC4`](https://stellar.expert/explorer/testnet/contract/CBET7IDGZQKG2Q3KPUDNKWLFAVDJ2YQJTCKPIS5I55KTTDF7WIX45FC4) — verification key fixed in the constructor |
| Deployed in | [`945bb0e2…`](https://stellar.expert/explorer/testnet/tx/945bb0e2da12914d71bedbd0de2a853cc081f9e1e444fc32d34b4e765c89c2fc) |
| Issued | right #1, sample week 03 — [`3ff775ff…`](https://stellar.expert/explorer/testnet/tx/3ff775ff4da6347e69df2acc7ccc476a4639f083a2b8b5e959def860407b2f3a); right #2, sample week 01 — [`1ad567cd…`](https://stellar.expert/explorer/testnet/tx/1ad567cd49e04248309aff632c0f424a0c04bfd600f9c0b2b85ec7339fa3bade) |
| **Proof-authorized rental** | [`85b16c610912f10812fd9fbcd30b7aabbccee325fd86b6e230fafd2861a55ce7`](https://stellar.expert/explorer/testnet/tx/85b16c610912f10812fd9fbcd30b7aabbccee325fd86b6e230fafd2861a55ce7) — right #1 to the renter until 2026-11-28; signed by the holder alone |
| **Proof-authorized sale** | [`9b7ce1ea45559b8e057a89c1aeaeb107e7abf6e72d3086ccaf373f786c13d974`](https://stellar.expert/explorer/testnet/tx/9b7ce1ea45559b8e057a89c1aeaeb107e7abf6e72d3086ccaf373f786c13d974) — right #2 to the buyer; signed by the holder and the buyer |

Neither transaction carries an issuer signature. After them, `holder(1)` is the
renter, `holder(2)` is the buyer, and `commitment(2)` is
`1232be5f…88d7` — byte for byte the `next_commitment` the sale's proof
computed for the buyer.

Each owner made a secret with `npm run zk:secret` and passed only its hash `h`
to the issuer, which computed the commitment with `npm run zk:commitment` and
called `issue`. Transfers were proved with `npm run zk:prove` and submitted with
`npm run zk:submit`, which signs exactly the authorizations the simulation asks
for.

**Cost, verification and transfer in one transaction:**

| | Local host budget (`cargo test cost_of_one_proven_sale -- --nocapture`) | Testnet simulation (`npm run zk:submit`) | Fee charged on testnet |
| --- | --- | --- | --- |
| Rental | — | 79,607,161 instructions | 141,072 stroops (0.0141 XLM) |
| Sale | 75,535,619 instructions, 497,418 bytes | 80,352,655 instructions | 184,436 stroops (0.0184 XLM) |

The local figure runs the contract as native Rust, so it leaves out the WASM VM's
own work; the simulation runs the deployed WASM and is the number that counts.
A sale uses **20.1%** of testnet's 400,000,000-instruction limit and a rental
19.9%. Memory is reported only by the local budget: under 0.5 MB of 40 MiB.


## Step 4: re-issued, redeployed, and the rejection evidence

Completed 2026-10-09, on the final deployment
[`CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD`](https://stellar.expert/explorer/testnet/contract/CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD)
(deployed in `c17e5c9d…`; WASM `25e95e05…`). It differs from the Week 2 contract
in one respect: `issue` refuses a contract address as owner, with `NotAnAccount`,
so no right can be created that no proof could ever transfer.

The four sample weeks were re-issued with Poseidon commitments
(`npm run zk:reissue`), and `npm run zk:evidence` produced two accepted and five
rejected transfers. Every rejection was read back from the ledger and matched
its expected error — `InvalidProof`, `NullifierUsed`, `WrongAccount`,
`WrongSignalCount` for the holder-and-issuer transfer with no proof, and
`Error(Auth, InvalidAction)` for the issuer's seizure — with an
`invoke_host_function_trapped` result, not a resource failure. The hashes, and
what to look for in each, are in [EVIDENCE.md](./EVIDENCE.md#phase-2-the-seven-transactions).

The rejections are submitted by `withSiblingResources`
(`scripts/lib/zk-tx.ts`), an evidence-only path: a transaction the contract
refuses cannot be built from its own simulation, so it borrows the footprint of
its successful twin's simulation and declares twice that twin's CPU (about
160 million instructions), enough that only the contract's check can stop it.

`npm run check-privacy -- --phase2`: 11 transactions (four issuances, seven
transfers), 71 forbidden values, none found at any layer. A negative control —
searching the same bytes for `h'` and `C'`, which are on chain — finds both,
so the search does find what is there.

## Step 5: the app and the command line

Completed 2026-10-09. The app talks to the final deployment, and no part of it asks
the issuer to approve anything.

- **Proving stays on the holder's machine.** `npm run zk:prove` writes
  `transfer.json`; the Transfer screen's *Prove ownership* step takes it,
  `/api/tx/proven-transfer` checks it names the signed-in holder and simulates the
  call — so the contract checks the proof before the wallet signs — and the holder
  signs the envelope.
- **The buyer's signature (§3) is given in advance.** It covers `(right_id, h')`
  only, which does not depend on the seller's proof, so the buyer signs it when
  asking to buy: the server prepares the authorization preimage, the wallet signs it
  (`signAuthEntry`), and stellar-sdk's `authorizeEntry` checks the signature
  against the buyer's key before the ask is stored. Freighter and Hana implement
  `signAuthEntry`; xBull, Albedo and Rabet do not, so in the app a buyer needs one
  of the first two.
- **`/verify`** computes `d` with SHA-256 in the browser, checks it against the v2
  attestation ([ATTESTATION.md](./ATTESTATION.md)), lists the week's accepted
  transfers from the contract's events — each one a proof the contract verified —
  and says in one sentence why `d → C` is `npm run verify-record --secret-hash`.
  Poseidon never runs in the browser.
- **`/issue`** reads the role. An owner signs in and asks for issuance with their
  `h` (`/api/requests/issuance`, the account taken from the session, `h` checked as
  below). The issuer sees the pending asks; picking one fills in and locks the
  first holder and `h`, and issuing closes it. The issuer can also take an `h`
  given directly. Either way the route takes the record and the owner's `h`
  (decimal or hex). The server
  computes `C` with `commitment` from `scripts/lib/zk.ts` — the module
  `npm run zk:commitment` and `zk:issue` use, on the one Poseidon in
  `circuits/gpl/poseidon.ts` — and refuses an `h` that does not parse or is not
  below `r` with 400, before anything is issued. The screen then offers the record
  exactly as issued for download; with it and the owner's secret file,
  `npm run zk:prove` proves a transfer.
- **`npm run e2e`** covers the flow end to end — 65 checks, including an
  owner's ask issued and closed, an ask in another account's name and asks with
  an invalid `h` refused, the Issue screen showing the form to the issuer only,
  five
  malformed `h` refused with nothing issued, the server's `C` equal to the
  command line's, `npm run verify-record` confirming each week's `C` on chain from
  the saved record, `npm run zk:prove` proving a rental from that record, a
  replayed proof, someone else's proof, a tampered proof, a sale without consent
  and a forged consent — run against a throwaway deployment so it issues nothing
  on the evidence contract ([SETUP.md](./SETUP.md#end-to-end-test)).
- **When the event window has passed.** The RPC keeps events for about a week, so
  *Verified on chain* falls back to the deployment's evidence transactions from
  `docs/evidence-phase2.json` — two accepted, five refused, each a Stellar Expert
  link — and says in one sentence why. The e2e checks this on a week with no
  transfer in the window, which is the state every week reaches a week after its
  last transfer.

## Decisions

Approved 2026-10-09.

1. **Buyer signature on a sale** (§3). The contract requires
   `to.require_auth_for_args((right_id, h'))` on a sale. `h'` stays a public
   signal, and the contract checks the signed `h'` equals the proof's `h'`
   before the pairing check. Unit test: a seller planting their own `h'` is
   rejected.
2. **The record check** (§4). `d → C` runs in the CLI (`npm run verify-record`).
   `/verify` computes `d` with SHA-256 in the browser, shows the on-chain
   verification result, and explains in one sentence why the last step is in
   the CLI. No Poseidon in the browser.
3. **The window** (§6). 720 ledgers. A used nullifier's temporary-storage TTL
   always outlives the proof's `expiry_ledger`; a unit test shows the entry is
   not gone while the proof could still be replayed.
4. **Where Poseidon runs** (approved 2026-10-10, replacing "only in the circuit
   and the CLI"). **Poseidon runs in the circuit, in the CLI and on the server;
   it does not run in the contract or in the browser.** The server is the
   `/api/issue` route, which computes `C` from the record and the owner's `h` so
   the issuer no longer copies a record into a file and `C` back into a form.
   Conditions: the route imports the CLI's own module — there is no second
   Poseidon and no copy of its constants; it refuses an `h` that does not parse
   as decimal or hex or is not below `r` (400, tested); `npm run zk:check-bundle`
   still exits 0, and now also confirms the server build does contain the code
   it finds absent from the browser's. The secret `s` reaches the server at no
   stage — only `h`, which the issuer was always given. This rule is ours, from
   `phase2.md`; the SOW sets none on where Poseidon runs.

Written against `phase2.md`, which is aligned with the approved Phase 2 SOW.
