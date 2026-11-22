# QuietStay Phase 3 — Browser proofs, passkeys, safe USDC payments, swaps, and a Stellar Mainnet pilot

You are working in the QuietStay repository. Phase 1 (MVP) and Phase 2
(ZK-proof-gated transfers on testnet) are complete; see README.md, docs/
DESIGN.md, docs/CIRCUIT.md and docs/EVIDENCE.md. Phase 3 has an approved
Statement of Work, and your job is to implement it faithfully. The SOW is the
contract: do not add scope, do not drop scope, and do not change an approved
technical choice without stopping to ask me first. The sprint starts on the
date the SOW is approved and runs 30 days.

## How to run this plan

This file is the full plan. It lives in the repository as
`docs/PHASE3_PROMPT.md`, and I will start each working session by telling you
which step to do.

- Work on one step per session. Read this file and `docs/PHASE3_PROGRESS.md`
  first, then do only the step I name.
- At the end of every step, update `docs/PHASE3_PROGRESS.md` with: the step
  and date, the branch and commit hash that was tested, what was done,
  decisions I approved, tx hashes and addresses produced, measured numbers,
  and open issues, each marked Critical, High, Medium or Low. Keep it short. The next
  session relies on this file, not on your memory.
- Decisions I approve at a checkpoint are recorded in the progress file and in
  the relevant doc. Do not reopen them in a later step unless something breaks.

## What Phase 3 must achieve

By the end, a user can prove ownership in the browser without any manual
steps, approve transactions with a passkey, pay in USDC knowing the owner is
paid only when the right is transferred (and, for rentals, only after the
first night of the stay), and swap rights directly with another owner. The
contracts go live on Stellar Mainnet after a written pre-launch checklist, and
the pilot uses sample rights and small amounts of my own funds. This is a
controlled technical pilot, not an audited commercial launch.

## Reference material

- The Phase 2 code and docs are the base. Reuse the existing circuit, the
  Poseidon parameters, the proof conversion step and `auth.rs`; do not rebuild
  them.
- stellar/stellar-dev-skill: read `skills/zk-proofs/SKILL.md` again before
  Step 2, and any smart-wallet or passkey skill it contains before the passkey
  work.
- Passkeys: start from the current Stellar developer docs on smart wallets
  (developers.stellar.org → contract accounts → smart wallets). My default
  choice is OpenZeppelin Smart Account contracts driven by Smart Account Kit.
  Check the current versions before you choose anything. Launchtube is retired
  and must not be used.

## Hard constraints (non-negotiable)

Network and money
- Testnet first, always. The default network in every script and in the app
  is testnet. After mainnet launch, the testnet deployment stays live as a
  public demo and as staging: every fix goes to testnet first, then to
  mainnet. Mainnet requires an explicit flag, and nothing touches mainnet
  until I have written GO on the completed pre-launch checklist (Step 5).
- I approve every mainnet transaction before you send it. Show me the
  simulated result and the exact command first.
- Never read, print, log or commit a secret key. Mainnet identities live only
  in the Stellar CLI keystore, under names I create. If a step needs a key you
  do not have, stop and ask me.
- **I run every mainnet command myself** (added 2026-11-21, Step 5 review; it
  applies from now on, and to Step 6 and Step 7).
  - You prepare the exact command; I run it in my own terminal and paste you
    the output. You verify the result by reading the chain.
  - You never run a command that signs or sends anything with a mainnet
    identity or with `--network mainnet`: no `stellar tx new`, `tx sign`,
    `tx send`, `contract upload`, `contract deploy`, `contract invoke
    --send=yes`, `contract extend` or `contract restore` on mainnet, and no
    script that does one. That includes the mainnet path of
    `scripts/mainnet-sign-submit.sh` and `scripts/arbiter-resolve.sh`.
  - You may still read mainnet: RPC and Horizon reads, and
    `simulateTransaction` with a public key as the source, which signs and
    sends nothing.
  - Never load `.env.local` or any other secret yourself: no reading,
    printing or deriving anything from a secret key, seed phrase or a file or
    variable that holds one, not even a public key. Never run
    `stellar keys secret`.
  - Run no command at all on a mainnet identity, not even a read like
    `stellar keys address qs-main-…`. Ask me for its public key.
  - On testnet, signing through the CLI keystore with a testnet identity
    (`--source qs-owner`, and the like) stays as before: the CLI signs and
    you never see the key.
