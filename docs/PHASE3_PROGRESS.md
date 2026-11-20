# QuietStay Phase 3 — Progress log

This file is updated at the end of every step in `docs/PHASE3_PROMPT.md`.
Each new session reads it before starting work. Keep entries short and
factual: every hash, address and number must come from a command that was
actually run.

## Sprint

- SOW approved on: _(date)_
- Sprint ends on: _(approval date + 30 days)_
- Current step: **Step 3 checkpoint approved; the testnet runs are stopped
  (2026-11-20).** The first offer call on the deployed contract failed on chain
  (allowance-expiration bug). A tested fix waits for your approval, and with
  it a redeployment. See "Step 3 deployment" in the step log

## Open issues

| Severity | Issue | Found in step | Status |
| --- | --- | --- | --- |
| High | D2: browser proving puts GPL-3.0 code in the browser | 1 | resolved: approved; LICENSE in `prover-worker/` + in-app notice (spec §2) |
| High | D6: who pays fees for passkey txs | 1 | resolved: approved with conditions (spec §13) |
| High | D12: how the allowance is given | 1 (review) | resolved: approved, set by the offer calls; DESIGN.md documents the leftover allowance |
| Medium | D4a: record-before-offer vs key hash in the offer | 1 (review 2) | resolved: option 1 approved with three additions (review 3) |
| Medium | Upstash connection and plan | 1 (review 2) | resolved: you confirmed `upstash-kv-cobalt-pillow` (Upstash for Redis) is connected and on the Free plan (Vercel dashboard, 2026-11-19) |
| Medium | Sealed-link page must load no analytics: separate root layout for `/receive`, no-leak test checks analytics endpoints | 1 (review 2) | resolved 2026-11-19: `(sealed)` root layout; checked by e2e/no-leak.spec.ts |
| High | **Passkey sign-in.** The app's server routes (asks, issuance asks, building proven transfers) need a SEP-10 session, and SEP-10 works only for `G…` accounts. The spec did not say how a `C…` smart wallet signs in | 2 | resolved 2026-11-19 (review): SEP-45 with Anchor Platform's web-auth contract @ `dc5817fb`, working within the time box; no ping fallback needed |
| Medium | The reused web-auth contract has `upgrade` gated by an admin, which conflicts with "no upgrade, no admin key" | 2 (review) | resolved 2026-11-19: approved as deployed (unmodified, unauthorizable admin). The claim is scoped to the rights contract in EVIDENCE.md and DESIGN.md, which add a web-auth entry. `scripts/check-web-auth.ts` passes on testnet; the checklist repeats it on mainnet |
| Medium | Fee route key: spec §13 named `qs-testnet-fee`; I had made `qs-fee-testnet` | 2 | resolved 2026-11-19 (review): `qs-fee-testnet` is the fee key, spec updated. You set `QUIETSTAY_TESTNET_FEE_SECRET` in Vercel and `.env.local`; its public key matches `GCGDZWCL…L77Z`. New identities: you create them |
| Medium | Passkeys were tested with Chromium's virtual authenticator only. One approval on your own device was still to do | 2 | resolved 2026-11-19: Windows Hello (PIN) on a MONSTER ABRA A7 V11.3, Windows 10 Enterprise 10.0.19045, Chrome 157.0.8103.79, authorized `list` from wallet `CAMTPQ3B…44YLT`, tx `059bc1b3…` |
| Medium | Stellar CLI 27.0.0 warns on testnet protocol 30; upgrade to 30.0.1 before Step 2 | 1 | resolved 2026-11-19: 30.0.1 installed (Step 2) |
| Low | This machine lacked the system libraries Playwright's browsers need | 2 | resolved 2026-11-19: you ran the install with sudo; the unpacked workaround is removed, and both browsers start on the system libraries |
| **High** | Intermittent errors in e2e runs: a 500 from `/api/issue` and a 502 from `/api/me`. **Step 3 review (2026-11-20):** read-only RPC calls now retry a dropped connection, up to 3 attempts, and log the network code; `sendTransaction` is never retried. In the first run after that, the server logged `[rpc-retry] simulate next_id: attempt 1 of 3 failed (fetch failed)`, the retry succeeded, and no failed `/api` response was saved. The code was not readable: the SDK's HTTP layer (`feaxios`) drops the error's cause. The retry log now also reads undici's diagnostics channels, which carry the code. The next run had no drop, so the code is still to be confirmed at the next one. **Earlier Step 3 evidence:** the capture saved a 502 from `/api/inventory`, body `{"error":"fetch failed"}`, and the same call returned 200 a moment later. In the same session the test process itself got `fetch failed` (cause `AggregateError`) three times reaching testnet. Leading hypothesis, not yet confirmed: transient connection failures from this machine to the testnet RPC/Horizon, which the routes turn into 500/502. `/api/inventory` now logs the error with its `cause`, as `/api/issue` and `/api/me` do. Neither the `/api/issue` 500 nor the `/api/me` 502 appeared in Step 3. Neither recurred on a rerun; their bodies were not kept then. Now the browser specs capture the body of every failed `/api` response (`e2e/lib/failures.ts`). Both routes log the error they catch, and the test server's log is kept. The cause must be found **before Step 5** | 2 (review) | open: High until the cause is found. The no-leak rerun after this change had 0 failed responses |
| Medium | SEP-45 and the fee route need the deployment's store (Upstash) on Vercel, for single-use nonces and rate limits. Without it they refuse, by design. The SIGNING_KEY account must exist on each network | 2 (review) | open: Step 5 checklist item (spec §14) |
| Low | `next build` (Turbopack) fails locally to resolve `next/font/google` files. It also fails on the untouched `96bbb5f`, so it predates Step 2. `next build --webpack` succeeds | 2 | open |
| Low | `npm run lint`: 7 findings remain, all in code from before Step 2 (it was 13 on `96bbb5f`) | 2 | open |
| **High** | **Every offer call on `CDC6XD3W…KMZO` fails on chain.** The allowance expiration was `now + 120,960`, a value inside the arguments the buyer signs at simulation, so it no longer matches once the transaction lands. The unit tests mocked every signature and could not see it. The fix (expire with the buyer's latest live offer) is built and tested, but not deployed. It needs your approval, then a fresh deployment. Then the runs start again, the wait rental first | 3 (deployment) | open: spec note 10 |
| Medium | The Step 3 on-chain runs (one-step sale, rental paid out after the wait, disputed rental resolved by the arbiter, the rejected transactions) are waiting on the fix above | 3 | open |
| Low | The first deployment `CDC6XD3W…KMZO` stays on testnet as is, with weeks #1–#5 issued to `qs-owner`. Nothing moved on it. It will not be used once the fix is deployed | 3 | open (record only) |
| Medium | **Pre-launch checklist item (Step 3 review):** pilot funds are never sent to the contract address directly. USDC sent there with the token is stuck forever (DESIGN.md known limitation 17). Checked on chain on both networks | 3 | open: Step 5 checklist item, spec §14 |
| Medium | **Pre-launch checklist item:** the mainnet sign-in key `mainnet-test` (`GCEF3BTQ…TDAR`) currently holds XLM. It is a separate account from `GALA3K…HE3M`. You reduce it to the minimum balance before its secret goes to the server (Step 6); the checklist records the balance read back from mainnet. Kept as it is (Step 3 review) | 3 | open: Step 5 checklist item, spec §14 |
| Low | The payment screens are checked by typecheck, `next build --webpack`, lint and unit tests only. Their end-to-end run needs the Step 3 WASM on testnet and USDC in throwaway accounts, so it comes after the deployment | 3 | open |
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
- **Step 2 review decisions (2026-11-19):**
  - **Passkey sign-in** is SEP-45, with Anchor Platform's web-auth contract
    pinned at `dc5817fb`, deployed by us on testnet now and on mainnet later.
    SEP-10 stays for G accounts. The fallback would have been a ping
    function in a separate contract, never in the rights contract; it was
    not needed.
  - **The web-auth contract is approved as deployed:** unmodified, with an
    unauthorizable admin. "No upgrade" is claimed for the rights contract
    only. The checklist repeats the check on mainnet.
  - **The fee key** is `qs-fee-testnet`. You create any new identity.
  - **The sign-in signing key** is the single mainnet server key: no contract
    role, minimum balance, funded by you, listed as the checklist exception.
  - **check-privacy** runs right after every evidence transaction, on both
    networks, and its output is committed under `evidence/privacy/`.
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
| Arbiter account | `GACLONYVHKPB4BG3QUWMKG4LAKTRYKM4CFLBF4VTBAF5773X4UYZEEZC` (`qs-arbiter`, created by you) | | `stellar keys public-key qs-arbiter` (2026-11-20) |
| Step 3 rights contract, first deployment (offer calls fail; superseded once the fix is approved) | `CDC6XD3WK4GZSJWNBJELDBHAHNPHLS7WL6RZG2KEACC2RGJWCRTGKMZO` | | `scripts/deploy.sh` (2026-11-20): upload `dd7a0153fd19263a890b7ab3c2a6c2f5ad3db4013b03c5e8642cb95fd5963e86`, deploy `c05ada7aacdc3fd98c2e6ef9809c05c7a0d8f8794ab9f14b4a0aa1cf4a4e9194`. Read back: arbiter `GACLONYV…EEZC`, usdc `CBIELTK6…DAMA`, max_payment 1000000000, issuer `GBNBWXSC…YUBE`, on-chain WASM `db92ae3e…b38f` |
| Testnet buyer / renter (USDC trustlines) | `qs-buyer` `GB3VDHPHD27MVDMQAN5JD3EUGWTX76W7SJWHKG4EPITK2WOOAPX5UWVQ`, `qs-renter` `GBNDVZTDK7IOUFEAZH4ZBJ25WT2FXJ4IZPXWADAD4BEQPDD5FDQNZAXN` | | trustlines `de0444b6…1bcb`, `bc671422…0a79`; 20 USDC each from Circle's faucet (Horizon, 2026-11-20) |
| Smart wallet (passkey) | `CDSI6FMLEA5LRMCTFU2RBMVBMFHWH4TJN7PEMEWSK477S4KP2KAKOKWY` (Step 2 probe) | | `npm run passkey:probe` |
| WebAuthn verifier (OZ, via kit) | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` | smart-account-kit deployment manifests. Checked on chain in Step 2: both run WASM `e63a030d…6b72b76` (`stellar contract fetch --id …`, then `sha256sum`) |
| Step 2 staging rights contract | `CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5` | — | `stellar contract deploy` (Step 2). Step 3 redeploys with USDC/arbiter |
| Testnet fee payer (D6) | `GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z` (`qs-fee-testnet`) | — (no server key on mainnet) | approved as the fee key at the Step 2 review |
| SEP-45 web-auth contract | `CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM` | later, deployed by us | `npx tsx scripts/deploy-web-auth.ts --network testnet --source qs-issuer` (tx `31f480413f355f51a545a2817ccdb1a8e163eab5a49d6f59a92debda5b825ff1`) |
| Web-auth WASM (must match) | `708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1` | | built from java-stellar-anchor-sdk @ `dc5817fb` |
| Web-auth admin (unusable) | `CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2` | same | SHA-256("QuietStay SEP-45 web-auth: no admin"); no contract at it |
| SEP-10 / SEP-45 signing key | `GDC2YUKYIPDETC6M7QVOL4222SJF6MVYCW5ZOOVFQEZQQPYIENPLRRGQ` (exists) | `GCEF3BTQVDJ473URMW4556VG67YAPS2J5OP77FBXT7T47M2DOIZ7TDAR` (`mainnet-test`; holds XLM now, to be reduced to the minimum by you before Step 6) | testnet: `qs-sep10-server`; mainnet: `stellar keys public-key mainnet-test` (2026-11-20; the secret was not read) |
| Measurement contract (Step 1 only) | `CCKL74S5L57GZ32K2AWIIRGKNED3CZNWFCM62BMVASLMSHJXOYK4ZLY4` | — | `stellar contract deploy … quietstay_measure.wasm` |
| Wasm hash (must match) | Deployed on `CDC6XD3W…KMZO`: `db92ae3eeb552aaf7e1b694fd688af085b62a39f342488131b00e8aef770b38f` (58,704 bytes, protocol v27; offer calls fail). With the proposed fix, not deployed: `c7473e8e8a449328704964db8ec1285080fc303794e3a41e9b4fd59eaeec6b6b` (58,774 bytes, protocol v27, 42 functions) | | `cd contracts && stellar contract build --package quietstay-rights`, then `sha256sum target/wasm32v1-none/release/quietstay_rights.wasm` |
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
- Date: 2026-11-19. **Closed 2026-11-19** after two reviews.
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
- **Review (2026-11-19), done:**
  - **SEP-45 for smart wallets**, working within the one-day time box.
    - The web-auth contract is vendored unmodified from
      stellar/java-stellar-anchor-sdk @ `dc5817fb`
      (`contracts/vendor/anchor-web-auth/`, PINNED.md). Its WASM is
      `708cacdc…`, protocol 26.
    - Testnet deployment `CBCDSOZP…5KGM` (tx `31f48041…`), with admin
      `CDA2IFOT…33G2`, which nobody can authorize. The stored Admin and the
      absence of any contract at that address were read back from chain.
    - `src/lib/sep45.ts` and `/api/auth/contract` implement SEP-45 v0.1.1
      §Challenge and §Token. The session is the same as SEP-10's. SEP-10
      stays for G accounts. `/.well-known/stellar.toml` advertises both.
    - Added to the spec's permissions table (§10) and checklist (§14).
  - **Fee key:** `qs-fee-testnet`, spec §13 updated; your secret matches its
    public key.
  - **Playwright:** the workaround is removed and the system libraries are
    used.
  - **check-privacy:** a `--tx label=hash` mode, with `--record`, `--secret`
    and `--next-secret`, writes its full output (events included) to
    `evidence/privacy/`, which has a README. The specs that make evidence
    transactions run it right after them. The Step 2 evidence transactions
    are in `evidence/privacy/2026-11-19-step2-testnet.txt`.
  - **Passkey screens.**
    - Header: "Use a passkey" (create a wallet, or sign in). An unsupported
      browser is told to use a regular wallet instead.
    - The wallet is created through `/api/tx/sponsor` and signs in with
      SEP-45.
    - Asks, issuance asks, offers, a buyer's consent and in-browser proven
      transfers all work for a C account. `sign`, `submitSigned` and
      `signConsent` route each one.
    - For C callers, the builders use the fee account as source.
  - **`/api/tx/sponsor`** follows spec §13: testnet only; rights-contract
    calls or pinned-WASM wallet creation only; the fee account nowhere but
    the source; fee ≤ 1 XLM; 10/IP/hour, 20/wallet/day, 300/day; refuses
    without a store; refuses if the fee key is the issuer, the sign-in key
    or a holder. It rebuilds every transaction itself.
  - **Device step for you:** docs/PASSKEY_DEVICE_TEST.md.
- **Review tests (all 2026-11-19):**
  - `cargo test`: 80/80, unchanged.
  - `npm run zk:test`: 27/27.
  - `npm run test:app`: 12/12 (the sponsor policy, rule by rule).
  - `npx playwright test`: 15/15, of which:
    - prover 3/3;
    - passkey 8/8, 4 of them SEP-45: sign-in; unsigned, replayed and
      tampered challenges refused;
    - passkey app 2/2;
    - no-leak 2/2.
    
    The full-suite run had one failure: no-leak, at the 500 from
    `/api/issue` above. It passed on the rerun.
  - The no-leak rerun recorded 409 requests and found 0 leaks among 25
    forbidden values. Its on-chain check
    (`evidence/privacy/2026-11-19-no-leak-aa174f21.txt`) passes.
  - An earlier run of that check flagged the buyer's `h'` on the sale. That
    was a false positive: `h'` is public by design. `--next-secret` was
    added and the transcript dropped.
  - `zk:check-bundle` passes. `next build --webpack` passes.
  - Lint: the same 7 findings as before Step 2.
- **Your device's passkey (2026-11-19, docs/PASSKEY_DEVICE_TEST.md):**
  - Wallet `CAMTPQ3B2PPQDTPGJB52K54X4VETQ3BM46VWGB74XLVFTTDLZOZ44YLT`,
    created in your Chrome. It runs WASM `c514d35e…` (`stellar contract fetch`
    + `sha256sum`).
  - Right #4 (2026-12-19 → 12-26) issued to it on `CCR2Z4IQ…MAX5`:
    `69d3705fbab2aad395698ce370c01ee63a5a878736ee297fba53f532e9a424ed`
  - **Passkey-approved `list`:**
    `059bc1b3e9156b3cec5bd0d1695afea05b7c1ef18540593ff8cca0fe6ae59afb`
    (ledger 5,818,569, 2026-11-19T19:28:05Z). Read back from chain:
    - the source is `qs-fee-testnet` (it only pays);
    - the call is `list` on the rights contract;
    - the one authorization is the wallet's, context rule 0, with an
      External signer on the WebAuthn verifier `CC7EKIH…OM3F`;
    - `get_listing(4)` now shows the offer, by the wallet, for 7 days.
  - check-privacy, right after each transaction:
    `evidence/privacy/2026-11-19-device-wallet-issue-69d3705f.txt` and
    `…-device-passkey-list-059bc1b3.txt`. Both pass, meta and events
    included.
- **Second review (2026-11-19), done:**
  - Device recorded, read with `powershell.exe` from WSL:
    - `Microsoft Windows 10 Enterprise 10.0.19045`
    - `MONSTER ABRA A7 V11.3`
    - Chrome `157.0.8103.79`, on Windows (not in WSL), at
      `http://localhost:3000`
    - Windows Hello PIN (from you)
  - Web-auth contract approved as deployed.
    - EVIDENCE.md and DESIGN.md now say "no `upgrade` in the rights
      contract", and have a web-auth entry: the stored admin, and no
      contract at that address.
    - `npx tsx scripts/check-web-auth.ts --network testnet`: 3/3 checks.
    - The checklist (spec §14) repeats it on mainnet.
  - DESIGN.md: only the SEP-45 web-auth contract is reused from Anchor
    Platform. No Anchor Platform service, anchor integration, fiat or
    on/off ramp is used.
  - The sign-in signing key is approved as the single mainnet server key: no
    contract role, minimum balance, funded by you. It is listed as the
    exception in the checklist and DESIGN.md. Its mainnet public key goes to
    you before Step 6.
  - The sale pair redone with a privacy record: sale
    `5b75d907aaee63faac4f4f327244f51cd1f2cc852e6138ef907ff160e4fe7766`, rental
    `92154017748440ee48ff25cdc95079277f9d13d836b1b45f40f2e84c8666a11d`
    (no-leak 2/2, 409 requests, 0 leaks). The check passes:
    `evidence/privacy/2026-11-19-no-leak-5b75d907.txt`. It supersedes the
    pair `f7834cce…`/`d8bcae93…`, which has none.
  - Failed-request capture added (see the High issue). `passkey-app` was rerun
    with it: 2/2, 0 failed responses, rental
    `8de8acb5fa551f5b7534cdefe243c0566a003ce65ef6e4c2d4031fd1d7e9eab6`
    (`evidence/privacy/2026-11-19-passkey-app-8de8acb5.txt`).
- **Supported browsers (Step 2 result):**

  | Use | Browser and device | Tested how | Result |
  | --- | --- | --- | --- |
  | In-browser proving | Chromium 158, Linux (WSL2), i7-10750H | Playwright, headless | median 498 ms |
  | In-browser proving | Firefox 159, same machine | Playwright, headless | median 556 ms |
  | Passkey wallet, SEP-45, approvals | Chromium 158 with a virtual platform authenticator | Playwright (CDP WebAuthn) | all passkey specs pass |
  | Passkey wallet, SEP-45, approval | **Chrome 157.0.8103.79 on Windows 10 Enterprise 10.0.19045, MONSTER ABRA A7 V11.3, Windows Hello PIN** | by you, by hand | `list` tx `059bc1b3…` |
  | Anything else | Firefox, Safari, phones | not tested | a browser without WebAuthn, Workers, WebCrypto or IndexedDB is told so and pointed to a regular wallet |

- **Review tx hashes (testnet):**
  - Web-auth contract deployed: `31f480413f355f51a545a2817ccdb1a8e163eab5a49d6f59a92debda5b825ff1`
  - **Passkey screens, approved with the passkey** (wallet
    `CCNDU6CKCMBO4BF747VO77HYERV745NFB44NY6GDX4GYFAHWET5HH35B`): rental
    `e590f8b026d60019bc7bd43bd5e393aea095ccd0ba2ee0f312efb55c33d3e2fc`
  - Second passkey-app run (wallet `CDE7YVIL…LMFN`): rental `b409db2f029f23a6d412e2a46b72b3a09fb96da2bac06d2188d8a5866afb2232`
  - Passkey spec rental: `b263df24a8f977986e5d8167661394106fbe7afa5831421d2a492d7cd15567d6`
  - No-leak (rerun): sale `aa174f215da846076c4701ae6e017bdf2a3c9f9ca0ee711dd78d09bc7799589b`,
    rental `19335b24d115aeab54454e6e144af2f20bc9fc1f1a69d2f29116602fc0dd1d9c`
  - Each has its check in `evidence/privacy/`. The no-leak pair from the
    run with the false positive (`f7834cce…`, `d8bcae93…`) has none,
    because its throwaway secrets were gone.

### Step 3 — USDC sale, rental escrow and pilot arbiter
- Date: 2026-11-20. **At the checkpoint:** built and tested, not deployed.
- Branch / commit: `phase3`. `5c6841b` contract and unit tests; the app and
  docs commit follows it in the git log.
- Decision from the Step 2 checkpoint, recorded: on mainnet the sign-in key is
  the separate identity **`mainnet-test`**, not `qs-sep10-server`. Public key
  `GCEF3BTQVDJ473URMW4556VG67YAPS2J5OP77FBXT7T47M2DOIZ7TDAR`
  (`stellar keys public-key mainnet-test`, 2026-11-20). Its secret was not
  read or printed; it was not funded or used. It is used only in Step 6. It
  holds XLM now: you reduce it to the minimum before its secret goes to the
  server (checklist item, spec §14).
- Done:
  - **Contract** (`contracts/quietstay-rights`): the constructor takes
    `(issuer, arbiter, usdc, name, symbol, verification_key, max_payment)`.
    New modules:
    - `offers.rs`: record requests, sale and rental offers, acceptance;
    - `escrow.rs`: the §5 state machine;
    - `payment.rs`: the only module that calls USDC.
    Every right still moves only through `authorize_transfer`. `burn` is
    refused while an escrow is Funded or Disputed (D11).
  - **Contract surface diff** (`stellar contract info interface`): 19 → 42
    functions with the constructor.
    - Added, writes: `request_record`, `cancel_record_request`,
      `create_sale_offer`, `create_rental_offer`, `cancel_offer`,
      `accept_sale`, `accept_rental`, `collect`, `confirm`,
      `report_problem`, `refund`, `submit_evidence`, `resolve`,
      `extend_escrow`.
    - Added, views: `arbiter`, `usdc`, `max_payment`, `get_record_request`,
      `get_offer`, `get_escrow`, `next_request_id`, `next_offer_id`,
      `next_escrow_id`.
    - Changed: `__constructor` (arbiter, usdc, max_payment) and `burn` (the
      escrow guard).
    - Unchanged: `transfer` and every Phase 2 function. Still no `upgrade`,
      no admin, no setter.
    - New error codes 30–54; 13 new events.
  - **WASM:** 58,704 bytes (45% of 131,072), env-meta protocol v27,
    sha256 `db92ae3e…b38f`.
  - **Spec additions to review:** PHASE3_SPEC.md "Step 3 implementation
    notes", items 1–9.
  - **App:**
    - `/stays` ("Offers & stays"): make an offer; offers for your weeks, with
      in-browser proving to accept; your offers; stays and payments. Statuses
      shown: offer open, offer expired, accepted, closed, funded, collectable,
      disputed, paid out, refunded. Evidence files are hashed in the browser.
    - Routes: `/api/payments` and `/api/record-request/[id]` (public reads);
      `/api/tx/accept-offer`; `/api/tx/build` gains the 10 non-proof
      actions.
    - `/receive` accepts on-chain record requests (link kind `offer`, D4a).
      The List screen links each week to a paid offer.
    - Errors 30–54 have messages. USDC-token failures (missing trustline)
      are recognised by their text.
    - Amounts are bigint everywhere (`src/lib/usdc.ts`), with no floating
      point.
    - The fee route sponsors an offer's USDC `approve` and nothing else
      in USDC.
    - "What the chain sees" on `/stays` and in DESIGN.md says plainly that
      amounts and addresses are public.
  - **Scripts:**
    - `scripts/arbiter-resolve.sh`: checks the identity is `arbiter()` and
      the escrow is Disputed, hashes the decision file, simulates, asks you
      to type RESOLVE, and signs from the keystore.
    - `scripts/deploy.sh`: the new constructor, testnet only, identity
      `qs-arbiter`.
    - `check-privacy` gains `--evidence <file>`.
    - The fixture generator gains `--only`.
  - **Pilot evidence samples:** `pilot/evidence/` (README and 4 text
    files). `sha256sum pilot/evidence/*.txt`:
    - problem-report `22f5dc8c…06c7`;
    - renter-evidence-1 `c2085d8c…f980`;
    - owner-evidence-1 `f41e4437…ad95`;
    - arbiter-decision `d55f0ef5…4009`.
  - **DESIGN.md:** privileged surface, the arbiter, buyer and escrow tables;
    "What the ledger reveals" for payments; why no allowlist; the escrow and
    arbiter; the direct-transfer note.
- Tests (all run 2026-11-20):
  - `cd contracts && cargo test`: rights **125/125** (73 before, plus 52 in
    `test_payments.rs`), verifier 6/6, measure 1/1. `cargo clippy
    --all-targets`: 0 warnings.
  - The 52 cover every case in the Step 3 list:
    - sale: one-step sale; unaccepted offer; expired offer; low balance; low
      allowance; wrong token; wrong amount;
    - rental and escrow: acceptance funds the escrow and grants the right in
      one tx; collect at check-in + 24 h − 1 s refused and at + 24 h
      allowed; early confirmation; report within the window and after it;
      collect during a dispute; double payout, double refund and refund
      after payout;
    - arbiter: on an undisputed escrow; trying to move a right; outsider and
      issuer calls refused;
    - evidence hashes recorded and bounded;
    - the USDC invariant over three escrows;
    - allowances: five offers on one allowance with an accept, a cancel and
      a balance drop; an allowance that expires before its offer; an offer
      that outlives its allowance;
    - outside accounts: every public function, with its own signature and
      naming builder accounts. The swap functions come in Step 4;
    - plus record requests, check-in rules, burn guards, TTL, a smart-wallet
      seller, and the constructor.
  - Fixtures: 3 new real proofs (`rental_r2`, `rental_r3`, `sale_r2`, made
    with `npm run zk:test-fixtures -- --only …`); the existing ones unchanged.
  - `npm run test:app`: 22/22 (12 before, plus 3 sponsor, 4 USDC amount and
    3 escrow-status tests).
  - `npx tsc --noEmit`: clean. `next build --webpack`: passes, `/stays` and
    the three new routes included. `npm run zk:check-bundle`: passes.
  - Lint: the new and changed files are clean. The 3 findings on
    `list/page.tsx` are among the 7 from before Step 2.
  - `npm run check-privacy` and `-- --phase2`: pass.
  - `npx playwright test`, the full suite on the Step 2 WASM, as a
    regression check of the app changes (2026-11-20):
    - First run: 5 passed, 2 failed, 8 not run. Both failures were
      `TypeError: fetch failed` (cause `AggregateError`) in the passkey
      specs' setup, a connection failure from this machine to testnet, before
      any page loaded.
    - Reruns: `passkey.spec.ts` 8/8. `passkey-app.spec.ts` failed once more,
      after its rental landed
      (`1ad5c0e2ad5141719a4544740d3c64afecbbf156dcf07bb9482f0889f3f3f856`): the
      `check-privacy` step got `fetch failed` partway. That rental has no
      privacy check, because its throwaway secrets were gone. The incomplete
      output was not committed. **`1ad5c0e2…` is not used as evidence**
      (Step 3 review). The third run passed 2/2 (rental
      `8bc42bdf59f97d9b21169d8e76e3b341b578c1dea12f9c7b392cbbebba4d67bf`,
      check in `evidence/privacy/2026-11-20-passkey-app-8bc42bdf.txt`).
    - So every spec passed: no-leak 2/2 (409 requests, 24 forbidden values,
      0 leaks; `evidence/privacy/2026-11-20-no-leak-d67f31fd.txt`),
      prover 3/3, passkey 8/8, passkey-app 2/2.
- Tx hashes: none yet. Nothing was deployed or sent in Step 3. The testnet
  deployment and its runs follow your approval.
- Open: see the table at the top (deployment, `qs-arbiter` and testnet
  USDC, the `mainnet-test` balance item, the payment screens' e2e run).

#### Step 3 review (2026-11-20): answers and changes; deployment not approved yet

1. **Contract size.**
   - The limit is **131,072 bytes on both networks**:
     `contract_max_size_bytes 131072` from `stellar network settings`, testnet
     and mainnet, 2026-11-20. 64 KB was the stale comment in `deploy.sh`,
     fixed in Step 3.
   - The build is already optimised: 58,704 bytes, from 65,783 unoptimised
     (`stellar contract build`).
   - **Swap estimate: about 70–73 KB, 53–56% of the limit.** Derivation: the
     Step 2 WASM (`85b8ee5`, built in a scratch worktree) is 27,615 bytes, so
     Step 3 added 31,089 bytes for 14 write functions, 9 views, 13 events and
     25 errors. The swap adds 5 write functions (`offer_swap`, `cancel_swap`,
     `accept_swap`, `withdraw_swap_acceptance`, `complete_swap`), one view,
     about 5 events and a burn guard, and it reuses `authorize_transfer` and
     the request code: about 11–14 KB. Step 4 measures the real size.
   - **If it did not fit:** optimisation is already on; next would be
     trimming, measured function by function.
   - **A separate swap contract is not a fallback.** It could move rights
     only through a privileged call into the rights contract (spec §8), which
     the constraints forbid. I would stop and bring you the numbers.
2. **Allowance.** The USDC `approve` is a sub-invocation inside
   `create_sale_offer`, `create_rental_offer` and `cancel_offer`
   (`offers.rs` → `payment::set_allowance`), in the same transaction under
   the buyer's one authorization. There is no separate call to the USDC
   contract.
   - New test
     `the_allowance_is_set_inside_the_offer_call_not_by_a_separate_usdc_call`
     reads the recorded authorization tree: one tree, the buyer's, with the
     offer function at the root and `approve(buyer, contract, sum)` as its
     only sub-invocation.
   - Rights tests: 126/126.
3. **USDC sent directly.** DESIGN.md known limitation 17: it is stuck
   forever. Checklist item (spec §14): pilot funds are never sent to the
   contract address directly, checked on chain on both networks.
4. **Network errors.**
   - `src/lib/rpc-retry.ts` (bounded retry, 3 attempts, after 300 ms and
     900 ms, connection failures and HTTP 429/502/503/504 only, each attempt
     logged with its code).
   - `src/lib/rpc-server.ts` (`RetryingServer`): its read methods retry,
     and `sendTransaction` is inherited unchanged.
   - It is used by the app's routes, SEP-45, the fee route, `check-privacy`
     (and its Horizon reads), the e2e helpers and the scripts.
   - The browser's ledger reads retry too.
   - 5 new app tests: 27/27.
5. **Privacy records.**
   - Each spec registers its check (`evidenceLanded`) the moment a
     transaction lands. `test.afterEach` runs every registered check, whether
     the test passed or failed.
   - A check that fails on the network is retried. Its records and secrets
     are kept (0700, outside the repo) until a check completes, or kept with
     a printed rerun command if it never does.
   - `1ad5c0e2…` is marked not used as evidence.
6. **`mainnet-test`** holds XLM and is separate from `GALA3K…HE3M`. The
   checklist item is kept as it is.

- Runs after the changes (2026-11-20), `npx playwright test`:
  - **Run 1: 13/14 passed.** One SEP-45 test failed on the test process's
    own `getLatestLedger` (`AxiosError: fetch failed`), which had no retry
    then. The e2e helpers now use `RetryingServer`.
  - Run 1 transactions: no-leak sale `1c91490670aa3cd7e84ab9a5879eabdb80c55e0a167df9d1e6e121da546ea18e`,
    no-leak rental `163c6d9b35b480f3257e463756b525cee28ae9b4b1a6efc23717edd8c39fda3b`,
    passkey-app rental `4fbf58ded97b148e4219d87a04a428525c1b014ddba25986800e0878d1e9465d`,
    passkey-spec rental `d7976971e3a7c07de5d2dbca112dbdef1c3ad2b53541c9bbcdcdd6931e98dc4b`.
  - **Run 2: 15/15**, no network drop, no failed `/api` response.
  - Run 2 transactions: no-leak sale `b61611bcce4cfee13a92f00cef1866e16f73b06b10b1299fc1e7949ac29a1243`,
    rental `94980af7773c7097962d6d20f47bfd30082092829ab6f173d02aed58c910bbae`,
    passkey-app rental `724a7b94ee1aac3f81fb2444ca226cff95114afffc0b8e4b0ab497e004883982`,
    passkey-spec rental `c82d0fe29cb183b297ff6aa65e77931ed4d2edd72bde691e57e700fb0e89fc66`.
  - Every one of them has a completed check in `evidence/privacy/`.
  - `tsc`, `next build --webpack`, `zk:check-bundle` and `check-privacy`
    pass. `cargo clippy`: 0 warnings.
- For the deployment, once you approve: you create `qs-arbiter`; I add USDC
  trustlines to `qs-buyer` and `qs-renter` on testnet and give you their
  addresses for Circle's faucet.

#### Step 3 deployment (2026-11-20): stopped at the first offer

- **Approved:** the test results, the interface change (19 → 42 functions)
  and spec notes 1–9. `qs-arbiter` was created by you; only its public key
  was read: `GACLONYVHKPB4BG3QUWMKG4LAKTRYKM4CFLBF4VTBAF5773X4UYZEEZC`.
- **Trustlines** (`stellar tx new change-trust --line USDC:GBBD47IF…LLA5`):
  - `qs-buyer`: `de0444b60182e8128b4e3c04e85fcae00916e9f17bff9808058d52e644ee1bcb`
  - `qs-renter`: `bc671422389c435a069ef9fc89e37b6a2dbe1d95edb2befcb6f034d3ad3e0a79`
  - You sent faucet USDC; Horizon shows 20 USDC on each.
- **Deployed** with `scripts/deploy.sh` (tests, build, deploy as `qs-issuer`,
  arbiter `qs-arbiter`): `CDC6XD3WK4GZSJWNBJELDBHAHNPHLS7WL6RZG2KEACC2RGJWCRTGKMZO`.
  - Upload: `dd7a0153fd19263a890b7ab3c2a6c2f5ad3db4013b03c5e8642cb95fd5963e86`.
  - Deploy: `c05ada7aacdc3fd98c2e6ef9809c05c7a0d8f8794ab9f14b4a0aa1cf4a4e9194`.
  - Read back from chain: arbiter, usdc, max_payment and issuer are as
    configured. `stellar contract fetch` + `sha256sum` = `db92ae3e…b38f`, the
    committed build.
- **Weeks issued** by `scripts/step3-evidence.ts issue` (signed by
  `qs-issuer` through the keystore). Rights #1–#5 to `qs-owner`, 2026-11-20 →
  2026-11-27:
  - `532e6c5bea7370cbae5a540d496734cec4e3ad397aebf0ad0e4cb74077191c39`
  - `1c02d4944d977157a178bce64f6d1822e8effe701bc26e90afb893d63725e4bf`
  - `c771936b3a54d397b23ee35b1336dddc43d2b059186ea6a24fe4b6efd24e7397`
  - `00d6aa7fddf5b1b9e63a65a58d5912b77ee9dcaa8547dbc7e2f981cc6a53f1b9`
  - `1800b54adea51d31c1f09932b93f3f1574c69c3491e2f1ac1ca1d3b16248fb9f`
  - Privacy record: `evidence/privacy/2026-11-20-step3-issue.txt`. Records
    and secrets are in `.secrets/CDC6XD3W/step3/` (gitignored).
- **The first rental offer failed on chain:** `create_rental_offer` by
  `qs-renter`,
  `32ee35321401a80e5b1e6752f275febcbcb029fa2317f7eadd74711214dc5f42`,
  `Error(Auth, InvalidAction)`. It passed simulation; nothing moved; only the
  fee was charged.
  - **Cause, read from chain:** the signed authorization holds
    `approve(…, expiration_ledger = simulation ledger + 120,960)` (5,957,168
    at simulation ledger 5,836,208). At inclusion the contract computes a
    later ledger + 120,960, so its `approve` call no longer matches what was
    signed.
  - This is the D12 text as approved (§4), so it cannot be fixed without
    you. **The runs stopped here.** No sale, no dispute and no rejected
    transaction was attempted on this contract.
- **Proposed fix, built and tested, not deployed:** spec note 10. The
  allowance expires at the latest `expires_ledger` of the buyer's live
  offers.
  - New tests `an_offer_signed_at_one_ledger_still_lands_ledgers_later` (on
    the old rule it fails with exactly `Error(Auth, InvalidAction)`, checked
    by reverting temporarily) and
    `the_allowance_expires_with_the_last_live_offer`.
  - One test changed meaning: an expired lone offer now leaves no allowance.
  - Rights 128/128, verifier 6/6, measure 1/1, clippy 0 warnings.
  - WASM `c7473e8e…6b6b`, 58,774 bytes.
- **`scripts/step3-evidence.ts`:** the evidence driver.
  - Signing: every envelope is signed by a CLI identity (`stellar tx sign
    --sign-with-key`). The only in-memory key is a Friendbot-funded throwaway
    outside account.
  - Each rejected transaction is sent with a valid sibling's resources and
    must fail with exactly the expected error.
  - Each step writes its privacy record. The log goes to
    `evidence/step3-testnet.json`.
  - Steps: issue, wait-rental (check-in = last ledger time + 90 s),
    sale, dispute-open/close, confirm, sale-rejections, escrow-rejections.
- **To continue, once you approve note 10:**
  1. Deploy the fixed WASM, which gives a new contract id.
  2. Issue the weeks again.
  3. Run wait-rental first, and report the exact collect time.
  4. Run the other steps.

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
