/**
 * Proof generation times in real browsers, for docs/PROOF_TIMES.md.
 *
 *   npm run zk:build-worker && npx tsx e2e/prover-bench.ts [--runs 7] [--browser chromium|firefox|all]
 *
 * Serves public/ from localhost, starts the built prover worker
 * (public/zk/prover.worker.js) in a headless browser and makes `--runs`
 * rental proofs, one after another, after one warm-up proof that is reported
 * separately (it includes fetching and hash-checking the 3.9 MB of keys). For
 * each run it records the time from `postMessage` to the answer, as a user
 * would wait for it, and the time inside `groth16.fullProve`.
 *
 * Every proof's public signals are compared with the CLI prover's
 * (scripts/lib/zk.ts) for the same inputs. The record and secret are test
 * values made up for the run.
 *
 * Writes e2e/results/proof-times-<browser>-<date>.json.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, totalmem } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, firefox, type BrowserType } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

import type { JsonValue } from "../src/lib/canonical";
import { circuitInput, randomSecret, splitRecordDigest } from "../scripts/lib/zk";

const PORT = 4318;
const PUBLIC = resolve("public");
const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function main() {
  const { values: a } = parseArgs({ options: { runs: { type: "string" }, browser: { type: "string" } } });
  const runs = Number(a.runs ?? 7);
  const which = a.browser ?? "all";
  if (!existsSync(join(PUBLIC, "zk/prover.worker.js"))) throw new Error("run `npm run zk:build-worker` first");

  const record = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8")) as JsonValue;
  const secret = randomSecret();
  const ctx = {
    rightId: 1n,
    from: Keypair.random().publicKey(),
    to: Keypair.random().publicKey(),
    expiresAt: 1_783_728_000n,
    expiryLedger: 5_000_360n,
    nextSecretHash: 0n,
  };
  const expected = (await circuitInput(await splitRecordDigest(record), secret, ctx)).publicSignals.map(String);

  const http = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>bench</title>");
      return;
    }
    const file = join(PUBLIC, path);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  }).listen(PORT);

  const types: [string, BrowserType][] = [
    ["chromium", chromium],
    ["firefox", firefox],
  ];
  mkdirSync("e2e/results", { recursive: true });
  try {
    for (const [name, type] of types) {
      if (which !== "all" && which !== name) continue;
      const browser = await type.launch();
      const page = await browser.newPage();
      // tsx (esbuild keepNames) wraps functions passed to evaluate() in __name().
      await page.addInitScript({ content: "globalThis.__name = (f) => f;" });
      await page.goto(`http://localhost:${PORT}/`);
      const msg = {
        record,
        secret: secret.toString(),
        ctx: {
          rightId: ctx.rightId.toString(),
          from: ctx.from,
          to: ctx.to,
          expiresAt: ctx.expiresAt.toString(),
          expiryLedger: ctx.expiryLedger.toString(),
          nextSecretHash: "0",
        },
      };
      const result = await page.evaluate(
        async ({ msg, runs }) => {
          const w = new Worker("/zk/prover.worker.js");
          let id = 0;
          const call = (op: string, args: object) =>
            new Promise<{ ms: number; result: { signals: string[]; proveMs: number } }>((ok, fail) => {
              const my = ++id;
              const t0 = performance.now();
              w.onmessage = (e) => {
                if (e.data.id !== my) return;
                if (e.data.ok) ok({ ms: performance.now() - t0, result: e.data.result });
                else fail(new Error(e.data.error));
              };
              w.postMessage({ id: my, op, ...args });
            });
          const warm = await call("prove", msg);
          const out = [];
          for (let i = 0; i < runs; i++) out.push(await call("prove", msg));
          w.terminate();
          return {
            ua: navigator.userAgent,
            threads: navigator.hardwareConcurrency,
            warm: { ms: warm.ms, proveMs: warm.result.proveMs, signals: warm.result.signals },
            runs: out.map((r) => ({ ms: r.ms, proveMs: r.result.proveMs, signals: r.result.signals })),
          };
        },
        { msg, runs },
      );
      const all = [result.warm, ...result.runs];
      if (!all.every((r) => JSON.stringify(r.signals) === JSON.stringify(expected))) {
        throw new Error(`${name}: the worker's signals differ from the CLI prover's`);
      }
      const summary = {
        date: new Date().toISOString(),
        browser: `${name} ${browser.version()} (Playwright 1.65.0, headless)`,
        user_agent: result.ua,
        device: `${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} logical cores (hardwareConcurrency ${result.threads}), ${Math.round(totalmem() / 2 ** 30)} GiB RAM, Linux (WSL2)`,
        proof: "rental, right 1, inventory/records/week-01.json, random test secret",
        signals_match_cli: true,
        first_proof_ms: Math.round(result.warm.ms),
        runs_ms: result.runs.map((r) => Math.round(r.ms)),
        median_ms: Math.round(median(result.runs.map((r) => r.ms))),
        median_full_prove_ms: Math.round(median(result.runs.map((r) => r.proveMs))),
        command: `npx tsx e2e/prover-bench.ts --runs ${runs} --browser ${name}`,
      };
      const file = `e2e/results/proof-times-${name}-${summary.date.slice(0, 10)}.json`;
      writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
      console.log(`${name}: first ${summary.first_proof_ms} ms, median ${summary.median_ms} ms over ${runs} runs (${summary.runs_ms.join(", ")}) → ${file}`);
      await browser.close();
    }
  } finally {
    http.closeAllConnections();
    http.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
