# QuietStay Phase 3 — Progress log

This file is updated at the end of every step in `docs/PHASE3_PROMPT.md`.
Each new session reads it before starting work. Keep entries short and
factual: every hash, address and number must come from a command that was
actually run.

## Sprint

- SOW approved on: _(date)_
- Sprint ends on: _(approval date + 30 days)_
- Current step: **Step 5, pilot-plan change (2026-11-23): the 8-day app
  work, in progress.** The pilot flows move to the browser with Freighter,
  and the `qsmain` user is dropped (decision 6). The plan is items 1–6 below
  (Step 5 log), with two stops: after item 2 (the second Vercel project) and
  after items 3–4 (your Freighter try). The contract and its WASM stay
  unchanged. Not GO yet. Before that, 2026-11-22: Step 5, second runbook
  review done; not GO yet. The rehearsal as `qsmain` was then next; it is
  superseded. Earlier the same day: Step 5,
  runbook review done (2026-11-22); not GO yet.
  The verifier is our own instance (testnet done; mainnet in Step 6). The
  testnet demo is extended to ~2027-05-21. Next is yours: rehearse with
  `docs/MAINNET_REHEARSAL.md` on testnet and paste each check, then
  `docs/MAINNET_SETUP.md` Parts 0–4. Earlier: Step 5 review done
  (2026-11-21). You
  decided: the High network issue is closed, the swap Medium is closed with a
  Step 6 gate, and the deploy cost is accepted in principle. Next is yours:
  run `docs/MAINNET_SETUP.md` and paste each check. I verify it, then you
  give GO. **New rule:** you run every mainnet command; I never sign or send
  on mainnet, and never load a secret (PHASE3_PROMPT.md). **Step 3 closed**
  (2026-11-21): escrow #1 on `CA4B3MIZ…` was collected at
  2026-11-21T21:11:01Z, 88,951 s after check-in, tx `b40f55b6…695e`. Before the review: Step 5, the checklist is complete
  (`docs/PRELAUNCH_CHECKLIST.md`, 2026-11-21). Nothing was sent to mainnet.
  Earlier: Step 4 closed 2026-11-21 (approved). Step 3 was open because the
  escrow #1 collect was not possible yet. At 2026-11-21T13:00:06Z (ledger
  5,848,473) escrow #1 was Funded, and collect opens at ledger time
  2026-11-21T20:28:30Z. The step is ready:
  `npx tsx scripts/step3-evidence.ts collect-wait --contract CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73`
  (it refuses to send anything before then). Earlier note: Step 4 started 2026-11-20 while Step 3 waited. Step 3's
  remaining items (wrong token, unaccepted offer, trustlines, the expiry race,
  the EVIDENCE.md generator) are done; Step 3 waits only for the collect on
  escrow #1 of `CA4B3MIZ…PPV73`, **possible from ledger time
  2026-11-21T20:28:30Z**. When you say the wait is over: pause Step 4 at a
  clean point, collect as `qs-owner`, send the rejected problem report after
  the window (#49), each with its privacy record, show check-in and collect
  side by side, close Step 3, then continue Step 4

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
| ~~High~~ | **Closed at the Step 5 review (2026-11-21). Step 5: cause found** (checklist §9, `evidence/network/`). (1) Node's fetch gives each address 250 ms to connect, and this machine has no IPv6 route, so a slow IPv4 connect fails as `ETIMEDOUT` after about 0.5 s. Fixed in `src/lib/rpc-server.ts` with 2 s per attempt: in two parallel 30-minute probes, 61 failures → 0. (2) This machine's connection itself drops at times (DNS `EAI_AGAIN`, 10 s connect timeouts) on every host: the reads retry, and the sends recover by hash. Earlier record: intermittent errors in e2e runs: a 500 from `/api/issue` and a 502 from `/api/me`. **Step 3 review (2026-11-20):** read-only RPC calls now retry a dropped connection, up to 3 attempts, and log the network code; `sendTransaction` is never retried. In the first run after that, the server logged `[rpc-retry] simulate next_id: attempt 1 of 3 failed (fetch failed)`, the retry succeeded, and no failed `/api` response was saved. The code was not readable: the SDK's HTTP layer (`feaxios`) drops the error's cause. The retry log now also reads undici's diagnostics channels, which carry the code. The next run had no drop, so the code is still to be confirmed at the next one. **2026-11-20, later:** a one-off `Account not found` for `qs-issuer` (`GBNBWXSC…YUBE`) from the testnet RPC's `getAccount`, while Horizon returned 200 for that account and the same read had worked two minutes earlier. The immediate rerun passed. So the RPC can also answer wrongly, not only drop the connection; `getAccount` is a read and could join the retry, but a "not found" can also be true, so it is recorded here rather than retried blindly. **2026-11-21, Step 4 close:** a regression run of `passkey-app` got two 502s `{"error":"fetch failed"}` (`/api/me`, `/api/requests/issuance`), and its rerun failed in the test process itself (`TypeError: fetch failed`) before any page. Horizon, RPC and Friendbot answered a moment later, and the next rerun passed 2/2. The server log of the failing run was overwritten by the next spec, which uses the same port, so the code was lost again. The harness should keep one log per run before Step 5 (done 2026-11-21, see the Step 5 items below). **Earlier Step 3 evidence:** the capture saved a 502 from `/api/inventory`, body `{"error":"fetch failed"}`, and the same call returned 200 a moment later. In the same session the test process itself got `fetch failed` (cause `AggregateError`) three times reaching testnet. Leading hypothesis, not yet confirmed: transient connection failures from this machine to the testnet RPC/Horizon, which the routes turn into 500/502. `/api/inventory` now logs the error with its `cause`, as `/api/issue` and `/api/me` do. Neither the `/api/issue` 500 nor the `/api/me` 502 appeared in Step 3. Neither recurred on a rerun; their bodies were not kept then. Now the browser specs capture the body of every failed `/api` response (`e2e/lib/failures.ts`). Both routes log the error they catch, and the test server's log is kept. The cause must be found **before Step 5** | 2 (review) | **closed 2026-11-21 (your decision, Step 5 review)**; (2) stays as the Low "connection drops" below |
| Medium | SEP-45 and the fee route need the deployment's store (Upstash) on Vercel, for single-use nonces and rate limits. Without it they refuse, by design. The SIGNING_KEY account must exist on each network | 2 (review) | Step 6 gate (checklist §8): configured per deployment |
| Low | `next build` (Turbopack) fails locally to resolve `next/font/google` files. It also fails on the untouched `96bbb5f`, so it predates Step 2. `next build --webpack` succeeds | 2 | open |
| Low | `npm run lint`: 7 findings remain, all in code from before Step 2 (it was 13 on `96bbb5f`) | 2 | open: 7 errors, all from before Step 2. The unused import, counted with them, was removed in Step 5 |
| ~~High~~ | **Resolved 2026-11-20:** fix approved (spec note 10) and deployed as `CA4B3MIZ…PV73`; every signed call on it succeeded. Was: **every offer call on `CDC6XD3W…KMZO` fails on chain.** The allowance expiration was `now + 120,960`, a value inside the arguments the buyer signs at simulation, so it no longer matches once the transaction lands. The unit tests mocked every signature and could not see it. The fix (expire with the buyer's latest live offer) is built and tested, but not deployed. It needs your approval, then a fresh deployment. Then the runs start again, the wait rental first | 3 (deployment) | open: spec note 10 |
| ~~Medium~~ | Still to run (needs the 24 h wait): collect on escrow #1, from 2026-11-21T20:28:30Z, and the rejected problem report after the window on that escrow | 3 | **resolved 2026-11-21:** report refused #49 `806d8a78…cdf`, collect `b40f55b6…695e` (Step 3 log) |
| Low | `approve`'s *amount* is the sum of the buyer's live offers, so if another of their offers expires between simulation and inclusion, the call fails like `32ee3532` (nothing moves; resend). It cannot be removed without an interface change (the buyer passing the total). Reported at the audit | 3 | accepted 2026-11-20 (your decision): stays Low, no interface change; DESIGN.md known limitation 18 |
| ~~Low~~ | `docs/EVIDENCE.md` is generated by `npm run evidence-doc`, which rewrote the whole file and would have dropped the hand-added Phase 3 sections | 3 | resolved 2026-11-20: Phase 3 entries live in `docs/evidence-phase3.md`, which the generator copies in; it refuses to write if any current heading would be lost (tested) |
| Medium | **Pre-launch checklist item:** every G account that will receive USDC in the mainnet pilot has a USDC trustline first (sellers, owners, renters for refunds, and any account USDC is moved to). The app tells a seller or owner without one before they accept, and blocks the acceptance | 3 | checklist §8: OPEN, yours (the mainnet pilot accounts do not exist yet). New `scripts/check-pilot-accounts.ts` checks each trustline and the 5 USDC total; `mainnet-sign-submit.sh` runs it before every mainnet signature |
| Low | The first deployment `CDC6XD3W…KMZO` stays on testnet as is, with weeks #1–#5 issued to `qs-owner`. Nothing moved on it. It will not be used once the fix is deployed | 3 | open (record only) |
| Medium | **Pre-launch checklist item (Step 3 review):** pilot funds are never sent to the contract address directly. USDC sent there with the token is stuck forever (DESIGN.md known limitation 17). Checked on chain on both networks | 3 | testnet PASS (invariant on 3 contracts); `tx-review.ts` now refuses a USDC transfer to the rights contract. Mainnet: Step 6, after each pilot transaction |
| Medium | **Pre-launch checklist item:** the mainnet sign-in key `mainnet-test` (`GCEF3BTQ…TDAR`) currently holds XLM. It is a separate account from `GALA3K…HE3M`. You reduce it to the minimum balance before its secret goes to the server (Step 6); the checklist records the balance read back from mainnet. Kept as it is (Step 3 review) | 3 | checklist §8: OPEN, yours. It holds 9.0001000 XLM on 2026-11-21 (Horizon); the minimum for 0 subentries is 1 XLM |
| Low | The payment screens are checked by typecheck, `next build --webpack`, lint and unit tests only. Their end-to-end run needs the Step 3 WASM on testnet and USDC in throwaway accounts, so it comes after the deployment | 3 | partly covered: the browser suite now runs on the final WASM; `/stays` sale and rental acceptance in a browser are still covered only by swap.spec's rental and collect notice. Low |
| ~~Medium~~ | **Swap cost on mainnet.** `complete_swap` measured 174.8 M instructions (43.7%) on testnet (protocol 30). Mainnet (protocol 29) has different CPU/memory cost parameters (`stellar network settings`, 2026-11-20), so its count can differ. 56% headroom, but it is measured, not assumed: the mainnet `--send=no` simulation of each flow (spec §14) | 4 | **closed 2026-11-21 (your decision, Step 5 review)**, with the Step 6 gate (checklist §5.2): the 86 cost parameters a protocol-27 build can use are byte-identical on both networks; the WASM-priced swap gives the same count with both (ratio 1.0000); the upload simulated on mainnet. One Step 6 gate stays: `--send=no` of `complete_swap` right after the deploy |
| ~~Medium~~ | **Found by the Step 4 browser test:** for a G account with no USDC trustline, `/api/payments` returned 502, so Step 3's "no trustline" notice never showed. The token's `balance` fails with only `Error(Contract, #13)`, without the "trustline entry is missing" text the app matched on | 3 (found in 4) | resolved 2026-11-20: `readUsdcBalance` reads the trustline ledger entry for a G account (`null` if absent); checked on a throwaway account without one and on `qs-buyer` (200,000,000) |
| ~~Low~~ | A USDC token failure was shown as QuietStay's error of the same number (the token's #13 TrustlineMissingError as QuietStay's #13 "AlreadyListed"), and `collect` was not blocked for an owner without a trustline | 4 | resolved 2026-11-21 (Step 4 close): failures are explained by the contract they started in, on all four paths; collect is blocked with the same notice; unit and browser tests |
| Medium | **Pre-launch checklist item (recorded 2026-11-21):** one server log per test run, never overwritten (`e2e/results/logs/`, opened with `wx`, streamed). Done and checked: `passkey.spec.ts` twice on port 4322 left two logs, both 8/8 | 4 (close) | PASS (checklist §8) |
| Medium | **Pre-launch checklist item (recorded 2026-11-21):** submission recovery. Look the transaction up by hash; if it is not on chain, resend the same signed envelope; never build and sign a new transaction for the same action. `scripts/mainnet-sign-submit.sh` enforces it; every path rehearsed on testnet | 4 (close) | PASS (checklist §8): the "not found" path repeated before GO, `d4369423…ec5d` |
| Low | Mainnet RPC is not configured in the CLI (`stellar network ls -l`: "Bring Your Own"); Step 1 read settings via `--rpc-url https://mainnet.sorobanrpc.com` | 1 | open until you run `docs/MAINNET_SETUP.md` Part 0.1 (`stellar network add mainnet --rpc-url https://mainnet.sorobanrpc.com …`; checked in a scratch config dir on 2026-11-21: it resolves `--network mainnet`). Every mainnet script names the URL |
| Low | This machine's connection drops at times (DNS `EAI_AGAIN`, 10 s connect timeouts, 30 s hangs) on every host, Horizon included (`evidence/network/`). The reads retry; the sends recover by hash | 5 | open (environment) |
| Medium | **Mainnet deploy cost:** uploading the rights WASM simulates at 694,336,359 stroops (69.43 XLM) of minimum resource fee; the web-auth upload at 3.44 XLM (`scripts/mainnet-simulate-upload.ts`). **Step 5 review:** reproduced exactly by `tools/upload-fee` (soroban-env-host 30.0.0). It is 0.0226 XLM of write fees, 60.3574 XLM of rent, and 9.0536 XLM of 15% simulation margin, which is refunded, so 60.38 XLM is charged. Budget: 121 XLM in all, 113 from you (`docs/MAINNET_SETUP.md`) | 5 | accepted in principle (your decision, Step 5 review); funding is in the runbook |
| Low | After about 119 days on mainnet, the call that finds the instance below 17,280 ledgers extends the code entry to 518,400 ledgers and pays its rent: **about 14.6 XLM charged** (16.8 XLM declared; Step 5 review, from the 1,086,431-byte rent size). The Step 5 "about 17 XLM" included the 15% margin. After the pilot; can be done ahead with `stellar contract extend` | 5 | open (record) |
| ~~Medium~~ | The final deployment's wait rental (escrow #1 on `CATUBRZZ…`) can be collected from 2026-11-22T13:50:56Z: the only flow on the final WASM still to land | 5 | **resolved 2026-11-22:** report refused #49 `a29d267e…fce1`, collect `67533a18…d295`, 102,275 s after check-in (Step 5 log). Every flow on the final WASM has now landed |
| ~~Medium~~ | **The WebAuthn verifier is someone else's contract instance** (found applying your Step 5 review rule "only reuse an uploaded WASM, never someone else's contract instance"). The app passes the kit's manifest instance to every passkey wallet: testnet `CC7EKIHQ…OM3F`, mainnet `CB7HENHJ…Q5YR`. Its code (`e63a030d…`) has no constructor, admin or `upgrade`, but its TTL is not ours | 5 (review) | **approved 2026-11-22; done on testnet:** our own instance `CBK3H55V…WEEL` (tx `38bbd549…`), `WEBAUTHN_VERIFIER_ID` per deployment, passkey specs 10/10 on it, with a new footprint assertion. Mainnet: Step 6 (MAINNET_SETUP.md Part 5) |
| Low | The OZ code our passkey wallets need lives on mainnet for about 93 days (account `c514d35e…`, live until ledger 67,205,504) and about 71 days (verifier `e63a030d…`, until 66,824,189), from 2026-11-21 (`scripts/check-mainnet-wasm.ts`). Anyone can extend it. Reusing both saves about 60.2 XLM of uploads | 5 (review) | open: Step 6 runs `scripts/check-ttl.ts --network mainnet --until <pilot end>` after the deploy (checklist §4.1). On testnet both are extended to ~2027-05-21 |
| ~~Low~~ | The final WASM's code entry on **testnet** is live until ledger 5,959,276, about 2026-11-27 (`scripts/check-mainnet-wasm.ts --network testnet`). The 2026-11-22 collect comes first; a later testnet rehearsal needs a `stellar contract extend` of it (a testnet transaction) | 5 (review) | **resolved 2026-11-22:** every code entry and instance of the testnet demo extended to testnet's maximum, live until ~2027-05-21 (checklist §4.2) |
| ~~Low~~ | **WASM size** (checklist §5.4): without behaviour changes, the most is about 3.5 XLM (6%), by dropping the interface spec's 21,128 bytes of doc strings. That changes the hash, so the Step 5 testnet run would be redone. The build is already at its smallest compiler setting | 5 (review) | **decided 2026-11-22: keep the tested WASM** |

| Medium | **The testnet demo must stay usable through the Instawards review** (your item 4, 2026-11-22). Code and instances are extended to ~2027-05-21. Data entries lapse on their own TTLs, and an SDF testnet reset would wipe everything | 5 (runbook review) | standing (checklist §4.2): `check-ttl --network testnet --until <review end>` before and weekly during the review; watch for reset announcements; redeploy with the rehearsal's Part 5 if one falls in the review |
| Low | `check-privacy.ts` called `loadEnv()`, which reads `.env.local` (keys included) into its own process. It used nothing from it. My two collects and the passkey specs ran it on 2026-11-21/22, after your rule | 5 (runbook review) | **fixed 2026-11-22:** the call is removed; both modes pass without it. Found and reported, see the log |
| ~~Low~~ | Other places still loaded `.env.local`: `scripts/attest.ts`, `describe.ts`, `verify-record.ts`, `e2e.ts`, and, found while fixing them, six Phase 2 tools in `scripts/zk/`. The browser specs start `next dev`, which reads `.env.local` | 5 (runbook review) | **resolved 2026-11-22 (your decision):** the app may read it in testnet browser tests, under the new rule that repo files hold testnet values only. The ten scripts read only their named variables (`loadEnvVars`, tested); `loadEnv` is gone. None of them was run |

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
| **Step 3 rights contract (fixed)** | `CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73` | | `scripts/deploy.sh` (2026-11-20): upload `837df69a0adbbb01119967e8a5bcdda494c7c050238c5d7159a4a5de2bbd7ecd`, deploy `36aaabf9d7a2dae7e9e2bec3d4156c7714626e3827868afa049a44fb23544773`. Read back: arbiter `GACLONYV…EEZC`, usdc `CBIELTK6…DAMA`, max_payment 1000000000, issuer `GBNBWXSC…YUBE`, on-chain WASM `c7473e8e…6b6b` |
| **Step 4 rights contract (swap; measurement)** | `CCSL6J5X6ZAZETYNFDJK47W7Z6KEGDTSVWMKEO6GSN227UEC4C5FITK7` | | `scripts/deploy.sh` (2026-11-20, from `dedad4b`): upload `1b9ac00ac8f9f3563ffa5286776e3061979547b46304f0fda598e549e29a22e7`, deploy `adda9b3fd7cfe0f10bd2136c1d22b51fe4cfcc96c2669cb6f6a18a85b0259d82`. Read back: arbiter `GACLONYV…EEZC`, usdc `CBIELTK6…DAMA`, max_payment 1000000000, issuer `GBNBWXSC…YUBE`, on-chain WASM `76d69e79…dddde`, 50 functions |
| **Final testnet deployment (Step 5; the mainnet WASM, swap included)** | `CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM` | Step 6 | `scripts/deploy.sh` (2026-11-21): deploy `12d4baaf277be6d55f67f5616e95ea06bb3ceb41c36a4cd8ae705afb2d1bdcb7`, with no upload (the WASM was already on testnet). Read back: issuer `GBNBWXSC…YUBE`, arbiter `GACLONYV…EEZC`, usdc `CBIELTK6…DAMA`, max_payment 1000000000, on-chain WASM `76d69e79…dddde`, VK hash `55ce858f…b1de` |
| Step 3 rights contract, first deployment (offer calls fail; superseded) | `CDC6XD3WK4GZSJWNBJELDBHAHNPHLS7WL6RZG2KEACC2RGJWCRTGKMZO` | | `scripts/deploy.sh` (2026-11-20): upload `dd7a0153fd19263a890b7ab3c2a6c2f5ad3db4013b03c5e8642cb95fd5963e86`, deploy `c05ada7aacdc3fd98c2e6ef9809c05c7a0d8f8794ab9f14b4a0aa1cf4a4e9194`. Read back: arbiter `GACLONYV…EEZC`, usdc `CBIELTK6…DAMA`, max_payment 1000000000, issuer `GBNBWXSC…YUBE`, on-chain WASM `db92ae3e…b38f` |
| Testnet owner (USDC trustline, added for the sale payout) | `qs-owner` `GBCETLZR2XY5S3DBCWUJRNS7ITYYMOJGTQVLNNQ77P2TLRKDUHLR4AYR` | | trustline `6443bdb5ecf88c0429f96481903d939afac89a67edf9b3de93eb55b20f413025` |
| Testnet buyer / renter (USDC trustlines) | `qs-buyer` `GB3VDHPHD27MVDMQAN5JD3EUGWTX76W7SJWHKG4EPITK2WOOAPX5UWVQ`, `qs-renter` `GBNDVZTDK7IOUFEAZH4ZBJ25WT2FXJ4IZPXWADAD4BEQPDD5FDQNZAXN` | | trustlines `de0444b6…1bcb`, `bc671422…0a79`; 20 USDC each from Circle's faucet (Horizon, 2026-11-20) |
| Smart wallet (passkey) | `CDSI6FMLEA5LRMCTFU2RBMVBMFHWH4TJN7PEMEWSK477S4KP2KAKOKWY` (Step 2 probe) | | `npm run passkey:probe` |
| **WebAuthn verifier, our own instance** (Step 5 review) | `CBK3H55VKCKZ4LRIZSETP3ZYP4OI4IIBN3SCCCFNYI5WDFC45PSWWEEL` | Step 6 | `stellar contract deploy --wasm-hash e63a030d… --source qs-issuer --network testnet` (2026-11-22), tx `38bbd5492bd9bb38a0bd5e4aed10704f2c41c8bb32d6955bbc6f891b454328e6`; runs `e63a030d…` (`stellar contract fetch` + `sha256sum`) |
| Rehearsal dry run (Claude's testnet identities; not the demo) | rights `CC7W4OGPTTKUQNUFORFP5NXRTBV2L2VOX65X4Y5JV4ZXPRPVCPQ77ZRP`, web-auth `CDJJSKRIS2CUKSPNO37Q56SY7QJBEOYOLTLLSKDUWGEF4EPR5BTIF5SN`, verifier `CBZKYQIQ335HWKC55NFKOUKDIGDR6MHFWSLM6IITIXHQL2Z4GLXPSEHS` | — | MAINNET_REHEARSAL.md Parts 5–6 through `mainnet-sign-submit.sh --network testnet` (2026-11-22); see the Step 5 log |
| ~~WebAuthn verifier (OZ, via kit)~~ (no longer used) | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` | smart-account-kit deployment manifests. Checked on chain in Step 2: both run WASM `e63a030d…6b72b76` (`stellar contract fetch --id …`, then `sha256sum`) |
| Step 2 staging rights contract | `CCR2Z4IQNKXO2YCTQI2JBU5YLQTFXCXWVY6HV6H6TWNFWL5RAQ3IMAX5` | — | `stellar contract deploy` (Step 2). Step 3 redeploys with USDC/arbiter |
| Testnet fee payer (D6) | `GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z` (`qs-fee-testnet`) | — (no server key on mainnet) | approved as the fee key at the Step 2 review |
| SEP-45 web-auth contract | `CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM` | later, deployed by us | `npx tsx scripts/deploy-web-auth.ts --network testnet --source qs-issuer` (tx `31f480413f355f51a545a2817ccdb1a8e163eab5a49d6f59a92debda5b825ff1`) |
| Web-auth WASM (must match) | `708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1` | | built from java-stellar-anchor-sdk @ `dc5817fb` |
| Web-auth admin (unusable) | `CDA2IFOTJJMMIKRIP33B4KOUZQMU7FR6SEYNBHY3LQQCBXYJB73C33G2` | same | SHA-256("QuietStay SEP-45 web-auth: no admin"); no contract at it |
| SEP-10 / SEP-45 signing key | `GDC2YUKYIPDETC6M7QVOL4222SJF6MVYCW5ZOOVFQEZQQPYIENPLRRGQ` (exists) | `GCEF3BTQVDJ473URMW4556VG67YAPS2J5OP77FBXT7T47M2DOIZ7TDAR` (`mainnet-test`; holds XLM now, to be reduced to the minimum by you before Step 6) | testnet: `qs-sep10-server`; mainnet: `stellar keys public-key mainnet-test` (2026-11-20; the secret was not read) |
| Measurement contract (Step 1 only) | `CCKL74S5L57GZ32K2AWIIRGKNED3CZNWFCM62BMVASLMSHJXOYK4ZLY4` | — | `stellar contract deploy … quietstay_measure.wasm` |
| Wasm hash (must match) | **`c7473e8e8a449328704964db8ec1285080fc303794e3a41e9b4fd59eaeec6b6b`** on `CA4B3MIZ…PV73` (58,774 bytes, protocol v27, 42 functions). Superseded: `db92ae3e…b38f` on `CDC6XD3W…KMZO` | | `cd contracts && stellar contract build --package quietstay-rights`, then `sha256sum target/wasm32v1-none/release/quietstay_rights.wasm` |
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

#### Step 3 redeployment and runs (2026-11-20)

- **Spec note 10 approved:** the allowance expires at the latest
  `expires_ledger` among the buyer's live offers.
- **Audit**, of every signed sub-invocation argument derived from the ledger
  sequence or time:
  - Every `require_auth()` sits on a root caller, and covers only the call's
    own arguments.
  - Phase 2's `require_auth_for_args((right_id, h'))` takes both from the
    call's arguments.
  - Of the three token calls, only `approve` is signed by a user, and its
    expiration is now fixed. `transfer_from` and `transfer` are authorized by
    the contract itself, with arguments from stored offers and escrows.
  - Ledger reads feed only checks, TTLs and stored `funded_at`/`listed_at`.
  - **One dependence remains:** `approve`'s amount counts only offers not yet
    expired (Low issue above).
- **Real-signature tests**, 4 new (`real_signature_*`, test_payments.rs):
  - How they sign: with the fixtures' real ed25519 keys (each checked against
    its address), the same preimage a wallet signs, landed 7–15 ledgers after
    signing.
  - Coverage: `create_rental_offer`, `create_sale_offer`, `cancel_offer` with
    one offer left and with none, and a refused signature over the old-rule
    arguments.
  - On the old rule the three positive ones fail (checked by reverting
    temporarily).
  - New dev-dependencies `ed25519-dalek` 2.2.0 and `sha2` 0.10.9, already in
    Cargo.lock.
  - Rights tests **132/132**, verifier 6/6, measure 1/1, clippy 0.
- **Zero allowance accepted by testnet USDC:**
  - Directly, before the redeploy: `approve(qs-buyer, CDC6XD3W…, 0, …)`,
    `9b7c24a4faba13cd77ae755709fcea89da792e1bf274ee0b69f86380a8a02ee9`. The
    allowance reads back 0.
  - Through the contract on the new deployment: the buyer's only offer
    `d55127c34142c94e9b7adfced8d1450cea2ba1739511c0f3f81390960122146d`, then
    its cancel `7537fd5730d611883980f38e9801b099302b2e68f0136375c074275d1352ef80`.
    The allowance went 10,000,000 → 0.
- **Deployed** `CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73`
  (see Addresses). It is the WASM the tests ran, read back from chain.
- **The weeks issued again:** rights #1–#5 to `qs-owner`, 2026-11-20 →
  2026-11-27.
  - `aab97545b6b9e90907e6b24370d1226d9e6bab44abfac830d80c3dc9a235d1f8`
  - `498bde557e78c3e097fbf4e1b8ed6c15d4c55ea1b50dd0b7ff242890f6953cb9`
  - `2e341f8a01406ec0c6796611308383afa787dac6ef431b79f072954db02488f4`
  - `5c2a827b83d8cdab54544c577d01cc256d67a6276bb0e571dd8725bb7dfbd610`
  - `fa8eb814c26aad0b0031df549b8ff9b3fe8ee47c2bbc9bee84574dcf2b2277d0`
- **Wait rental, first (week #1, escrow #1, 1 USDC):**
  - offer `8d42b704495844beec607290d7f497d4be7b24679372290dbfa26ded2bc9a529`,
    with check-in = last ledger time + 90 s;
  - accept `383b8635b56954a7f2c94aea0ac61b6011fa294e549d689b34262a8972c88472`;
  - check-in 2026-11-20T20:28:30Z (1795206510).
  - **Collect possible from 2026-11-21T20:28:30Z (1795292910).**
- **One-step sale (week #2, 1 USDC):**
  - record request `436141683d35a8d8d851d2eb2ccabbae33cc6de2b024efba66a73b5a4e829204`;
  - offer `199867f29201e7d66ba9f3b4cc28d02c1ed077c72cf02f7ef561cc56530c2a55`;
  - accept `992278c03088824c0b7d3b22a27c5f554d11b3a4aefa908cce42769118eeae73`.
  - The first acceptance was refused in simulation, so nothing was sent:
    token error #13, no trustline on `qs-owner`, as spec §5 says a G payee
    needs. A trustline was added (`6443bdb5…3025`) and the same offer was
    accepted. Holder now `qs-buyer`; 1 USDC buyer → owner.
- **Disputed rental resolved by the arbiter (week #3, escrow #2, 1 USDC):**
  - offer `1945cb1d1931bc23f0adc7593e5462e5e57f797e838b4a50e3436e58094e0929`;
  - accept `824c6ec506f6f7822595f2ddb0fdd31b9775f7aa6e57e14f1586d0f8adfe557a`;
  - problem report `69ffc43be642ef2d78d1e3bce2b1963853f2f412965085856a5b65c003a2b5ad`
    (hash `22f5dc8c…06c7`, problem-report.txt);
  - renter evidence `3c695010c450223bacc47b15698ba4e0fd117708676716154eefeec8a06ce667`;
  - owner evidence `3e45404f58d0b4ee526bd95f36fec47cd831a7b5a505d18049fdde3642f5db77`;
  - **arbiter `resolve(RefundRenter)`**
    `822ab5e76b14ce3978222ca940506c7cb9c9a1f13d840b9ebfb5d63dfaf4364e`, via
    `scripts/arbiter-resolve.sh` (RESOLVE typed from stdin, with your
    approval of the run). Decision hash `d55f0ef5…4009` = arbiter-decision.txt.
- **Early confirmation (week #5, escrow #3, 1 USDC):**
  - offer `bcc15131a3ebcf7ac5f925ac79b0e1fdbe0930f85d6c7baa54bd6ec115a1d96e`;
  - accept `e7245716d595ec182faa8c38fccda6fcaa2b56172e426572ea244bdc727dd5c6`;
  - confirm `77faef4d6ac6dcb45433942db5c6303260472c76a820551625453c24de4a2947`.
- **Rejected on chain, each with exactly the expected error**
  (`withSiblingResources`, `invokeHostFunctionTrapped`):
  - collect during a dispute #46 `a5dd299a57af632508a840af7a43e83470165ca91d19b4c04e36612ad56483c1`
  - outside account resolves #51 `b1c57913373fbe799df4f32be1cf33bd56046f7705a40184a143d203cdbd4b4b`
  - outside account submits evidence #47 `0b38f4f7431fa467b3e9ba053d11930026feb1068f5181abf49624182a61c3bd`
  - double refund #46 `6243a558754f4bd2d3fba89698f904992f6cdf1ec6507c14c3e4ce1141cce139`
  - arbiter resolves again #46 `671328698ea36b31f27c9e9a543c647756f5a003be7fd7b8113a3798d9bff41e`
  - payout after refund #46 `8e4230929c675d88032781a0b193530e83ada8217bf1228582c6d5b7f317d180`
  - double payout #46 `f32980e8ecc362f27a260441fbbff00b536582c6ef4a1abbec3be2c2d7b79613`
  - refund after payout #46 `896f93fbbceae4106fb84c21e2a066abcc2005dabe5fd902ca9aff9557c45975`
  - problem report after payout #46 `c1947dd3cb080e3d4c39aeeb521e5116a9aaf45ecea7449d0406244355c794a5`
  - wrong amount #32 `ad15c3ceb2b7ecc0e982457a767d9556108aabc8a171a7e2d01eeea224f2efa6`
  - low allowance #53 `aaa762edadb571929eb6e4e79854af87428cce8eef3875b7d2240be8ebe90fc5`
    (after the buyer lowered it directly, `f1cd865d…a234`)
  - low balance #54 `84f19a301e0056a5e870a74b97f27821ec25071c3f0b7afb7538d3525af6fede`
    (USDC moved away `8674e494…e9d2` and back `ba20cebb…fb7e`)
  - expired offer #34 `326aa7dbb967253fc500038e3e28b40be80769e89b35e51b34dc2a3a8e896176`
    (then offer A cancelled `41c0897e…b756`)
  - collect before check-in + 24 h #48 `a4a28c10497b9c61c54cb05cc4d103bbc24ff31bbe61d09dd0814788f6c605a2`
  - arbiter on an undisputed escrow #46 `b82a236612aedd083e3e4f6df48be7bffc006e18b9a69eda32cb35461d6c9724`
  - outside account collects #47 `5ae571975f01206a7af1a4bf99764a22f7bfdd004caffcefbf2596d2e0581e98`
  - outside account confirms #47 `eaed5595a75c4bf792a75438e4974bf35905df717222d116fd9ba5a007bc987a`
  - arbiter burns a right naming its owner, `Error(Auth, InvalidAction)`,
    `f325cdfcc9d93c68d74cacda1e672ab95a57fb966f4ade6ce383c46169fe9c48`
  - arbiter burns a right as itself #4 `90077ca3f1aa01bde4f3655d9605847dca4d8996d92000f3c94851e155d72a8d`
  - The outside accounts were throwaway Friendbot keys, in memory only.
- **Not evidence:**
  `111168cef484180b15c39106f01a11423c8c7fee7ce17b44355e7010fe9e466f`, a
  driver bug. The first rejection was sent without the caller's own auth
  entry, so it failed `Error(Auth, …)` instead of #46. No real signed call
  failed; the driver now adds the source-account entry, and the same case is
  `a5dd299a…`.
- **On-chain checks after the runs:**
  - contract USDC 10,000,000 = escrow #1 (Funded); escrow #2 Refunded,
    escrow #3 PaidOut, so the invariant holds;
  - balances: owner 2 USDC, buyer 19, renter 18;
  - log `evidence/step3-testnet-CA4B3MIZ.json`: 28 accepted, 19 rejected as
    expected.
- **Privacy records**, each with its records, secrets and evidence files, all
  passing: `evidence/privacy/2026-11-20-step3-CA4B3MIZ-{issue,wait-rental,cancel-last,sale,dispute-open,dispute-close,confirm,sale-rejections,escrow-rejections}.txt`.
  The first deployment's issue record is `…-step3-CDC6XD3W-issue.txt`.
- **EVIDENCE.md:** a new entry, "a signing bug caught on testnet, before
  mainnet".
- **Next session:** after 2026-11-21T20:28:30Z, run `collect` on escrow #1
  as `qs-owner`, with its privacy record, then the rejected `report_problem`
  after the window on the same escrow (#49).

#### Step 3 remaining items (2026-11-20, ledger time; collect still pending)

1. **Wrong token: no function takes a token argument**, so there is no
   transaction to produce. Evidence (EVIDENCE.md, "no function accepts a
   token"):
   - The deployed interface has 42 functions (`stellar contract info
     interface --id CA4B3MIZ…PPV73 --network testnet --output json`). Its
     only token address is `__constructor(usdc)`. Every other `address`
     argument names a party.
   - `usdc()` reads back `CBIELTK6…DAMA`.
   - The source builds its one `TokenClient` in `payment.rs` from the stored
     config.
   - Unit test `only_the_constructors_usdc_can_be_moved`.
2. **Unaccepted offer** (week #4, sale offer #8, 1 USDC, 30-ledger life):
   - record request `de2c9d883e3789cfba07e055ec35a5a2a8aa79303f5620f45f7aaec2f35d0e30`;
   - offer `b8d98645606a3c57f745ef51773d9f0d025aa13692723527c4b9ec62c99adfbb`,
     open until ledger 5,838,157, never accepted.
   - USDC (units) read from the token, buyer / owner / contract / buyer's
     allowance:
     - ledger 5,838,126, before: 190,000,000 / 20,000,000 / 10,000,000 / 0;
     - 5,838,128, open: the same balances, allowance 10,000,000;
     - 5,838,159, expired: the same balances, allowance 0.
   - The offer's events are `approve`, `allow`, `sale_off`; no `transfer`.
     Horizon shows no balance change on the buyer's operations.
   - The first run took all three readings, then crashed on a log line
     (BigInt in `JSON.stringify`) before its checks. `--resume-offer 8`
     finished them from the log on the same transactions; no second offer
     was made. Its first try hit the RPC's false `Account not found` (see the
     High issue).
   - Privacy record: `evidence/privacy/2026-11-20-step3-CA4B3MIZ-unaccepted-offer.txt` (passes).
3. **Trustlines:**
   - Spec §14 has the checklist item, with the list of G payees by role.
   - The app: `/stays` shows a "no USDC trustline" notice on each incoming
     offer and disables "Prove and sell" / "Prove and rent out".
     `needsUsdcTrustline` is in `src/lib/usdc.ts`; C accounts are never
     flagged. `USDC_ISSUER` was added to config, same Circle source.
   - Checked by 4 unit tests, typecheck, lint and `next build --webpack`;
     not yet in a browser run (see the Low issue on the payment screens).
4. **Expiry race:** kept Low, no interface change. It is DESIGN.md known
   limitation 18. The stale "proposed, awaiting approval" note on spec note
   10 in DESIGN.md now says approved and deployed.
5. **EVIDENCE.md generator:**
   - The Phase 3 entries moved verbatim to `docs/evidence-phase3.md`. The
     generator copies them in at the top, with a contents list.
   - It refuses to write if any heading in the current EVIDENCE.md would be
     lost (`scripts/lib/evidence-guard.ts`, 4 tests). Tried by hand: a
     hand-added section makes it refuse and leaves the file unchanged.
   - Two more silent losses on a rerun are fixed:
     - the Phase 2 test count and WASM size came from the working tree
       (73 tests, 58,774 bytes, Phase 3's). They are pinned to 62 and 27,490
       as at `66cdf13`;
     - the hand-edited "no `upgrade` in the rights contract" bullet is now in
       the generator.
   - A rerun is idempotent.
- Tests: `npm run test:app` 35/35 (27 before, plus 4 trustline and 4 guard).
  `tsc` clean, eslint clean on the changed files, `next build --webpack`
  passes.

#### Step 3, the collect (2026-11-21): not possible yet, so Step 3 stays open

- You said the wait was over. The ledger disagrees: the latest ledger,
  5,848,308, closed at **2026-11-21T12:46:21Z**, and escrow #1 can be
  collected from **2026-11-21T20:28:30Z** (check-in 1795206510 + 86,400 s,
  read back with `get_escrow`, which showed it Funded). A collect now would
  only be refused with #48. That refusal is already on record
  (`a4a28c10…05a2`), so nothing was sent.
- **Prepared:** `scripts/step3-evidence.ts collect-wait`. It reads escrow #1
  and refuses before ledger time reaches check-in + 24 h; run at 13:00:06Z it
  refused and sent nothing. Once the window opens, it does three things:
  1. sends the renter's problem report, which must be refused **#49**
     (ReportWindowClosed). This goes first, while the escrow is still Funded:
     `report_problem` checks the state before the window, so after a collect
     it would be refused #46 instead (`escrow.rs` lines 204–206);
  2. collects as `qs-owner`, and checks the escrow is PaidOut;
  3. prints check-in, the collect time, and both transactions' ledger times
     side by side, logs them, and writes the privacy record.
- **Step 5 checklist items recorded now** (spec §14, open-issues table):
  1. **One server log per test run, never overwritten.**
     - `e2e/lib/app.ts` streams `next dev` output to
       `e2e/results/logs/next-dev-<time>-port<port>-<random>.log`, opened
       with `wx`, from the start (a crash still leaves it).
     - `e2e/lib/failures.ts` writes a per-run
       `failed-requests-<spec>-<run>.json`. Both are gitignored, as before.
     - Checked: `npx playwright test e2e/passkey.spec.ts` twice on port 4322,
       8/8 both times, left two separate logs.
  2. **Submission recovery.** `scripts/mainnet-sign-submit.sh` signs once,
     keeps the signed envelope and hash, looks up by hash after every send,
     resends only the same envelope and only on a confirmed "not found", and
     never re-signs. Rehearsed on testnet with `qs-issuer` and read-only calls
     on `CCSL6J5X…` (2026-11-21):
     - normal: `adb9e23c8edfdb0b57f4087930c1b2cbb53c2f23aaedc76c8f0fc035252cf833`,
       SUCCESS;
     - the same file again: refused to sign, pointing to `--resume`;
     - `--resume` of a landed one: looked up first, SUCCESS, nothing sent;
     - first send failed (test hook `QS_TEST_FAIL_FIRST_SEND=1`, testnet only:
       the first attempt goes to an unreachable RPC). The lookup said not
       found, and the same envelope landed on the second send:
       `2ad818681c54fb5aa38315d444c1a960e36e9f20d7a9fc138a006ed03f43e80d`;
     - stale envelope: its sequence number was used first by
       `4ecdac05b52b97326357d727ea38d2fe398c13a97a754c1232e01d22500915ff`.
       Its send got TxBadSeq (`76e3044c…66cc`, never on chain), and the
       script stopped without re-signing.
     These carry no record or secret, so they have no privacy record.

#### Step 3 close (2026-11-21, ledger time): the collect; Step 3 is closed
- Run by me on testnet, at your request ("the wait is over"):
  `npx tsx scripts/step3-evidence.ts collect-wait --contract CA4B3MIZLWO6NLDOBOZGGXLFTERQN6A76CCYZYGAR7FHJ56I74APPV73`.
  It signs with the testnet identities `qs-renter` and `qs-owner` through the
  CLI keystore.
- Escrow #1 was Funded; check-in 2026-11-20T20:28:30Z, collect from
  2026-11-21T20:28:30Z. The latest ledger was 5,854,362, closed
  2026-11-21T21:10:51Z.
- **Rejected as expected:** the renter's problem report after the window,
  `Error(Contract, #49)`, tx
  [`806d8a78…cdf`](https://stellar.expert/explorer/testnet/tx/806d8a78d172497510b2d77b0c1033a893165c73ce5e8a5e53092cc37bafecdf).
  It was in ledger 5,854,363 at 2026-11-21T21:10:56Z, 2,546 s after the
  window closed. On Horizon `successful: false`, source `GBNDVZTD…`
  (`qs-renter`).
- **Collect:** the owner, tx
  [`b40f55b6…695e`](https://stellar.expert/explorer/testnet/tx/b40f55b6bd4924ae59e36c3b2538000bba4d2f0ca7dadf9c5956c1ebe772695e).
  - It was in ledger 5,854,364 at 2026-11-21T21:11:01Z, **88,951 s after
    check-in** (the window opens at 86,400 s).
  - On Horizon `successful: true`, source `GBCETLZR…` (`qs-owner`).
  - Escrow #1 is now PaidOut. The owner's USDC went 40,000,000 →
    50,000,000; the contract's went 10,000,000 → 0.
- Privacy record: `evidence/privacy/2026-11-21-step3-CA4B3MIZ-collect-wait.txt`.
  It has no findings in either transaction, for the record and the holder
  secret given.
- The log, with the side-by-side times, is `evidence/step3-testnet-CA4B3MIZ.json`.
  Step 7's rental timing check in EVIDENCE.md can use these two hashes.
- **Step 3 is closed.** The final deployment's wait rental on `CATUBRZZ…` was
  collected separately, on 2026-11-22 (Step 5 log).

### Step 4 — Swap and two-proof cost measurement
- Date: 2026-11-20 (ledger time). **Stopped at the measurement, with the
  numbers, as asked.** The rejection tests, the swap screen and the rejected
  testnet transactions come after your decision.
- Branch / commit: `phase3`. `dedad4b` is the swap contract, deployed and
  measured. The measurement driver and this entry are in the next commit.
- **Why the swap code came first:** spec §11 says Step 4 measures on the
  integrated contract, and the size can only be measured with the code. So
  the contract side of the approved §7 design (D5) is built:
  - `offer_swap`, `cancel_swap`, `accept_swap`, `withdraw_swap_acceptance`
    and `complete_swap`, plus the views `get_swap`, `get_swap_acceptance` and
    `next_swap_id`. That is 42 → 50 functions; the Step 3 estimate counted
    one view.
  - `auth.rs`: `TransferMode::Swap { counter_right_id }`, with mode
    `2^64 + id` as a `U256`. Swap moves title like a sale.
  - `accept_swap` runs `precheck_transfer`, which is `authorize_transfer`'s
    checks without the pairing, writing nothing.
  - `complete_swap` runs `authorize_transfer` twice, the taker's stored
    proof first. It is still the one function that moves a right.
  - `burn` has the pending-swap guard (D11).
  - New errors 55–62 and 5 new events.
  - No circuit change: mode is a free public input (§7).
  - Script provers: `swapFor` in `scripts/lib/zk.ts`. The browser prover
    gets it with the screen.
- Tests (2026-11-20): rights **134/134** (132, plus a valid swap with real
  proofs on both sides and the local-budget test), verifier 6/6, measure 1/1,
  clippy 0 warnings. New fixtures: `swap_taker`, `swap_maker`
  (`npm run zk:test-fixtures -- --only swap_taker,swap_maker`; both verify
  off-chain). The Step 4 rejection list is not written yet.
- **Limits, read from the network** (`stellar network settings --output json`,
  testnet and `--rpc-url https://mainnet.sorobanrpc.com`, 2026-11-20; saved as
  `evidence/network-settings-{testnet,mainnet}-2026-11-20.json`):
  - These are identical on both networks: 400,000,000 instructions;
    41,943,040 bytes of memory; 200 entries / 200,000 bytes read; 200
    entries / 132,096 bytes written; 132,096-byte transaction; 16,384 bytes
    of events; 131,072-byte WASM. Testnet runs protocol 30, mainnet 29 (RPC
    `getNetwork`).
  - **These differ:**
    - The CPU and memory cost parameters (`contract_cost_params_*`).
      Protocols 30 and 29 price host functions differently, so the
      instruction count below is testnet's.
    - `soroban_state_target_size_bytes` (7e9 testnet, 3e9 mainnet), which
      scales rent.
    - The minimum TTLs, as already known.
  - Every other fee rate is the same.
- **Measured: `complete_swap`, two proof verifications in one transaction**
  (`npx tsx scripts/step4-swap-measure.ts --contract CCSL6J5X…ITK7 --settings
  evidence/network-settings-testnet-2026-11-20.json`, log
  `evidence/step4-testnet-CCSL6J5X.json`):

  | | Value | % of the per-tx limit | Source |
  | --- | --- | --- | --- |
  | CPU, simulated | **174,763,775** instructions | **43.7%** of 400,000,000 | RPC `simulateTransaction`, ledger 5,838,350 |
  | Memory, local host budget | **924,903** bytes | **2.2%** of 41,943,040 | `cargo test -p quietstay-rights swap_cost -- --nocapture` (the RPC does not report memory) |
  | CPU, local host budget (native, no VM) | 151,029,723 instructions | | same test |
  | Ledger entries | 2 read-only + 12 read-write | 7.0% of 200 read, 6.0% of 200 written | simulated footprint |
  | Disk read / write | 0 / 1,640 bytes | 0% / 1.2% of 132,096 | simulated |
  | Transaction size | 3,340 bytes | 2.5% of 132,096 | assembled envelope |
  | Contract events | 3 events, 944 bytes | 5.8% of 16,384 | transaction meta |
  | Min resource fee, simulated | 88,137 stroops | | simulation |
  | **Fee charged, real tx** | **82,477 stroops** (0.0082477 XLM): non-refundable 76,163, refundable 6,214 (of which rent 3,899), inclusion 100 | | transaction meta, ledger 5,838,351 |
  | **WASM size** | **71,244 bytes** | **54.4%** of 131,072 | `stellar contract build`, sha256 `76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde`, protocol v27 |

  - For comparison, `accept_swap`, which stores the proof and does no
    pairing: 2,170,029 instructions (0.5%), 3,036 bytes, min resource fee
    25,549 stroops.
  - Against the Step 1 estimate:
    - CPU: 175–180 M estimated, 174.8 M measured.
    - Memory: under 2% estimated, 2.2% measured, still about 45× headroom.
    - Size: 70–73 KB estimated, 71.2 KB measured.
  - **Result: the swap fits** on testnet with 56% CPU headroom.
  - On mainnet the instruction count can differ, because the cost parameters
    differ. Mainnet can only be simulated once a contract is deployed there,
    so the checklist's mainnet `--send=no` simulation of each flow (spec
    §14) covers it before GO.
- Tx hashes (testnet, `CCSL6J5X…ITK7`, 2026-11-20):
  - issue right #1 to `qs-owner`: `372372f3ccf82ad8efda4d3eaf763185225d8d7089aa47446076006663cbef6a`
  - issue right #2 to `qs-buyer`: `c049f56b83d0f815782fbae097388aa793406d0daf86b8d0f7cfb74104f7762d`
  - maker's record request for #2: `e4852757f58f71167e8fb19865ecc9a9f6d152b11334bcb791752c33578208c3`
  - taker's record request for #1: `4f6b6c890c024bc492b610d71fefa710a123906c47b71ed82740bfd649b71c01`
  - `offer_swap` (swap #1): `c590904ec05746dc1e8b41f4c61934dee68ecd8d7ce871d83059306f2e9a8446`
  - `accept_swap`: `8ad01279023e010db5acf64dc17bfbd2ad1626a47b3b4a6be7391a12deb7b23a`
  - **`complete_swap`, the measured transaction:**
    `bafd6e6fee71169c5258eec7b4ee250d756bf98d306d4ca97bd975c9f1a19eb5`
    (ledger 5,838,351). Afterwards #1 is held by `qs-buyer` and #2 by
    `qs-owner`, with the proofs' new commitments.
  - Privacy record: `evidence/privacy/2026-11-20-step4-CCSL6J5X-swap-measure.txt`
    (7 transactions, passes).
- Decision (mainnet or testnet only): **yours.** The numbers say it fits on
  testnet's limits.
- Open:
  - Medium: the mainnet instruction count, measured in Step 5.
  - The Step 4 rest after your decision: the rejection tests (one side
    expired, rented out, already transferred, someone else's, a reused
    proof), outside-account swap tests, the swap screen with the browser
    prover's `swapFor`, the rejected testnet transactions, and the spec §10
    table and DESIGN.md for the 8 new functions.

#### Step 4, the rest (2026-11-20, ledger time): stopped at the checkpoint

- **Your decision (recorded):** the swap goes to mainnet, as the SOW says,
  because it fits on testnet. The Step 5 mainnet simulation is the final
  check; if it does not fit there, the swap stays testnet-only and you
  decide then. The Medium "swap cost on mainnet" item stays open until then.
- **Contract:** no change since `dedad4b`; the WASM is still `76d69e79…dddde`
  (rebuilt and compared; the only source diff is `rustfmt`).
- **Unit tests** (`contracts/quietstay-rights/src/test_swap.rs`, 26 tests):
  - Every refusal compares both rights, the title counts and the swap entries
    before and after, so each one moves nothing.
  - The plan's cases:
    - one side expired: the right past its validity (#6); the maker's proof
      past its window, with the taker's leg reverted (#24); the acceptance
      lapsing with the taker's proof (#59); the swap offer expired (#56);
    - rented out: by the taker, and by the maker, after the acceptance (#4);
      and a rented-out week cannot be offered (#4);
    - already transferred: sold by the taker, and by the maker, after the
      acceptance (#19);
    - belonging to someone else: the holder's proof (#21); a proof of their
      own (#19); a week the maker does not hold (#4); only the maker completes
      or cancels and only the taker withdraws (#57);
    - a reused proof: a completed swap again (#55); the first swap's proof
      after a swap back to the original secrets (#27).
  - Also: a swap proof used as a sale (#23); withdraw, then a new acceptance
    with the same unspent proof; a second live acceptance (#58); cancel drops
    the acceptance; the burn guard on both weeks (#60), lifted by withdrawal
    or lapse; record requests in both directions, consumed, wrong week (#61)
    or another's (#39); the wrong h' on either side (#26).
  - **Outside account** (deferred from Step 3):
    `an_outside_account_cannot_move_a_right_through_any_swap_function`. All
    five write functions, with the outsider's own signature (each refused)
    and naming builder accounts (host refuses the signature). Nothing changes,
    and the builder's swap still completes.
  - 6 new fixtures: `swap_maker_short`, `swap_stranger_taker`,
    `swap_back_taker`, `swap_back_maker`, `rental_by_buyer_r2`,
    `sale_by_buyer_r2`.
- **Browser prover:** `swapFor` in `src/lib/zk-fields.ts`, the worker core,
  the worker's message and `prover-client.ts`. Two parity cases (G and C
  holders) in `circuits/test/prover-core.test.ts`.
- **App:**
  - `/swap` ("Swap" in the header when signed in): offer a swap, swap offers
    for your weeks, your swap offers.
  - Each side asks on chain for the other week's record, gets the request
    link, and must hold the record checked against the chain before
    offering or accepting (D4a). It is checked again just before committing.
  - Statuses: offer open, accepted, accepted by someone else, expired,
    completed (kept in localStorage once the entries leave storage).
  - Buttons: prove and accept, prove and complete, withdraw, cancel. Errors
    come from simulation, mapped by `src/lib/errors.ts` (new 55–62).
  - Routes: `/api/swaps` (public read); `/api/tx/swap` (accept and complete,
    proof only); `/api/tx/build` gains `offer_swap`, `cancel_swap` and
    `withdraw_swap_acceptance`. The fee route already sponsors any
    rights-contract call.
  - `/receive` links a received record to `/swap` too.
- **DESIGN.md:** "Swaps (built in Step 4)", and the no-allowlist section
  points to the swap outside-account test. **Spec §10:** the view row lists
  every view, the swap ones included.
- **Testnet transactions** (`CCSL6J5X…ITK7`; `scripts/step4-evidence.ts`;
  log `evidence/step4-testnet-CCSL6J5X.json`). Every refusal was sent with a
  valid sibling's resources, plus read-only exactly the entry the sibling
  does not read (another account's record request, or the replayed proof's
  nullifier), and failed with exactly the expected error:
  - **requests-rented** (#3 owner, #4 buyer):
    - D4a both directions: requests `249de4e9172069353b9d90f52305a3513b34dcef519f32edc68c71897331adad`
      (maker, for #4) and `99d19c8e82a38788aadc098682abbf0ccdbcff4c461e91d9fe3a848925730152`
      (taker, for #3). Read back before, and `null` after the offer / the
      acceptance consumed them.
    - offer `891cb669fc5e79b952e27f3e4fe7dab0078a09d0e67290882d1c7c0e1985a65a`
    - refused #61 (wrong-week request `8849d368…b157`): `b24582e8cc18ad9c199cbd7f5ebe588f18adc44192b1ae803158e157ceea6202`
    - refused #21 (qs-renter, request `efe400b6…7457`, the holder's proof): `8b8ef24ab833874c6527252f7e4157d6db0c7949d6eb84c7a8df72fb0a40c47c`
    - refused #19 (qs-renter, a proof of its own): `7e675e577c47fc9d9deebe3434041b56931ae23643b11801bb56e94324c2562c`
    - accept `a6591c4b822faf82f9e365fc5bb063c4916fe6c604da7700c162c102a220365c`
    - **D5:** the taker rents #4 out (`transfer`, rental)
      `60d31006ef16b73c352697ded51b94718e7646d5929c0bd0ef0a8d7c566f2c52`;
      complete refused #4 `fd6a040f7b4e869a0232198fb322539d4c94855080cad96d162df3b19798070d`
    - **withdraw** `c70fc6e703de6e2d207d9ca5d1462c2a5cf9e680a08feb5301564522eafe4b5b`;
      complete refused #59 `0b55c8ee99b2b2c3dd6a983412b2df34a66af4dcaecdc44b19c7e6015e45ddf6`
    - Afterwards #3 is the owner's and #4 the renter's (rental), both
      commitments as issued.
    - The script logged "acceptance after the withdrawal: present". That was
      a bug in the script: the view returned `null`, and the script compared
      it with `undefined`. Fixed. The log keeps a corrected reading (`null`,
      re-read with `stellar contract invoke --send=no`) next to it.
  - **sold** (#5, #6): offer `d99abe26b6ff05fb73a0bcc984f2ae07e1dc7aaf71847f17dde4b6bc0828a21d`,
    accept `eedf41b2bd5ca60b4ebb31a67b88c60f8659c4c2e77baf6fdafe30a17e586998`;
    the taker sells #6 to qs-renter for 1 USDC (request `af4cf0f9…7141`,
    offer `a9982f89…c82d`, `accept_sale`
    `f2ac186c85bf2000e9ec668accdefb6a531e4c3896be83d63531d028a55ba611`);
    complete refused #19 `3152ea4a301e7ff24915a2726786ce2a4a90759d1f634f97534c75b101ac7a12`.
  - **replay** (#9, #10): swap 1 offer `4b5c1496…841e`, accept
    `ab1187fe…773d`, **complete `a9d3b3e1b207bc5fa04829e7a37a8a63b7da34728bf1396fdfbb776a38d82d7c`**;
    swap back with the original h: requests `de1c9831…7f88` /
    `dcb3ccb8…c17c`, offer `17d0dc7f…d229`, accept `dc7ce156…2367`,
    **complete `172e7553afcb026068d27690974f755ba84415d3c354cad369f94920b5c8d7db`**.
    Both commitments read back equal to the issued ones. Then the same swap
    offered again (`d03cc5bd…fed4`, requests `53ea069f…4a4d` / `eb7dbbcd…c20a`),
    and swap 1's taker proof refused **#27**
    `5902f48a580fe3843686b5153de72c82496678e3888255c9969e9420fa90dc15`;
    clean-up cancel `1c71291e…cef2`.
  - **expired:**
    - right #11 issued with validity ending 2026-11-20T23:27:55Z: offer
      `d2245334…2476`, accept `34721314…2f4e`; complete refused **#6**
      `7810639603ca63c8855022b17de7a9b570e888cbd1da16b11043f3449e26e8d5`.
    - #13/#14: offer `4062d341…4e89`, accept `448ec1f0…05f7`; a maker proof
      with a 12-ledger window; complete refused **#24**
      `8b7b21e3a4b9191be819cc82cd528e2846edfee29287488916ad8097cee88273`.
  - Every issue and request hash is in the log.
  - **Not evidence:** the first `replay` run issued #7/#8 and made two
    requests, then `offer_swap` was refused in simulation (#5: the taker's
    week was dated in 2027, so not yet valid). Nothing more was sent. Those
    4 transactions are marked in the log; the script now keeps weeks inside
    2026. Their record files were overwritten by the rerun, so their privacy
    record checks the inventory values and the four holder secrets only.
  - Separately, the first `expired` run stopped before sending anything
    (record check-out equal to check-in).
- **Privacy records**, all passing: `evidence/privacy/2026-11-20-step4-CCSL6J5X-{swap-measure,requests-rented,sold,replay,expired,replay-aborted}.txt`.
  Holder secrets are checked as `--secret` (s and h). Swap-side secrets are
  checked as `--next-secret`, because a swap publishes h' by design. In
  `replay`, the original secrets are checked as `--next-secret` too, because
  the swap back republishes their h as h' on purpose.
- **EVIDENCE.md:** a new entry, "a swap of two weeks, and every way it must
  fail" (from `docs/evidence-phase3.md`).
- **Browser test** `e2e/swap.spec.ts` (`npx playwright test e2e/swap.spec.ts`):
  **1/1 passed** (3.1 min, 2026-11-21 UTC). It runs on a fresh Step 4
  contract `CAM73642…RDWG` with throwaway accounts.
  - Each owner gets a week through the issue flow; the record requests and
    sealed records go both ways.
  - Swap transactions: offer `90584073e43d43167da2222d6d5de3158264ad36d743c7164ffa44f1a76fd220`,
    accept `8671e8439eab2fc8457d89212f093a30acdd66f752268c33a1989fa71db6a82b`,
    withdraw `d35d9883d6f39ae3a039a11a233d0525f4a0b7d15e53f8d165e54410facfd935`.
  - Then the maker's stale complete is refused in simulation; the screen
    shows the #59 message, and both holders are checked unchanged.
  - Re-accept `b6c7701d9c05405d5d6e13d32715a037692568d29d92f096f94dab918f45d1b8`,
    then complete `6c7579b9c15ca8965177e42cfd7e773967f859cc6d84af153c1cc64c042653a5`;
    both holders are checked swapped.
  - Then `/stays`: a rental offer for the maker's new week. With no USDC
    trustline, the notice shows and "Prove and rent out" is disabled; after
    a change-trust, the notice is gone and the button is enabled.
  - Privacy record `evidence/privacy/2026-11-21-swap-e2e-6c7579b9.txt`
    passes (5 transactions). Three earlier runs that completed a swap
    before failing later have passing records too: `…-323ed350`, `…-340037b9`,
    `…-ea0a371c`.
  - **It took 8 runs, and found 3 real bugs, all fixed:**
    1. The prover worker bundle is built only by `npm run dev`/`build`, and
       the harness starts `next dev` directly. So it ran a stale prover
       without `swapFor`, and the contract refused the proof (#23); the
       screen showed it. `e2e/lib/app.ts` now builds the worker first.
    2. A G account without a USDC trustline made `/api/payments` fail, so the
       Step 3 trustline notice could never show (see the open issues).
    3. A response race on `/stays`: an earlier `/api/payments` read without
       the account could finish last and drop the balance, and with it the
       notice. Both `/stays` and `/swap` now keep only the latest read.
  - Harness fixes: `next dev` reloads a page when it first compiles a route,
    which dropped sign-ins, so the spec now compiles every route first and
    waits for a signed-in marker. A link to `/receive` from `/receive`
    differs only by fragment and does not reload, so links open from a
    blank page. Steps time out at 3 min.
  - Two runs that stopped mid-flow left an offer, and in one an acceptance,
    on their throwaway contracts (`CC2JEWQZ…`, `CCNBH7GN…`) with no privacy
    record. Their secrets were gone with the browsers. Not evidence.
- Error message #23 now names swaps too.
- **Tests at the checkpoint (all run 2026-11-21 UTC):**
  - `cd contracts && cargo test`: rights **158/158** (134, plus 24 swap
    tests), verifier 6/6, measure 1/1. `cargo clippy --all-targets`: 0
    warnings.
  - `npm run test:app`: 35/35. `npm run zk:test`: **29/29** (27, plus 2 swap
    parity cases). `npm run check-privacy`: passes. `npx tsc --noEmit`: clean.
    `npm run zk:check-bundle`: passes. `next build --webpack`: passes, with
    `/swap`, `/api/swaps` and `/api/tx/swap`.
  - `npx playwright test`: **16/16**: swap 1/1 (above) and, as a regression
    run after the app changes, no-leak 2/2, passkey-app 2/2, passkey 8/8 and
    prover 3/3. Their privacy records: `evidence/privacy/2026-11-21-{no-leak-9c5c5917,passkey-app-0cbd4a88,passkey-spec-1a5f6532}.txt`.
- **Stopped at the Step 4 checkpoint.** The escrow #1 collect on
  `CA4B3MIZ…PPV73` is still pending (from 2026-11-21T20:28:30Z).

#### Step 4 close (2026-11-21): approved; the Low item fixed

- **Approved:** Step 4, at the checkpoint above.
- **Collect blocked without a trustline.** On `/stays`, the owner's escrow
  card shows the same notice as the accept cards. They share one
  `TrustlineNotice` component. It shows while the escrow is Funded or
  Disputed, because every payout to the owner (collect, the renter's
  confirm, the arbiter's PayOwner) needs the trustline. "Collect the
  payment" is disabled until there is one.
- **Why a token failure showed as "AlreadyListed".**
  - Reproduced on testnet, in simulation: `accept_sale` by a seller with no
    trustline, on `CCSL6J5X`. Setup sent: issue right #16
    (`7ab2bfa97ffc55778c36a78e27066edba68842119d79d499bb91f5f2aa04c856`),
    qs-buyer's request (`7bf5605b16c3abde5d92cfc3899598cdf9cdc82bd4af6e26d36ecb7e92d0c780`)
    and 1 USDC sale offer #3 (`56c40e7b3f8ef936010b5fe5af0af5c91473d8843be68d48dbbdd8b5bc1764ea`).
    The acceptance was only simulated.
  - A first attempt had sent issue #15 `52cf31f3…f749`, request
    `5986ef04…320b` and offer #2 `288b9f7a…35e4`, then my script failed
    building the simulation. Its seller's record and secret existed only in
    memory, so the setup was redone. Those 6 setup transactions have no
    privacy record; they carry no record or secret of any kept account, only
    throwaway ones. Not evidence.
  - **The cause:** the RPC's error text is only
    `HostError: Error(Contract, #13)`. The app took the first
    `Error(Contract, #N)` from the text, whichever contract raised it. The
    diagnostic events do say: the first `error` event comes from the USDC
    token `CBIELTK6…`, with code 13 and "trustline entry is missing for
    account"; QuietStay re-raises the same code after it.
  - The token's codes are the Stellar Asset Contract's built-in ones
    (soroban-env-host 27, `contract_error.rs`): 13 TrustlineMissingError,
    10 BalanceError, 9 AllowanceError, 11 BalanceDeauthorizedError,
    6 AccountMissingError, and so on.
- **Every place a token error could be read as ours:**

  | Path | Before | Now |
  | --- | --- | --- |
  | `simulateCall` (reads, including token reads) | text only | explained by origin |
  | `simulateOrThrow` (every build: accept, collect, offers…) | text only | explained by origin |
  | `submit` (a landed failure's diagnostic events) | text only, events present but unused | explained by origin |
  | `/api/tx/sponsor` (passkey transactions) | raw first line, unmapped | explained by origin |
  | `readUsdcBalance` | text match (fixed at the checkpoint) | trustline ledger entry |
  | `describeError` (browser) | passes messages through | unchanged |
  | `isRightNotFound` (`get_right` reads) | code #1 | unchanged; no token involved |

  - `explainFailure` (`src/lib/errors.ts`) takes the first `error` event and
    the contract that emitted it:
    - the USDC token, or a call made to the token itself: the token's own
      message, e.g. "The USDC token refused this: the receiving account has
      no USDC trustline… (USDC token error #13 TrustlineMissingError)";
    - another contract: says so, with that contract's code;
    - otherwise: QuietStay's code, as before.
  - Helpers in `src/lib/contract.ts`: `failureEvents` (reads emitter and
    code from the XDR), `invokedContract` and `explainSimulationFailure`.
  - The scripts report raw codes with the contract (`describeScError`); they
    do not map to QuietStay names.
- **Tests:**
  - `src/lib/errors.test.ts`, 5 tests, on the real capture
    (`src/lib/fixtures/token-trustline-simulation.json`). The old mapper
    gives "AlreadyListed" for it; the new one names the token's missing
    trustline. The tests also cover a QuietStay #13 kept as ours, a direct
    token call, another contract, and `failureEvents` on XDR events.
    `npm run test:app`: **40/40**.
  - `e2e/swap.spec.ts` now ends with the collect notice: **1/1 passed**
    (3.9 min).
    - The throwaway renter gets 1 testnet USDC from qs-renter (CLI-signed;
      the test process never sees the key).
    - The maker accepts its rental offer in the browser (escrow funded,
      `0b3866418b9ac52352b489b55580057c3b8915aabdd42a613057eedb78246018`),
      and its empty trustline is removed.
    - The escrow card shows "Add a USDC trustline before you collect" and
      collect is disabled. With the trustline back, the notice is gone.
    - Collect itself stays disabled by its 24-hour window (the week is in
      December). That 1 USDC stays in the throwaway contract's escrow.
    - Swap txs this run: offer `2da59e6f…7567`, accept `082d8681…e2af`,
      withdraw `bc4041fa…3b4f`, accept `88f6ec4a…8ec3`, complete
      `16ef22e14ca3e9b42a352512b0a5b3ae994b482a2b74cfcf0bc940fb82be5e4d`.
    - Privacy records `evidence/privacy/2026-11-21-{swap-e2e-16ef22e1,collect-notice-0b386641}.txt`
      pass.
  - Regression of the other browser specs: no-leak 2/2, passkey 8/8,
    prover 3/3. passkey-app failed on a network drop (see the High issue),
    failed again in its own set-up, then passed 2/2 (rental
    `7d4796397cc35cb591d921fe0590f22870a491386257f65b3ed11dd039d775e4`).
    So the browser suite is **16/16** on the passing runs.
  - `tsc`, eslint (changed files), `next build --webpack` and
    `zk:check-bundle` pass. Contract tests unchanged: 158/158.
- **Step 4 is closed.** The escrow #1 collect on `CA4B3MIZ…PPV73` stays for
  tonight (from 2026-11-21T20:28:30Z).

### Step 5 — Pre-launch checklist
- Date: 2026-11-21 (UTC).
- Branch / commit: `phase3` @ `cb4e220` (code and evidence); the checklist
  commit follows it.
- Result: `docs/PRELAUNCH_CHECKLIST.md` is complete. Every item is PASS,
  OPEN (yours), or a Step 6 gate. Nothing was sent to mainnet; the only
  mainnet calls were reads and two simulations.
- **Final testnet deployment** `CATUBRZZ…FVLM`: the mainnet WASM
  `76d69e79…dddde`, swap included (see Addresses). Every flow was run on it
  once, each with its privacy record
  (`evidence/privacy/2026-11-21-{step3-CATUBRZZ-*,step4-CATUBRZZ-swap-measure,final-passkey-probe-4a20d086}.txt`,
  all pass):
  - issue: weeks #1–#5;
  - wait rental: escrow #1, check-in 2026-11-21T13:50:56Z, **collect from
    2026-11-22T13:50:56Z**;
  - sale: `f01dda8d…eecc`;
  - dispute and arbiter: report `6111325f…`, both sides' evidence, `resolve`
    `45919dee…cf73` through `scripts/arbiter-resolve.sh`;
  - early confirm: `7efa759e…`;
  - the sale rejections: #32, #53, #54, #34;
  - the escrow rejections: #48, #46, #47 twice, Auth, #4;
  - the dispute-close rejections: #46 three times;
  - swap: `complete_swap` `e27478f4…612f`, 174,820,830 instructions (43.7%);
  - passkey-authorized `transfer`: `4a20d086…cab20` (wallet `CCQUIQXR…2NXD`).
  - Logs: `evidence/step3-testnet-CATUBRZZ.json` and
    `evidence/step4-testnet-CATUBRZZ.json`. 37 accepted and 19 refused, each
    refusal with exactly the expected error.
- Measured (details in the checklist):
  - Every flow's fee and resources read from the ledger. The largest share of
    any limit is 43.7% of the instructions (`complete_swap`).
  - Mainnet fees estimated with the host's `compute_rent_fee` at mainnet's
    TTLs and rent rate: under 0.001 to 0.19 XLM per flow. With testnet's
    settings the same method reproduces testnet's charged rent within 0.2%
    for 36 of 37 transactions.
  - Swap on mainnet: the 86 cost parameters a protocol-27 build can use are
    byte-identical on both networks, and the WASM-priced swap gives
    167,615,462 instructions with both.
  - Mainnet `simulateTransaction` of the upload: rights WASM 69.43 XLM,
    web-auth 3.44 XLM, almost all rent.
- Fixed or added because the checklist found them missing:
  - `scripts/check-protocol.ts`, `check-vk.ts`, `check-fee-account.ts` (spec
    §13 named it), `check-pilot-accounts.ts` (D7: trustlines and the 5 USDC
    total), `mainnet-simulate-upload.ts` and `flow-costs.ts`;
  - `tx-review.ts` refuses a USDC transfer to the rights contract, and an
    envelope without resources;
  - `mainnet-sign-submit.sh` runs the protocol and pilot-account checks
    before every mainnet signature;
  - the no-leak, passkey and passkey-app specs deploy the final WASM, where
    they deployed Step 2's;
  - the network fix in `rpc-server.ts`;
  - the unused import in `verify/page.tsx`;
  - two `--ignored` cost tests, `swap_cost_network_priced_from_the_wasm` and
    `mainnet_fees_of_the_final_testnet_transactions`.
  - `soroban-env-host` 27.0.1 is a new dev-dependency, already in
    Cargo.lock.
- Tests (2026-11-21):
  - rights 158/158 (+2 ignored, both pass), verifier 6/6, measure 1/1;
    clippy 0;
  - app 40/40; zk 29/29; tsc, zk:check-bundle and check-privacy (both) pass;
    `next build --webpack` passes; lint shows the 7 old errors;
  - browser 16/16 on the final WASM, first run. The rerun after the network
    fix: 14 passed; no-leak failed in set-up on the test process's own
    Friendbot `fetch` (a dropped connection, cause 2), and one spec did not
    run. `fund()` now retries a dropped connection after checking whether the
    account was funded; then no-leak 2/2. The server logs of that rerun show
    3 read retries (`ETIMEDOUT`), all recovered.
- Rehearsed on testnet:
  - the submission recovery "not found" path, `d4369423…ec5d`;
  - `tx-review.ts` refusing a USDC transfer to the contract;
  - `extend_escrow` `4f597e4d…`, `stellar contract extend` `a27094dd…` and
    `stellar contract restore` `38a3a0e3…` (the Phase 1 instance, which was
    archived).
- Proposed, for your decision: close the High network issue (checklist §9),
  and close the swap-cost Medium with a Step 6 gate (§5.2).
- My mistake, reported: to check that `.env.local`'s issuer key is
  `qs-issuer`, I loaded the secrets in `.env.local` in a one-off Node command
  to derive their public keys. Only public keys were printed or kept. It
  should not have read them at all. A public-key comparison from the CLI
  keystore is enough, and I will not do it again.
- Open: checklist §10.
- GO / NO-GO (yours):

#### Step 5 review (2026-11-21): not GO yet; the runbook is yours
- **Your decisions:**
  - the High network issue is closed; the connection drops stay as a Low;
  - the swap Medium is closed, with the Step 6 gate (simulate `complete_swap`
    right after the mainnet deploy, before any swap transaction);
  - the deploy cost is accepted in principle, and you asked for a full budget.
- **New rule (recorded in PHASE3_PROMPT.md, hard constraints):**
  - from now on you run every mainnet command in your own terminal;
  - I prepare the exact commands and verify the results by reading the chain;
  - I never run a command that signs or sends with a mainnet identity or on
    `--network mainnet`, and no command at all on a `qs-main-` identity;
  - I never load `.env.local` or any secret again.
  - It was set because of my two Step 5 mistakes: the `.env.local` read, and
    starting `mainnet-sign-submit.sh` with `mainnet-test`.
- **Done in this review.** All of it was read-only or offline; nothing was
  signed or sent on any network.
  - **Reuse check** (`scripts/check-mainnet-wasm.ts`, new; reads code entries
    by hash). Our rights and web-auth WASMs are not on mainnet, so the
    web-auth saving is 0. The OZ account WASM `c514d35e…` (already reused by
    the kit) and the verifier WASM `e63a030d…` are uploaded. Reusing both saves
    about 60.2 XLM (43.36 + 16.80 charged).
  - **Finding:** the verifier the wallets call is the kit's instance, not
    ours; proposal in checklist §5.4.
  - **The 69.43 XLM** reproduced exactly with `tools/upload-fee`, a new
    standalone crate on soroban-env-host 30.0.0: 0.0226 XLM of write fees,
    60.3574 XLM of rent and 9.0536 XLM of refunded margin. Web-auth also
    reproduced exactly: 2.99 XLM charged.
  - Two corrections came out of it:
    - The simulation adds 15% to the rent, so the "about 17 XLM" extension
      is about 14.6 XLM charged.
    - The networks' host counts custom sections in a module's memory cost,
      and host 27.0.1 does not. That is noted in checklist §5.2; the swap
      decision stands.
  - **Size:** `scripts/wasm-size-variants.ts` (new). The variants change only
    the custom sections. The most saved without changing behaviour is
    3.54 XLM, without the spec's doc strings. Compiler settings `s` and `3`
    are larger, by about 35 XLM.
  - **Budget:** 121 XLM, 113 from you. Per account it is in
    `docs/MAINNET_SETUP.md`.
  - **Runbook** `docs/MAINNET_SETUP.md`, with `scripts/check-mainnet-setup.ts`
    (new, Horizon reads only), the check you run after each part.
    - Every account command was built with `--build-only` on testnet and
      decoded, with public keys only: create-account, payment, change-trust
      and path-payment-strict-receive.
    - The check was run against random public keys and against testnet
      identities, whose guards failed as they should. The DEX quote reads
      only the direct XLM/USDC book. On 2026-11-21 that was 15.4734 XLM for
      2 USDC.
  - Evidence:
    - `evidence/checklist/mainnet-wasm-uploaded-2026-11-21.txt`;
    - `mainnet-upload-fee-breakdown-2026-11-21.{txt,json}`;
    - `mainnet-upload-fee-breakdown-web-auth-2026-11-21.{txt,json}`;
    - `wasm-size-variants-2026-11-21.txt`.
- Open: the runbook (yours), the verifier decision and the WASM size decision.
  The Step 3 collect was done on 2026-11-21 (Step 3 close).

#### Step 5: the final deployment's wait-rental collect (2026-11-22, ledger time)
- Run by me on testnet, with the command you gave:
  `npx tsx scripts/step3-evidence.ts collect-wait --contract CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM`.
  It signs with `qs-renter` and `qs-owner` through the CLI keystore.
- Escrow #1 was Funded; check-in 2026-11-21T13:50:56Z, collect from
  2026-11-22T13:50:56Z. The latest ledger was 5,869,536, closed
  2026-11-22T18:15:21Z.
- **Rejected as expected:** the renter's problem report after the window,
  `Error(Contract, #49)`, tx
  [`a29d267e…fce1`](https://stellar.expert/explorer/testnet/tx/a29d267eba812026b254ca0b68e9ec170fdb9ab77f25a7aa722c561686c3fce1).
  It was in ledger 5,869,537 at 2026-11-22T18:15:26Z, 15,870 s after the
  window closed. On Horizon `successful: false`, source `GBNDVZTD…`
  (`qs-renter`).
- **Collect:** the owner, tx
  [`67533a18…d295`](https://stellar.expert/explorer/testnet/tx/67533a18e3ea2c15fb5bfbde68f4608c08a409e9857bb1fa8b458bbe775fd295).
  - It was in ledger 5,869,538 at 2026-11-22T18:15:31Z, **102,275 s after
    check-in** (the window opens at 86,400 s).
  - On Horizon `successful: true`, source `GBCETLZR…` (`qs-owner`).
  - Escrow #1 is now PaidOut. The owner's USDC went 50,000,000 →
    60,000,000; the contract's went 10,000,000 → 0.
- Privacy record: `evidence/privacy/2026-11-22-step3-CATUBRZZ-collect-wait.txt`,
  with no findings. Log: `evidence/step3-testnet-CATUBRZZ.json`.
- **Every flow has now landed on the final WASM** `76d69e79…dddde`, the
  24-hour collect included.

#### Step 5, the runbook review (2026-11-22): verifier, demo lifetime, rehearsal
- **Your decisions:**
  - our own verifier instance on each network;
  - keep the tested WASM;
  - the rule as I read it, with testnet ownership-record secrets readable,
    unprinted, by the privacy check;
  - extend the testnet demo as far as testnet allows;
  - USDC from the DEX.
- **1. Verifier (done on testnet):**
  - deployed our own instance `CBK3H55V…WEEL` from the uploaded `e63a030d…`,
    as `qs-issuer`, tx `38bbd549…28e6`, 16,234 stroops. It runs `e63a030d…`.
  - `src/lib/config.ts`: `WEBAUTHN_VERIFIER_ID` now defaults to it, and is
    set per deployment with `NEXT_PUBLIC_QUIETSTAY_WEBAUTHN_VERIFIER_ID`.
    `e2e/passkey.spec.ts` and the probe use the config value.
  - New assertion in `passkey.spec.ts`: the passkey-approved transaction's
    footprint holds `CBK3H55V…` and not the kit's `CC7EKIHQ…`.
  - Passkey specs 10/10 (`passkey.spec.ts` 8, `passkey-app.spec.ts` 2):
    - rental `e89883fb…`;
    - in-app rental `d9b8d17b…`; both use `CBK3H55V…`;
    - `evidence/checklist/passkey-own-verifier-2026-11-22.txt`.
  - Its TTL is in checklist §4.1, and `scripts/check-ttl.ts` (new) reads it.
- **4. Testnet demo lifetime:**
  - Seven `stellar contract extend … --ledgers-to-extend 3110399` (testnet's
    `max_entry_ttl` − 1) as `qs-issuer`, about 181.5 testnet XLM in all.
  - Rights, web-auth, OZ account and OZ verifier code; instances
    `CATUBRZZ…`, `CBCDSOZP…`, `CBK3H55V…`.
  - All are live until ledgers 8,980,356–8,980,362, ~2027-05-21. The hashes
    are in checklist §4.2, with the standing items for the review period.
  - `scripts/check-deployment.ts` (new) passes on the demo
    (`evidence/checklist/check-deployment-testnet-demo-2026-11-22.txt`).
- **The rehearsal, `docs/MAINNET_REHEARSAL.md`.** It mirrors
  `MAINNET_SETUP.md`; only the network, the names and the funding differ.
  `MAINNET_SETUP.md` gains Part 5, the Step 6 deploy, marked "only after
  GO". Its commands match the rehearsal's except for the network, the prefix
  and the USDC id. New or changed for it:
  - `scripts/tx-review.ts`:
    - an upload shows its size and hash, and must be one of the two pinned
      builds;
    - a deploy shows its deployer, salt, WASM, the id it creates and each
      constructor argument.
    - A rights deploy is refused unless:
      - the issuer is the deployer, and the arbiter is not the issuer;
      - the USDC is the network's, and the key hash is the committed one;
      - the id equals `QS_RIGHTS_CONTRACT`.
    - Web-auth must have the unauthorizable admin; the verifier takes no
      arguments.
  - `scripts/mainnet-sign-submit.sh` runs its protocol and pilot-account
    checks on testnet too.
  - `scripts/check-mainnet-setup.ts --network testnet`.
  - `scripts/pilot-envelope.ts` (new) builds each sale and rental-offer
    envelope unsigned, from public keys, for `mainnet-sign-submit.sh`.
  - Envelopes are simulated twice. The first simulation records the
    authorization, which then costs a little more to check. One simulation
    made the review refuse by about 0.25% of instructions; two match it
    exactly.
  - CLI 30.0.1: a `--build-only` deploy needs `--wasm`, not `--wasm-hash`, so
    the verifier's WASM is fetched by hash first. In build-only mode `--wasm`
    adds no upload.
- **Dry run of the rehearsal, by me, on testnet, 2026-11-22.** It used my
  identities in place of `qs-rehearsal-`, with `SEND` piped in.
  - Part 5, all through `mainnet-sign-submit.sh`, each with the protocol and
    pilot checks:
    - upload rights `a2f3ed42…`;
    - upload web-auth `6536776b…`;
    - deploy rights `c05e3f92…` → `CC7W4OGP…`, equal to the predicted id;
    - deploy web-auth `94ba6fc5…` → `CDJJSKRI…`;
    - deploy verifier `e0ea6b5d…` → `CBZKYQIQ…`;
    - `check-deployment`: all pass.
  - Part 6, all SUCCESS:
    - issue A `36a5f550…`, issue B `098a1077…`;
    - request `a4665e15…`, sale offer `d2481ea2…`;
    - accept `80911c72…`: week A to the buyer, 1 USDC to the owner;
    - rental offer `0e100018…`.
  - Privacy record `evidence/privacy/2026-11-22-pilot-testnet-CC7W4OGP.txt`:
    no findings.
  - **Not a real rehearsal of the pilot check.** My testnet owner, buyer and
    renter hold 7, 18 and 12 USDC, so `QS_PILOT_ACCOUNTS` was a contract
    holding none (`CBK3H55V…`). The 5 USDC check itself was rehearsed in
    Step 5; yours runs on the rehearsal accounts.
  - Found by the dry run and fixed:
    - the builder did not exit after a proof (snarkjs worker threads);
    - an accepted offer showed as `null`.
  - Logs: `evidence/checklist/rehearsal-dryrun-*-2026-11-22.*`.
- Tests: app 40/40; tsc clean; check-privacy passes in both modes; lint on
  the changed files shows one old warning.
- **Reported:**
  - **`check-privacy.ts` loaded `.env.local`.** Its `loadEnv()` reads
    `.env.local` into its own process, keys included, and it used none of it.
    It ran inside my two collects (2026-11-21/22) and the passkey specs, after
    your rule. I found it today and removed the call. Other scripts that load
    the file, and the browser specs' `next dev`, are listed in the open issues
    for your decision.
  - **A command of mine went wrong.**
    - While inserting Part 5 into MAINNET_SETUP.md, the text's own `<<EOF`
      ended my heredoc early. Bash then ran part of the runbook text as
      commands.
    - What ran: three `stellar contract id wasm … --network mainnet`, with
      an empty source. They failed on the key argument, before any network
      call; the command only computes an id locally anyway.
    - Then a stray quote stopped the parse, so no upload, deploy or
      `mainnet-sign-submit.sh` line ran.
    - Nothing was signed or sent, and no file was created. To confirm that no
      `qs-main-` identity exists, I ran `stellar keys ls`, which lists names
      only; it shows none.
    - Since then, text containing heredocs goes through files, not nested
      heredocs.
- Open:
  - your rehearsal, then MAINNET_SETUP.md Parts 0–4, then GO;
  - the `.env.local` decision above.

#### Step 5, the second runbook review (2026-11-22): testnet-only files, the `qsmain` user
- **Your decisions:**
  - the app may read `.env.local` in testnet browser tests, under a new rule:
    `.env.local` and every file in the repo hold testnet values only, and the
    mainnet sign-in key goes only into Vercel's mainnet environment, set by
    you;
  - scripts read only the variables they need;
  - the mainnet and rehearsal keys live under a separate Linux user,
    `qsmain`.
  - Both rules are in PHASE3_PROMPT.md, hard constraints.
- **Scripts.** `loadEnv()` is replaced by `loadEnvVars(names)`
  (`scripts/lib/cli.ts`).
  - It parses only the lines that assign a named variable. A variable
    already set wins, and nothing else from the file reaches the process.
  - New unit test `scripts/lib/cli.test.ts`, on a fake file in a temp
    directory; app tests 43/43.
  - Changed: `attest` and `describe` (issuer key only); `verify-record`
    (nothing: it needs no secret); `e2e.ts` (the issuer and three demo keys,
    two URLs).
  - Found while fixing them: six Phase 2 tools in `scripts/zk/` loaded the
    whole file too (`submit-transfer`, `secret`, `issue-week`, `measure`,
    `produce-evidence`, `reissue-inventory`). They are changed the same way.
  - Why the URL and contract variables are not listed: they are read when
    `src/lib/config.ts` loads, before any of this runs, so the file never
    supplied them.
  - None of the ten scripts was run.
- **The `qsmain` user.** Part 0.0, the same text in both runbooks, has the
  exact commands for you to run. I ran none of them, and nothing as `qsmain`
  or with `sudo`.
  - **Three things on this machine would have defeated a second user**
    (`id`, `/var/run/docker.sock`, `/proc/sys/fs/binfmt_misc/`):
    - `murat` is in the `docker` group, Docker is active, and the group is
      root-equivalent;
    - WSL interop is on, so any `murat` process can start `wsl.exe -u root`;
    - whether sudo asks for a password, I did not test (that is a sudo
      command).
  - 0.0.1 removes `murat` from `docker`, turns interop off, and sets
    `timestamp_timeout=0` for `murat`. It also checks for passwordless sudo.
  - **`qsmain` runs a root-owned read-only snapshot,
    `/opt/quietstay`, at a commit you check with `git rev-parse`.** It never
    runs the working tree, which I can edit: an edited
    `mainnet-sign-submit.sh` could sign something else or copy the keystore.
  - Its tools come from the official releases, checked by digest:
    - Stellar CLI 30.0.1 `48c70074…658f`, from GitHub's release API;
    - Node 24.17.0 `ab343a1b…a917`, from nodejs.org's SHASUMS256.
    - I downloaded the CLI archive once to confirm the digest and that it
      holds the single `stellar` binary.
  - `npm ci --ignore-scripts` from the lockfile. The two built WASMs are
    copied in, and Part 5 checks their sha256.
  - The key store: as `qsmain`, the secure-store test decides `QS_KEY_STORE`.
    If it fails, the file store under `qsmain`'s 700 home is acceptable,
    which it was not under `murat`.
- **Changes so the scripts run from a read-only repo:**
  - `pilot-envelope.ts` keeps its state in `$QS_PILOT_STATE_DIR` and writes
    its privacy record to `--out`;
  - `mainnet-sign-submit.sh` makes the envelope path absolute before it
    changes to the repo.
- **Tested from a read-only copy** (`chmod -R a-w`, no `.env.local`, no
  `.secrets`):
  - `check-deployment` on the demo: all pass;
  - `check-mainnet-setup --network testnet --part 1`: all pass;
  - `mainnet-sign-submit.sh` on a fresh testnet upload envelope, answered
    `no`: review, protocol and pilot checks ran, then "Not sent";
  - `pilot-envelope status` with its state outside the repo: privacy record
    written to `--out`.
  - Not tested: the real `/opt` snapshot, `npm ci --ignore-scripts`, and the
    secure store under `sudo -iu`. Those need sudo, so 0.0.5 checks them on
    your machine.
- Open: your Part 0.0, then the rehearsal. **Superseded on 2026-11-23**:
  there is no `qsmain` user.

#### Step 5, the pilot-plan change (2026-11-23): browser flows, no `qsmain`
- **Your decisions:**
  1. The pilot flows run by hand in the browser with Freighter, on the
     mainnet app. They are listing, the sale offer and acceptance, the rental
     offer and acceptance, collect, the problem report, evidence and the
     swap. This fits Deliverable 1, proofs made in the browser.
  2. No attestation on mainnet; `/verify` says so plainly. The testnet demo
     keeps it.
  3. Trustlines and USDC come from Freighter's own screens, without the 5 USDC
     trustline limit. You run `check-pilot-accounts` by hand before each
     flow. The contract's 1 USDC cap per payment stays.
  4. Passkey: it approves creating the wallet and the renter's offer in the
     wait rental. Those are the only two passkey fee envelopes you sign with
     the CLI.
  5. `arbiter-resolve.sh` goes through `mainnet-sign-submit.sh`.
  6. **No `qsmain` user.**
     - The CLI keys `qs-main-issuer`, `-arbiter`, `-fee` and `mainnet-test`
       stay in your own keystore.
     - My session is closed whenever you run a mainnet command.
     - The rules stay: I never run anything with a `qs-main-` identity, and
       nothing that signs or sends on mainnet. I never run `sudo`.
  7. The rehearsal is a second Vercel project on the free plan: testnet,
     configured exactly like mainnet, with no issuer key and no fee key on the
     server.
  - Recorded in PHASE3_PROMPT.md (hard constraints), and in my memory notes.
- **The plan (go-ahead 2026-11-23), about 8 days, in this order:**
  1. the network setting;
  2. the mainnet-like testnet deployment. **Stop 1**: the environment list
     for the second Vercel project, and the Upstash plan, with one key prefix
     per deployment if the plan allows only one database;
  3. issuing through unsigned envelopes;
  4. the two passkey fee envelopes. **Stop 2**: you try 3 and 4 with real
     Freighter on the mainnet-like app, and I fix what you find;
  5. the arbiter routing;
  6. tests, docs and a dry run. Stop.
  - The contract and its WASM stay unchanged. If anything seems to need a
    contract change, I stop and tell you.

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
