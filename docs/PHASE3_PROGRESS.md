# QuietStay Phase 3 — Progress log

This file is updated at the end of every step in `docs/PHASE3_PROMPT.md`.
Each new session reads it before starting work. Keep entries short and
factual: every hash, address and number must come from a command that was
actually run.

## Sprint

- SOW approved on: _(date)_
- Sprint ends on: _(approval date + 30 days)_
- Current step: **Step 2 closed (2026-11-19).** Step 3 starts in a new session

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
| **High** | Intermittent errors in e2e runs: a 500 from `/api/issue` and a 502 from `/api/me`. Neither recurred on a rerun; their bodies were not kept then. Now the browser specs capture the body of every failed `/api` response (`e2e/lib/failures.ts`). Both routes log the error they catch, and the test server's log is kept. The cause must be found **before Step 5** | 2 (review) | open: High until the cause is found. The no-leak rerun after this change had 0 failed responses |
| Medium | SEP-45 and the fee route need the deployment's store (Upstash) on Vercel, for single-use nonces and rate limits. Without it they refuse, by design. The SIGNING_KEY account must exist on each network | 2 (review) | open: Step 5 checklist item (spec §14) |
| Low | `next build` (Turbopack) fails locally to resolve `next/font/google` files. It also fails on the untouched `96bbb5f`, so it predates Step 2. `next build --webpack` succeeds | 2 | open |
| Low | `npm run lint`: 7 findings remain, all in code from before Step 2 (it was 13 on `96bbb5f`) | 2 | open |
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
| Arbiter account | | | |
| Smart wallet (passkey) | `CDSI6FMLEA5LRMCTFU2RBMVBMFHWH4TJN7PEMEWSK477S4KP2KAKOKWY` (Step 2 probe) | | `npm run passkey:probe` |
| WebAuthn verifier (OZ, via kit) | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` | smart-account-kit deployment manifests. Checked on chain in Step 2: both run WASM `e63a030d…6b72b76` (`stellar contract fetch --id …`, then `sha256sum`) |
| Step 2 staging rights contract | `CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5` | — | `stellar contract deploy` (Step 2). Step 3 redeploys with USDC/arbiter |
| Testnet fee payer (D6) | `GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z` (`qs-fee-testnet`) | — (no server key on mainnet) | approved as the fee key at the Step 2 review |
| SEP-45 web-auth contract | `CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM` | later, deployed by us | `npx tsx scripts/deploy-web-auth.ts --network testnet --source qs-issuer` (tx `31f480413f355f51a545a2817ccdb1a8e163eab5a49d6f59a92debda5b825ff1`) |
| Web-auth WASM (must match) | `708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1` | | built from java-stellar-anchor-sdk @ `dc5817fb` |
| Web-auth admin (unusable) | `CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2` | same | SHA-256("QuietStay SEP-45 web-auth: no admin"); no contract at it |
| SEP-10 / SEP-45 signing key | `GDC2YUKYIPDETC6M7QVOL4222SJF6MVYCW5ZOOVFQEZQQPYIENPLRRGQ` (exists) | must be funded | `qs-sep10-server` |
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