- **Testnet values only in files** (added 2026-11-22, runbook review).
  - `.env.local`, and every file in the repo, only ever hold testnet values.
  - No mainnet secret is ever written to a file in the repo.
  - The mainnet sign-in key goes only into Vercel's mainnet environment, set
    by me.
  - The app may read `.env.local` during testnet browser tests. Scripts read
    only the variables they name (`loadEnvVars` in `scripts/lib/cli.ts`),
    never the whole file.
- **Mainnet keys live under a separate Linux user** (added 2026-11-22,
  runbook review).
  - Every `qs-main-` identity, and in the rehearsal every `qs-rehearsal-`
    identity, is created and used only as `qsmain`, from a `sudo -iu qsmain`
    shell.
  - `qsmain` runs a root-owned, read-only snapshot of the repo at a commit I
    checked, and the official Stellar CLI and Node releases
    (MAINNET_SETUP.md Part 0.0).
  - You never run anything as `qsmain` or with `sudo`. I run every `sudo`
    command myself.
- Pilot limits on mainnet: no single payment above 1 USDC, and no more than
  5 USDC held across all pilot accounts at any time, unless I raise these
  limits in writing. All pilot accounts are mine, so this USDC circulates
  between them rather than being spent.
- The USDC contract address is fixed in the constructor, separately for
  testnet and mainnet. Take each address from an official Circle or Stellar
  source, and record the source next to it. The contracts reject any other
  token.
- Amounts are i128 values in the token's smallest unit (USDC has 7 decimals
  on Stellar). No floating point anywhere in the contracts or in the amount
  handling in the app.

Authorization and powers
- `auth.rs` stays the single authorization boundary. Turn the Phase 2
  transfer check into one reusable function that sale, rental, rental escrow
  and swap all call. No second code path may move a right.
- No `upgrade` function, and no admin key. No account (issuer, arbiter or
  builder) can move, freeze or burn a held right, or move escrowed USDC
  outside the escrow rules below.
- The arbiter is a separate address, fixed in the constructor and with no
  setter. It can act only on rental escrows that are in Disputed, it can only
  pay out to the owner or refund the renter, and it cannot touch any right.
- Do not add an allowlist to restrict the pilot. Pilot access is limited
  because every sample right is held by builder-controlled accounts and every
  money movement needs a holder's acceptance. Document this in DESIGN.md. If
  you find a path where an outside account could move money or a right
  without an action by a builder account, STOP and tell me.

Cryptography (unchanged from Phase 2)
- No custom cryptography. Exactly one Circom circuit. Same Poseidon
  parameters as Phase 2. The contract never computes Poseidon. The
  verification key is fixed in the constructor, and no function accepts or
  replaces one.
- If browser proving, the passkey account binding or the swap needs a change
  to the circuit, STOP and explain the change before you make it. A circuit
  change means a new development setup, a new verification key and a new
  deployment.
- The trusted setup is still a builder-controlled development setup. It is
  labeled non-production everywhere, including on mainnet.

Privacy and honesty
- The private ownership record and its secret never leave the user's
  device. No request from the app may contain them; an automated test must
  check this (see Step 2).
- No personal data on the ledger. Dispute evidence goes on-chain only as
  SHA-256 hashes. `npm run check-privacy` must keep passing, updated for the
  new storage and events.
- Payment amounts and addresses are now public on-chain. Update the "What the
  chain sees" section in the app and in DESIGN.md to say so plainly.
- Never invent transaction hashes, contract addresses, proof times or cost
  figures. Every number in the docs must come from a command you actually
  ran; record the command next to it.

Tooling
- No paid services, no hosted relayer, no new production infrastructure.
  Fees are paid by a builder-controlled account. If the passkey kit you pick
  needs a hosted service, STOP and ask me.
- Passkeys need to work on at least one browser/device. Do not try to support
  every browser.

## Out of scope — do not build

KYC/AML, tax and payment compliance; independent security audit; public
launch or open sign-ups; production multi-party trusted setup; real resorts,
property managers, legal title or check-in guarantees; check-in confirmation
by resorts or devices; an independent arbitration service; fiat, bank
transfers, on/off ramps; group or chained swaps, swap matching, an exchange
marketplace; swaps with non-timeshare homes; a points system for swaps that
do not happen at the same time; passkey support on every browser and device;
account recovery beyond the basic passkey setup; an arbiter dashboard.

