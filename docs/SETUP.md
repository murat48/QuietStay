# Setup

Two ways in, depending on what you need.

**Just reviewing?** You do not need any of this. Open the links in
[EVIDENCE.md](./EVIDENCE.md) — a contract address, four transactions, and a demo
video. Nothing to install.

**Running it yourself?** Read on.

- [Requirements](#requirements)
- [Run against the existing deployment](#run-against-the-existing-deployment)
- [Deploy your own](#deploy-your-own)
- [Every command](#every-command)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| | Version used | Notes |
| --- | --- | --- |
| Rust | 1.96.0 | Only for the contract. Not needed to run the web app. |
| `wasm32v1-none` target | — | `rustup target add wasm32v1-none` |
| Stellar CLI | 27.0.0 | `cargo install --locked stellar-cli` |
| Node.js | 24.17 | 20.6+ works; `process.loadEnvFile` is required. |
| A Stellar wallet | — | Any of **Freighter, xBull, Albedo, Rabet, Lobstr, Hana**, set to **testnet**. |

Connection goes through [Stellar Wallets Kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit),
so there is no single required extension — pick your wallet from the kit's modal.
Hardware wallets and WalletConnect are deliberately not enabled; see the
[README](../README.md#wallets) for why.

The pinned versions are `soroban-sdk` 27.0.6, `@stellar/stellar-sdk` 16.2.0, and
`@creit.tech/stellar-wallets-kit` 2.5.0.

### A note on `npm audit`

`npm audit` reports findings in `elliptic`, `axios`, and friends. They arrive as
transitive dependencies of wallet modules the kit *packages* but this app never
*loads* — Trezor, Ledger, HOT, and WalletConnect. Because the modules are imported
individually, that code is absent from the build; `grep -r cdp-sdk .next/static` and
the like come back empty. The advisories cannot be resolved by us without the kit
dropping those integrations upstream.

## Run against the existing deployment

The contract at
[`CDBPK4OOM43UCROSEDC2Q5NHR6L7GBKLESXP4GXXN4KHNL25FTM3DBXS`](https://stellar.expert/explorer/testnet/contract/CDBPK4OOM43UCROSEDC2Q5NHR6L7GBKLESXP4GXXN4KHNL25FTM3DBXS)
is live with sample inventory already issued. You can read all of it with no
configuration at all:

```bash
npm install
npm run dev            # then open http://localhost:3000/list
```

The **list** and **verify** screens work immediately — they only read. Sample
records and attestations to paste into the verify screen are in
[`inventory/`](../inventory/).

### To issue or transfer

Those need keys, because they need signatures.

```bash
cp .env.example .env.local
```

Then fill in `.env.local`. It is gitignored; do not commit it.

```bash
# 1. The issuer's key. Signs attestations and co-signs transfer approvals.
stellar keys generate qs-issuer --fund --network testnet
stellar keys show qs-issuer          # → QUIETSTAY_ISSUER_SECRET

# 2. SEP-10 challenge signing key. Never submitted, so it needs no funding.
stellar keys generate qs-sep10-server
stellar keys show qs-sep10-server    # → QUIETSTAY_SEP10_SERVER_SECRET

# 3. Session signing secret. Any 32+ random characters.
openssl rand -hex 32                 # → QUIETSTAY_SESSION_SECRET

# 4. Optional: demo identities, used only by the scripts.
for k in qs-owner qs-renter qs-buyer; do
  stellar keys generate "$k" --fund --network testnet
  echo "$k → $(stellar keys show $k)"
done
```

One caveat worth knowing before you try: **`issue` on the existing deployment will
not work with your own issuer key.** The contract binds its issuer at deployment and
has no setter, deliberately — see
[DESIGN.md § privileged surface](./DESIGN.md#privileged-surface-enumerated). To use
the issue screen, deploy your own.

## Deploy your own

```bash
./scripts/deploy.sh
```

Which runs the tests, builds the WASM, reports its size against the 64 KB limit, and
deploys with `qs-issuer` as the issuer. Put the printed contract address into
`.env.local` as **both** `QUIETSTAY_CONTRACT_ID` and
`NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID`, then:

```bash
npm run seed        # issue the four sample weeks, write attestations
npm run evidence    # produce the four evidence transactions, regenerate EVIDENCE.md
npm run dev
```

`npm run seed` deliberately leaves sample week 04 attested as **not** clean — it
carries €410 in arrears, so the issuer declines to vouch for it. That gives the
verify screen and the approval service something real to refuse.

## Every command

| Command | What it does |
| --- | --- |
| `cd contracts && cargo test` | 32 contract unit tests. |
| `cd contracts && stellar contract build` | Build the WASM. |
| `./scripts/deploy.sh` | Test, build, deploy to testnet. |
| `npm run dev` | Development server on :3000. |
| `npm run build && npm run start` | Production build and serve. |
| `npm run typecheck` | `tsc --noEmit` over app and scripts. |
| `npm run seed` | Issue the sample inventory and write attestations. |
| `npm run evidence` | Produce the four evidence transactions; rewrite `docs/EVIDENCE.md`. |
| `npm run check-privacy` | Fetch the evidence transactions back and search for record leaks. |
| `npm run e2e` | 34 checks against a running app. Needs `npm run start` first. |
| `npm run commit-record -- <record.json>` | Compute a commitment; write canonical bytes for `sha256sum`. |
| `npm run verify-record -- <id> <attestation.json> [record.json]` | The verify screen's checks, on the command line. The record is optional. |
| `npm run attest -- <id> <record.json>` | Re-sign an attestation, e.g. once arrears are settled. |

## Troubleshooting

**`Failed to find config identity for qs-issuer`** — the identity does not exist yet.
Note that `--global` was removed in Stellar CLI 27; identities are global by default,
so `stellar keys generate qs-issuer --fund --network testnet` is the whole command.

**`QUIETSTAY_ISSUER_SECRET is not set`** — `.env.local` is missing or unreadable.
Scripts load it with `process.loadEnvFile`; Next.js loads it automatically.

**A wallet is missing from the chooser** — extension wallets inject on page load, so
install first and then reload. Only Freighter, xBull, Albedo, Rabet, Lobstr, and Hana
are enabled.

**`Your wallet is on PUBLIC. QuietStay Phase 1 is testnet only`** — switch the wallet
to testnet and reconnect. The app refuses rather than building a transaction for the
wrong network. Wallets that do not report a network (Albedo, for one) are allowed
through: the transaction carries the testnet passphrase either way, so a wrong-network
wallet will refuse or produce a signature the network rejects.

**`This is the issuer's screen`** — you are signed in as an account that is not this
deployment's issuer. Expected; see [above](#to-issue-or-transfer). Roles come from the
registry, so signing in with a different account is the only way to change one.

**`You have no week to transfer right now`** — this account holds nothing, or the
weeks it owns are all out on rental. A rented-out week is not the owner's to move
until the term lapses, which it does on its own.

**`the issuer has no attestation on file for right #N`** — the approval service will
not approve a transfer of a week it cannot vouch for. Sign one with
`npm run attest -- N <record.json>`.

**`This right's use year has closed`** — the sample inventory is use-year 2026, so
every sample right goes inert on 2027-01-01. Re-seed with later dates.

**`EADDRINUSE: :::3000`** — an earlier server is still running. `pkill -f next-server`.

**Contract calls fail after a long gap** — testnet resets roughly quarterly, which
deletes all accounts and contracts. Redeploy and re-seed.
