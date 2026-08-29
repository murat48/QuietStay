<img src="./logo.png" alt="QuietStay" width="120" align="right">

# QuietStay — Phase 1

**Rent or sell a timeshare week you cannot use — and let the buyer verify it is
real, without publishing who you are, where the resort is, or what your deed says.**

A timeshare owner who cannot travel this year has no simple way to pass the week on.
Transfers are slow, broker-dependent, and fee-heavy, and a buyer has no way to check
who really holds the week or whether it carries unpaid maintenance fees. QuietStay
puts the week on Stellar so those two checks take seconds — and keeps the deed, the
name, and the address off the ledger while doing it.

**Testnet only.** Phase 1 does not deploy to mainnet and has no switch that would
let it.

| | |
| --- | --- |
| Live app | **[quietstay.vercel.app](https://quietstay.vercel.app)** — verify a week without an account or a wallet |
| Contract | [`CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M`](https://stellar.expert/explorer/testnet/contract/CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M) |
| Network | `Test SDF Network ; September 2015` |
| Contract source | [`contracts/quietstay-rights/src/`](./contracts/quietstay-rights/src/) |
| Tests | [34 unit tests](./contracts/quietstay-rights/src/test.rs) — readable without installing anything; `cd contracts && cargo test` to run them |
| Demo video | **[~2 minutes, end to end](https://youtu.be/7hhtiG_yGFY)** — issue, verify, rent, sell, and a transfer the contract refuses |

## Reviewing this?

Everything is links to open. Nothing to clone, install, or build.

1. **[The demo video](https://youtu.be/7hhtiG_yGFY)**, two minutes — a week issued
   and offered, a counterparty verifying it, a week in arrears failing exactly one
   check, a rental and a sale, and the same transfer refused when the issuer's
   approval is taken out of it. Everything below is that, checkable.
2. **[quietstay.vercel.app/verify](https://quietstay.vercel.app/verify)** — type
   `3` and press verify. Every check runs in your browser against the live contract,
   with no account and nothing installed. Paste the record from
   [`inventory/records/`](./inventory/records/), change one character of it, and
   watch the commitment check fail.
3. **[docs/EVIDENCE.md](./docs/EVIDENCE.md)** — the contract address and four
   transactions, each one a claim you can check in an explorer. Two of the four
   were refused by the contract, which is the point of including them.
4. **[docs/DESIGN.md](./docs/DESIGN.md)** — the protocol, the trust model, and what
   this phase deliberately does not do.

## How it works

The ownership record — deed reference, resort, unit, owner name — stays **off
chain**. The ledger holds a **SHA-256 commitment** to it and an **issuer-signed
attestation** that the week is valid and free of arrears. A buyer verifies exactly
what needs verifying: that the seller is the authorized holder, and that the week is
clean. No document, name, or resort ever reaches the public ledger.

The attestation also carries a **public description** — town and country, bedrooms,
how many it sleeps, what it offers — because a hash covers the whole record, so no
part of it can be revealed on its own. A registry built from the ledger alone could
say *when* a week is and nothing else, and nobody takes a week on those terms. The
line falls at the town: a town shares its name with thousands of owners, while a
resort plus a unit names one apartment. So the resort, the unit, and the deed are
disclosed once, to a buyer, who checks the whole document against the hash.

A completed sale shows on the ledger, in full: two account addresses, an integer id,
`null`, and a 32-byte hash. That is checked against the real chain by
`npm run check-privacy`, not asserted.

Renting and selling are **one contract function**, separated only by whether the
grant has an end date. A rental therefore ends on its own — no return transaction,
and a renter whose term has lapsed is not the holder at all.
[How that works](./docs/DESIGN.md#the-transfer-primitive).

## What the issuer can and cannot do

Phase 1 rests on a trusted issuer signature for *attestation*, and that is
deliberate. But "trusted to attest honestly" must not become "able to take your
week."

**Cannot** — enforced by the contract, not by good behaviour: move, reassign,
freeze, or burn a right someone holds; claw back; overwrite an existing right; or
alter a commitment after issuance.

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
not that it was honest. Closing that is
[Phase 2's whole purpose](./docs/DESIGN.md#what-phase-2-is-for).

## The four screens

| | |
| --- | --- |
| **Issue** | Commit to an ownership record and create the right. The hash is computed in your browser, so it is never a surprise from a server. |
| **List** | The registry as the contract has it — holder, term, standing offers. |
| **Verify** | A counterparty checks a disclosed record and attestation, entirely client-side. |
| **Transfer** | Rent out or sell through one form, with issuer approval — plus a control that submits **without** it, so you can watch the contract refuse. |

Four, deliberately. No dashboards, search, profiles, or admin panels.

Nobody picks a role. Owner, renter, and issuer are **read off the ledger**, and each
lands on different content with a different transfer form — a renter's sell option is
disabled with the reason stated, because the contract would refuse it anyway.
[Details](./docs/DESIGN.md#roles-owner-renter-issuer).

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000 — the landing page needs no configuration
```

Issuing and transferring need keys: see [SETUP.md](./docs/SETUP.md).

```bash
cd contracts && cargo test    # 34 unit tests
npm run e2e                   # end-to-end checks against a running app
npm run check-privacy         # confirm nothing leaked, against the real chain
```

Any Stellar wallet works — **Freighter, xBull, Albedo, Rabet, Lobstr, Hana** —
through [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit).

## Documentation

| | |
| --- | --- |
| [EVIDENCE.md](./docs/EVIDENCE.md) | Contract address, transaction hashes, sample inventory. Start here. |
| [DESIGN.md](./docs/DESIGN.md) | The protocol, the trust model, the enumerated privileged surface, and the boundaries of this phase. |
| [COMMITMENT.md](./docs/COMMITMENT.md) | Canonical serialization, precisely enough to recompute a hash with `sha256sum`. |
| [ATTESTATION.md](./docs/ATTESTATION.md) | Attestation schema, signing key, and the verification procedure. |
| [SETUP.md](./docs/SETUP.md) | Requirements, configuration, every command, troubleshooting. |
| [VERCEL.md](./docs/VERCEL.md) | Deploying it. Environment, the two modes — with the issuer key and without — and where attestations are read from. |
| [inventory/README.md](./inventory/README.md) | The sample weeks, and how to check a commitment with `sha256sum`. |

```
contracts/quietstay-rights/src/
  lib.rs        the contract surface
  auth.rs       the single authorization boundary — Phase 2 substitutes here
  store.rs      storage, TTL, and the holding-chain rules
  types.rs      Right, Holding, Period, Validity, Listing
  events.rs     what may appear on the ledger, and what may not
  test.rs       34 tests
src/lib/        canonical serialization, commitments, attestations, contract client, SEP-10
src/app/        four screens and the API routes
scripts/        deploy, seed, evidence, privacy check, verification CLI, e2e
inventory/      sample records, canonical forms, and attestations
```

## Built on

Ecosystem standards only — **no custom cryptography anywhere in this repository.**

- **SEP-41** token interface, with one documented substitution: `right_id` in place of
  `amount`, because weeks are not fungible. [The divergences are enumerated](./docs/DESIGN.md#relationship-to-sep-41-and-where-it-diverges).
- **SEP-10** wallet authentication, via `WebAuth` from `@stellar/stellar-sdk`.
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

## License

[Apache-2.0](./LICENSE). Copyright 2026 murat48.

Apache rather than MIT for the patent grant: a contributor cannot hand over code and
later assert a patent against the people using it. That matters more than usual for a
repository whose whole subject is a transfer of rights.