## Work plan with checkpoints

| Step | SOW week | SOW deliverable | Day budget |
| --- | --- | --- | --- |
| 0–2 | Week 1 | Deliverable 1 | ~6 days |
| 3 | Week 2 | Deliverable 2 (sale, rental, arbiter) | ~6 days |
| 4 | Week 2 | Deliverable 2 (swap) | ~6 days |
| 5–6 | Week 3 | Deliverable 3 (checklist, mainnet deploy) | ~7 days with Step 7 |
| 7 | Week 4 | Deliverable 3 (pilot, evidence, demo) | |
| — | Buffer | integration and fixes | ~5 days |

If time gets tight, the fallback is already decided in the SOW: the swap
stays on testnet. Tell me as soon as you see the timeline slipping.

### Step 0 — Current state (no code)

Read the repository and report briefly: what Phase 3 work, if any, already
exists; the current contract functions; the current circuit's public inputs;
and how the Phase 2 proof binds the holder's account. Write this summary
into the "Step 0" section of `docs/PHASE3_PROGRESS.md` (create the file if
it is missing). Then go on to Step 1.

### Step 1 — Phase 3 specification (Week 1 · STOP for my review)

Write `docs/PHASE3_SPEC.md` before writing any code. Open it with a one-page
plain-language summary for a reviewer with minimal technical background.
Then answer each of these explicitly:

1. Account binding for passkeys. A smart wallet is a C-address, while the
   Phase 2 proof binds to a G-address public key. Give a concrete design for
   how a proof binds to either kind of address, and say whether the circuit
   must change; a circuit change is allowed only with my approval. This item
   blocks everything else: no code for Steps 2–4 until I approve it.
2. Browser proving. Where the record and secret are kept in the browser, how
   they get there the first time for a sample right, how a buyer's new secret
   is created and stored after a sale or swap, and what happens if browser
   storage is lost (state this as a known limitation). Proving runs in a Web
   Worker. The `.wasm` and `.zkey` files are checked against committed
   SHA-256 hashes before use.
3. The reusable transfer check: its exact signature, what it checks, and how
   each flow (sale, rental, rental escrow, swap) calls it.
