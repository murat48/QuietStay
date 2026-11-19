# QuietStay Phase 3 — Progress log

This file is updated at the end of every step in `docs/PHASE3_PROMPT.md`.
Each new session reads it before starting work. Keep entries short and
factual: every hash, address and number must come from a command that was
actually run.

## Sprint

- SOW approved on: _(date)_
- Sprint ends on: _(approval date + 30 days)_
- Current step: Step 2 checkpoint (2026-11-19), waiting for your review

## Open issues

| Severity | Issue | Found in step | Status |
| --- | --- | --- | --- |
| High | D2: browser proving puts GPL-3.0 code in the browser | 1 | resolved: approved; LICENSE in `prover-worker/` + in-app notice (spec §2) |
| High | D6: who pays fees for passkey txs | 1 | resolved: approved with conditions (spec §13) |
| High | D12: how the allowance is given | 1 (review) | resolved: approved, set by the offer calls; DESIGN.md documents the leftover allowance |
| Medium | D4a: record-before-offer vs key hash in the offer | 1 (review 2) | resolved: option 1 approved with three additions (review 3) |
| Medium | Upstash connection and plan | 1 (review 2) | resolved: you confirmed `upstash-kv-cobalt-pillow` (Upstash for Redis) is connected and on the Free plan (Vercel dashboard, 2026-11-19) |
| Medium | Sealed-link page must load no analytics: separate root layout for `/receive`, no-leak test checks analytics endpoints | 1 (review 2) | resolved 2026-11-19: `(sealed)` root layout; checked by e2e/no-leak.spec.ts |
| High | **Passkey sign-in.** The app's server routes (asks, issuance asks, building proven transfers) need a SEP-10 session, and SEP-10 works only for `G…` accounts. The spec does not say how a `C…` smart wallet signs in, so the passkey screens are not built. Needs your decision | 2 | open |
| Medium | Fee route key: spec §13 names `qs-testnet-fee`, made by you, with its secret in `QUIETSTAY_TESTNET_FEE_SECRET`. I made `qs-fee-testnet` for the probe only. `/api/tx/sponsor` is not built yet (it waits on passkey sign-in) | 2 | open |
| Medium | Passkeys were tested with Chromium's virtual authenticator only. One approval on your own device is still to do | 2 | open |
| Medium | Stellar CLI 27.0.0 warns on testnet protocol 30; upgrade to 30.0.1 before Step 2 | 1 | resolved 2026-11-19: 30.0.1 installed (Step 2) |
| Low | This machine lacks the system libraries Playwright's browsers need (`libnss3`, `libnspr4`, `libasound2t64`), and `sudo` needs your password. Workaround: the Ubuntu packages, unpacked without root into `~/.local/share/qs-playwright-deps`, plus `LD_LIBRARY_PATH`. Proper fix: `sudo npx playwright install-deps chromium firefox` | 2 | open |
| Low | `next build` (Turbopack) fails locally to resolve `next/font/google` files. It also fails on the untouched `96bbb5f`, so it predates Step 2. `next build --webpack` succeeds | 2 | open |
| Low | `npm run lint`: 13 problems (12 errors, 1 warning) already on `96bbb5f`, none from Step 2 | 2 | open |
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
| Smart wallet (passkey) | `CDSI6FMLEA5LRMCTFU2RBMVBMFHWH4TJN7PEMEWSK477S4KP2KAKOKWY` (Step 2 probe) | | `npm run passkey:probe` |
| WebAuthn verifier (OZ, via kit) | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` | smart-account-kit deployment manifests. Checked on chain in Step 2: both run WASM `e63a030d…6b72b76` (`stellar contract fetch --id …`, then `sha256sum`) |
| Step 2 staging rights contract | `CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5` | — | `stellar contract deploy` (Step 2). Step 3 redeploys with USDC/arbiter |
| Testnet fee payer (D6) | `GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z` | — | `stellar keys generate qs-fee-testnet --fund` |
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
- Date: 2026-11-19 (STOP: checkpoint, waiting for your review)
- Branch / commit: `phase3`. `c51691e` transfer check · `68bad46` CLI and pins ·
  `df21722` passkey probe · `add5428` browser proving · the final Step 2 commit
  is in the git log.
- Done:
  - **Stellar CLI 30.0.1** (`f2a7b741`), the official release binary via
    `cargo binstall stellar-cli@30.0.1`. It is byte-identical to the binary in
    the v30.0.1 release tarball (sha256 `d161f7ca…367c`). `cargo install`
    failed because `libdbus-1-dev` is missing and installing it needs sudo.
    The testnet protocol-30 warning is gone.
  - **Pinned exactly:** stellar-sdk 16.4.1, smart-account-kit 0.10.0,
    stellar-wallets-kit 2.5.0, @playwright/test 1.65.0, esbuild 0.28.2.
    Recorded in docs/SETUP.md.
  - **The reusable transfer check.** `auth.rs::authorize_transfer(right, from,
    to, mode, h', proof, signals)` is the only path that moves a right, and
    `transfer` (sale and rental) calls it. D1: `split_address` tags C with
    2^128; `issue` accepts a C owner.
  - **In-browser proving.**
    - `prover-worker/` (GPL-3.0, LICENSE, README) builds
      `public/zk/prover.worker.js`. It checks `transfer.wasm` and
      `transfer.zkey` against SHA256SUMS (compiled in) before proving.
    - The Apache app talks to it only by `postMessage` (D2). The license
      notice is in the footer and on the screens that prove.
    - The vault (IndexedDB) holds secrets, records and sealed-link keys.
    - Sealed links (ECDH P-256, then HKDF, then AES-GCM) go through
      `/receive`, which has its own root layout with no analytics (D3, D4).
  - **The screens.**
    - Issue: the owner's ask makes `s` in the browser.
    - List: the buyer's ask makes `s'` in the browser.
    - Transfer: proves in the browser against an open ask.
    - No file and no command line on any of them. The CLI `h` stays under
      "Advanced".
  - **Passkeys, kit level.** The WebAuthn verifier WASM is `e63a030d…` on both
    networks. Account WASM `c514d35e…` is installed on both. They declare
    protocols 26 and 28, both ≤ 29. Rights WASM `0c6e4b2f…` declares v27.
    - The passkey probe passed, and so did the hand-off to
      `scripts/mainnet-sign-submit.sh`, rehearsed on testnet.
    - Unsupported-browser detection is in `src/lib/passkey.ts`.
    - **Passkey screens are not built:** see open issue "Passkey sign-in".
  - `check-privacy`: Phase 1 and Phase 2 evidence txs are now older than RPC
    retention. It reads them from Horizon, which serves no meta. So for those
    txs the envelope and result are scanned, not the events, and the output
    says so. Passes, with and without `--phase2`.
  - Docs: `docs/PROOF_TIMES.md`; CIRCUIT.md §5 (tagged encoding); DESIGN.md
    limitations 4 and 6; SETUP.md, the browser-test section.
- Tests (all run 2026-11-19):
  - `cd contracts && cargo test`: rights 73/73 (62 Phase 2, 2 of them
    changed in meaning, plus 11 new), verifier 6/6, measure 1/1.
  - `npm run zk:test`: 27/27 (18 Phase 2 and Step 1, plus 9 new
    browser-prover parity tests).
  - `npx playwright test e2e/prover.spec.ts`: 3/3. Genuine keys accepted;
    tampered zkey refused; substituted wasm refused.
  - `npx playwright test e2e/passkey.spec.ts`: 4/4. Passkey rental;
    tampered signature refused on chain (`Error(Auth, InvalidAction)`);
    cancelled prompt (`NotAllowedError`, nothing signed, nothing moved);
    WebAuthn detection.
  - `npx playwright test e2e/no-leak.spec.ts`: 2/2. A sale and a rental
    proved in the browser. 409 requests from the owner's, buyer's and renter's
    browsers, plus the issuer's while it sealed, including the worker's fetches
    of the circuit and key. None contained s, s', the record (or its salt, id,
    name, email or deed), d, d_hi, d_lo or a link fragment: 24 values, 0 leaks.
    `/receive` made no analytics request and its HTML references none. A
    browser without Workers sees the "cannot prove" message. Evidence:
    `e2e/results/no-leak-2026-11-19.json`.
  - `npm run zk:check-bundle`: passes (sections 1–4).
  - `npm run check-privacy` and `-- --phase2`: pass (see above).
  - Proof tests at contract level: valid, tampered, reused, wrong-account
    and expired proofs are the Phase 2 tests, now through
    `authorize_transfer`, plus C-address equivalents.
- Measured (proof times, `npx tsx e2e/prover-bench.ts --runs 7`; same machine,
  i7-10750H; see docs/PROOF_TIMES.md):
  - Chromium 158 (headless): median **498 ms**, first proof 1,159 ms.
  - Firefox 159 (headless): median **556 ms**, first proof 1,905 ms.
- Tx hashes (testnet):
  - Step 2 staging contract `CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5`
    deployed: `ab335e2bfc82d7e8c56c0d06eb73f1e0de6c6a3af0681d8fc1f7d385974aa667`
  - Probe 1: wallet `CDSI6FMLEA5LRMCTFU2RBMVBMFHWH4TJN7PEMEWSK477S4KP2KAKOKWY`
    - deployed: `c5fabe85f29f732ef49c8381148a7ae851c093521dd9c2959674909f654217bd`
    - right #1 issued: `26dde7846d1a5cc8de176bde7c51aa87c5e1cfb23db5b525cd214c27ae9549b0`
    - **passkey-authorized transfer** (wallet → qs-renter):
      `059a5ae5555e3522fb1b4869d580e5dd8954558d984ed7d3fc255baacadbbd95`
  - Mainnet-flow rehearsal: wallet `CCGONFSPIWO66M63VGDSG5YVL4WG2TFLYJHLHTNFQNWRYNSGJ5G6WQXA`
    - deployed: `10a7d2f78de8a8cdfd7624b43b674cf80b86b4253f22e5885556e5cb21108a68`
    - right #3, transfer sent by `mainnet-sign-submit.sh … --network testnet`:
      `01719bc9082f72e1d7d7b85fee704c6da661770a79478f8b63803800774730a9`
      (SUCCESS, ledger 5,815,136)
  - The first hand-off attempt (wallet `CA2KXJQM…GZT`, right #2) was refused
    by the script: fee below the re-simulated one, 3-minute time bound.
    Nothing was sent. The builder now adds headroom and a one-hour bound.
  - An unused wallet `CDK2LNXJ…CMV4` (`72b75b07…9a71`) is left from a first
    probe run that stopped before connecting. It holds nothing.
  - Throwaway contracts from the e2e runs: `CDASUH6V…CBZD`, `CBBDZEUI…ZCTT`,
    `CACK7NC6…SJE3`, plus the passkey spec's own. Their issuers were random
    keys, now discarded.
  - No-leak run (contract `CDRWQ5OOFNC3AD6CCEYLTI3N25DNRCLSKHEPHZBD64VR6IWQZPIAJS5U`):
    - sale proved in the owner's browser: `398b365e3a52aaff3ee4814c4f15f75084b26d733cb3a045e188d601913caa0f` (SUCCESS, ledger 5,815,911)
    - rental proved in the buyer's browser with s': `9bd55f30fc6c644b74a112e2ca90ac7866934343e188e88ff4dc9bca098c7437` (SUCCESS, ledger 5,815,916)
  - Passkey spec rental: `c513ea1c002d17abf35981eabb29a33f17467fe0f32a010ad66ebb6fe5788b1d`
- New identity: `qs-fee-testnet` (`GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z`),
  made by me for the probe. Spec §13 names `qs-testnet-fee`, made by you, for
  the fee route. See open issues.
- Supported browsers:
  - Proving: Chromium 158 and Firefox 159, desktop Linux, headless (measured).
    Any browser with Web Workers, WebCrypto and IndexedDB should work; others
    get a clear message.
  - Passkeys: Chromium with a platform authenticator (a CDP virtual
    authenticator in the tests). Not yet tested on a physical device, in
    Firefox or in Safari.
- Open: see the table at the top (Passkey sign-in, fee route key, real-device
  passkey).

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
