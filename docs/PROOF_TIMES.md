# Proof generation times in the browser

How long the in-browser prover (`public/zk/prover.worker.js`, built from
[`prover-worker/`](../prover-worker/)) takes to make one ownership proof.
Every number below comes from the command next to it, and the raw results are
in [`e2e/results/`](../e2e/results/).

## Results

| Date | Device | Browser | First proof | Median of 7 | Median inside `fullProve` | Runs (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19 | Intel Core i7-10750H, 12 logical cores, 15 GiB RAM, Linux (WSL2) | Chromium 158.0.8127.18, headless | 1,159 ms | **498 ms** | 459 ms | 673, 551, 441, 453, 503, 429, 498 |
| 2026-11-19 | same machine | Firefox 159.0, headless | 1,905 ms | **556 ms** | 512 ms | 594, 573, 541, 643, 539, 556, 550 |

Command, for both rows:

```bash
npm run zk:build-worker
npx tsx e2e/prover-bench.ts --runs 7        # writes e2e/results/proof-times-<browser>-<date>.json
```

## What is measured

- **The proof:** a rental of one week, with the committed development keys
  (`circuits/keys/`, the same ones as Phase 2). A sale proves the same circuit
  and costs the same.
- **First proof:** from `postMessage` to the answer, in a fresh worker. It
  includes fetching `transfer.wasm` and `transfer.zkey` (3.9 MB together),
  checking their SHA-256, and building Poseidon.
- **Median of 7:** the next 7 proofs in the same worker, one after another,
  from `postMessage` to the answer: what a user waits for. Each one includes
  verifying the proof against the verification key and comparing its public
  signals with the ones computed for the transfer.
- **Inside `fullProve`:** the time spent in snarkjs's `groth16.fullProve`
  alone, as the worker reports it.
- **Correctness:** for every proof, the benchmark checks that the worker's
  public signals equal the CLI prover's (`scripts/lib/zk.ts`) for the same
  inputs.

## Limits of these numbers

- **Two browsers, one machine.** Step 2 asks for at least two devices *or*
  browsers. These are two browser engines on one laptop. A phone or a slower
  laptop will be slower.
- **Headless, through Playwright.** A desktop browser window should be close,
  but it is not the same measurement.
- **For comparison only:** the Node prover inside the passkey probe
  (`npm run passkey:probe`) printed 1.5 s and 0.5 s for its single proof in
  two runs on the same machine. Those are single runs, not a median.
