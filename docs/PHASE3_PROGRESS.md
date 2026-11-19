# QuietStay Phase 3 — Progress log

This file is updated at the end of every step in `docs/PHASE3_PROMPT.md`.
Each new session reads it before starting work. Keep entries short and
factual: every hash, address and number must come from a command that was
actually run.

## Sprint

- SOW approved on: _(date)_
- Sprint ends on: _(approval date + 30 days)_
- Current step: Step 1 approved (third review, 2026-11-19). Step 2 starts in a new session

## Open issues

| Severity | Issue | Found in step | Status |
| --- | --- | --- | --- |
| High | D2: browser proving puts GPL-3.0 code in the browser | 1 | resolved: approved; LICENSE in `prover-worker/` + in-app notice (spec §2) |
| High | D6: who pays fees for passkey txs | 1 | resolved: approved with conditions (spec §13) |
| High | D12: how the allowance is given | 1 (review) | resolved: approved, set by the offer calls; DESIGN.md documents the leftover allowance |
| Medium | D4a: record-before-offer vs key hash in the offer | 1 (review 2) | resolved: option 1 approved with three additions (review 3) |
| Medium | Upstash connection and plan | 1 (review 2) | resolved: you confirmed `upstash-kv-cobalt-pillow` (Upstash for Redis) is connected and on the Free plan (Vercel dashboard, 2026-11-19) |
| Medium | Sealed-link page must load no analytics: separate root layout for `/receive`, no-leak test checks analytics endpoints | 1 (review 2) | open, Step 2 |
| Medium | Stellar CLI 27.0.0 warns on testnet protocol 30; upgrade to 30.0.1 before Step 2 | 1 | open |
| Low | Mainnet RPC is not configured in the CLI (`stellar network ls -l`: "Bring Your Own"); Step 1 read settings via `--rpc-url https://mainnet.sorobanrpc.com` | 1 | open |

Severity: Critical (blocks mainnet), High, Medium, Low.

## Approved decisions

Decisions I approved at checkpoints. Do not reopen them unless something
breaks. Full text: `docs/PHASE3_SPEC.md`, "Decisions".

All of these were approved on 2026-11-19: D1, D2 and D6 at the first review
of the spec, the rest at the second review of `def5eb6`.

- **D1.** Bind G or C addresses with a kind tag in `hi` (G = 0, C = 1); no
  circuit change. The circuit has no range check (confirmed), and the C-holder
  proof was verified off-chain and on chain. The contract-level C-address test
  is in Step 2. Stop if a circuit change turns out to be needed.
- **D2.** The GPL-3.0 prover lives only in a separate worker, with a `LICENSE`
  file in `prover-worker/` and an in-app license notice.
- **D3.** The first record reaches the holder through the sealed link: no
  file, no server storage, no backup export. A lost browser means a lost
  ability to prove (known limitation).
- **D4.** Offers carry `h'`. The buyer receives and checks the sealed record
  against the current on-chain `C` **before** creating an offer. The buyer's
  encryption-key hash is bound on chain, and the seller's browser checks the
  link key against it before encrypting. No analytics at all on the receiving
  page. The ordering detail is D4a, still to confirm.
- **D5.** Three-step swap (offer, accept with the taker's proof stored,
  complete verifies both). No lock between accept and complete, the taker can
  withdraw, and complete re-checks everything.
- **D6.** Testnet fee route: QuietStay calls or smart-wallet deployment only,
  rate-limited, and its key has no other role. Mainnet: a CLI signing script
  with an auth-entry expiry of about 720 ledgers.
- **D7.** `max_payment` is a constructor argument, so the WASM hash is
  identical on both networks: 1 USDC on mainnet, 100 USDC on testnet. A script
  checks the 5 USDC total before each mainnet transaction.
- **D8.** Versions as in spec §12.
- **D9.** Offer lifetime ≤ 120,960 ledgers.
- **D10.** Evidence hashes in the escrow entry, ≤ 4 per party, plus the
  decision hash, plus events.
