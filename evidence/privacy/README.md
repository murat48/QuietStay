# Privacy checks, kept

`npm run check-privacy` fetches an evidence transaction back from the network
and searches every layer of it, events included, for anything from the
off-chain records. That covers record contents, the record digest `d`
(`d_hi`, `d_lo`), and the holder's secret `s` and its hash `h`. It also prints
what the call and its events do show.

Stellar RPC keeps a transaction's meta, and so its events, for about a week.
Horizon no longer serves meta at all. So a check run later can scan the
envelope and the result, but not the events. From Phase 3 Step 2 on
(review, 2026-11-19), the check is run **right after every evidence
transaction**, on testnet and on mainnet, and its full output is committed
here.

- One file per run: `<date>-<what>.txt`. Each starts with the date, the
  network and the exact command.
- Records and secrets are passed by file and searched for, never printed.
  The end-to-end tests pass theirs through a private temporary directory
  that is deleted afterwards (`e2e/lib/privacy.ts`).
- A transaction whose record or secret was not available when it was checked
  is listed as checked against the inventory values only.

Run by hand:

```bash
npm run check-privacy -- --network testnet --tx <label>=<hash> [--tx …] \
  [--record <record.json>] [--secret <secret.json>] \
  --out evidence/privacy/<date>-<what>.txt
```
