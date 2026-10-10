# QuietStay Phase 2 — protocol, trust model, and boundaries

This document explains what QuietStay is after Phase 2, exactly what it guarantees,
and exactly what it does not. Where the code and this document could be read
differently, the code is right and this document is a bug. The proof itself is
specified in [CIRCUIT.md](./CIRCUIT.md); Phase 1's version of this document is at
the [last Phase 1 commit](https://github.com/murat48/QuietStay/blob/a1b8ad2edf2953dac7216d36a49d2fb56c47b4b8/docs/DESIGN.md).

- [The problem](#the-problem)
- [The protocol](#the-protocol)
- [The trust model, Phase 1 and Phase 2](#the-trust-model-phase-1-and-phase-2)
- [The transfer primitive](#the-transfer-primitive)
- [The authorization boundary](#the-authorization-boundary)
- [Verification: what a buyer checks](#verification-what-a-buyer-checks)
- [Roles: owner, renter, issuer](#roles-owner-renter-issuer)
- [Privileged surface, enumerated](#privileged-surface-enumerated)
- [What the ledger reveals](#what-the-ledger-reveals)
- [Relationship to SEP-41, and where it diverges](#relationship-to-sep-41-and-where-it-diverges)
- [Known limitations](#known-limitations)
- [What Phase 3 is for](#what-phase-3-is-for)

---

## The problem

A timeshare owner who cannot travel in a given year has no simple way to rent or
sell that week. Transfers are slow, broker-dependent, and fee-heavy. A buyer cannot
easily verify who really holds the week, or whether it carries unpaid maintenance
fees. A public ledger solves the trust problem and creates a new one: ownership
history and travel schedules become visible to everyone.

QuietStay keeps the *record* off chain and puts a *commitment* to it on chain. Phase
1 let the issuer approve every transfer. Phase 2 removes that: a transfer is
authorized by a zero-knowledge proof that the holder knows the week's record secret,
verified by the contract on chain, and by nobody's permission.

## The protocol

| Artifact | Where it lives | What it is |
| --- | --- | --- |
| Ownership record | Off chain: with the holder, and with the issuer from issuance | Owner identity, resort, unit, deed reference, fee history, and a 32-byte salt. [Schema](./COMMITMENT.md). |
| Record digest `d` | Off chain; in the attestation | `SHA-256(canonical(record))` — what `sha256sum` gives. |
| Record secret `s` | **Only on the holder's machine** | A random field element. Knowing it is what the proof proves. |
| Secret hash `h` | Off chain; given to the issuer at issuance, disclosed with the record | `Poseidon(s)`. Shareable: it checks a record against the commitment, proves nothing alone. |
| Commitment `C` | **On chain**, in the right | `Poseidon(d, holder's account, h)`. Replaced on every sale. |
| Attestation | Off chain, issuer-signed | The issuer's statement about validity and fees, bound to `d`, the right and the contract. [Schema](./ATTESTATION.md). |
| Usage right | **On chain** | Issuer, week, use year, `C`, and the holding chain. |
| Ownership proof | In the transfer's call | Groth16 over BLS12-381: three curve points and eleven public signals. [Specification](./CIRCUIT.md). |

**What leaves whose machine.** The record and `s` stay on the holder's machine
*when proving*: the prover runs there and sends only the proof and its public
signals. At issuance the record goes to the issuer — as it has since Phase 1, since
the issuer validates it, computes `d` and attests it — and so does `h`, from which
the issuer's server computes `C` (Poseidon runs in the circuit, the CLI and that
server; never in the contract or a browser — [CIRCUIT.md](./CIRCUIT.md#decisions)).
`h` is the only thing Phase 2 newly sends to the server. `s` is sent to it at no
stage, so neither the issuer nor its server can ever prove a transfer.

The salt matters more under Phase 2 than it did in Phase 1: after a sale the buyer's
`h'` is public, so `C'` is hidden only because `d` cannot be guessed — and `d` cannot
be guessed because of the salt.

## The trust model, Phase 1 and Phase 2

The condition on this project from the start: "trusted to attest honestly" must not
become "able to take a holder's week away." Phase 1 met it for seizure and left the
issuer able to *decline* transfers. Phase 2 removes the issuer from transfers
altogether.

| The issuer… | Phase 1 | Phase 2 |
| --- | --- | --- |
| …moves, reassigns or seizes a held week | **No** — `from.require_auth()` | **No** — the holder's signature *and* proof |
| …approves or declines a transfer | **Yes** — every transfer needed its co-signature | **No** — it has no part in a transfer |
| …freezes a week by withholding an attestation | **Yes, in effect** — no attestation, no approval | **No** — no attestation is a condition of a transfer |
| …burns a held week | No — `burn` needs the holder | No — unchanged |
| …overwrites a right or alters a commitment | No | No |
| …replaces the contract's code | **Yes** — `upgrade` | **No** — `upgrade` removed |
| …replaces the verification key | — | **No** — fixed in the constructor; no function takes one |
| …issues new weeks | Yes | Yes — at fresh ids only |
| …attests falsely about validity or fees | **Yes** | **Yes** — the one power that remains |

Each "No" in the Phase 2 column is enforced by the contract and shown on chain:
[EVIDENCE.md](./EVIDENCE.md#phase-2-the-seven-transactions) has the issuer's attempt
to move a held week to itself, and a transfer carrying both the holder's and the
issuer's signatures but no proof — both refused.

### What remains: attesting falsely

The issuer can still sign that a week is valid and free of arrears when it is not.
Verification proves the issuer *said* it; nothing proves the issuer was honest. Under
Phase 2 the damage is bounded: an attestation is shown to buyers and decides nothing,
so a false one misleads a buyer but cannot move, keep or free a week. The issuer can
also issue rights for weeks that do not exist — nothing checks issuance against a
real inventory — and refuse to attest, which leaves a week with nothing vouching for
its fees but transferable all the same.

### The development trusted setup — non-production

Groth16 needs a per-circuit setup. Phase 2's was run by the builder alone, with one
contribution per phase ([CIRCUIT.md](./CIRCUIT.md#trusted-setup)). Whoever ran it
could have kept the randomness and could forge a proof for any public signals.
Nothing in the script keeps it, but nothing can prove that either.

What a forged proof could do: pass the contract's proof check. What it could not do:
move a week without the holder's own wallet signature, because `transfer` checks
`from.require_auth()` first, independently. So the development setup weakens the
second factor, not the first. A production multi-party ceremony is Phase 3.

### No `upgrade`: a bug fix means a fresh deployment

Phase 1 had an `upgrade` function, and with it every "the issuer cannot" was a
property of the code running now rather than a guarantee: the issuer could deploy
a version that could. Phase 2 removes it. The code deployed is the code that runs,
and nobody can change it.

The cost is real and accepted: a defect in the contract cannot be patched in place.
Fixing one means deploying a new contract, issuing the inventory again on it, and
holders moving across — which is exactly what Phase 2's own history shows: the Week
2 contract and the final one differ by one fix (`issue` refusing contract addresses),
and the fix shipped as a new deployment ([CIRCUIT.md](./CIRCUIT.md#step-4-re-issued-redeployed-and-the-rejection-evidence)).

## The transfer primitive

**One function, with a duration parameter, and a proof.**

```rust
transfer(from, to, right_id, expires_at: Option<u64>, proof: Proof, public_signals: Vec<U256>)
```

- `expires_at = None` — open-ended. A **sale**. `to` becomes the title holder, and
  the commitment is replaced by the one the proof computed for `to`.
- `expires_at = Some(t)` — a **rental**. `to` holds the week until `t`, then it
  reverts to `from`. The commitment is unchanged.

Sale and rental are not two code paths. A right holds a **holding chain**:
`holdings[0]` is the open-ended title, and entries above it are finite-term grants
with non-increasing expiries. The chain is re-evaluated against the ledger time on
every read ([`store::prune_lapsed`](../contracts/quietstay-rights/src/store.rs)), so
a rental lapses **without a return transaction**: nobody sends anything, the term
stops being in force, and a renter whose term has ended is not the holder at all.

Two chain rules are enforced on every grant, as in Phase 1:

- A holder cannot grant a longer term than they hold (`ExpiryBeyondSenderTerm`).
- Only the effective holder can transfer, so a title holder cannot sell a week out
  from under an active renter (`NotHolder`) until the term lapses.

**Sub-letting can no longer happen.** Phase 1's contract permitted a renter to
sub-grant inside their own term, and its issuer declined to approve one. Under Phase
2 that question answers itself: a transfer needs a proof of the record secret, and a
renter does not have it. The chain rules still guard every grant — the unit tests
exercise them directly — but no renter can reach them.

## The authorization boundary

Every transfer passes through [`auth.rs`](../contracts/quietstay-rights/src/auth.rs),
and nothing else in the contract decides whether one is allowed. Phase 1's body was
one line, `right.issuer.require_auth()`. Phase 2 replaces it with the proof check,
in two halves:

1. **`check_transfer_proof`** — before the holding-chain rules, and cheap. Every
   public signal is compared with what the contract already knows: eleven signals,
   each below the scalar modulus; both parties `G…` accounts; the commitment equal
   to the stored one; the right, sender, recipient, sale-or-rental and rental end
   equal to the call's; the deadline in the future and within 720 ledgers; on a
   sale, `h'` non-zero and signed by the buyer; on a rental, `h'` zero; the
   nullifier unused. A replayed proof is therefore refused as a replay.
2. **`consume_transfer_proof`** — after the chain rules, so verification is only
   paid for on a transfer that can happen: the Groth16 pairing check against the
   key fixed at deployment, then the nullifier stored with a TTL that outlives the
   proof's deadline.

`from.require_auth()` runs before both, unchanged from Phase 1. A transfer needs the
holder's wallet **and** the holder's secret. The contract never computes Poseidon:
commitments and nullifiers arrive as public signals and are only compared and stored.

Two details the code documents where they live: public signals arrive as `U256` and
are refused at or above the modulus, because soroban-sdk reduces a field element
modulo `r` silently and the same nullifier could otherwise be stored under two
encodings; and the account key is read with `Address::to_payload()`, behind
soroban-sdk's `hazmat-address` feature, as an identifier the proof binds to — never
to verify a signature, which stays with `require_auth`.

## Verification: what a buyer checks

1. **The week is clean, by the issuer's word.** The issuer's Ed25519 attestation,
   with the issuer address read from the contract. The one check that trusts the
   issuer — and under Phase 2 it decides nothing, it informs.
2. **The seller is the holder.** `holder(right_id)` is authoritative and the issuer
   cannot influence it; SEP-10 proves the seller controls that account.
3. **Optionally, the record is the attested one.** If the seller discloses it, the
   browser computes `d` with SHA-256 and checks it against the attestation. The last
   link — that `d` is inside the ledger's `C` — needs the holder's `h` and Poseidon,
   which does not run in a browser: `npm run verify-record --secret-hash`.
4. **The week has only ever moved by proof.** The verify screen lists the week's
   accepted transfers from the contract's events; each one is a proof the contract
   verified.

As in Phase 1, the document is optional: checks 1, 2 and 4 answer whether the week is
real, what it owes and who holds it, with no deed changing hands. Everything runs in
the counterparty's browser on the [verify screen](../src/app/verify/page.tsx), and on
the command line via `npm run verify-record`.

### The holder's credential is the chain, not a forwarded document

A buyer who has taken a week arrives with their wallet, not with the seller's PDF:
the issuer knows which unit right #N is, the chain says who holds it, and a wallet
signature proves the person at the desk is that holder. Nothing on the resort's side
— check-in flow, front desk, integration — is built; real resorts are out of scope.

## Roles: owner, renter, issuer

A role is **read off the ledger, never declared** ([`src/lib/roles.ts`](../src/lib/roles.ts)).

| Role | Turkish | Derived from | May |
| --- | --- | --- | --- |
| Issuer | ihraççı | equals `issuer()` on the contract | issue weeks at fresh ids, attest validity and fees |
| Owner | kiraya veren | holds **title** — `holdings[0]` | rent the week out or sell it, by proving ownership |
| Renter | kiracı | effective holder on a **finite term** | use the week until the term lapses — not sell, not sub-let: no record secret |
| Visitor | ziyaretçi | none of the above | verify any week; ask to rent or buy a listed one |

Roles gate nothing the contract does not already gate; they let a refusal arrive
before a signature. Each screen differs by role inside the same four screens:

- **Issue** — issuer only. The issuer pastes `C` from `npm run zk:commitment`, from
  the owner's `h`; the page computes `d` itself.
- **List** — the registry. A visitor asks for a listed week; asking to *buy* includes
  the buyer's `h'` and a wallet signature over `(right_id, h')` — the one signature a
  sale needs from a buyer (Freighter and Hana support it; xBull, Albedo and Rabet do
  not). The holder sees each ask with the exact prove command, the asker's account
  and `h'` filled in. Fee status is shown as a warning and blocks nothing.
- **Verify** — open to everyone, no account.
- **Transfer** — "Prove ownership": the holder runs the CLI prover on their own
  machine, uploads `transfer.json`, and signs. A renter is told why there is nothing
  to transfer.

## Privileged surface, enumerated

**Privileged — requires the issuer:**

| Function | Justification |
| --- | --- |
| `issue(owner, period, validity, commitment)` | Only the issuer creates inventory. Writes to a counter-assigned id, so it cannot reach an existing right. Refuses a non-canonical commitment and a contract-address owner, either of which would create a week no proof could ever transfer. |
| `__constructor(issuer, name, symbol, verification_key)` | Binds the issuer and the verification key once, at deployment. There is no setter for either. |

**Holder-initiated:**

| Function | Requires |
| --- | --- |
| `transfer(from, to, right_id, expires_at, proof, public_signals)` | `from`'s signature and a valid proof; on a sale also `to`'s signature over `(right_id, h')`. |
| `list(by, right_id, term_secs)` | The effective holder. |
| `unlist(by, right_id)` | The effective holder. |
| `burn(from, right_id)` | The title holder with no live sub-grant. See [known limitation 7](#known-limitations). |

**Unprivileged reads:** `issuer`, `name`, `symbol`, `decimals`, `balance`, `next_id`,
`get_right`, `commitment`, `holder`, `holding`, `holdings`, `is_active`, `get_listing`.

That is the whole interface — 19 functions with the constructor. There is no
`upgrade`, migrate, pause, freeze, seize, force-transfer, clawback or fee switch, and
no function that accepts a verification key. Check it against the deployed contract:
`stellar contract info interface --id CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD --network testnet`.

## What the ledger reveals

Checked against the real transactions, not assumed: `npm run check-privacy -- --phase2`
fetches every Phase 2 evidence transaction and issuance back from the network and
searches the raw bytes of the envelope, the result and the meta.

**Never on chain, confirmed by that check:** every field of every record, every
record digest `d` (hex, raw, and as the circuit's two 16-byte halves), every owner's
secret `s`, and every owner's secret hash `h`.

**Public, deliberately:**

| What | Where | Why |
| --- | --- | --- |
| Account addresses | Parameters, event topics | Who holds what — pseudonymous. |
| Right id | Parameters, events | The thing being transferred. |
| Commitment `C` (and `C'` after a sale) | Event data, contract state, public signals | What a proof is checked against. Opaque. |
| The proof and its eleven public signals | Parameters | What the contract verifies. Reveal nothing about `s` or the record. [CIRCUIT.md §8](./CIRCUIT.md#8-what-the-proof-reveals-and-what-it-hides). |
| The buyer's `h'`, on a sale | Parameters | Public signal 10, and what the buyer signs. Proves nothing without `s`. |
| The week's dates and use year | Contract state | An offer has to say what it is offering. |
| An offer: the account offering it and the rental term | Contract state | A marketplace has to show what is on offer. |
| A rental's end time | Parameters, event data, contract state | The contract cannot enforce a term it cannot see. |

The honest residual is Phase 1's: an observer learns that some pseudonymous account
holds a week with these dates and moved it to another. Not whose, not where.

### Against the SOW's "no names, contract numbers, or travel dates"

**Names and contract numbers: never on chain.** No owner name, email, resort, unit,
deed reference or registry, as the check above confirms.

**Dates: the week's, yes; a person's, no.** The week's date range is public because
the week *is* the offer — a listing that hid its dates could not be shopped. A
rental's end is public because the rental ends by itself, with no transaction, and
the contract can only do that if it knows when. Both are facts about an **account**
holding a week, not about a person: who stands behind an account is in the record,
and the record is off chain.

### What could be hidden, and what it would cost

| What | Could it be hidden? | Cost |
| --- | --- | --- |
| The week's date range | Yes, by a contract change: the dates are already inside `d`; listings would show them from the attestation | A fresh deployment and new evidence; the dates stop being the chain's guarantee and become the issuer's word |
| Offers on chain | Yes, by moving them to the app's store | Offers stop being publicly checkable; no proof depends on them |
| The buyer's `h'` | Yes, by a circuit change, signing `C'` instead | A new circuit and key for almost no gain — `h'` proves nothing alone |
| Who holds a week | Not in this design | The SOW binds a proof to the submitting account; hiding holders means ownership without accounts — a different design |
| A rental's end | Not in this design | A term that ends by itself needs the contract to see it |
| That a transfer happened, and of which right | No | Every Stellar transaction is public |

Hiding the last three is selective disclosure, which the SOW places out of scope.

### The measure that needs no code: one account per week

What links an account to a person is how the account is used — an exchange that knows
its owner, an address posted publicly. An owner who holds each week in its own
account, and a renter who rents with one, leave nothing that ties two weeks, or two
stays, to the same person. The dates above then describe an account that does nothing
else.

## Relationship to SEP-41, and where it diverges

The token interface follows [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
with **one systematic substitution**: rights are non-fungible, so `right_id: u64`
takes the place of `amount: i128`. `name`, `symbol`, `decimals` (`0`) and `balance`
(rights held as **title**) are kept.

| SEP-41 | Here | Reason |
| --- | --- | --- |
| `transfer(from, to, amount)` | `transfer(from, to, right_id, expires_at, proof, public_signals)` | Which week moves, sale or rental, and the ownership proof that authorizes it. |
| `burn(from, amount)` | `burn(from, right_id)` | Same substitution. |
| `approve` / `allowance` / `transfer_from` / `burn_from` | **Absent** | Delegated spending has no role here, and under Phase 2 a delegate could not prove anyway. |

**This is not a drop-in fungible SEP-41 token**, and a wallet expecting one fails at
the type level rather than silently doing the wrong thing.

## Known limitations

Deliberate, and stated so nobody discovers them as surprises:

1. **Development trusted setup, non-production** — [above](#the-development-trusted-setup--non-production).
2. **No upgrade: a bug fix is a fresh deployment** — [above](#no-upgrade-a-bug-fix-means-a-fresh-deployment).
3. **The issuer can attest falsely** — [above](#what-remains-attesting-falsely).
4. **A lost record secret strands the week.** The holder can still use it, but can
   never rent it out or sell it again: nobody else can prove for it, the issuer
   included, by design.
5. **A sale needs a buyer whose wallet can sign an authorization entry** in the web
   app — Freighter or Hana. Others can sign from the command line.
6. **Who still uses the command line: the owner, not the issuer.** Issuance runs in
   the app end to end. The owner signs in on the Issue screen and asks for a week
   with their `h` — `npm run zk:secret` prints a link, `/issue?h=…`, that fills it
   in (the issuer's form never reads it); the issuer, on the same screen, picks the ask — which fills in the
   first holder and `h` and locks both — enters the record, and issues. The server
   computes `C`; `s` never reaches it. The owner still makes the secret and its `h`
   (`npm run zk:secret`) and the transfer proof (`npm run zk:prove`) on the command
   line, because both need Poseidon and the browser does not run it. Moving those two
   steps into the browser is Phase 3; in-browser proving is out of scope for Phase 2.
7. **`burn` needs the holder's wallet, not the holder's proof.** Someone who steals a
   holder's wallet key cannot transfer the week — that needs the secret too — but can
   burn it, destroying it for everyone. The issuer can do neither. Binding `burn` to
   the proof is left to Phase 3.
8. **A week under an active rental cannot be sold** until the term lapses.
9. **No issuer key rotation.** Rotating means redeploying.
10. **Rights expire with their use year.** The sample inventory is use-year 2026 and
    goes inert on 2027-01-01.
11. **No price anywhere.** Payment, escrow and settlement are out of scope; an offer
    records availability and term only.
12. **Requests are off chain.** An ask is a message the deployment keeps. A sale ask
    carries the buyer's signed consent, which the contract checks when the sale is
    submitted; the ask itself binds nobody. An owner's ask for issuance is kept in
    the same store and carries only the asker's account, from their session, and
    their `h`.
13. **Sub-grant depth is capped at 4** — a resource bound; under Phase 2 no renter can
    sub-grant anyway.

## What Phase 3 is for

Mainnet, a security audit, and a production multi-party trusted-setup ceremony —
together the step from a testnet demonstration to something real money could rest on.
Binding `burn` to the proof belongs there too, and so does taking the command line out
of the owner's hands: making the record secret and proving a transfer in the browser.

**Out of scope for Phase 2, and absent from this repository:** mainnet deployment, a
security audit, a production trusted-setup ceremony, in-browser proving, selective
disclosure, any new cryptographic primitive, swaps between owners, payment and
escrow, real resorts, legal title transfer, and passkey login.