4. Sale offer. My default: the buyer creates an on-chain offer (right, price,
   expiry, the buyer's new commitment) and gives the contract a USDC
   allowance with a matching expiration ledger. The USDC stays in the buyer's
   account. When the seller accepts with a proof, one invocation moves the
   USDC to the seller with `transfer_from` and moves the right to the buyer.
   If the allowance or the balance is too low, the whole transaction fails.
   Cover cancellation, expiry, and what happens when one buyer has several
   open offers sharing one allowance. Propose a different mechanism only if
   this one does not work, and explain why.
5. Rental offer and escrow. The offer includes the check-in time. On
   acceptance, one transaction grants the rental right and pulls the renter's
   USDC into escrow. Give the full state machine (Funded → PaidOut, or Funded
   → Disputed → PaidOut / Refunded, and nothing else) with who can call each
   transition and when:
   - the owner can collect when the ledger time is at least check-in + 24 h
     and the escrow is not disputed;
   - the renter can confirm early at any time while Funded;
   - the renter can report a problem from funding until check-in + 24 h
     (I expect this window; confirm or argue);
   - in Disputed, the renter can still pay out, the owner can still refund,
     and each party can submit evidence hashes; the arbiter resolves with a
     decision hash.
   Also answer: may check-in be earlier than acceptance (I expect no); must
   check-in fall inside the rented period; and what happens to the rental
   right after a refund (I expect it stays until it expires, because nothing
   can touch a right; state this plainly as a limitation).
6. Evidence files. The app hashes files in the browser and submits only the
   hash. There is no server storage. For the pilot, the sample evidence files
   are committed under `pilot/evidence/` so anyone can recompute the hashes.
   If real upload storage seems necessary, STOP.
7. Swap. Two holders each give a proof bound to the other holder as
   recipient and to the swap mode. Both rights move, with new commitments, in
   one transaction, or nothing moves. Explain how the mode is encoded and
   whether the circuit can express a swap without changes.
8. Contract layout: one contract with modules, or several. If several,
   explain why, and give no contract a privileged call into another unless
   you justify it.
9. Storage and TTL for rights, nullifiers, offers and escrows. A funded
   escrow must never be archived without a documented way to extend it.
10. A permissions table: every public function, who can call it, and in
    which state.
11. Early swap cost estimate. Using the Phase 2 cost numbers and one
    simulation (`--send=no`) that verifies two existing Phase 2 proofs in a
    single transaction, estimate whether a two-proof swap fits within the
    current Soroban limits. Step 4 repeats the measurement on the integrated
    contract.
12. Pinned versions. List the exact versions of Smart Account Kit, the
    OpenZeppelin smart-account contracts, stellar-sdk, soroban-sdk, circom
    and snarkjs that you will use, and check that they work together. These
    versions are pinned in the lockfiles and recorded in `docs/SETUP.md`.

Then stop and show me the spec. Do not proceed until I approve it.

### Step 2 — Browser proofs, reusable transfer check, passkeys (Week 1 · STOP with results)

- In-browser proving in the app, with no command line and no file upload.
  Sale and rental both use it.
- An automated end-to-end test that captures every network request during
  proving and submission and fails if any request contains the record or the
  secret.
- The reusable transfer check in `auth.rs`, with the existing rental and sale
  moved onto it.
- Passkey approval through the chosen smart wallet, plus the existing
  regular wallet as a fallback. Before building screens on it, confirm the
  pinned versions with one real passkey-authorized testnet transaction. Detect unsupported browsers and show a clear
  message that points to the fallback wallet.
- Tests: valid proof; tampered, reused, wrong-account and expired proofs;
  unsupported browser; cancelled passkey prompt; failed signing. Keep all
  still-relevant Phase 2 tests passing.
- `docs/PROOF_TIMES.md`: proof generation times on at least two devices or
  browsers, with the median of several runs, the device, the browser and the
  date.

Checkpoint: show me the test results, the proof-time table, one
passkey-approved testnet transaction (a contract call authorized by the
smart wallet, not just a login), and the list of supported browsers. These
are the Week 1 outputs in the SOW.

### Step 3 — USDC sale, rental escrow and pilot arbiter (Week 2)

Implement the approved spec. Unit tests must cover, at minimum: one-step sale
(right and USDC move together); unaccepted offer moves nothing; expired
offer; low balance or low allowance; wrong token; wrong amount; rental
acceptance funds escrow and grants the right in one transaction; collect
before check-in + 24 h rejected; collect after it succeeds; early
confirmation; problem report within the window; problem report after the
window rejected; collect during dispute rejected; double payout and double
refund rejected; refund after payout rejected; arbiter action on an
undisputed escrow rejected; arbiter attempting to move a right rejected;
outsider calls rejected; evidence hash recorded. Add an invariant test: the
contract's USDC balance always equals the sum of Funded and Disputed
escrows.

Allowance tests: one buyer opens five offers on one allowance, one is
accepted, one is cancelled, and the buyer's balance then drops; an allowance
that expires before its offer; an offer that outlives its allowance. In
every case, an offer either completes in full or moves nothing.

Outside-account tests: an account the builder does not control tries every
public function (issue a right, create and accept offers, fund, collect,
confirm, report a problem, submit evidence, resolve, swap). None of them may
move USDC or a right without an action by a builder-controlled account.

Add the screens these flows need, and show the current status at every step
(offer open, accepted, funded, collectable, disputed, paid out, refunded),
with clear error messages. The arbiter acts through a script,
`scripts/arbiter-resolve`, not through a UI.

Checkpoint: show me the test results and the contract surface diff, then wait
for my approval. After I approve, deploy to testnet and produce: a one-step
sale, a rental paid out after the wait, a disputed rental resolved by the
arbiter, and the rejected transactions above. Report every tx hash.

### Step 4 — Swap and the two-proof cost measurement (Week 2 · STOP with numbers)

- First measure, by simulation (`--send=no`) and then one real testnet
  transaction, whether a swap with two proof verifications fits within the
  current Soroban per-transaction limits. Read the current limits from the
  network; do not assume them. Report the CPU instructions, memory, fee, and
  the percentage of each limit.
- If it fits: implement the swap on the reusable transfer check. Tests: valid
  swap; one side expired, rented out, already transferred, belonging to
  someone else, or using a reused proof; each must be rejected with nothing
  moving. Add the swap screen and error handling.
- If it does not fit: stop and show me the numbers. The swap then stays on
  testnet, as the SOW says, and I will decide how far to take it.

Checkpoint: test results, the cost report, and testnet tx hashes for an
accepted swap and its rejected cases.

### Step 5 — Pre-launch checklist (Week 3 · STOP — GO/NO-GO is mine)

Write `docs/PRELAUNCH_CHECKLIST.md`. Each item has: pass or fail, the
evidence (command and output), and the date. It must cover:

- Permissions: the table from the spec, checked against the code.
- Money movement: every path that moves USDC, its preconditions, the
  invariant test result, and the allowance and outside-account test results.
- Proof reuse: nullifiers, offers and escrows cannot be used twice.
- Storage: the TTL plan, and the commands to extend entries.
- Transaction costs: each flow measured on testnet, compared with mainnet
  limits and fees.
- Configuration: network passphrase, RPC URL, wasm hashes, verification key
  hash, USDC address (with its source), arbiter address — each double-checked
  and written out in full, for testnet and mainnet side by side. The wasm
  hashes and the verification key hash must be identical on both networks.
- Tests: all critical tests pass, and there are no known serious bugs.

Fix anything the checklist finds before you report. Then show me the
checklist and wait for my written GO.

### Step 6 — Mainnet deployment (Week 3, after my GO)

- Give me the exact deploy commands. Deploy only after I confirm each one.
- Publish two deployments of the same app: the mainnet pilot at the main
  public link, and a testnet demo at a second link. Both are built from the
  same commit; only the network configuration differs. Show the active
  network clearly on every screen, and use no paid hosting. `/verify` must
  work on both with no wallet and no account.
- The testnet demo lets anyone try the full flow (sale, rental, dispute,
  swap) with testnet accounts, testnet XLM and testnet USDC. Add a short
  "Try it on testnet" guide to the app and to README.md. The mainnet pilot
  keeps its rule: transactions that move money or rights use only
  builder-controlled accounts.
- Produce the first mainnet proof, payment and (if within limits) swap
  transactions, within the pilot limits.
- Report the mainnet contract addresses and tx hashes.

### Step 7 — Mainnet pilot, evidence and documentation (Week 4)

- Run the pilot with sample rights: a one-step sale, a rental paid out after
  the first night, a disputed rental resolved by the arbiter, and a swap (if
  within limits). At least one of these is approved with a passkey.
- `docs/EVIDENCE.md`: a one-page guide in the Phase 1 style. Each entry has
  a claim, a Stellar Expert link (testnet or mainnet, labeled) or a file
  link, and one sentence on what to look for. Include the rental timing
  check (comparing check-in with the payout time), the evidence hashes, and
  where to confirm that there is no `upgrade` function and no admin function.
- `docs/DESIGN.md`: payment rules, the escrow state machine, the arbiter's
  limits, why pilot access needs no allowlist, the completed checklist, and
  the known limitations: no independent audit, no production trusted setup,
  no resort or legal validation, a pilot arbiter controlled by the builder,
  check-in not verified on-chain, a lost browser secret means a lost ability
  to prove, fixes require a fresh deployment, and a refunded renter keeps the
  rental right until it expires. For that last one, add a short "future
  design" note on when a later version could end a rental right after a
  refund, and why this pilot does not.
- `docs/REVIEWER_ACCOUNT.md`: point reviewers to the testnet demo first, as
  the way to try every flow themselves. Then list the steps I follow to give
  a reviewer a funded mainnet test account on request. Do not automate key
  sharing.
- In `docs/EVIDENCE.md`, add one entry showing that the mainnet and testnet
  contracts have the same wasm hash, with both Stellar Expert links.
- README.md: update the summary, the reviewer path, the test count and
  "Out of scope". Keep the tone from Phase 1 and 2: claims you can check.
- I will record the ~3-minute demo myself. Leave me a short script that
  lists each step to show — browser proof with the network recording, a
  passkey approval, a sale, a rental, a disputed rental, a swap, and the
  verify flow without a wallet — with the tx hash or screen that proves each
  one.

## How to work

- Small, focused commits with clear messages.
- When something in the SOW turns out to be impossible or ambiguous, stop and
  ask rather than choosing silently.
- At each checkpoint, give me: what was done, what was measured, what is
  still open, the exact commands to reproduce it, and the date it was
  completed, so the evidence lines up with the SOW timeline.
