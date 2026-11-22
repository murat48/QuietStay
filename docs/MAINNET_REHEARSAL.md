# QuietStay Phase 3 — Mainnet rehearsal on testnet

A runbook for the project owner. It covers the steps of
[MAINNET_SETUP.md](MAINNET_SETUP.md) and of the Step 6 deploy, run on
**testnet**, in your own terminal, before you run them on mainnet.

**What differs from mainnet, and nothing else:**
- the network: `--network testnet`;
- the identities: `qs-rehearsal-` instead of `qs-main-`, and `QS_REHEARSAL_*`
  instead of `QS_MAIN_*`;
- the funding: Friendbot instead of an exchange, and Circle's faucet
  instead of the DEX;
- the network's own constants: testnet USDC instead of mainnet USDC.

Two identities stand in for mainnet things:
- `qs-rehearsal-signin` plays `mainnet-test`;
- `qs-rehearsal-funder` holds the faucet USDC.

Every other command, script and check is the one you will run on mainnet. The
Step 6 deploy and the two flows go through `scripts/mainnet-sign-submit.sh
--network testnet`, so you practice its review and typing SEND. Since the Step
5 review, that script also runs the protocol and pilot-account checks on
testnet.

- **I ran this whole runbook myself first, as a dry run**, with my testnet
  identities (`qs-issuer`, `qs-owner`, …) in place of `qs-rehearsal-`:
  - Parts 5 and 6 on 2026-11-22;
  - the dry-run deployment is `CC7W4OGP…77ZRP`. The results are in
    PHASE3_PROGRESS.md (Step 5 review, rehearsal).
- **After each part, run its check and paste me the output.** Each check only
  reads.
- **Never paste a secret key or seed phrase.** The same rules as the mainnet
  runbook apply. If a command errors after it may have sent something, run
  the check before running it again.

Everything from Part 1 on runs as `qsmain`, from the read-only snapshot,
exactly as on mainnet:

```sh
sudo -iu qsmain
cd /opt/quietstay
mkdir -p ~/qs-rehearsal
```

## Part 0 — Before you start

Part 0.0 sets up the `qsmain` user, once for both the rehearsal and mainnet.
It is the same text as in MAINNET_SETUP.md. Then, as `qsmain`, do the mainnet
runbook's 0.1 and 0.2:
- 0.1, the CLI's mainnet RPC: the protocol check that `mainnet-sign-submit.sh`
  runs reads mainnet;
- 0.2, which sets `QS_KEY_STORE` (use `qs-rehearsal-storetest` as the test
  name).

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


## Part 1 — Identities

The six roles, as on mainnet, plus the two stand-ins:

```sh
stellar keys generate qs-rehearsal-issuer  $QS_KEY_STORE   # issuer and deployer
stellar keys generate qs-rehearsal-arbiter $QS_KEY_STORE   # resolves disputes only
stellar keys generate qs-rehearsal-fee     $QS_KEY_STORE   # fee identity (not used until a passkey flow)
stellar keys generate qs-rehearsal-owner   $QS_KEY_STORE
stellar keys generate qs-rehearsal-buyer   $QS_KEY_STORE
stellar keys generate qs-rehearsal-renter  $QS_KEY_STORE
stellar keys generate qs-rehearsal-signin  $QS_KEY_STORE   # plays mainnet-test
stellar keys generate qs-rehearsal-funder  $QS_KEY_STORE   # holds the faucet USDC
```

```sh
cat > ~/qs-rehearsal-public-keys.env <<EOF
export QS_REHEARSAL_ISSUER=$(stellar keys address qs-rehearsal-issuer)
export QS_REHEARSAL_ARBITER=$(stellar keys address qs-rehearsal-arbiter)
export QS_REHEARSAL_FEE=$(stellar keys address qs-rehearsal-fee)
export QS_REHEARSAL_OWNER=$(stellar keys address qs-rehearsal-owner)
export QS_REHEARSAL_BUYER=$(stellar keys address qs-rehearsal-buyer)
export QS_REHEARSAL_RENTER=$(stellar keys address qs-rehearsal-renter)
export QS_REHEARSAL_SIGNIN=$(stellar keys address qs-rehearsal-signin)
export QS_REHEARSAL_FUNDER=$(stellar keys address qs-rehearsal-funder)
EOF
source ~/qs-rehearsal-public-keys.env      # repeat in every new terminal
```

