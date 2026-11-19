// SPDX-License-Identifier: GPL-3.0
// Part of the QuietStay in-browser prover (prover-worker/). See LICENSE and README.md.

/**
 * Build the prover worker into public/zk/.
 *
 *   npm run zk:build-worker        (also runs before `npm run dev` and `npm run build`)
 *
 * Writes:
 *   public/zk/prover.worker.js   the worker, one file, GPL-3.0 (first line says so)
 *   public/zk/transfer.wasm      copied from circuits/keys/
 *   public/zk/transfer.zkey      copied from circuits/keys/
 *   public/zk/LICENSE            the GPL-3.0 text
 *
 * The SHA-256 of transfer.wasm and transfer.zkey is read from
 * circuits/keys/SHA256SUMS, checked against the files, and compiled into the
 * worker. These outputs are build artifacts and are not committed.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const KEYS = resolve("circuits/keys");
const OUT = resolve("public/zk");

function committedHash(name: string): string {
  const line = readFileSync(join(KEYS, "SHA256SUMS"), "utf8")
    .split("\n")
    .find((l) => l.trim().endsWith(` ${name}`));
  const hash = line?.split(/\s+/)[0];
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`no hash for ${name} in SHA256SUMS`);
  const actual = createHash("sha256").update(readFileSync(join(KEYS, name))).digest("hex");
  if (actual !== hash) throw new Error(`${name} does not match SHA256SUMS (${actual} != ${hash})`);
  return hash;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const wasm = committedHash("transfer.wasm");
  const zkey = committedHash("transfer.zkey");

  await build({
    entryPoints: [resolve("prover-worker/src/worker.ts")],
    outfile: join(OUT, "prover.worker.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    banner: {
      js:
        "/* SPDX-License-Identifier: GPL-3.0 — QuietStay in-browser prover. Source: prover-worker/ " +
        "(built from snarkjs, ffjavascript and circomlib-derived Poseidon). License: /zk/LICENSE */",
    },
    define: {
      __WASM_SHA256__: JSON.stringify(wasm),
      __ZKEY_SHA256__: JSON.stringify(zkey),
      global: "globalThis",
    },
    logLevel: "warning",
  });

  copyFileSync(join(KEYS, "transfer.wasm"), join(OUT, "transfer.wasm"));
  copyFileSync(join(KEYS, "transfer.zkey"), join(OUT, "transfer.zkey"));
  copyFileSync(resolve("prover-worker/LICENSE"), join(OUT, "LICENSE"));
  console.log(`prover worker built: ${join(OUT, "prover.worker.js")} (wasm ${wasm.slice(0, 8)}…, zkey ${zkey.slice(0, 8)}…)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
