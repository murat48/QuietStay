# QuietStay Phase 3 — Mainnet account setup (before GO)

A runbook for the project owner. **You run every command here in your own
terminal.** Claude prepared the commands and checks the results by reading the
chain; it runs nothing on mainnet that signs or sends, and no command on a
`qs-main-` identity (PHASE3_PROMPT.md, hard constraints).

Parts 0–4 cover only the accounts: identities, XLM, the sign-in key's
balance, trustlines and USDC. **Part 5, the Step 6 deploy, is here so that the
commands you rehearse are the ones you will run, but it waits for your
GO.** Part 6 is the mainnet app's settings, and Part 7 how a dispute is
decided.

**Rehearse it first on testnet:** [MAINNET_REHEARSAL.md](MAINNET_REHEARSAL.md)
has the same commands. Only the network, the `qs-rehearsal-` names and the
funding source differ.

- Prepared 2026-11-21, **revised 2026-11-28** for the pilot-plan decisions of
  2026-11-23 (no `qsmain` user; the pilot accounts in Freighter, their
  trustlines and USDC from Freighter's screens; the flows in the browser),
  D18 (the fee account's key in Vercel), mainnet's move to protocol 30, and
  plan item 5 (the arbiter through `mainnet-sign-submit.sh`).
- Every amount comes from a command run on 2026-11-21, re-checked on
  protocol 30 on 2026-11-27: uploads and every flow's fee are unchanged
  (PHASE3_PROGRESS.md).
- **After each part, run its check and paste the output back.** Every check
  reads only public data from mainnet Horizon: `npx tsx
  scripts/check-mainnet-setup.ts --part N`. It exits non-zero if anything
  fails.
- **Never paste a secret key or seed phrase anywhere**: not in the chat, not
  in a file in this repo, not in a shell history you share. Public keys (`G…`)
  are fine to paste. The one secret that leaves your keystore is the fee
  account's, typed by you into Vercel's settings (Part 6).
- **If a command errors after it may have sent something, do not run it
  again.** Run the part's check first, or look the transaction up by the hash
  the CLI printed (`stellar tx fetch result --hash <hash> --network mainnet`).
  A second `payment` would pay twice. A second `create-account` fails
  harmlessly (`op_already_exists`), but the check tells you which happened.
- Amounts in the commands are in stroops: 1 XLM = 10,000,000, and 1 USDC =
  10,000,000 (7 decimals).

**Run everything as yourself, from the repository, with Claude's session
closed** (decision 6, 2026-11-23: there is no `qsmain` user). The `qs-main-`
keys live in your own Stellar CLI keystore. Before each sitting:

```sh
cd ~/QuietStay/QuietStay
git status --short          # nothing: the tree is exactly the commit
git log --oneline -1        # the commit Claude reported for the runbook
```

Close the Claude session (the VS Code panel or terminal) before the first
mainnet command and open it again only after the last, then paste the outputs.

## Budget

Mainnet, 2026-11-21: base reserve 0.5 XLM, so the minimum balance is
(2 + subentries) × 0.5 XLM. The base fee is 100 stroops (Horizon
`ledgers?order=desc&limit=1`, ledger 65,601,574). Fees come from
[PRELAUNCH_CHECKLIST.md](PRELAUNCH_CHECKLIST.md) §5.3 and §5.4.

| Account | Minimum balance | One-time costs | Pilot fees | Fund it with | Balance after the pilot (about) |
| --- | ---: | --- | --- | ---: | ---: |
| `qs-main-issuer`: issuer and deployer | 1 | rights upload: **69.4336 declared**, 60.3800 charged, 9.0536 refunded. Web-auth upload: 3.4403 declared, 2.9917 charged. Rights deploy: ~0.49 declared, ~0.43 charged. Web-auth deploy: ~0.03. Our own WebAuthn verifier instance (approved; §5.4): ~0.03 | about 6 `issue` calls at ≤ 0.12 each: ~0.6. 5 `create-account`s: 0.0005 | **75** | ~10.5 |
| `qs-main-arbiter` | 1 | — | `resolve` ~0.007 | **2** | ~2.0 |
| `qs-main-fee`: the fee account (D18): pays every passkey user's network fee, its key in Vercel (Part 6) | 1 | **each passkey wallet's creation: 0.163** (a wallet is a contract and has no reserve of its own) | the pilot's passkey calls at ≤ 0.19, within the route's 5 XLM daily budget: ~1–2 | **5** | ≥ 2.5 |
| `qs-main-owner` | 1 + **0.5 trustline** | — | offers, record requests, evidence, swap, collect: ~0.3 | **3** | ~2.7 |
| `qs-main-buyer` | 1 + **0.5 trustline** | **2 USDC on the DEX: ~15.5 XLM** (quote 2026-11-21; the send-max allows 3% more) | accept, record request, swap: ~0.1 | **19** (3 if the USDC comes from an exchange) | ~3.4, plus 2 USDC |
| `qs-main-renter` | 1 + **0.5 trustline** | **2 USDC on the DEX: ~15.5 XLM** | two `accept_rental`s at ~0.19, report, evidence, release: ~0.4 | **19** (3 if the USDC comes from an exchange) | ~3.1, plus 2 USDC |
| `mainnet-test`: the SEP-10/SEP-45 sign-in key | 1 | — | none (it signs challenges, and pays no fees) | **stays at exactly 1**. Its other 8.0000900 XLM go to the deployer (Part 3) | 1 |
| **Total** | | | | **123 XLM**: 115 from you plus 8.0000900 from `mainnet-test`. **91 XLM** (83 from you) if the USDC comes from an exchange | |

- **The deployer must hold the declared 69.43 XLM at the moment it uploads.**
  The network reserves the declared fee and refunds the margin after. That is
  why it gets 75, not 65.
- About 64.6 XLM is spent on the deploy and the pilot's fees. The DEX XLM is
  not spent: it becomes 4 USDC that stays in the pilot accounts.
- **Not in this budget:** after about 119 days, extending the rights code
  costs about 14.6 XLM charged (checklist §4). That comes after the pilot.
- **USDC:** 2 to the buyer and 2 to the renter, **4 in total, under the 5 USDC
  cap** (D7). That covers the pilot's payments: a sale of ≤ 1, two rentals of
  ≤ 1 each, one of them disputed, and a passkey-approved flow funded from the
  buyer. The trustlines come from Freighter with no limit (decision 3), so
  the 5 USDC total is held by the checks: Part 4's, and the pilot-account
  check before every mainnet signature.

## Part 0 — Before you start

**0.1 Give your CLI a mainnet RPC.** The built-in `mainnet` network has none.
This is a local setting and sends nothing:

```sh
stellar network add mainnet \
  --rpc-url https://mainnet.sorobanrpc.com \
  --network-passphrase "Public Global Stellar Network ; September 2015"
stellar ledger latest --network mainnet     # expect: Protocol Version: 30
npx tsx scripts/check-protocol.ts           # PASS: mainnet is on protocol 30
```

If the protocol is no longer 30, stop: the checklist's protocol, simulation
and cost items are re-run first, as they were for 29 → 30.

**0.2 Choose where your mainnet keys are kept.** Test whether the OS secure
store keeps a key across a WSL restart:

```sh
stellar keys generate qs-main-storetest --secure-store
stellar keys address qs-main-storetest
```

Then in Windows PowerShell `wsl --shutdown`, open a new terminal, and:

```sh
stellar keys address qs-main-storetest     # the same G… address?
stellar keys rm qs-main-storetest
```

- **If it printed the same address**, use the secure store:
  `echo 'export QS_KEY_STORE=--secure-store' >> ~/.profile`.
- **If it failed**, the CLI's file store is the fallback (`export
  QS_KEY_STORE=`): the seed phrase is then in
  `~/.config/stellar/identity/<name>.toml`, readable by any process you run.
  That is why the Claude session is closed whenever a mainnet command runs
  (decision 6), and why the keys hold only what the pilot needs.

## Part 1 — Create the mainnet accounts

Three keys in your CLI keystore, each used for one role. The arbiter is
separate from the issuer, as the constructor requires. No `--fund` (that is
Friendbot, testnet only).

```sh
stellar keys generate qs-main-issuer  $QS_KEY_STORE   # issuer and deployer
stellar keys generate qs-main-arbiter $QS_KEY_STORE   # resolves disputes only
stellar keys generate qs-main-fee     $QS_KEY_STORE   # the fee account (D18): pays passkey users' fees
```

**The three pilot accounts are in Freighter** (decision 1): the flows run in
the browser, so the owner, the buyer and the renter sign there. In Freighter
(set to Mainnet), create three new accounts, named for example "QS owner",
"QS buyer" and "QS renter", and copy each one's `G…` address.

**Back up every key offline** before funding it, on paper or in a password
manager that is not on this machine:

- the three CLI keys: `stellar keys secret qs-main-issuer` (and `-arbiter`,
  `-fee`), shown on your screen only; never paste them anywhere;
- Freighter's recovery phrase, from its settings.

Then save the **public** keys in a file outside the repository, and load them:

```sh
cat > ~/qs-main-public-keys.env <<EOF
export QS_MAIN_ISSUER=$(stellar keys address qs-main-issuer)
export QS_MAIN_ARBITER=$(stellar keys address qs-main-arbiter)
export QS_MAIN_FEE=$(stellar keys address qs-main-fee)
export QS_MAIN_OWNER=<the owner's G… from Freighter>
export QS_MAIN_BUYER=<the buyer's G… from Freighter>
export QS_MAIN_RENTER=<the renter's G… from Freighter>
EOF
source ~/qs-main-public-keys.env      # repeat in every new terminal
```

Edit the three Freighter lines with their real addresses before `source`.

**Check 1** (paste the output). It needs six valid, distinct keys, none of
them a testnet identity or the sign-in key, and none already on mainnet:

```sh
npx tsx scripts/check-mainnet-setup.ts --part 1
```

## Part 2 — Fund the accounts, in this order

**2.1 From your exchange to the deployer.** Withdraw XLM on the Stellar
network to `$QS_MAIN_ISSUER` (`echo $QS_MAIN_ISSUER`), no memo needed.
- **At least 115 XLM must arrive** on the DEX route. On the exchange-USDC
  route, at least 83 XLM.
- The withdrawal creates the account. If your exchange cannot send to an
  account that does not exist yet, do Part 3 first, using its "create"
  variant; then the withdrawal goes to an existing account.

**2.2 The deployer creates the other five accounts.** Each command signs with
the deployer's key and sends one `create_account`:

```sh
stellar tx new create-account --source-account qs-main-issuer --network mainnet --destination "$QS_MAIN_ARBITER" --starting-balance 20000000    #  2 XLM
stellar tx new create-account --source-account qs-main-issuer --network mainnet --destination "$QS_MAIN_FEE"     --starting-balance 50000000    #  5 XLM
stellar tx new create-account --source-account qs-main-issuer --network mainnet --destination "$QS_MAIN_OWNER"   --starting-balance 30000000    #  3 XLM
stellar tx new create-account --source-account qs-main-issuer --network mainnet --destination "$QS_MAIN_BUYER"   --starting-balance 190000000   # 19 XLM (30000000 on the exchange-USDC route)
stellar tx new create-account --source-account qs-main-issuer --network mainnet --destination "$QS_MAIN_RENTER"  --starting-balance 190000000   # 19 XLM (30000000 on the exchange-USDC route)
```

Afterwards the deployer holds about 67 XLM. Part 3 brings it to 75.

**Check 2** (paste the output). Every account must exist with at least its
planned XLM, its own master key as the only signer, and nothing else. On the
exchange-USDC route, add `--usdc exchange`:

```sh
npx tsx scripts/check-mainnet-setup.ts --part 2
```

## Part 3 — `mainnet-test` down to its minimum; the rest to the deployer

`mainnet-test` (`GCEF3BTQ…TDAR`) is the server's sign-in key, and its secret
goes to the server. So it should hold only its minimum: 1 XLM with 0
subentries. On 2026-11-21 it holds 9.0001000 XLM. What is sent:

    9.0001000 (balance) − 0.0000100 (this transaction's fee) − 1.0000000 (minimum) = 8.0000900 XLM = 80000900 stroops

- **First check that the balance is still 9.0001000.** `npx tsx
  scripts/check-mainnet-setup.ts --part 3` prints it on the `mainnet-test:`
  line; it fails on the balance until this part is done.
- If the balance differs, send (balance − 1.0000100) XLM instead.
- Keep the default fee, 100 stroops. A higher fee would leave too little for
  the payment, and the transaction would fail and still charge its fee.

```sh
stellar tx new payment --source-account mainnet-test --network mainnet \
  --destination "$QS_MAIN_ISSUER" --asset native --amount 80000900
```

**Variant, if the deployer does not exist yet** (your exchange could not
create it in 2.1). This creates the deployer with the same 8.0000900 XLM:

```sh
stellar tx new create-account --source-account mainnet-test --network mainnet \
  --destination "$QS_MAIN_ISSUER" --starting-balance 80000900
```

**Check 3** (paste the output). `mainnet-test` must hold exactly 1.0000000 XLM
with 0 subentries, its last payment must have gone to the deployer, and the
deployer must hold at least 75 XLM:

```sh
npx tsx scripts/check-mainnet-setup.ts --part 3
```

## Part 4 — USDC trustlines, then at most 5 USDC

**From Freighter's own screens** (decision 3, 2026-11-23). The issuer,
arbiter, fee account and `mainnet-test` get no trustline, so they cannot hold
USDC at all.

USDC is Circle's mainnet issuer
`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`; its contract is
`CCW67TSZ…MI75` (`evidence/checklist/usdc-addresses-2026-11-21.txt`).

**4.1 Trustlines** on the owner, the buyer and the renter. In Freighter, for
each of the three accounts: Manage assets → Add an asset → USDC, and check
that the issuer shown is `GA5Z…KZVN` (Circle) before you confirm. Each locks
0.5 XLM of reserve. Freighter sets no limit; the 5 USDC total is checked
below and before every mainnet signature.

**4.2 USDC: 2 to the buyer, 2 to the renter.** Either route:

- **Route A, swap in Freighter:** in the buyer's account, swap XLM for
  exactly 2 USDC (Freighter's swap, on the Stellar DEX); the same in the
  renter's. Check the received amount on the confirmation screen.
- **Route B, an exchange withdrawal:** withdraw USDC on the Stellar network,
  2 to `$QS_MAIN_BUYER` and 2 to `$QS_MAIN_RENTER`. If the exchange's minimum
  is above 2 but at most 4, withdraw it all to the buyer and send 2 on to the
  renter from Freighter.

**No more than 5 USDC may arrive in total**: that cap (D7) is the hard rule.
An exchange fee taken from the amount leaves less than 2, which the check
reports and we look at together.

`npx tsx scripts/check-mainnet-setup.ts --part 4 --quote` still prints the
live DEX price of 2 USDC, as a reference for the swap.

**Check 4** (paste both outputs). The first needs:
- the three trustlines (their limits are printed);
- no USDC trustline on the issuer, arbiter, fee account or `mainnet-test`;
- 2/2/0 USDC held;
- a total ≤ 5.

The second is the pilot-account check that `mainnet-sign-submit.sh` runs
before every mainnet signature. Add `--usdc exchange` to the first on
route B.

```sh
npx tsx scripts/check-mainnet-setup.ts --part 4
npx tsx scripts/check-pilot-accounts.ts --network mainnet --accounts "$QS_MAIN_OWNER,$QS_MAIN_BUYER,$QS_MAIN_RENTER"
```

## Part 5 — The Step 6 deploy (only after your written GO)

**Do not run this part before GO.** It is the rehearsal's Part 5 with
`mainnet`, `qs-main-`, `QS_MAIN_*` and mainnet USDC.
- Each of the five transactions goes through `scripts/mainnet-sign-submit.sh
  --network mainnet`. It runs the protocol check and the pilot-account check,
  shows the review, and signs only when you type SEND.
- **5.1 declares 69.43 XLM** (60.38 charged, 9.05 refunded; checklist §5.4).

**5.0 Set up:**

```sh
export STEP6=~/qs-main/step6 && mkdir -p "$STEP6"
RIGHTS_WASM=contracts/target/wasm32v1-none/release/quietstay_rights.wasm
WEB_AUTH_WASM=contracts/vendor/anchor-web-auth/target/wasm32v1-none/release/web_auth.wasm
echo "76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde  $RIGHTS_WASM"   | sha256sum -c
echo "708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1  $WEB_AUTH_WASM" | sha256sum -c
stellar contract fetch --wasm-hash e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76 --network mainnet -o "$STEP6/oz-verifier.wasm"
echo "e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76  $STEP6/oz-verifier.wasm" | sha256sum -c

cat > "$STEP6/salts.env" <<EOF
export SALT_RIGHTS=$(openssl rand -hex 32)
export SALT_WEB_AUTH=$(openssl rand -hex 32)
export SALT_VERIFIER=$(openssl rand -hex 32)
EOF
source "$STEP6/salts.env"
export QS_RIGHTS_CONTRACT=$(stellar contract id wasm --salt "$SALT_RIGHTS"   --source-account "$QS_MAIN_ISSUER" --network mainnet)
export WEB_AUTH_ID=$(stellar contract id wasm --salt "$SALT_WEB_AUTH"       --source-account "$QS_MAIN_ISSUER" --network mainnet)
export VERIFIER_ID=$(stellar contract id wasm --salt "$SALT_VERIFIER"       --source-account "$QS_MAIN_ISSUER" --network mainnet)
export QS_PILOT_ACCOUNTS="$QS_MAIN_OWNER,$QS_MAIN_BUYER,$QS_MAIN_RENTER"
echo "rights $QS_RIGHTS_CONTRACT  web-auth $WEB_AUTH_ID  verifier $VERIFIER_ID"
VK="$(node -e 'process.stdout.write(JSON.stringify(require("./circuits/keys/verification_key.soroban.json")))')"
sim() { stellar tx simulate --source-account "$QS_MAIN_ISSUER" --network mainnet | stellar tx simulate --source-account "$QS_MAIN_ISSUER" --network mainnet; }
```

**5.1–5.5.** Build one, sign it, then build the next. The review must show
what the rehearsal's Part 5 lists for each.

```sh
stellar contract upload --wasm "$RIGHTS_WASM" --source-account "$QS_MAIN_ISSUER" --network mainnet --build-only | sim > "$STEP6/01-upload-rights.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/01-upload-rights.xdr" qs-main-issuer --network mainnet

stellar contract upload --wasm "$WEB_AUTH_WASM" --source-account "$QS_MAIN_ISSUER" --network mainnet --build-only | sim > "$STEP6/02-upload-web-auth.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/02-upload-web-auth.xdr" qs-main-issuer --network mainnet

stellar contract deploy --wasm "$RIGHTS_WASM" --salt "$SALT_RIGHTS" --source-account "$QS_MAIN_ISSUER" --network mainnet --build-only -- \
  --issuer "$QS_MAIN_ISSUER" --arbiter "$QS_MAIN_ARBITER" --usdc CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75 \
  --name "QuietStay Usage Rights" --symbol QSTAY --verification_key "$VK" --max_payment 10000000 \
  | sim > "$STEP6/03-deploy-rights.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/03-deploy-rights.xdr" qs-main-issuer --network mainnet

stellar contract deploy --wasm "$WEB_AUTH_WASM" --salt "$SALT_WEB_AUTH" --source-account "$QS_MAIN_ISSUER" --network mainnet --build-only -- \
  --admin "$(npx tsx scripts/deploy-web-auth.ts --print-admin)" | sim > "$STEP6/04-deploy-web-auth.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/04-deploy-web-auth.xdr" qs-main-issuer --network mainnet

stellar contract deploy --wasm "$STEP6/oz-verifier.wasm" --salt "$SALT_VERIFIER" --source-account "$QS_MAIN_ISSUER" --network mainnet --build-only \
  | sim > "$STEP6/05-deploy-verifier.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/05-deploy-verifier.xdr" qs-main-issuer --network mainnet
```

**Check 5** (paste it):

```sh
npx tsx scripts/check-deployment.ts --network mainnet --rights "$QS_RIGHTS_CONTRACT" --web-auth "$WEB_AUTH_ID" \
  --verifier "$VERIFIER_ID" --issuer "$QS_MAIN_ISSUER" --arbiter "$QS_MAIN_ARBITER"
npx tsx scripts/check-ttl.ts --network mainnet --rights "$QS_RIGHTS_CONTRACT" --web-auth "$WEB_AUTH_ID" --verifier "$VERIFIER_ID"
```

After that, the remaining Step 6 gates (checklist §10) are prepared from the
deployed ids. Among them is the `complete_swap` simulation before any swap
transaction.

## Part 6 — The mainnet app's settings (Vercel)

The mainnet Vercel project is configured as [VERCEL.md](VERCEL.md) lists for
`cli` mode on mainnet: `NEXT_PUBLIC_QUIETSTAY_NETWORK=mainnet`, signing
`cli`, no issuer or arbiter key on the server, and the contract ids from
Part 5. Two settings carry the fee account (D18), set by you in Vercel's
settings only, never in a file:

| Setting | Value |
| --- | --- |
| `NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT` | `$QS_MAIN_FEE` (public) |
| `QUIETSTAY_FEE_SECRET` | its `S…`, shown by `stellar keys secret qs-main-fee` on your screen and typed or pasted only into Vercel's value field (Sensitive) |

- The fee route refuses unless the secret is that account's key.
- It pays only QuietStay calls and passkey wallet creation, at most 0.5 XLM a
  transaction and **5 XLM a day in all**, with per-IP, per-wallet, per-week
  and wallet-creation limits (PHASE3_SPEC.md D18). So the account loses at
  most 5 XLM a day whatever is tried, and holds only what Part 2 gave it.
- Its balance is on the Wallet screen, signed in as the issuer, with a
  warning below 3 XLM and a top-up from Freighter. Or send it XLM from
  anywhere.

After deploying, `npx tsx scripts/check-app-config.ts <the mainnet URL>`
must show `signing: cli`, `fee_route: true` and no issuer key.

## Part 7 — Deciding a dispute (the arbiter)

The arbiter acts only on a Disputed escrow and can only pay its own owner or
refund its own renter its own amount. There is no screen: one command, which
builds the unsigned envelope with the arbiter's public key and hands it to
`mainnet-sign-submit.sh`, like every other mainnet transaction (plan item 5,
rehearsed on testnet 2026-11-28):

```sh
QS_PILOT_ACCOUNTS="$QS_MAIN_OWNER,$QS_MAIN_BUYER,$QS_MAIN_RENTER" \
scripts/arbiter-resolve.sh --network mainnet --contract "$QS_RIGHTS_CONTRACT" \
  --escrow <id> --outcome pay-owner|refund-renter --decision <decision file> --arbiter qs-main-arbiter
```

- It checks that `qs-main-arbiter` is the contract's arbiter and that the
  escrow is Disputed, prints the escrow, the evidence hashes and exactly who
  is paid how much, and hashes the decision file (only the hash goes on
  chain; keep the file).
- The envelope is saved as `~/quietstay-envelopes/resolve-escrow-<id>-mainnet.xdr`.
  Then the review, the protocol and pilot checks, **SEND**, one signature,
  and the submission recovery.
- Run again for the same escrow, it builds nothing new: if it was signed, it
  prints the `--resume` command.

## After the runbook

- I check each pasted output against the chain myself, with the same reads.
  I also record every account and transaction in PHASE3_PROGRESS.md
  (Addresses).
- **Then you give GO.** Step 6 starts with Part 5, run by you, like the
  other parts.
- A passkey wallet is created in Step 6 from the app on your device. The fee
  account pays for its creation and for its transactions, through the fee
  route, within the limits above.
