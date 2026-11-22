# QuietStay Phase 3 — Mainnet account setup (before GO)

A runbook for the project owner. **You run every command here in your own
terminal.** Claude prepared the commands and checks the results by reading the
chain; it runs nothing on mainnet that signs or sends, and no command on a
`qs-main-` identity (PHASE3_PROMPT.md, hard constraints).

Parts 0–4 cover only the accounts: identities, XLM, the sign-in key's
balance, trustlines and USDC. **Part 5, the Step 6 deploy, is here so that the
commands you rehearse are the ones you will run, but it waits for your
GO.**

**Rehearse it first on testnet:** [MAINNET_REHEARSAL.md](MAINNET_REHEARSAL.md)
has the same commands. Only the network, the `qs-rehearsal-` names and the
funding source differ.

- Prepared 2026-11-21. Every amount comes from a command run that day (see the
  budget's sources). The DEX price moves, so Part 4 re-quotes it live.
- **After each part, run its check and paste the output back.** Every check
  reads only public data from mainnet Horizon: `npx tsx
  scripts/check-mainnet-setup.ts --part N`. It exits non-zero if anything
  fails.
- **Never paste a secret key or seed phrase anywhere**: not in the chat, not
  in a file in this repo, not in a shell history you share. Public keys (`G…`)
  are fine to paste.
- **If a command errors after it may have sent something, do not run it
  again.** Run the part's check first, or look the transaction up by the hash
  the CLI printed (`stellar tx fetch result --hash <hash> --network mainnet`).
  A second `payment` would pay twice. A second `create-account` fails
  harmlessly (`op_already_exists`), but the check tells you which happened.
- Amounts in the commands are in stroops: 1 XLM = 10,000,000, and 1 USDC =
  10,000,000 (7 decimals).

**Run everything as `qsmain`, from the read-only snapshot** (Part 0.0):

```sh
sudo -iu qsmain
cd /opt/quietstay
```

## Budget

Mainnet, 2026-11-21: base reserve 0.5 XLM, so the minimum balance is
(2 + subentries) × 0.5 XLM. The base fee is 100 stroops (Horizon
`ledgers?order=desc&limit=1`, ledger 65,601,574). Fees come from
[PRELAUNCH_CHECKLIST.md](PRELAUNCH_CHECKLIST.md) §5.3 and §5.4.

| Account | Minimum balance | One-time costs | Pilot fees | Fund it with | Balance after the pilot (about) |
| --- | ---: | --- | --- | ---: | ---: |
| `qs-main-issuer`: issuer and deployer | 1 | rights upload: **69.4336 declared**, 60.3800 charged, 9.0536 refunded. Web-auth upload: 3.4403 declared, 2.9917 charged. Rights deploy: ~0.49 declared, ~0.43 charged. Web-auth deploy: ~0.03. Our own WebAuthn verifier instance (approved; §5.4): ~0.03 | about 6 `issue` calls at ≤ 0.12 each: ~0.6. 5 `create-account`s: 0.0005 | **75** | ~10.5 |
| `qs-main-arbiter` | 1 | — | `resolve` ~0.007 | **2** | ~2.0 |
| `qs-main-fee`: fee identity for the passkey wallet's transactions (spec §13) | 1 | **the mainnet smart wallet's creation: 0.163** (the wallet is a contract and has no reserve of its own) | up to ~5 passkey-approved calls at ≤ 0.19: ≤ 1 | **3** | ≥ 1.8 |
| `qs-main-owner` | 1 + **0.5 trustline** | — | offers, record requests, evidence, swap, collect: ~0.3 | **3** | ~2.7 |
| `qs-main-buyer` | 1 + **0.5 trustline** | **2 USDC on the DEX: ~15.5 XLM** (quote 2026-11-21; the send-max allows 3% more) | accept, record request, swap: ~0.1 | **19** (3 if the USDC comes from an exchange) | ~3.4, plus 2 USDC |
| `qs-main-renter` | 1 + **0.5 trustline** | **2 USDC on the DEX: ~15.5 XLM** | two `accept_rental`s at ~0.19, report, evidence, release: ~0.4 | **19** (3 if the USDC comes from an exchange) | ~3.1, plus 2 USDC |
| `mainnet-test`: the SEP-10/SEP-45 sign-in key | 1 | — | none (it signs challenges, and pays no fees) | **stays at exactly 1**. Its other 8.0000900 XLM go to the deployer (Part 3) | 1 |
| **Total** | | | | **121 XLM**: 113 from you plus 8.0000900 from `mainnet-test`. **89 XLM** (81 from you) if the USDC comes from an exchange | |

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
  buyer. Each USDC trustline gets a 5 USDC limit, so no single account can
  ever hold more than 5.

## Part 0 — Before you start

If you did 0.0 for the rehearsal, it is already in place: check 0.0.5, and
if the commit has changed since, refresh the snapshot with 0.0.4. Then do 0.1
and 0.2 for the mainnet keys.

### 0.0 A separate Linux user, `qsmain`, for every mainnet and rehearsal key

All `qs-main-` keys, and in the rehearsal all `qs-rehearsal-` keys, live only
in the keystore of a separate Linux user, `qsmain`. You use them only from a
`sudo -iu qsmain` shell.

Claude's session runs as `murat` and can type into anything `murat` runs,
SEND included. So the keys must be in a place `murat` cannot read. That place
must also run only code `murat` cannot change: `qsmain` runs a root-owned,
read-only snapshot of the repo at a commit you have checked, and tools from
the official releases.

**You run every command in this part yourself. Claude never runs anything as
`qsmain` or with `sudo`.** Steps 0.0.1–0.0.4 run as `murat`, in your terminal;
`sudo` asks for your password.

**0.0.1 Close the three ways around a second user.** Without these, a
process running as `murat`, Claude's included, could still reach
`qsmain`'s files.

```sh
# (a) sudo must ask for murat's password, every time.
sudo -k; if sudo -n true 2>/dev/null; then echo "PASSWORDLESS sudo: stop, and fix it before going on"; else echo "sudo asks for a password: good"; fi
echo 'Defaults:murat timestamp_timeout=0' | sudo tee /etc/sudoers.d/90-murat-no-sudo-cache > /dev/null
sudo chmod 0440 /etc/sudoers.d/90-murat-no-sudo-cache && sudo visudo -c

# (b) The docker group is root-equivalent: murat is in it and Docker is running.
sudo gpasswd -d murat docker

# (c) WSL interop lets any WSL process start wsl.exe -u root.
printf '\n[interop]\nenabled=false\nappendWindowsPath=false\n' | sudo tee -a /etc/wsl.conf > /dev/null
cat /etc/wsl.conf
```

Then, in **Windows PowerShell**: `wsl --shutdown`, and open a new WSL terminal.
Check, as `murat`:

```sh
id                                                    # no "docker" in the list
ls /proc/sys/fs/binfmt_misc/ | grep -c WSLInterop     # 0
sudo -n true 2>/dev/null && echo "PASSWORDLESS" || echo "password required: good"
```

- Docker still works with `sudo docker …`.
- With interop off, WSL can no longer start Windows programs: `code .`,
  `explorer.exe`, and the Windows tools on your PATH. VS Code still
  connects to WSL from the Windows side.
- If you need interop back, turn it back on. While it is on, the keys are
  reachable from `murat` again.
- If (a) printed PASSWORDLESS: give `murat` a password (`sudo passwd
  murat`), and remove any `NOPASSWD` line for it (`sudo visudo`, and the files
  in `/etc/sudoers.d/`). Then check again.

**0.0.2 Create `qsmain`.** It has no password, so it cannot log in; you
reach it only through `sudo -iu qsmain`. Its home is closed to every other
user.

```sh
sudo adduser --disabled-password --gecos "" qsmain
sudo chmod 700 /home/qsmain
ls /home/qsmain     # as murat: "Permission denied"
```

**0.0.3 The tools, from the official releases** (not the copies in
`murat`'s home, which `murat` could change):

```sh
sudo install -d -m 0755 /opt/qs-dl
sudo curl -fsSL -o /opt/qs-dl/stellar-cli-30.0.1.tar.gz \
  https://github.com/stellar/stellar-cli/releases/download/v30.0.1/stellar-cli-30.0.1-x86_64-unknown-linux-gnu.tar.gz
echo "48c70074020e09af0a3ebbd2bf62d53c9aec47935e49a112d3cd90fb4e37658f  /opt/qs-dl/stellar-cli-30.0.1.tar.gz" | sha256sum -c
sudo tar -xzf /opt/qs-dl/stellar-cli-30.0.1.tar.gz -C /opt/qs-dl stellar
sudo install -m 0755 -o root -g root /opt/qs-dl/stellar /usr/local/bin/stellar

sudo curl -fsSL -o /opt/qs-dl/node-v24.17.0-linux-x64.tar.xz https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-x64.tar.xz
curl -fsSL https://nodejs.org/dist/v24.17.0/SHASUMS256.txt | grep " node-v24.17.0-linux-x64.tar.xz$"
echo "ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917  /opt/qs-dl/node-v24.17.0-linux-x64.tar.xz" | sha256sum -c
sudo tar -xJf /opt/qs-dl/node-v24.17.0-linux-x64.tar.xz -C /opt
for b in node npm npx; do sudo ln -sf /opt/node-v24.17.0-linux-x64/bin/$b /usr/local/bin/$b; done
```

- The Stellar CLI digest is the one GitHub publishes for that asset. It is
  shown on the release page, and in `api.github.com/repos/stellar/stellar-cli/releases/tags/v30.0.1`,
  read 2026-11-22.
- The Node line printed by `grep` must show the same hash as the `echo`.
- Your own `murat` shell keeps using its nvm Node and `~/.cargo/bin/stellar`.

**0.0.4 The repo, as a root-owned read-only snapshot at a commit you have
checked.**
- `qsmain` never runs the working tree in `/home/murat`, which Claude edits.
- The snapshot holds no `.env.local` and no `.secrets/`.
- `COMMIT` is the commit Claude reports for the runbook. Compare it with `git
  log` before you go on.

```sh
COMMIT=<the commit hash Claude reported>
git -C ~/QuietStay/QuietStay log --oneline -1 "$COMMIT"
git -C ~/QuietStay/QuietStay bundle create /tmp/quietstay.bundle phase3
sudo rm -rf /opt/quietstay
sudo git clone --branch phase3 /tmp/quietstay.bundle /opt/quietstay
sudo git -C /opt/quietstay checkout --detach "$COMMIT"
sudo git -C /opt/quietstay rev-parse HEAD        # must print $COMMIT exactly
cd /opt/quietstay && sudo env PATH=/usr/local/bin:/usr/bin:/bin npm ci --ignore-scripts && cd -
# The two built WASMs are not in git; Part 5 checks their sha256 before any upload.
sudo install -D -m 0644 ~/QuietStay/QuietStay/contracts/target/wasm32v1-none/release/quietstay_rights.wasm \
  /opt/quietstay/contracts/target/wasm32v1-none/release/quietstay_rights.wasm
sudo install -D -m 0644 ~/QuietStay/QuietStay/contracts/vendor/anchor-web-auth/target/wasm32v1-none/release/web_auth.wasm \
  /opt/quietstay/contracts/vendor/anchor-web-auth/target/wasm32v1-none/release/web_auth.wasm
sudo chown -R root:root /opt/quietstay && sudo chmod -R go-w /opt/quietstay
```

- The bundle comes from `murat`'s repo. That is fine, because `rev-parse`
  proves the snapshot is exactly the commit you checked.
- `--ignore-scripts` keeps package install scripts from running as root.
- If a later step fails because a package needs its install script, run
  `sudo env PATH=/usr/local/bin:/usr/bin:/bin npm ci` in `/opt/quietstay`, and
  tell Claude which package it was.
- **To update the snapshot** after a fix, run 0.0.4 again with the new
  commit.

**0.0.5 Switch to `qsmain` and check that the setup holds.** From here on,
every command in this runbook runs in this shell:

```sh
sudo -iu qsmain
cd /opt/quietstay
stellar --version        # stellar 30.0.1 (f2a7b74175c34585f3b30a1abf42a2d41cbcc390)
node --version           # v24.17.0
touch /opt/quietstay/x   # must fail: Permission denied (read-only)
ls /home/murat           # must fail: Permission denied
npx tsx scripts/check-ttl.ts --network testnet   # all entries live
```

Paste the output of 0.0.1's checks and of 0.0.5. To leave the `qsmain`
shell, type `exit`.

**0.1 Give `qsmain`'s CLI a mainnet RPC** (as `qsmain`). The built-in `mainnet` network has none,
which was the Low issue. This is a local setting and sends nothing:

```sh
stellar network add mainnet \
  --rpc-url https://mainnet.sorobanrpc.com \
  --network-passphrase "Public Global Stellar Network ; September 2015"
stellar ledger latest --network mainnet     # expect: Protocol Version: 29
```

**0.2 Choose where `qsmain` keeps its keys.** As `qsmain`, test whether the
OS secure store keeps a key across a WSL restart. A `sudo -iu` shell may have
no Secret Service, in which case the test fails:

```sh
stellar keys generate qs-main-storetest --secure-store
stellar keys address qs-main-storetest
```

Then `exit`, and in Windows PowerShell `wsl --shutdown`. Open a new terminal,
and `sudo -iu qsmain` again:

```sh
stellar keys address qs-main-storetest     # the same G… address?
stellar keys rm qs-main-storetest
```

- **If it printed the same address**, use the secure store:
  `export QS_KEY_STORE=--secure-store`.
- **If it failed**, use the CLI's file store: `export QS_KEY_STORE=`. The
  seed phrase is then in `/home/qsmain/.config/stellar/identity/<name>.toml`.
  - Only `qsmain` and root can read it: the home is mode 700, and 0.0.1 took
    away `murat`'s ways around that.
  - That is why the separate user makes the file store acceptable here,
    which it was not under `murat`.
- Either way, put the choice in `qsmain`'s profile, so every later shell has
  it:
  `echo "export QS_KEY_STORE=$QS_KEY_STORE" >> ~/.profile`.

## Part 1 — Create the mainnet identities

Six new keys, each used for one role. The arbiter is separate from the issuer,
as the constructor requires. No `--fund` (that is Friendbot, testnet only).

```sh
stellar keys generate qs-main-issuer  $QS_KEY_STORE   # issuer and deployer
stellar keys generate qs-main-arbiter $QS_KEY_STORE   # resolves disputes only
stellar keys generate qs-main-fee     $QS_KEY_STORE   # pays the passkey wallet's transactions
stellar keys generate qs-main-owner   $QS_KEY_STORE   # pilot owner (receives USDC)
stellar keys generate qs-main-buyer   $QS_KEY_STORE   # pilot buyer (pays USDC)
stellar keys generate qs-main-renter  $QS_KEY_STORE   # pilot renter (pays USDC, gets refunds)
```

**Back up each key offline** before funding it, for example on paper or in a
password manager that is not on this machine:

```sh
stellar keys secret qs-main-issuer     # shown on your screen only; never paste it anywhere
```

Repeat for each of the six. Then save the **public** keys in a file outside
the repository, and load them:

```sh
cat > ~/qs-main-public-keys.env <<EOF
export QS_MAIN_ISSUER=$(stellar keys address qs-main-issuer)
export QS_MAIN_ARBITER=$(stellar keys address qs-main-arbiter)
export QS_MAIN_FEE=$(stellar keys address qs-main-fee)
export QS_MAIN_OWNER=$(stellar keys address qs-main-owner)
export QS_MAIN_BUYER=$(stellar keys address qs-main-buyer)
export QS_MAIN_RENTER=$(stellar keys address qs-main-renter)
EOF
source ~/qs-main-public-keys.env      # repeat in every new terminal
```

**Check 1** (paste the output). It needs six valid, distinct keys, none of
them a testnet identity or the sign-in key, and none already on mainnet:

```sh
npx tsx scripts/check-mainnet-setup.ts --part 1
```

## Part 2 — Fund the accounts, in this order

**2.1 From your exchange to the deployer.** Withdraw XLM on the Stellar
network to `$QS_MAIN_ISSUER` (`echo $QS_MAIN_ISSUER`), no memo needed.
- **At least 113 XLM must arrive** on the DEX route. On the exchange-USDC
  route, at least 81 XLM.
- The withdrawal creates the account. If your exchange cannot send to an
  account that does not exist yet, do Part 3 first, using its "create"
  variant; then the withdrawal goes to an existing account.

**2.2 The deployer creates the other five accounts.** Each command signs with
the deployer's key and sends one `create_account`:

```sh
stellar tx new create-account --source-account qs-main-issuer --network mainnet --destination "$QS_MAIN_ARBITER" --starting-balance 20000000    #  2 XLM
stellar tx new create-account --source-account qs-main-issuer --network mainnet --destination "$QS_MAIN_FEE"     --starting-balance 30000000    #  3 XLM
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

**4.1 Trustlines** on the three G accounts that receive USDC. Each locks
0.5 XLM of reserve. The limit, 50,000,000 = 5 USDC, means no single account
can ever hold more than the pilot cap. The issuer, arbiter, fee identity and
`mainnet-test` get no trustline, so they cannot hold USDC at all.

USDC is Circle's mainnet issuer
`GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`; its contract is
`CCW67TSZ…MI75` (`evidence/checklist/usdc-addresses-2026-11-21.txt`).

```sh
stellar tx new change-trust --source-account qs-main-owner  --network mainnet --line USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN --limit 50000000
stellar tx new change-trust --source-account qs-main-buyer  --network mainnet --line USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN --limit 50000000
stellar tx new change-trust --source-account qs-main-renter --network mainnet --line USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN --limit 50000000
```

**4.2 USDC: 2 to the buyer, 2 to the renter.** Choose one route.

**Route A, the Stellar DEX (recommended: the amount is exact).** Each account
buys exactly 2.0000000 USDC with its own XLM, in the direct XLM/USDC order
book. First get a live quote. This only reads Horizon, and prints the two
commands with your keys and a send-max 3% above the quote:

```sh
npx tsx scripts/check-mainnet-setup.ts --part 4 --quote
```

The commands it prints look like this, with today's numbers (2026-11-21:
15.4734 XLM for 2 USDC; send-max 15.9376 XLM):

```sh
stellar tx new path-payment-strict-receive --source-account qs-main-buyer --network mainnet \
  --send-asset native --send-max 159376113 \
  --destination "$QS_MAIN_BUYER" --dest-asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN --dest-amount 20000000
```

- **Run the two printed commands, not this example.** The price moves.
- `--dest-amount 20000000` is exactly 2 USDC received.
- `--send-max` caps the XLM spent. If the price has moved more than 3%, the
  transaction fails (`op_over_source_max`), nothing is traded, and you
  re-quote.
- Do not add a `--path`. The quote uses only the direct XLM/USDC book, with no
  trade through any other asset.

**Route B, an exchange withdrawal.** Withdraw USDC on the Stellar network:
2 USDC to `$QS_MAIN_BUYER` and 2 USDC to `$QS_MAIN_RENTER`.
- **No more than 5 USDC may arrive in total.**
- If the exchange's minimum withdrawal is above 2 but at most 4, withdraw it
  all to the buyer, and pass 2 USDC on:

  ```sh
  stellar tx new payment --source-account qs-main-buyer --network mainnet \
    --destination "$QS_MAIN_RENTER" --asset USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN --amount 20000000
  ```

- If its minimum is above 4, use route A.
- An exchange fee taken from the amount leaves less than 2 USDC. The check
  then reports a difference from the plan, which I look at with you. The cap
  is the hard rule.

**Check 4** (paste both outputs). The first needs:
- the three trustlines, each with a 5 USDC limit;
- no USDC trustline on the issuer, arbiter, fee identity or `mainnet-test`;
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

## After the runbook

- I check each pasted output against the chain myself, with the same reads.
  I also record every account and transaction in PHASE3_PROGRESS.md
  (Addresses).
- **Then you give GO.** Step 6 starts with Part 5, run by you, like the
  other parts.
- The mainnet smart wallet (passkey) is created in Step 6, from the app on
  your device. The fee identity pays for it, which is in its budget.