**Check 1:**

```sh
npx tsx scripts/check-mainnet-setup.ts --network testnet --part 1
```

## Part 2 — Funding

**2.1 Friendbot to the deployer**, in place of the exchange withdrawal. It
creates the account with 10,000 testnet XLM:

```sh
curl -s "https://friendbot.stellar.org/?addr=$QS_REHEARSAL_ISSUER" > /dev/null && echo funded
```

**2.2 The deployer creates the other five accounts.** These are the mainnet
commands, with `--network testnet`:

```sh
stellar tx new create-account --source-account qs-rehearsal-issuer --network testnet --destination "$QS_REHEARSAL_ARBITER" --starting-balance 20000000    #  2 XLM
stellar tx new create-account --source-account qs-rehearsal-issuer --network testnet --destination "$QS_REHEARSAL_FEE"     --starting-balance 30000000    #  3 XLM
stellar tx new create-account --source-account qs-rehearsal-issuer --network testnet --destination "$QS_REHEARSAL_OWNER"   --starting-balance 30000000    #  3 XLM
stellar tx new create-account --source-account qs-rehearsal-issuer --network testnet --destination "$QS_REHEARSAL_BUYER"   --starting-balance 190000000   # 19 XLM
stellar tx new create-account --source-account qs-rehearsal-issuer --network testnet --destination "$QS_REHEARSAL_RENTER"  --starting-balance 190000000   # 19 XLM
```

**Check 2:**

```sh
npx tsx scripts/check-mainnet-setup.ts --network testnet --part 2
```

## Part 3 — The sign-in key down to its minimum; the rest to the deployer

Friendbot gives the stand-in sign-in key what `mainnet-test` already has on
mainnet: an existing balance. Then it sends all but its 1 XLM minimum to the
deployer, the same `payment` as on mainnet, with its own amount:

    10000.0000000 (Friendbot) − 0.0000100 (fee) − 1.0000000 (minimum) = 9998.9999900 XLM = 99989999900 stroops

```sh
curl -s "https://friendbot.stellar.org/?addr=$QS_REHEARSAL_SIGNIN" > /dev/null && echo funded
npx tsx scripts/check-mainnet-setup.ts --network testnet --part 3    # FAILS on the balance for now; read it on the "sign-in key:" line
```

If the balance it shows is not 10000.0000000, send (balance − 1.0000100)
instead.

```sh
stellar tx new payment --source-account qs-rehearsal-signin --network testnet \
  --destination "$QS_REHEARSAL_ISSUER" --asset native --amount 99989999900
```

**Check 3:**

```sh
npx tsx scripts/check-mainnet-setup.ts --network testnet --part 3
```

## Part 4 — Trustlines, then 4 USDC from the faucet

**4.1 Trustlines with a 5 USDC limit.** These are the mainnet commands, with
Circle's testnet issuer:

```sh
stellar tx new change-trust --source-account qs-rehearsal-owner  --network testnet --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 50000000
stellar tx new change-trust --source-account qs-rehearsal-buyer  --network testnet --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 50000000
stellar tx new change-trust --source-account qs-rehearsal-renter --network testnet --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 50000000
```

**4.2 USDC from Circle's faucet, through the funder.** Circle's faucet sends
more than 5 USDC at a time, more than a trustline limited to 5 USDC accepts.
So the faucet pays the funder, which has no limit, and the funder passes on
exactly 2 USDC to each account, as an exchange would on mainnet.

```sh
curl -s "https://friendbot.stellar.org/?addr=$QS_REHEARSAL_FUNDER" > /dev/null && echo funded
stellar tx new change-trust --source-account qs-rehearsal-funder --network testnet --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
echo "$QS_REHEARSAL_FUNDER"     # paste this at https://faucet.circle.com (network: Stellar Testnet, USDC)
```

When the faucet's USDC has arrived (Stellar Expert, or the funder's line on
Horizon):

```sh
stellar tx new payment --source-account qs-rehearsal-funder --network testnet \
  --destination "$QS_REHEARSAL_BUYER"  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --amount 20000000
stellar tx new payment --source-account qs-rehearsal-funder --network testnet \
  --destination "$QS_REHEARSAL_RENTER" --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --amount 20000000
```

On mainnet this step is the DEX path payment (`--part 4 --quote`). There is
no reliable XLM/USDC book on testnet to rehearse it against.

**Check 4:**

```sh
npx tsx scripts/check-mainnet-setup.ts --network testnet --part 4
npx tsx scripts/check-pilot-accounts.ts --network testnet --accounts "$QS_REHEARSAL_OWNER,$QS_REHEARSAL_BUYER,$QS_REHEARSAL_RENTER"
```

## Part 5 — The Step 6 deploy, through `mainnet-sign-submit.sh`

Five transactions, all from the deployer, each built unsigned, reviewed, and
signed only when you type SEND:
1. upload the rights WASM;
2. upload the web-auth WASM;
3. deploy the rights contract;
4. deploy the web-auth contract;
5. deploy our own WebAuthn verifier from OpenZeppelin's uploaded WASM.

Build one envelope, sign it, then build the next. Each envelope carries the
deployer's next sequence number.

On testnet both QuietStay WASMs are already uploaded, so 5.1 and 5.2 cost
almost nothing. On mainnet 5.1 declares 69.43 XLM.

**5.0 Set up.** First check that the files are the tested builds. Then fetch
the verifier's WASM by its hash; this is a read, and it uploads nothing. The
salts fix the contract ids, so the ids are known, and checked by the review,
before anything is deployed.

```sh
export STEP6=~/qs-rehearsal/step6 && mkdir -p "$STEP6"
RIGHTS_WASM=contracts/target/wasm32v1-none/release/quietstay_rights.wasm
WEB_AUTH_WASM=contracts/vendor/anchor-web-auth/target/wasm32v1-none/release/web_auth.wasm
echo "76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde  $RIGHTS_WASM"   | sha256sum -c
echo "708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1  $WEB_AUTH_WASM" | sha256sum -c
stellar contract fetch --wasm-hash e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76 --network testnet -o "$STEP6/oz-verifier.wasm"
echo "e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76  $STEP6/oz-verifier.wasm" | sha256sum -c

cat > "$STEP6/salts.env" <<EOF
export SALT_RIGHTS=$(openssl rand -hex 32)
export SALT_WEB_AUTH=$(openssl rand -hex 32)
export SALT_VERIFIER=$(openssl rand -hex 32)
EOF
source "$STEP6/salts.env"
export QS_RIGHTS_CONTRACT=$(stellar contract id wasm --salt "$SALT_RIGHTS"   --source-account "$QS_REHEARSAL_ISSUER" --network testnet)
export WEB_AUTH_ID=$(stellar contract id wasm --salt "$SALT_WEB_AUTH"       --source-account "$QS_REHEARSAL_ISSUER" --network testnet)
export VERIFIER_ID=$(stellar contract id wasm --salt "$SALT_VERIFIER"       --source-account "$QS_REHEARSAL_ISSUER" --network testnet)
export QS_PILOT_ACCOUNTS="$QS_REHEARSAL_OWNER,$QS_REHEARSAL_BUYER,$QS_REHEARSAL_RENTER"
echo "rights $QS_RIGHTS_CONTRACT  web-auth $WEB_AUTH_ID  verifier $VERIFIER_ID"
VK="$(node -e 'process.stdout.write(JSON.stringify(require("./circuits/keys/verification_key.soroban.json")))')"
```

- `QS_RIGHTS_CONTRACT` is the rights contract's id before it exists.
  `mainnet-sign-submit.sh` needs it from the first upload on, and the review
  refuses a rights deploy that would create any other id.
- `QS_PILOT_ACCOUNTS` lists the accounts whose USDC the 5 USDC check counts.
- Keep `salts.env`: in a new terminal, `source` both env files and run the
  three `export … contract id` lines again.

Every envelope is built with `--build-only`, then simulated twice; the
second simulation includes the check of its own authorization. Only then is
it signed:

```sh
sim() { stellar tx simulate --source-account "$QS_REHEARSAL_ISSUER" --network testnet | stellar tx simulate --source-account "$QS_REHEARSAL_ISSUER" --network testnet; }
```

**5.1 Upload the rights WASM.** The review must show `upload 71244 bytes, sha256 76d69e79…`.

```sh
stellar contract upload --wasm "$RIGHTS_WASM" --source-account "$QS_REHEARSAL_ISSUER" --network testnet --build-only | sim > "$STEP6/01-upload-rights.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/01-upload-rights.xdr" qs-rehearsal-issuer --network testnet
```

**5.2 Upload the web-auth WASM.** The review must show `upload 1547 bytes, sha256 708cacdc…`.

```sh
stellar contract upload --wasm "$WEB_AUTH_WASM" --source-account "$QS_REHEARSAL_ISSUER" --network testnet --build-only | sim > "$STEP6/02-upload-web-auth.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/02-upload-web-auth.xdr" qs-rehearsal-issuer --network testnet
```

**5.3 Deploy the rights contract.** The review must show:
- `creates` = `$QS_RIGHTS_CONTRACT`;
- `from WASM 76d69e79…`;
- `ctor 0` = your issuer, `ctor 1` = your arbiter, `ctor 2` = the network's
  USDC;
- `VK hash 55ce858f… = the committed key`;
- `max_payment 10000000`, the 1 USDC pilot cap.

```sh
stellar contract deploy --wasm "$RIGHTS_WASM" --salt "$SALT_RIGHTS" --source-account "$QS_REHEARSAL_ISSUER" --network testnet --build-only -- \
  --issuer "$QS_REHEARSAL_ISSUER" --arbiter "$QS_REHEARSAL_ARBITER" --usdc CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  --name "QuietStay Usage Rights" --symbol QSTAY --verification_key "$VK" --max_payment 10000000 \
  | sim > "$STEP6/03-deploy-rights.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/03-deploy-rights.xdr" qs-rehearsal-issuer --network testnet
```

`--wasm` is only used to read the constructor's interface. In a
`--build-only` deploy the envelope holds one operation, a deploy by hash,
and no upload. The review prints that operation.

**5.4 Deploy the web-auth contract.** The review must show `creates` =
`$WEB_AUTH_ID`, `from WASM 708cacdc…`, and `admin the unauthorizable CDA2IFOT…`.

```sh
stellar contract deploy --wasm "$WEB_AUTH_WASM" --salt "$SALT_WEB_AUTH" --source-account "$QS_REHEARSAL_ISSUER" --network testnet --build-only -- \
  --admin "$(npx tsx scripts/deploy-web-auth.ts --print-admin)" | sim > "$STEP6/04-deploy-web-auth.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/04-deploy-web-auth.xdr" qs-rehearsal-issuer --network testnet
```

**5.5 Deploy our own WebAuthn verifier** from OpenZeppelin's uploaded WASM.
The review must show `creates` = `$VERIFIER_ID`, `from WASM e63a030d…`, and
no constructor argument.

```sh
stellar contract deploy --wasm "$STEP6/oz-verifier.wasm" --salt "$SALT_VERIFIER" --source-account "$QS_REHEARSAL_ISSUER" --network testnet --build-only \
  | sim > "$STEP6/05-deploy-verifier.xdr"
scripts/mainnet-sign-submit.sh "$STEP6/05-deploy-verifier.xdr" qs-rehearsal-issuer --network testnet
```

**Check 5.** This checks:
- each instance runs its pinned WASM;
- `issuer()`, `arbiter()`, `usdc()` and `max_payment()`;
- the verification key;
- that web-auth can never be upgraded;
- every TTL.

```sh
npx tsx scripts/check-deployment.ts --network testnet --rights "$QS_RIGHTS_CONTRACT" --web-auth "$WEB_AUTH_ID" \
  --verifier "$VERIFIER_ID" --issuer "$QS_REHEARSAL_ISSUER" --arbiter "$QS_REHEARSAL_ARBITER"
```

## Part 6 — One sale and one rental offer, signed the same way

`scripts/pilot-envelope.ts` builds each step's unsigned envelope:
- It runs as `qsmain`, like everything else. The snapshot is read-only, so
  `QS_PILOT_STATE_DIR` puts its state in `qsmain`'s home.
- It uses your public keys and signs nothing.
- It keeps the ownership records and secrets it creates in
  `$QS_PILOT_STATE_DIR/<contract>/pilot-testnet/`, never printed.
- It prints the exact signing command, which you run.
- From the second step on, it first reads the previous step's outcome from
  the chain.

Each envelope stays valid for 25 minutes. The sale's proof is valid for about
30 minutes, so sign `sale-accept` soon after building it. Each payment is
1 USDC, the pilot cap.

```sh
export FLOWS=~/qs-rehearsal/flows QS_PILOT_STATE_DIR=~/qs-rehearsal/state
npx tsx scripts/pilot-envelope.ts issue-a      --network testnet --contract "$QS_RIGHTS_CONTRACT" --out "$FLOWS"
scripts/mainnet-sign-submit.sh "$FLOWS/01-issue-a.xdr" qs-rehearsal-issuer --network testnet

npx tsx scripts/pilot-envelope.ts issue-b      --network testnet --contract "$QS_RIGHTS_CONTRACT" --out "$FLOWS"
scripts/mainnet-sign-submit.sh "$FLOWS/02-issue-b.xdr" qs-rehearsal-issuer --network testnet

npx tsx scripts/pilot-envelope.ts sale-request --network testnet --contract "$QS_RIGHTS_CONTRACT" --out "$FLOWS"
scripts/mainnet-sign-submit.sh "$FLOWS/03-sale-request.xdr" qs-rehearsal-buyer --network testnet

npx tsx scripts/pilot-envelope.ts sale-offer   --network testnet --contract "$QS_RIGHTS_CONTRACT" --out "$FLOWS"
scripts/mainnet-sign-submit.sh "$FLOWS/04-sale-offer.xdr" qs-rehearsal-buyer --network testnet
```

The sale offer's review shows the buyer authorizing the USDC `approve`, with
the rights contract as spender, for 1 USDC. That is the allowance the sale
draws on (D12).

```sh
npx tsx scripts/pilot-envelope.ts sale-accept  --network testnet --contract "$QS_RIGHTS_CONTRACT" --out "$FLOWS"
scripts/mainnet-sign-submit.sh "$FLOWS/05-sale-accept.xdr" qs-rehearsal-owner --network testnet

npx tsx scripts/pilot-envelope.ts rental-offer --network testnet --contract "$QS_RIGHTS_CONTRACT" --out "$FLOWS"
scripts/mainnet-sign-submit.sh "$FLOWS/06-rental-offer.xdr" qs-rehearsal-renter --network testnet
```

**Check 6.** It reports:
- each step's status on chain;
- who holds each week: week A should be the buyer's, week B still the owner's;
- the USDC: owner 1, buyer 1, renter 2, contract 0;
- the privacy check over every landed step, with its record written to
  `$FLOWS/privacy-….txt`.

```sh
npx tsx scripts/pilot-envelope.ts status --network testnet --contract "$QS_RIGHTS_CONTRACT" --out "$FLOWS"
```

## After the rehearsal

- Paste me each check. I verify it on chain and record it in
  PHASE3_PROGRESS.md.
- If anything differed from what this runbook says, that difference is what
  the rehearsal found. I fix it in both runbooks before you run mainnet.
- The rehearsal accounts and contracts stay on testnet. Nothing needs
  cleaning up.
- Then the mainnet runbook, [MAINNET_SETUP.md](MAINNET_SETUP.md), Parts 0–4.
  Its Part 5 (the deploy) waits for your GO.
