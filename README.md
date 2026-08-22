# QuietStay — Phase 1

A marketplace for tokenized vacation usage rights on Stellar. Rent or sell a
timeshare week you cannot use, and let a buyer verify it — without publishing who
you are, where the resort is, or what your deed says.

**Testnet only.** Phase 1 does not deploy to mainnet and has no switch that would
let it.

| | |
| --- | --- |
| Contract | [`CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M`](https://stellar.expert/explorer/testnet/contract/CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M) |
| Network | `Test SDF Network ; September 2015` |
| Contract source | [`contracts/quietstay-rights/src/`](./contracts/quietstay-rights/src/) |
| Tests | 32 unit tests — `cd contracts && cargo test` |
| Demo video | _add link after recording — see [DEMO_SCRIPT.md](./docs/DEMO_SCRIPT.md)_ |

**Reviewing this?** Start at [**docs/EVIDENCE.md**](./docs/EVIDENCE.md). It is links
to open — a contract address and four transactions. Nothing to clone or build.

---

## The idea

A timeshare owner who cannot travel in a given year has no simple way to rent or sell
that week. Transfers are slow, broker-dependent, and fee-heavy, and a buyer cannot
easily verify who really holds the week or whether it carries unpaid maintenance fees.
A public ledger fixes the trust problem and creates a new one: ownership history and
travel schedules become visible to everyone.

So the record stays off chain. The ledger holds a **SHA-256 commitment** to it, plus
an **issuer-signed attestation** that the week is valid and free of arrears. A buyer
verifies exactly what needs verifying — that the seller is the authorized holder, and
that the week is clean — and no document, name, or resort ever reaches the public
ledger.

The attestation also carries a **public description** — town and country, bedrooms,
how many it sleeps, what it offers — because a hash covers the whole record and so
no part of it can be revealed on its own. A registry built from the ledger alone can
say when a week is and nothing else, and nobody takes a week on those terms. The
line falls at the town: a town shares its name with thousands of owners, while a
resort plus a unit names one apartment. So the resort, the unit and the deed are
disclosed once, to a buyer, who checks the whole document against the hash.

A successful sale transaction shows, in full: two account addresses, an integer id,
`null`, and a 32-byte hash. That is checked against the real chain by
`npm run check-privacy`, not asserted.

## One transfer primitive

```rust
transfer(from, to, right_id, expires_at: Option<u64>)
```

- `expires_at = None` → open-ended. A **sale**.
- `expires_at = Some(t)` → lapses at `t`. A **rental**.

Not two code paths. A right holds a chain of holdings — open-ended title at the
bottom, finite grants above it — and a grant either replaces the chain or extends it.
The chain is re-evaluated against the ledger clock on every read, so **a rental ends
on its own**: no return transaction, and a renter whose term expired is not the holder
at all.

Two rules fall out of that and are enforced on every grant: nobody can grant a longer
term than they hold (so a renter cannot sell), and only the effective holder can
transfer (so a week cannot be sold out from under an active renter).

## What the issuer can and cannot do

Phase 1 rests on a trusted issuer signature for *attestation*, and that is deliberate.
But "trusted to attest honestly" must not become "able to take your week."

**Cannot** — enforced by the contract, not by good behaviour: move, reassign, freeze,
or burn a right someone holds; claw back; overwrite an existing right; or alter a
commitment after issuance.

Demonstrated on chain: the issuer builds, signs, and pays for a transfer of a held
right to itself, and the contract rejects it. Hash in
[EVIDENCE.md](./docs/EVIDENCE.md).

**One qualifier, stated up front:** the contract has an `upgrade` function, so that
list describes the code running now rather than a permanent guarantee — a version
the issuer deploys through it could add any of those powers. It publishes an event
so no upgrade is silent, and it does not touch stored state, but the holder has no
veto and there is no timelock. The reasoning, and what was traded for what, is in
[DESIGN.md](./docs/DESIGN.md#the-qualifier-that-governs-that-whole-table-upgrade).

**Can, and this is stated rather than glossed over:** decline a transfer it should
have approved, and attest falsely. Verification proves the issuer *said* something,
not that it was honest. Closing that is [Phase 2's whole purpose](./docs/DESIGN.md#what-phase-2-is-for).

## The four screens

| | |
| --- | --- |
| **Issue** | Commit to an ownership record and create the right. The hash is computed in your browser, so it is never a surprise from a server. |
| **List** | The registry as the contract has it — holder, term, standing offers. |
| **Verify** | A counterparty checks a disclosed record and attestation, entirely client-side. |
| **Transfer** | Rent out or sell through one form, with issuer approval — plus a control that submits **without** it, so you can watch the contract refuse. |

Four, deliberately. No dashboards, search, profiles, or admin panels.

## Owner, renter, issuer — different entries, same four screens

Roles are **read off the ledger, never declared** — there is no "I am an owner"
selector anywhere, because a self-declared role would only earn an on-chain
rejection after a fee.

| Role | Turkish | Derived from | May |
| --- | --- | --- | --- |
| Issuer | ihraççı | equals `issuer()` on the contract | issue, attest, approve or decline |
| Owner | kiraya veren | holds **title** to a week | rent it out for a term, or sell it |
| Renter | kiracı | holds a week on a **finite term** | sublet within that term; **not** sell |
| Visitor | ziyaretçi | holds nothing | browse and verify — no account needed |

Not exclusive: owning one week and renting another makes you both, and the app shows
both. An owner and a renter land on different content, see different nav, and get a
different transfer form — the renter's sell option is disabled with the reason
stated, and their date picker stops at their own checkout.

None of this grants anything. Every limit is enforced again server-side and again on
chain; the role layer exists so a refusal arrives before a signature.
[Details](./docs/DESIGN.md#roles-owner-renter-issuer).

## Wallets

Any Stellar wallet, through
[Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit):
**Freighter, xBull, Albedo, Rabet, Lobstr, Hana.**

The six modules are named explicitly rather than using `allowAllModules()`. That
helper also pulls in WalletConnect, Trezor, Ledger, and HOT, which drag
`@coinbase/cdp-sdk`, `@trezor/connect`, and `elliptic` into the tree — code this app
never runs, some of it carrying published advisories. Naming the modules keeps it out
of the bundle rather than shipping it and hoping nobody reaches it; `grep` the build
output and none of those names appear. Adding hardware or WalletConnect support is
one import each, as a deliberate decision.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000/list — reads need no configuration
```

Issuing and transferring need keys: see [SETUP.md](./docs/SETUP.md).

```bash
cd contracts && cargo test    # 32 unit tests
npm run e2e                   # 24 checks against a running app
npm run check-privacy         # confirm nothing leaked, against the real chain
```

## Documentation

| | |
| --- | --- |
| [EVIDENCE.md](./docs/EVIDENCE.md) | Contract address, transaction hashes, sample inventory. Start here. |
| [DESIGN.md](./docs/DESIGN.md) | The protocol, the trust model, the enumerated privileged surface, and the boundaries of this phase. |
| [COMMITMENT.md](./docs/COMMITMENT.md) | Canonical serialization, precisely enough to recompute a hash with `sha256sum`. |
| [ATTESTATION.md](./docs/ATTESTATION.md) | Attestation schema, signing key, and the verification procedure. |
| [SETUP.md](./docs/SETUP.md) | Requirements, configuration, every command, troubleshooting. |
| [DEMO_SCRIPT.md](./docs/DEMO_SCRIPT.md) | Shot list and narration for the ~2 minute video. |
| [inventory/README.md](./inventory/README.md) | The sample weeks, and how to check a commitment with `sha256sum`. |

## Layout

```
contracts/quietstay-rights/src/
  lib.rs        the contract surface
  auth.rs       the single authorization boundary — Phase 2 substitutes here
  store.rs      storage, TTL, and the holding-chain rules
  types.rs      Right, Holding, Period, Validity, Listing
  events.rs     what may appear on the ledger, and what may not
  test.rs       32 tests
src/lib/        canonical serialization, commitments, attestations, contract client, SEP-10
src/app/        four screens and the API routes
scripts/        deploy, seed, evidence, privacy check, verification CLI, e2e
inventory/      sample records, canonical forms, and attestations
```

## Built on

Ecosystem standards only — no custom cryptography anywhere in this repository.

- **SEP-41** token interface, with one documented substitution: `right_id` in place of
  `amount`, because weeks are not fungible. [The divergences are enumerated](./docs/DESIGN.md#relationship-to-sep-41-and-where-it-diverges).
- **SEP-10** wallet authentication, via `WebAuth` from `@stellar/stellar-sdk`.
- **Stellar Wallets Kit** for multi-wallet connection and signing.
- **SEP-8**'s approval model for issuer-approved transfers, expressed with Stellar's
  native Soroban authorization rather than a bespoke scheme.
- **RFC 8785** (JSON Canonicalization) for commitments, via the `canonicalize`
  package. SHA-256 from WebCrypto; Ed25519 from `Keypair.sign`/`verify`.

`soroban-sdk` 27.0.6 · `stellar-cli` 27.0.0 · `@stellar/stellar-sdk` 16.2.0 ·
`@creit.tech/stellar-wallets-kit` 2.5.0 · Next.js 16 · Node 24

## Out of scope for Phase 1

Absent from this repository, not merely unused: mainnet deployment, zero-knowledge
proof generation or verification, any custom cryptographic primitive, a security
audit, swaps or multi-party exchange, payment/escrow/settlement of consideration,
integration with real resorts, and legal title transfer or contractual assignment.

Sample inventory is fictional. Names, resorts, unit numbers, and deed references were
made up for the demo.
