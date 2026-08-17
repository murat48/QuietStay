# QuietStay Phase 1 — protocol, trust model, and boundaries

This document explains what QuietStay Phase 1 is, exactly what it guarantees, and
exactly what it does not. Where the code and this document could be read
differently, the code is right and this document is a bug.

- [The problem](#the-problem)
- [The protocol](#the-protocol)
- [The transfer primitive](#the-transfer-primitive)
- [Verification: three independent legs](#verification-three-independent-legs)
- [The authorization boundary](#the-authorization-boundary)
- [Roles: owner, renter, issuer](#roles-owner-renter-issuer)
- [Centralization: what the issuer can and cannot do](#centralization-what-the-issuer-can-and-cannot-do)
- [Privileged surface, enumerated](#privileged-surface-enumerated)
- [What the ledger reveals](#what-the-ledger-reveals)
- [Relationship to SEP-41, and where it diverges](#relationship-to-sep-41-and-where-it-diverges)
- [Known limitations](#known-limitations)
- [What Phase 2 is for](#what-phase-2-is-for)

---

## The problem

A timeshare owner who cannot travel in a given year has no simple way to rent or
sell that week. Transfers are slow, broker-dependent, and fee-heavy. A buyer
cannot easily verify who really holds the week, or whether it carries unpaid
maintenance fees.

A public ledger solves the trust problem and creates a new one: ownership history
and travel schedules become visible to everyone.

Phase 1's answer is to put the *commitment* on chain and keep the *record* off it.
The ledger carries a SHA-256 hash of each ownership record plus an issuer-signed
attestation that the week is valid and free of arrears. A buyer verifies precisely
what needs verifying — that the seller is the authorized holder, and that the week
is clean — and no document, name, or resort ever reaches the public ledger.

## The protocol

Four artifacts, three of which never touch the ledger.

| Artifact | Where it lives | What it is |
| --- | --- | --- |
| Ownership record | Off chain, with the parties | Owner identity, resort, unit, deed reference, fee history, and a 32-byte salt. [Schema and canonical form](./COMMITMENT.md). |
| Commitment | **On chain**, in the right | `SHA-256(canonical(record))`. 32 bytes. |
| Attestation | Off chain, issuer-signed | The issuer's statement that the week is valid and carries no unpaid fees, bound to one right. [Schema and verification](./ATTESTATION.md). |
| Usage right | **On chain** | Issuer, week, use year, commitment, and the holding chain. |

The salt is not decoration. A record's contents are low entropy — a date range, a
resort from a short list, a name — so an unsalted hash could be confirmed by
guessing. Thirty-two random bytes turn the commitment from *reversible by brute
force* into *reveals nothing*.

## The transfer primitive

**One function, with a duration parameter.** This is the core architectural
decision.

```rust
transfer(from: Address, to: Address, right_id: u64, expires_at: Option<u64>)
```

- `expires_at = None` — open-ended. A **sale**. `to` becomes the title holder and
  `from` keeps no claim.
- `expires_at = Some(t)` — a **rental**. `to` holds the week until `t`, then it
  reverts to `from`.

Sale and rental are not two code paths. A right holds a **holding chain**:
`holdings[0]` is always the open-ended title, and entries above it are finite-term
grants with non-increasing expiries. A grant either replaces the chain (open-ended)
or extends it (finite). The chain is re-evaluated against the ledger timestamp on
every read, in [`store::prune_lapsed`](../contracts/quietstay-rights/src/store.rs).

That is what makes a rental lapse **without a return transaction**. Nobody sends
anything; the term simply stops being in force, and the previous holder is the
effective holder again. A renter whose week has ended is not "a renter with an
expired flag" — they are not the holder at all, and every call they attempt is
rejected with `NotHolder`.

Two rules fall out of the chain and are enforced on every grant:

- A holder cannot grant a longer term than they hold. So a renter cannot sell
  (`ExpiryBeyondSenderTerm`), and cannot sublet past their own checkout.
- Only the effective holder can transfer. So a title holder cannot sell a week out
  from under an active renter (`NotHolder`) until the term lapses.

Chain depth is capped at 4 (title plus three sub-grants) so reads and writes have a
fixed worst-case cost.

## Verification: three independent legs

A counterparty checks three things, and no two of them rest on the same party. The
first two are always available; the third is optional, and that is the point.

1. **The week is clean.** Verify the issuer's Ed25519 attestation, using the issuer
   address read **from the contract** rather than from the attestation. This is the
   one leg that trusts the issuer, and it is the only one.

2. **The seller is the holder.** `holder(right_id)` is authoritative and the issuer
   cannot influence it. SEP-10 proves the seller controls that account.

3. **Optionally, the record is the committed record.** If the seller discloses the
   underlying document, canonicalize it per RFC 8785, hash with SHA-256, and compare
   against `commitment(right_id)` read from the contract. A match proves it is the
   exact document committed at issuance and unedited since.

### Why the document is optional

**Legs 1 and 2 answer the questions that used to require documents** — is this week
real, does it owe maintenance fees, and does this seller actually hold it — using
only an issuer-signed attestation and the contract. No deed, no name, no resort
changes hands. That is what "verifiable through issuer-signed attestations rather
than through document exchange" means, and requiring a document to complete a
verification would have quietly reinstated the practice the design removes.

Leg 3 is a second, deeper step for a buyer who wants to know *which* resort and
*which* unit they are getting. When a record is supplied it is checked strictly;
when it is not, nothing is claimed about it and the verification still stands.

All of it runs in the counterparty's own browser on the
[verify screen](../src/app/verify/page.tsx), and identically on the command line via
`npm run verify-record`. A server that answered "verified" would be one more party
to trust, which defeats the exercise.

## The authorization boundary

Every transfer passes through exactly one function, and nothing else in the
contract consults the issuer:

```rust
// contracts/quietstay-rights/src/auth.rs
pub fn require_transfer_approval(env, right, from, to, expires_at) {
    right.issuer.require_auth();
}
```

This follows the approval model of **SEP-8 regulated assets**, expressed with
Stellar's native authorization framework rather than a custom scheme. The issuer's
approval is a `SorobanAuthorizationEntry` carried by the transaction that performs
the transfer. `require_auth()` binds it to that invocation — this contract, the
function `transfer`, and the complete argument list — so an approval cannot be
replayed against a different right, counterparty, or term, and host nonce handling
stops it being replayed against the same one twice.

**Enforcement is in the contract.** A transfer submitted without the issuer's entry
fails inside this call, before any state is written. The UI has no part in it, and
the approval service being unavailable, bypassed, or compromised cannot let an
unapproved transfer through. See
[`EVIDENCE.md`](./EVIDENCE.md) for a transaction that demonstrates precisely this,
on chain.

The boundary is one function so that Phase 2 can substitute proof verification for
the issuer signature by rewriting its body and nothing else. That is a structuring
note. **No proof machinery exists in this contract.**

## Roles: owner, renter, issuer

Three parties use this app and they can do different things. The design decision
worth stating is that **a role is read off the ledger, never declared**.

There is no "I am an owner" selector anywhere. An account's standing is computed
from the registry ([`src/lib/roles.ts`](../src/lib/roles.ts), served by
[`/api/me`](../src/app/api/me/route.ts) behind the SEP-10 session):

| Role | Turkish | Derived from | May |
| --- | --- | --- | --- |
| Issuer | ihraççı | the account equals `issuer()` on the contract | issue rights, attest weeks, approve or decline transfers |
| Owner | kiraya veren | holds **title** — `holdings[0]` — to ≥1 right | rent the week out for a term, or sell it outright |
| Renter | kiracı | is the effective holder of ≥1 right on a **finite term** | sublet within their own term; **not** sell |
| Visitor | ziyaretçi | none of the above | browse the registry and verify any week |

The roles are not exclusive. An account that owns one week and rents another is
both, and the interface shows both rather than making the user choose — that is the
ordinary case for an active account, not an edge case.

### Why derived rather than chosen

A self-declared role would be decoration. The contract would still refuse whatever
the account was not entitled to, so a "renter" who selected "owner" would simply get
an on-chain rejection after paying a fee. Deriving the role means the interface
stops offering actions that would be refused — which is the only honest thing a
role can do here.

Consequently **roles gate nothing that is not already gated**. Every restriction in
the table is independently enforced twice more: server-side against the SEP-10
session, and on chain by the contract. `RoleGate` and the nav exist so a refusal
arrives before a signature, not instead of one. Deleting them would make the app
ruder, not less safe.

### Where each role enters

Different entry, same four screens — a fifth "dashboard" route would be exactly the
scope creep [the SOW warns against](#what-phase-2-is-for), so the differentiation
lives inside the existing screens:

- **Landing** — after sign-in, shows that account's standing and links only to what
  it can actually do.
- **Nav** — Issue is hidden from non-issuers rather than shown as a link to a
  refusal.
- **Transfer** — the form is built from the account's transferable rights. An owner
  gets rent-out and sell; a renter gets sublet only, with the sell option disabled
  and the reason stated, and with the date picker capped at their own checkout
  rather than the end of the use year.
- **List** and **Verify** — open to everyone, no account required. Auditing the
  registry is the point; gating it would defeat the exercise.

## Centralization: what the issuer can and cannot do

The reviewer approved this scope with one explicit condition: issuer-approved
transfers must not let the issuer unilaterally seize or freeze assets. "Trusted to
attest honestly" must not silently become "able to take a holder's week away."

### The issuer cannot

| | Why not |
| --- | --- |
| Move or reassign a held right | `transfer` calls `from.require_auth()` independently of the approval. The issuer cannot produce the holder's signature. |
| Freeze a right | There is no freeze, pause, lock, or blocklist function. |
| Burn a holder's right | `burn` requires the title holder's own authorization. |
| Claw back | This is a Soroban contract token, not a classic asset, so no clawback flag exists to enable. There is no equivalent function. Verify it yourself: the [contract interface](#privileged-surface-enumerated) has 18 functions and none of them is one. |
| Overwrite an existing right | `issue` takes its id from a monotonic counter the caller does not control, so it can only write to an id never used before. |
| Alter a commitment, week, or validity window after issuance | No function writes those fields on an existing right. |
| Upgrade the contract to add any of the above | There is no `upgrade` function and no admin. The deployed WASM is what runs, permanently. |

Demonstrated on chain, not merely asserted: the issuer builds, signs, and pays for
a transfer of a held right to itself, and the contract rejects it. Transaction hash
in [`EVIDENCE.md`](./EVIDENCE.md). Also covered by unit tests
`the_issuer_cannot_seize_a_held_right`,
`the_issuer_cannot_seize_a_right_that_is_out_on_rental`, and
`the_issuer_cannot_burn_a_holders_right`.

### The issuer still can

Stated plainly, because understating it would be the most damaging thing this
project could ship:

- **Decline a transfer it should have approved.** A holder whose transfer is
  declined keeps the week — nothing is taken — but they cannot rent or sell it
  through this contract while the issuer withholds approval. This is real
  censorship power over transfers.
- **Attest falsely.** It can assert a week is free of arrears when it is not, or
  that an invalid week is valid. Verification proves the issuer *said* it; it
  cannot prove the issuer was honest.
- **Issue rights for weeks it should not.** Nothing in the contract checks an
  issued week against a real resort inventory.
- **Refuse to attest at all**, leaving a right that this deployment's approval
  service will not approve a transfer for.

Closing the first two is Phase 2's objective. Phase 1 does not claim to have
addressed them.

## Privileged surface, enumerated

Every function, and why it exists. Anything without a justification would be
deleted.

**Privileged — requires the issuer:**

| Function | Justification |
| --- | --- |
| `issue(owner, period, validity, commitment)` | Only the resort or issuer can create inventory. Writes to a counter-assigned id, so it cannot reach an existing right. |
| `__constructor(issuer, name, symbol)` | Binds the contract to its issuer once at deployment. Runs only at creation and cannot be re-run. There is deliberately **no** `set_issuer`: rotating the key means redeploying, which keeps the privileged surface to one function. |

**Holder-initiated — requires the holder, and the issuer for transfers:**

| Function | Notes |
| --- | --- |
| `transfer(from, to, right_id, expires_at)` | The one primitive. Needs `from` **and** the issuer. |
| `list(by, right_id, term_secs)` | Publish an offer. Effective holder only. No issuer involvement. |
| `unlist(by, right_id)` | Withdraw an offer. Effective holder only. |
| `burn(from, right_id)` | Destroy your own right. Title holder only, and not while a sub-grant is live, so a week cannot be burned out from under a renter. |

**Unprivileged reads:** `issuer`, `name`, `symbol`, `decimals`, `balance`,
`next_id`, `get_right`, `commitment`, `holder`, `holding`, `holdings`,
`is_active`, `get_listing`.

There is no admin function of any kind — no upgrade, migrate, pause, freeze,
seize, force-transfer, or fee switch.

## What the ledger reveals

Checked against the real transactions, not assumed —
[`npm run check-privacy`](../scripts/check-privacy.ts) fetches each evidence
transaction back from the network and searches the raw bytes of the envelope, the
result, and the meta for every value in the off-chain records.

**Never on chain, confirmed by that check:** owner name, email, resort name,
country, unit, deed reference, registry, record id, salt, and every fee figure.

**Public, deliberately:**

| What | Where | Why it has to be |
| --- | --- | --- |
| Account addresses | Operation parameters, event topics | Pseudonymous. They are who holds what. |
| Right id | Parameters and events | The thing being transferred. |
| Commitment hash | Event data, contract state | The whole point — it is what a verifier matches against. |
| The week's date range and use year | Contract state | An offer has to say what it is offering. Appears in the `meta` layer of any transaction that writes a right's state. |
| A rental's term-end timestamp | Operation parameters | The contract cannot enforce a term it cannot see. A **sale** carries no timestamp at all. |

A **sale** transaction shows, in full: two account addresses, an integer id, `null`,
and a 32-byte hash. Nothing else.

The honest residual: an observer who watches this contract learns that *some
pseudonymous account* holds *a week with these dates* and transferred it to
*another pseudonymous account*. They cannot learn whose week, which resort, which
unit, or anything from the deed or fee history. Correlating an address with a
real identity by other means would reveal that person's week dates — the same
exposure any pseudonymous ledger carries, and worth stating rather than glossing.

## Relationship to SEP-41, and where it diverges

The token interface follows [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md)
with **one systematic substitution**: usage rights are non-fungible, so
`right_id: u64` takes the place of `amount: i128` wherever a specific right must be
named.

Kept verbatim: `name()`, `symbol()`, `decimals()` (which returns `0` — a week is
not a quantity), and `balance(id) -> i128`, which counts the rights an address
holds **title** to. A renter's balance stays `0` while they occupy a week; use
`holder(right_id)` for occupancy.

Diverging, and why:

| SEP-41 | Here | Reason |
| --- | --- | --- |
| `transfer(from, to, amount)` | `transfer(from, to, right_id, expires_at)` | An amount cannot say *which* week moves, and a fungible-looking function that silently picked one would be worse than an honest signature change. The extra parameter carries the sale/rental distinction. |
| `burn(from, amount)` | `burn(from, right_id)` | Same substitution. |
| `approve` / `allowance` / `transfer_from` / `burn_from` | **Absent** | Delegated spending has no role in Phase 1 and none of the four screens needs it. Every function omitted is one less thing to review. |

**This is not a drop-in fungible SEP-41 token, and nothing here claims it is.** A
wallet expecting fungible semantics fails at the type level rather than silently
doing the wrong thing, which is the safer failure. This divergence is a
consequence of modelling non-fungible weeks on a fungible-token interface; it is
flagged here rather than papered over.

## Known limitations

Phase 1 limitations that are deliberate, and stated so nobody discovers them as
surprises:

1. **A week under an active rental cannot be sold** until the term lapses. This
   protects the renter and keeps the chain simple. Real timeshare markets do allow
   sale subject to an existing rental.
2. **No issuer key rotation.** Rotating means redeploying. The trade was a smaller
   privileged surface, which the centralization condition made the priority.
3. **Rights expire with their use year.** After `validity.until`, a right is inert.
   The sample inventory is use-year 2026, so it goes inert on 2027-01-01 and the
   demo will need reseeding after that.
4. **No price anywhere.** Payment, escrow, and settlement of consideration are out
   of scope, so an offer records availability and term only, and the parties settle
   however they already do.
5. **Attestations are files on disk.** Appropriate for a reference deployment and
   it keeps them inspectable; a production issuer would use a database behind
   [the same two functions](../src/lib/attestation-store.ts).
6. **Sub-grant depth is capped at 4.** A resource bound, not a market rule.
7. **The evidence run appends rights.** `npm run evidence` issues its own weeks each
   time rather than reusing the sample inventory, because a sale is permanent and
   reusing them would make the script work once. The registry therefore grows on
   each run.

## What Phase 2 is for

Phase 1 rests on a trusted issuer signature, and that is deliberate — it is not a
gap to be worked around. A verifier today learns that *the issuer asserted* this
week is clean. Phase 2's purpose is to replace that assertion with a cryptographic
proof, so a verifier learns that the week *is* clean without anyone's word.

The structural preparation is that the check lives behind
[one boundary](#the-authorization-boundary). Nothing else has been built toward it,
and nothing in this repository generates or verifies a proof.

**Out of scope for Phase 1, and absent from this repository:** mainnet deployment,
zero-knowledge proof generation or on-chain verification, any custom cryptographic
primitive, a security audit, swaps or multi-party exchange, payment/escrow/
settlement, integration with real resorts, and legal title transfer or contractual
assignment.
