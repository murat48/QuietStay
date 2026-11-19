# QuietStay Phase 3 — Progress log

This file is updated at the end of every step in `docs/PHASE3_PROMPT.md`.
Each new session reads it before starting work. Keep entries short and
factual: every hash, address and number must come from a command that was
actually run.

## Sprint

- SOW approved on: _(date)_
- Sprint ends on: _(approval date + 30 days)_
- Current step: Step 1, revised after the first review. Waiting for approval of D4, D5 and D12

## Open issues

| Severity | Issue | Found in step | Status |
| --- | --- | --- | --- |
| High | D2: browser proving puts GPL-3.0 code in the browser | 1 | resolved: approved; LICENSE in `prover-worker/` + in-app notice (spec §2) |
| High | D6: who pays fees for passkey txs | 1 | resolved: approved with conditions (spec §13) |
| High | D12: the fee route may sign only QuietStay calls, but a standalone USDC `approve` calls USDC; proposal: offers set the allowance by sub-invocation | 1 (review) | open, needs approval |
| Medium | Analytics could report full URLs including `#` fragments of sealed record links; `/receive` strips them and the no-leak test must cover it | 1 (review) | open, Step 2 |
| Medium | Stellar CLI 27.0.0 warns on testnet protocol 30; upgrade to 30.0.1 before Step 2 | 1 | open |
| Low | Mainnet RPC is not configured in the CLI (`stellar network ls -l`: "Bring Your Own"); Step 1 read settings via `--rpc-url https://mainnet.sorobanrpc.com` | 1 | open |

Severity: Critical (blocks mainnet), High, Medium, Low.

## Approved decisions

Decisions I approved at checkpoints. Do not reopen them unless something
breaks.

- 2026-11-19, D1: bind G or C addresses with a kind tag in `hi`
  (G = 0, C = 1); no circuit change. Conditions: no range check confirmed;
  C-holder end-to-end test added; contract-level test in Step 2. Stop if a
  circuit change turns out to be needed.
- 2026-11-19, D2: the GPL-3.0 prover lives only in a separate worker, with a
  LICENSE file in the worker folder and an in-app license notice.
- 2026-11-19, D6:
  - Testnet fee route: signs only QuietStay calls or smart-wallet deployment,
    is rate-limited, and its key has no other role.
  - Mainnet: a CLI signing script, with an auth-entry expiry long enough to
    sign and submit by hand.

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
- Open: D4, D5, D12 waiting for approval. D3 and D7–D11 are shown in full in
  the spec's decisions table.

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