- **D11.** Keep `transfer` and `burn`. `burn` is refused while the right is
  rented out, has a Funded or Disputed escrow, or has a pending swap
  acceptance, with a test for each.
- **D12.** The offer calls set the allowance; it equals the sum of the
  buyer's open offers. Leftover from offers that expired on their own cannot
  be pulled (documented in DESIGN.md). The Step 3 allowance tests apply.
- **D4a** (third review). On-chain `request_record` comes before the offer;
  the offer copies the key hash and consumes the request.
  1. Swaps use the same request and sealed-record flow in both directions,
     and complete only after both sides have checked the other's record.
     Rentals don't use requests.
  2. Requests expire within the D9 limit and are capped at 10 live per
     requester.
  3. A request creates no obligation for the seller.
- **Checklist.** The contracts are built and tested for mainnet protocol 29
  with no protocol-30-only features, and re-checked if mainnet upgrades during
  the sprint.

## Pilot limits

- Max single mainnet payment: 1 USDC
- Max USDC held across all pilot accounts: 5 USDC

## Addresses

| Item | Testnet | Mainnet | Source / command |
| --- | --- | --- | --- |
| Rights contract | | | |
| Other contracts (if any) | | | |
| USDC contract | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | Circle issuers (developers.circle.com/stablecoins/usdc-contract-addresses) → `stellar contract id asset --asset USDC:<issuer>` |
| Arbiter account | | | |
| Smart wallet (passkey) | | | |
| WebAuthn verifier (OZ, via kit) | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` | smart-account-kit deployment manifests; to check on chain in Step 2 |
| Measurement contract (Step 1 only) | `CCKL74S5L57GZ32K2AWIIRGKNED3CZNWFCM62BMVASLMSHJXOYK4ZLY4` | — | `stellar contract deploy … quietstay_measure.wasm` |
| Wasm hash (must match) | | | |
| App link | | | |

## Step log

### Step 0 — Current state
- Date: 2026-11-19
- Branch / commit: `main` @ `66cdf13`
- Summary:
  - No Phase 3 code exists. Only PHASE3_PROMPT.md and this file; the side
    branches hold UI and Phase 1 work only.
  - Contract `quietstay-rights` (soroban-sdk 27.0.6), public functions:
    `__constructor(issuer, name, symbol, verification_key)`, `name`, `symbol`,
    `decimals`, `balance`, `issue` (issuer only, fresh ids), `list`, `unlist`,
    `get_listing`, `transfer(from, to, right_id, expires_at, proof,
    public_signals)` (sale if `expires_at = None`, rental otherwise), `burn`,
    and views `issuer`, `next_id`, `get_right`, `commitment`, `holder`,
    `holding`, `holdings`, `is_active`. No upgrade, no admin, the
    verification key is fixed. Plus the standalone `quietstay-verifier`
    (`verify` only).
  - Circuit public inputs (11, in order): commitment, nullifier, right_id,
    from_hi, from_lo, to_hi, to_lo, mode (0 = sale, else the rental end),
    expiry_ledger, next_secret_hash, next_commitment.
  - Account binding: `C = Poseidon5(d_hi, d_lo, from_hi, from_lo, h)` over the
    G-account's 32-byte Ed25519 key, split at byte 16. `auth.rs` reads the key
    with `Address::to_payload()` and refuses C-addresses (`NotAnAccount`).
    `issue` refuses them too.

### Step 1 — Phase 3 specification
- Date: 2026-11-19
- Branch / commit: `phase3` (from `main` @ `66cdf13`); commit in the git log
- Done:
  - `docs/PHASE3_SPEC.md`: plain-language page, items 1–12, decisions D1–D11.
  - Measurement-only contract `contracts/quietstay-measure` (verifier.rs
    included by path, `verify_two`).
- Measured:
  - Two Phase 2 proofs verified in one simulated tx (`--send=no`):
    **171,992,473** instructions (43.0% of 400 M), minimum resource fee
    61,546 stroops, 0/0 ledger bytes read/written. Measured through RPC
    `simulateTransaction` on testnet, ledger 5,811,197.
  - Local budget: 150,094,049 instructions, **648,933 bytes** of memory (1.5%
    of 40 MiB). Command: `cargo test -p quietstay-measure -- --nocapture`.
  - Estimated integrated swap: ~175–180 M instructions (~45%), so it fits.
  - Testnet runs protocol 30 and mainnet protocol 29. Both: 400 M
    instructions, 41,943,040 bytes memory, 131,072-byte WASM, max entry TTL
    3,110,400. Min persistent / temporary TTL: testnet 120,960 / 720,
    mainnet 2,073,600 / 17,280.
- Tx hashes:
  - Measurement contract deployed: `5ffde55c074ad7a5e8c2daebbd9645b7dbdf86c43bfec1405fee8f6300b574aa` (testnet).
- Review 1 (2026-11-19), changes made:
  - D1: confirmed the circuit has no range check on the account halves.
    Added `circuits/test/c-address.test.ts`, which proves and verifies with the
    unchanged keys for a C holder (sale, rental) and a C recipient, and also
    checks G/C separation and that the untagged encoding is refused.
    `npm run zk:test`: 18/18 pass.
  - C-holder proof checked on chain by simulating the Phase 2 verifier
    `CDMUMM…K5BK`: `true`; a tampered signal gives `false`.
  - D4: the salt is confirmed (32 random bytes in the record, so 256 bits in
    `d`). Added the sealed-link delivery of the record (URL fragment, ECDH
    P-256 + AES-GCM, no files, no server storage).
  - D5: confirmed no lock between accept and complete; the taker can withdraw;
    `complete_swap` re-runs every check.
  - D6: specified the testnet fee-route allowlist, rate limits and key
    isolation, and the mainnet CLI script with a ~720-ledger auth expiry
    (spec §13).
  - Checklist additions: mainnet protocol 29, no protocol-30-only features,
    re-check on upgrade (spec §14). The Phase 2 and measurement WASMs declare
    env-meta `Protocol: v27`.
- Approved decisions:
  - D1 (with conditions: done above; contract-level C-address test in Step 2).
  - D2 (LICENSE file + in-app notice).
  - D6 (with conditions in spec §13).
- Review 2 (2026-11-19), changes made:
  - Spec: record-before-offer order, with the key hash bound by on-chain
    `request_record` and copied into the offer.
  - `/receive` in its own root layout with no analytics.
  - `max_payment` as a constructor argument, so one WASM serves both
    networks.
  - `burn` guards and their tests.
  - The D12 allowance model, with a per-buyer index of at most 10 offers.
  - DESIGN.md: the leftover-allowance rule.
- Approved decisions: all of D1–D12 (see "Approved decisions" above).
- Review 3 (2026-11-19):
  - D4a approved (option 1 plus three additions), recorded in the spec
    (§2, §4, §7, §9, §10, Decisions).
  - Upstash confirmed connected and on the Free plan.
- Open: none for Step 1. Step 2 starts in a new session.

### Step 2 — Browser proofs, reusable transfer check, passkeys
- Date:
- Branch / commit:
- Done:
- Measured (proof times):
- Tx hashes:
- Open:

### Step 3 — USDC sale, rental escrow and pilot arbiter
- Date:
- Branch / commit:
- Done:
- Tx hashes:
- Open:

### Step 4 — Swap and two-proof cost measurement
- Date:
- Branch / commit:
- Measured (CPU, memory, fee, % of limits):
- Decision (mainnet or testnet only):
- Tx hashes:
- Open:

### Step 5 — Pre-launch checklist
- Date:
- Branch / commit:
- Result:
- GO / NO-GO (mine):

### Step 6 — Mainnet deployment
- Date:
- Branch / commit:
- Contract addresses:
- Tx hashes:
- Open:

### Step 7 — Mainnet pilot, evidence and documentation
- Date:
- Branch / commit:
- Tx hashes:
- Docs updated:
- Open:
