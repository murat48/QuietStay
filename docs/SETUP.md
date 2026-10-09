# Setup

Two ways in, depending on what you need.

**Just reviewing?** You do not need any of this. Open the links in
[EVIDENCE.md](./EVIDENCE.md) — contract addresses and transactions, each with what to
look for. Nothing to install.

**Running it yourself?** Read on.

- [Requirements](#requirements)
- [Run against the existing deployment](#run-against-the-existing-deployment)
- [Proving a transfer](#proving-a-transfer)
- [Deploy your own](#deploy-your-own)
- [The circuit, Poseidon and the trusted setup](#the-circuit-poseidon-and-the-trusted-setup)
- [End-to-end test](#end-to-end-test)
- [Every command](#every-command)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| | Version used | Needed for |
| --- | --- | --- |
| Node.js | 24.17 | Everything. 20.6+ works; `process.loadEnvFile` is required. |
| Rust | 1.96.0 | The contracts. Not needed to run the web app or to prove. |
| `wasm32v1-none` target | — | `rustup target add wasm32v1-none` |
| Stellar CLI | 27.0.0 | `cargo install --locked stellar-cli` |
| circom | 2.2.2 (`e410b0d5`) | Compiling the circuit. `cargo install --locked --git https://github.com/iden3/circom.git --tag v2.2.2 circom` |
| snarkjs | 0.7.5 | Setup and proving — installed by `npm install` (pinned, exact). |
| circomlib / ffjavascript | 2.0.5 / 0.2.63 | The Poseidon template and field arithmetic — installed by `npm install`. |
| Docker + SageMath 10.4 | `sagemath/sagemath@sha256:8d657a42…` | **Only** to regenerate the Poseidon constants from scratch. Checking them needs nothing. |
| Python 3 | 3.12 | Only with the line above, for the round-number script. |
| A Stellar wallet | — | **Freighter, xBull, Albedo, Rabet** or **Hana**, on testnet. Asking to *buy* needs Freighter or Hana. |

Proving needs Node only: the compiled circuit, the proving key and the verification
key are committed in [`circuits/keys/`](../circuits/keys/), so `npm run zk:prove` works
from a clone with no circom installed.

Connection goes through [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit).
The five modules are named explicitly rather than using `allowAllModules()`, which
would pull in WalletConnect, Trezor, Ledger and HOT and their dependencies — code
this app never runs, some of it carrying published advisories. Lobstr is not among
them because its signer library is GPL-3.0 and would put GPL code in the browser
bundle (see the README's License section).

### A note on `npm audit`

`npm audit` reports findings in `elliptic`, `axios`, and friends. They arrive as
transitive dependencies of wallet modules the kit *packages* but this app never
*loads*. Because the modules are imported individually, that code is absent from the
build; `npm run zk:check-bundle` and `grep -r cdp-sdk .next/static` come back empty.

## Run against the existing deployment

The Phase 2 contract at
[`CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD`](https://stellar.expert/explorer/testnet/contract/CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD)
is live with the sample inventory issued
([`inventory/phase2/issued.json`](../inventory/phase2/issued.json)). Reading needs no
configuration:

```bash
npm install
npm run dev            # http://localhost:3000/verify
```

### Keys, for anything that signs

```bash
cp .env.example .env.local     # gitignored; never commit it
```

```bash
# 1. The issuer's key. Issues weeks and signs attestations — never transfers.
stellar keys generate qs-issuer --fund --network testnet
stellar keys show qs-issuer          # → QUIETSTAY_ISSUER_SECRET

# 2. SEP-10 challenge signing key. Never submitted, so it needs no funding.
stellar keys generate qs-sep10-server
stellar keys show qs-sep10-server    # → QUIETSTAY_SEP10_SERVER_SECRET

# 3. Session signing secret. Any 32+ random characters.
openssl rand -hex 32                 # → QUIETSTAY_SESSION_SECRET

# 4. Demo identities, used by the scripts (owner, renter, buyer).
for k in qs-owner qs-renter qs-buyer; do
  stellar keys generate "$k" --fund --network testnet
done                                 # → DEMO_OWNER_SECRET, DEMO_RENTER_SECRET, DEMO_BUYER_SECRET
```

`issue` on the existing deployment will not work with your own issuer key: the
contract binds its issuer at deployment and has no setter. To issue, deploy your own.

## Issuing a week from the terminal

On a contract whose issuer key is in `.env.local`, one command does what the Issue
screen and `zk:secret` / `zk:commitment` do between them:

```bash
npm run zk:issue -- --contract <C…> --owner <G…> --check-in 2026-12-05 --check-out 2026-12-12
```

It builds the record from a sample (`--like`, default `inventory/records/week-03.json`)
with a fresh `record_id` and `salt`, makes the owner's secret, computes `C`, calls
`issue` and signs the attestation. Record, secret and a summary go to
`.secrets/<first 8 of the contract>/`. `--record <file>` issues an existing record
instead; `--secret <file>` reuses a secret the owner already made. The attestation
lands in `inventory/phase2/attestations/` only for the contract that folder belongs
to — commit and push it for the live app to show it — and next to the secret otherwise.

Owner and issuer are one person here, which suits a demo. In real use the owner runs
`zk:secret` on their own machine and hands over only `h`.

## Proving a transfer

The holder's side of a transfer, on their own machine:

```bash
# Once, when the week is issued to you: make your record secret. Keep the file;
# send only the h it prints to the issuer.
npm run zk:secret -- .secrets/my-week.json

# A rental, running to the end of the week:
npm run zk:prove -- --record my-week-record.json --secret .secrets/my-week.json \
  --right 3 --from <your G…> --to <renter G…> --rental-until <unix seconds> \
  --out proofs/right-3

# A sale — with the h' the buyer gave when asking for the week:
npm run zk:prove -- --record my-week-record.json --secret .secrets/my-week.json \
  --right 3 --from <your G…> --to <buyer G…> --sale --next-secret-hash <buyer's h'> \
  --out proofs/right-3
```

The prover verifies its own proof with snarkjs before writing anything, and writes
`proof.json`, `public.json` and `transfer.json` — the last is what the Transfer
screen takes. A proof is valid for 360 ledgers by default (`--window`, at most 720 —
about an hour). The List screen shows each ask with this command already filled in.

From the command line instead of the app: `npm run zk:submit -- <contract> proofs/right-3`
signs every authorization the contract asks for with the keys in `.env.local`.

**Lose the secret file and the week can never be rented out or sold again** — nobody
else can prove for it, the issuer included. `.secrets/` and `proofs/` are gitignored.

The buyer's side of a sale is one command and one signature: `npm run zk:secret`,
then the List screen's *Sign my consent and ask to buy* with the printed `h'`.

To check a disclosed record against the ledger's commitment — the step the browser
does not take:

```bash
npm run verify-record -- <id> <attestation.json> <record.json> --secret-hash <h>
```

## Deploy your own

```bash
./scripts/deploy.sh                      # tests, builds, deploys with the committed verification key
# put the address in .env.local as QUIETSTAY_CONTRACT_ID and NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID
npm run zk:reissue -- <contract>         # issue the four sample weeks; secrets to .secrets/<contract>/
for n in 1 2 3 4; do npm run attest -- $n inventory/records/week-0$n.json; done
npm run dev
```

`zk:reissue` makes each owner's secret in `.secrets/<first 8 of the contract>/`, hands
only its hash to the issuer side, and records each week's `d` and `C` in
`inventory/phase2/issued.json`. Sample week 04 is attested **not** clean — it carries
€410 in arrears — which gives the verify screen something real to flag; under Phase
2 it does not stop a transfer.

The evidence: `npm run zk:evidence -- <contract> <deploy tx>` produces two accepted and
five rejected transfers on the contract, reads each rejection's error back from the
ledger and checks it, and writes `docs/evidence-phase2.json`; `npm run evidence-doc`
turns that into `docs/EVIDENCE.md`. The rejections use an evidence-only submission
path (`withSiblingResources` in `scripts/lib/zk-tx.ts`).

## The circuit, Poseidon and the trusted setup

```bash
npm run zk:compile           # circom → circuits/build/ (R1CS, WASM, symbols)
npm run zk:test              # 11 circuit tests
npm run zk:check-poseidon    # the Poseidon constants' provenance, 20 checks, offline
bash circuits/poseidon/generate.sh   # regenerate the constants from scratch (Docker, Sage)
npm run zk:setup             # a NEW development trusted setup — non-production
npm run zk:encode-vk         # the verification key in the contract's byte layout
npm run zk:test-fixtures     # real proofs for the contract tests
```

`npm run zk:setup` makes **new** keys every time — the contributions are random — and
every proof made with the old ones stops verifying against the new. The committed
keys are the ones the deployed contracts were constructed with; their hashes are in
[`circuits/keys/SHA256SUMS`](../circuits/keys/SHA256SUMS). After a new setup, run
`zk:encode-vk` and `zk:test-fixtures` and deploy afresh.

`generate.sh` needs Docker; it clones the Poseidon authors' repository at a pinned
commit and runs their scripts in a digest-pinned SageMath image. Its output is
deterministic: a rerun leaves `git diff circuits/poseidon` empty. Details and the
parameters in [CIRCUIT.md](./CIRCUIT.md#poseidon-parameters-over-bls12-381).

## End-to-end test

`npm run e2e` drives the running app over HTTP with the demo keys, proving with the
same code as `zk:prove`: SEP-10, issuance with a CLI-computed `C`, attestation v2,
offers, a proven rental, a replay refused, someone else's proof refused, a tampered
proof refused, a sale refused without the buyer's consent, a forged consent refused,
the sale with a real one, the verify screen's transfer list, and — on an app that
reads the evidence contract — the evidence links it falls back to once the event
window has passed: 41 checks.

It issues weeks, so **run it against a throwaway deployment**, never the one in
EVIDENCE.md — and give the app its own data directory, because every contract
numbers its rights from 1 and the app would otherwise write the throwaway weeks'
attestations over the committed ones:

```bash
VK="$(node -e 'process.stdout.write(JSON.stringify(require("./circuits/keys/verification_key.soroban.json")))')"
E2E=$(stellar contract deploy --wasm contracts/target/wasm32v1-none/release/quietstay_rights.wasm \
  --source qs-issuer --network testnet -- --issuer "$(stellar keys address qs-issuer)" \
  --name "QuietStay E2E" --symbol QSE2E --verification_key "$VK" | tail -1)
export NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=$E2E QUIETSTAY_CONTRACT_ID=$E2E

npm run build
QUIETSTAY_DATA_DIR=$(mktemp -d) npm run start -- -p 3107      # one terminal
E2E_BASE_URL=http://localhost:3107 npm run e2e                 # another
```

Step 11 looks at an app that reads the **evidence** contract. If the one under test
does not, point `E2E_EVIDENCE_BASE_URL` at one that does — the live app, or
`npm run dev -- -p 3108` with the default `.env.local` (Next 16's dev server builds
into `.next/dev`, so it runs beside `npm run start`).

**Rehearsing on a throwaway contract.** `npm run zk:reissue -- <throwaway> --out
<file outside the repo>` issues the sample weeks there without touching
`inventory/phase2/issued.json` — it refuses to overwrite that file with another
contract's issuance — and `npm run attest -- <id> <record> --issued <that file>`
attests them. The CLI reads the contract and the data directory before
`.env.local` is loaded, so give `QUIETSTAY_CONTRACT_ID`,
`NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID` and `QUIETSTAY_DATA_DIR` on the command line.

## Every command

| Command | What it does |
| --- | --- |
| `cd contracts && cargo test` | 62 rights-contract tests (every transfer with a real proof) and 6 verifier tests. |
| `./scripts/deploy.sh` | Test, build, deploy to testnet with the committed verification key. |
| `npm run dev` / `npm run build && npm run start` | The web app. |
| `npm run typecheck` | `tsc --noEmit` over app, scripts and circuit tests. |
| `npm run zk:secret -- <file>` | Make a record secret; print its shareable hash `h`. |
| `npm run zk:commitment -- --record … --owner … --secret-hash …` | The commitment `C` the issuer issues with. |
| `npm run zk:issue -- --contract … --owner … --check-in … --check-out …` | Record, secret, `C`, `issue` and attestation in one step. |
| `npm run zk:prove -- …` | Prove a transfer; write `transfer.json`. |
| `npm run zk:submit -- <contract> <proof dir>` | Submit a proven transfer from the command line. |
| `npm run zk:reissue -- <contract>` | Issue the sample inventory with Poseidon commitments. |
| `npm run zk:evidence -- <contract> <deploy tx>` | Produce the seven evidence transactions. |
| `npm run evidence-doc` | Regenerate `docs/EVIDENCE.md`. |
| `npm run attest -- <id> <record.json> [--secret-hash <h>]` | Sign a v2 attestation; the record is checked against the issuance or against `C`. |
| `npm run describe -- <id> --region … --bedrooms …` | Restate a week's description without its record. |
| `npm run verify-record -- <id> <attestation> [record] [--secret-hash <h>]` | The verify screen's checks, plus `d → C`. |
| `npm run commit-record -- <record.json>` | `d`, and the canonical bytes for `sha256sum`. |
| `npm run check-privacy -- --phase2` | Search every Phase 2 transaction for leaked record contents, `d`, `s` or `h`. |
| `npm run e2e` | End-to-end checks against a running app — see [above](#end-to-end-test). |
| `npm run zk:compile` / `zk:test` / `zk:check-poseidon` / `zk:setup` / `zk:encode-vk` / `zk:test-fixtures` | See [the circuit](#the-circuit-poseidon-and-the-trusted-setup). |
| `npm run zk:measure -- <verifier> <proof dir>` | Simulate the standalone verifier and print its cost. |
| `npm run zk:check-bundle` | After `npm run build`: confirm no GPL-3.0 code is in the browser bundle. |

## Troubleshooting

**`no open request from G… to buy right #N carries this proof's next secret hash`** —
a sale needs the buyer's consent, which the buyer gives when asking for the week.
Prove with the `h'` shown on that ask.

**`This proof has already been used`** / **`This proof's window has passed`** — make a
fresh one with `npm run zk:prove`. Each proof is good for one transfer, for about an
hour.

**`This proof is for a different record secret than the one this week is committed
to`** — the secret file is not the one this week was issued (or last sold) to. After
a sale, only the buyer's secret works.

**`xBull does not support the "signAuthEntry" function`** (or Albedo, Rabet) — asking
to buy needs a wallet that signs authorization entries: Freighter or Hana.

**`Failed to find config identity for qs-issuer`** — the identity does not exist yet:
`stellar keys generate qs-issuer --fund --network testnet`.

**`QUIETSTAY_ISSUER_SECRET is not set`** — `.env.local` is missing or unreadable.

**`Your wallet is on PUBLIC`** — switch the wallet to testnet and reconnect.

**`This right's use year has closed`** — the sample inventory is use-year 2026 and
goes inert on 2027-01-01. Issue again with later dates.
