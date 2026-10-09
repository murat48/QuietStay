<img src="./logo.png" alt="QuietStay" width="150" align="right">
<br>

# QuietStay — Phase 2

**Rent or sell a timeshare week you cannot use — and let the buyer verify it is
real, without publishing who you are, where the resort is, or what your deed says.**

A timeshare owner who cannot travel this year has no simple way to pass the week on.
Transfers are slow, broker-dependent, and fee-heavy, and a buyer has no way to check
who really holds the week or whether it carries unpaid maintenance fees. QuietStay
puts the week on Stellar so those checks take seconds, and keeps the deed, the name
and the address off the ledger while doing it.

**Phase 2: every rental and sale is authorized by a zero-knowledge proof the
contract verifies on chain — Groth16 over BLS12-381 — and by nobody's permission.**
The issuer, which approved every transfer in Phase 1, has no part in them any more.

**Testnet only.** There is no mainnet configuration and no switch that would add one.

| | |
| --- | --- |
| Live app | **[quietstay.vercel.app](https://quietstay.vercel.app)** — verify a week without an account or a wallet |
| Contract | [`CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD`](https://stellar.expert/explorer/testnet/contract/CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD) — proof-gated transfers, verification key fixed at deployment |
| Network | `Test SDF Network ; September 2015` |
| The proof | [CIRCUIT.md](./docs/CIRCUIT.md) — opens with a one-page summary; circuit in [`circuits/gpl/transfer.circom`](./circuits/gpl/transfer.circom) |
| Tests | [62 contract tests](./contracts/quietstay-rights/src/test.rs), every transfer carrying a real proof · 11 circuit tests · 73 end-to-end checks |
| Demo video, Phase 2 | _add link after recording_ |

## Reviewing this?

Everything is links to open. Nothing to clone, install, or build.

1. **[docs/EVIDENCE.md](./docs/EVIDENCE.md)** — opens with Phase 2, week by week.
   Seven transactions on the final contract: a rental and a sale authorized by a
   proof, and five the contract **refused** — a tampered proof, a replayed one, one
   presented by the wrong account, one carrying the holder's and the issuer's
   signatures but no proof, and the issuer trying to move a held week to itself. Each
   is listed with the error code the ledger recorded and what to look for in the
   explorer.
2. **[quietstay.vercel.app/verify](https://quietstay.vercel.app/verify)** — no
   account. Type a week number and press Verify:
   - **`3`** — rented out by proof on 9 October. The issuer's attestation checks
     pass, the holder is the renter until 28 November, and *Verified on chain*
     lists the rental's transaction.
   - **`1`** — sold by proof the same day. The holder is the buyer, and the
     commitment is now one only the buyer can prove against.
   - **`4`** — a week in arrears: exactly one check fails, *fees current*. Under
     Phase 2 that warns a buyer and stops nothing.

   On **Verify JSON**, paste [`inventory/records/week-03.json`](./inventory/records/week-03.json)
   for week 3: the browser computes its SHA-256 and matches what the issuer
   attested. Change one character inside a value — the unit, say — and that check
   fails.

   *Verified on chain* reads the contract's events, which the network keeps for
   about a week. After that it says so, and the explorer links in EVIDENCE.md are
   the permanent record.
3. **[docs/CIRCUIT.md](./docs/CIRCUIT.md)** — one page on what the proof reveals,
   hides and prevents, then every detail, and the measured cost: about 80 million
   instructions per transfer, a fifth of testnet's limit.
4. **[docs/DESIGN.md](./docs/DESIGN.md#the-trust-model-phase-1-and-phase-2)** — what
   the issuer could do in Phase 1 and can do now, side by side.

**Phase 1** stays checkable as delivered: its contract,
[`CC3URR3U…`](https://stellar.expert/explorer/testnet/contract/CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M),
and its transactions are in the second half of
[EVIDENCE.md](./docs/EVIDENCE.md#phase-1), with every source link pinned to the last
Phase 1 commit, [`a1b8ad2`](https://github.com/murat48/QuietStay/tree/a1b8ad2edf2953dac7216d36a49d2fb56c47b4b8).
Its demo video: **[~3 min](https://youtu.be/7hhtiG_yGFY)**.

## How it works

The ownership record — deed reference, resort, unit, owner name — stays **off
chain**. Its SHA-256, `d`, is what the issuer attests. What the ledger holds is a
**commitment** `C = Poseidon(d, holder, h)`, where `h` is the hash of a secret only
the holder has.

To rent the week out or sell it, the holder runs the prover on their own machine and
gets a **proof** that they know that secret, bound to this exact transfer: this
week, this recipient, sale or rental and its end, a deadline about an hour away, and
a one-time nullifier. The contract checks every public value against its own state,
verifies the proof, and records the nullifier so it cannot be used twice. A sale
also replaces `C` with one the proof computed for the buyer, from a secret the buyer
chose — so only the buyer can prove next.

**What leaves whose machine.** "The record and the secret never leave the holder's
machine" is a claim about *proving*: the prover runs there, and nothing it reads is
sent anywhere. Issuing is different, and always has been since Phase 1: the record
goes to the issuer, who validates it, computes `d` and attests it. What Phase 2 adds
to the issuer's side is only `h`, from which the issuer's server computes `C`. The
secret `s` reaches the server at no stage.

Renting and selling are **one contract function**, separated by whether the grant
has an end date. A rental ends on its own: no return transaction, and a renter whose
term has lapsed is not the holder at all.

A completed sale shows on the ledger: two account addresses, an integer id, `null`,
a proof, its public values, and opaque 32-byte commitments. `npm run check-privacy --
--phase2` searches every Phase 2 transaction for each record's contents, its `d`,
and each owner's secret and secret hash, and finds none.

## What the issuer can and cannot do

**Cannot** — enforced by the contract: move, reassign, freeze or burn a week someone
holds; approve or block a transfer, which it has no part in; overwrite a right or
alter a commitment; change the contract's code — **`upgrade` is gone**, so the code
deployed is the code that runs; or replace the verification key, which is fixed at
deployment.

Demonstrated on chain, in [EVIDENCE.md](./docs/EVIDENCE.md#phase-2-the-seven-transactions):
the issuer trying to move a held week to itself, and a transfer signed by the holder
*and* the issuer but carrying no proof — both refused.

**Can, stated rather than glossed over:** issue new weeks, and attest falsely about a
week's fees. The attestation is shown to buyers and decides nothing, so a false one
misleads but cannot move or freeze a week. The proving keys come from a
**development trusted setup, non-production**: whoever ran it could forge a proof,
which still could not move a week without the holder's wallet signature. A production
ceremony is Phase 3. [The full table](./docs/DESIGN.md#the-trust-model-phase-1-and-phase-2).

## The four screens

| | |
| --- | --- |
| **Issue** | The issuer creates a week from a record. The page computes `d`; the commitment `C` comes from the command line, from the owner's `h` — the issuer never learns the secret. |
| **List** | The registry. Ask to rent or buy a listed week — asking to buy carries your consent to the sale, signed by your wallet. The holder sees the exact prove command for each ask. |
| **Verify** | Check a week: the attestation against the record's `d`, the holder, and the proofs the contract accepted. No account needed. |
| **Transfer** | *Prove ownership*: upload the `transfer.json` the prover wrote, and sign. |

Four, deliberately. No dashboards, search, profiles, or admin panels. Roles are read
off the ledger — a renter is shown why there is nothing to transfer, because only
the title holder has the secret. [Details](./docs/DESIGN.md#roles-owner-renter-issuer).

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000 — the landing page needs no configuration
```

Issuing and transferring need keys and the proving tools: see [SETUP.md](./docs/SETUP.md).

```bash
cd contracts && cargo test         # 62 + 6 contract tests, real proofs
npm run zk:compile && npm run zk:test   # the circuit, 11 tests
npm run zk:check-poseidon          # where the Poseidon constants came from, checked
npm run zk:secret -- my.json       # make a record secret; prints the shareable h
npm run zk:prove -- …              # prove a transfer; writes transfer.json
npm run check-privacy -- --phase2  # confirm nothing leaked, against the real chain
```

Wallets: **Freighter, xBull, Albedo, Rabet, Hana**, through
[Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit). Asking to
*buy* needs a wallet that signs authorization entries — Freighter or Hana.

## Documentation

| | |
| --- | --- |
| [EVIDENCE.md](./docs/EVIDENCE.md) | Every transaction, Phase 2 then Phase 1, with what to look for. Start here. |
| [CIRCUIT.md](./docs/CIRCUIT.md) | The proof: one-page summary, specification, Poseidon parameters and their provenance, the trusted setup, and measured cost. |
| [DESIGN.md](./docs/DESIGN.md) | The protocol, the trust model in Phase 1 and Phase 2, the privileged surface, known limitations. |
| [COMMITMENT.md](./docs/COMMITMENT.md) | The record's canonical form and `d`, and how `d` becomes the on-chain `C`. |
| [ATTESTATION.md](./docs/ATTESTATION.md) | Attestation schema v2 — bound to `d`, the right and the contract — and its verification. |
| [SETUP.md](./docs/SETUP.md) | Requirements, tool versions, every command, the end-to-end test. |
| [VERCEL.md](./docs/VERCEL.md) | Deploying the app. |
| [inventory/README.md](./inventory/README.md) | The sample weeks. |

```
contracts/quietstay-rights/src/
  lib.rs        the contract surface
  auth.rs       the single authorization boundary — the proof check
  verifier.rs   the Groth16 pairing check (soroban-examples)
  store.rs      storage, TTL, and the holding-chain rules
  events.rs     what may appear on the ledger, and what may not
  test.rs       62 tests
contracts/quietstay-verifier/   the standalone verifier measured in Step 2
circuits/gpl/   the circuit, Poseidon, and the JavaScript Poseidon — GPL-3.0
circuits/       Poseidon provenance, keys, circuit tests
scripts/        prover, setup, evidence, privacy check, verification CLI, e2e
src/            the web app: four screens and their API routes
inventory/      sample records; phase2/ holds the Phase 2 issuance and attestations
```

## Built on

Ecosystem standards and audited building blocks — **no custom cryptography.**

- **Groth16 over BLS12-381**, verified with Soroban's native BLS12-381 host functions
  (CAP-0059), from [soroban-examples' verifier](https://github.com/stellar/soroban-examples/tree/main/groth16_verifier).
- **circom 2.2.2 + circomlib** for the circuit, **snarkjs 0.7.5** for the setup and the
  prover. **Poseidon** with constants for BLS12-381 generated by the Poseidon
  authors' reference tooling — [how, and checked](./docs/CIRCUIT.md#poseidon-parameters-over-bls12-381).
- **SEP-41** token interface, with `right_id` in place of `amount`
  ([divergences](./docs/DESIGN.md#relationship-to-sep-41-and-where-it-diverges)).
- **SEP-10** wallet authentication, via `WebAuth` from `@stellar/stellar-sdk`.
- **Soroban authorization** for the holder's signature and the buyer's consent.
- **RFC 8785** canonical JSON and **SHA-256** (WebCrypto) for `d`; **Ed25519**
  (`Keypair.sign`) for attestations.

`soroban-sdk` 27.0.6 · `stellar-cli` 27.0.0 · `@stellar/stellar-sdk` 16.2.0 ·
`@creit.tech/stellar-wallets-kit` 2.5.0 · Next.js 16 · Node 24

## Out of scope for Phase 2

Absent from this repository: mainnet deployment, a security audit, a production
trusted-setup ceremony, in-browser proving, selective disclosure, any new
cryptographic primitive, swaps between owners, payment and escrow, real resorts and
legal title transfer, and passkey login.

Sample inventory is fictional. Names, resorts, unit numbers, and deed references were
made up for the demo.

## License

[Apache-2.0](./LICENSE). Copyright 2026 murat48.

Apache rather than MIT for the patent grant: a contributor cannot hand over code and
later assert a patent against the people using it. That matters more than usual for a
repository whose whole subject is a transfer of rights.

One directory is the exception. [`circuits/gpl/`](./circuits/gpl/) — the ownership
circuit, the circomlib Poseidon template it includes, iden3's constant optimizer and
the JavaScript Poseidon the prover uses — derives from iden3's circomlib and
circomlibjs, and is **GPL-3.0** with its own [LICENSE](./circuits/gpl/LICENSE). It
serves the command-line tools and one server route: `/api/issue` imports the same
Poseidon module to compute the commitment `C` when the issuer issues a week. That
route runs on the issuer's server and is never sent to a browser.

**The browser bundle contains no GPL-3.0 code at all.** No page or browser module
imports `circuits/gpl/` or any iden3 package — the one file under `src/` that does
is that route handler, which nothing imports — and no copyleft package the app
depends on reaches `.next/static`. That includes the Lobstr wallet module, whose signer
library is GPL-3.0: Phase 1 shipped it, and Phase 2 removed it, which is why the
app offers five wallets rather than six. `npm run build && npm run zk:check-bundle`
checks all of this against the built bundle.
