# prover-worker — the in-browser prover (GPL-3.0)

Everything in this folder is licensed under the **GNU General Public License,
version 3** ([LICENSE](LICENSE)). The rest of QuietStay is Apache-2.0.

## Why this folder exists

QuietStay Phase 3 makes the ownership proof in the holder's browser, so the
record and its secret never leave the device (docs/PHASE3_SPEC.md §2). The
proof needs three things that are GPL-3.0:

| What | From | License |
| --- | --- | --- |
| Groth16 prover and verifier | [snarkjs](https://github.com/iden3/snarkjs) 0.7.5 (`build/browser.esm.js`) | GPL-3.0 |
| BLS12-381 field arithmetic | [ffjavascript](https://github.com/iden3/ffjavascript) 0.2.63 | GPL-3.0 |
| Poseidon | [`circuits/gpl/poseidon-core.ts`](../circuits/gpl/poseidon-core.ts), derived from circomlibjs | GPL-3.0 |
| The compiled circuit `transfer.wasm` and proving key `transfer.zkey` | [`circuits/gpl/transfer.circom`](../circuits/gpl/transfer.circom), using circomlib's Poseidon template | GPL-3.0 |

Decision D2 keeps all of it in **one separately built file**,
`public/zk/prover.worker.js`, which runs as a dedicated Web Worker. The
Apache-2.0 app ([`src/lib/prover-client.ts`](../src/lib/prover-client.ts))
talks to it only by `postMessage` and never imports it. `npm run
zk:check-bundle` checks that GPL code appears in the worker and nowhere in
the app's own bundle.

The worker also uses two Apache-2.0 files from this repository:
[`src/lib/zk-fields.ts`](../src/lib/zk-fields.ts) (address and field
encoding) and [`src/lib/canonical.ts`](../src/lib/canonical.ts) (the record
digest), plus [`scripts/lib/zk-encode.ts`](../scripts/lib/zk-encode.ts) (the
proof's byte layout). They are compiled into the GPL-3.0 worker, which
Apache-2.0 permits.

## What it does

- `src/core.ts`: the record digest `d`, the secret hash `h`, the commitment
  `C`, and a proof of one transfer. Every proof is verified against the
  committed verification key, and its public signals are compared with the
  ones computed for the transfer, before it is returned.
  `circuits/test/prover-core.test.ts` checks that it gives exactly the CLI
  prover's public signals.
- `src/worker.ts`: the message handler. Before the first proof it fetches
  `transfer.wasm` and `transfer.zkey` from its own folder. It refuses them
  unless their SHA-256 equals the hashes in `circuits/keys/SHA256SUMS`. Those
  hashes are compiled in at build time, never fetched. The worker keeps
  nothing between messages.

## Rebuild

```bash
npm run zk:build-worker   # runs automatically before `npm run dev` and `npm run build`
```

This writes `public/zk/prover.worker.js` (its first line names the license
and this folder), and copies `transfer.wasm`, `transfer.zkey` and
[LICENSE](LICENSE) next to it. Those are build outputs and are not
committed. The build uses esbuild 0.28.2, pinned in `package.json`.
