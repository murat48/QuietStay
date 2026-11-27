/**
 * The app under test: `next dev` on a free local port, pointed at a contract
 * and keys made for this run, with a fresh filesystem request store.
 *
 * Environment variables set here take precedence over .env.local, which
 * Next.js loads but never lets override a variable already set. So no value
 * from .env.local is used for anything this run touches. UPSTASH_* are
 * cleared, so requests go to a temporary directory and not to any shared
 * store.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Keypair } from "@stellar/stellar-sdk";

export interface App {
  url: string;
  stop(): Promise<void>;
}

export async function startApp(opts: {
  contract: string;
  issuer: Keypair;
  sep10: Keypair;
  port: number;
  /** A throwaway fee account for /api/tx/sponsor; the real one is never used in tests. */
  fee?: Keypair;
  /**
   * `cli` mode, as on mainnet (2026-11-27): no issuer key on the server, no
   * attestations; the issuer signs in and issues with envelopes.
   */
  cli?: boolean;
}): Promise<App> {
  const host = `localhost:${opts.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QUIETSTAY_CONTRACT_ID: opts.contract,
    NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID: opts.contract,
    QUIETSTAY_ISSUER_SECRET: opts.cli ? "" : opts.issuer.secret(),
    NEXT_PUBLIC_QUIETSTAY_SIGNING: opts.cli ? "cli" : "server",
    QUIETSTAY_SEP10_SERVER_SECRET: opts.sep10.secret(),
    QUIETSTAY_SESSION_SECRET: randomBytes(32).toString("hex"),
    QUIETSTAY_HOME_DOMAIN: host,
    QUIETSTAY_WEB_AUTH_DOMAIN: host,
    NEXT_PUBLIC_HOME_DOMAIN: host,
    NEXT_PUBLIC_WEB_AUTH_DOMAIN: host,
    QUIETSTAY_DATA_DIR: mkdtempSync(join(tmpdir(), "qs-e2e-")),
    NEXT_PUBLIC_QS_E2E_WALLET: "1",
    QUIETSTAY_TESTNET_FEE_SECRET: opts.fee?.secret() ?? "",
    // D18: the fee key's own name, read on mainnet and in `cli` mode too.
    QUIETSTAY_FEE_SECRET: opts.fee?.secret() ?? "",
    NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT: opts.fee?.publicKey() ?? "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    KV_REST_API_URL: "",
    KV_REST_API_TOKEN: "",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // Spawned directly (not through npx) and as its own process group, so that
  // stopping it stops next's own child processes too.
  // `next dev` is started directly, so `npm run dev`'s predev step does not
  // run: build the prover worker here, so a test never runs a stale prover.
  execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "prover-worker/build.ts"], { stdio: "ignore" });
  const child: ChildProcess = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", String(opts.port)],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  // One server log per run, never overwritten (Step 5 checklist item): the
  // file is created with "wx", which fails rather than replace one, and the
  // name carries the time, the port and a random suffix. It is written as the
  // server writes, so a crash or a killed run still leaves it. A later spec on
  // the same port once overwrote the log that held a network drop's code.
  mkdirSync("e2e/results/logs", { recursive: true });
  const logPath = `e2e/results/logs/next-dev-${new Date().toISOString().replace(/[:.]/g, "-")}-port${opts.port}-${randomBytes(3).toString("hex")}.log`;
  const logFd = openSync(logPath, "wx", 0o600);
  console.log(`next dev log: ${logPath}`);
  let log = "";
  const keep = (d: Buffer | string) => {
    log += d;
    try {
      writeSync(logFd, typeof d === "string" ? d : d.toString("utf8"));
    } catch {
      // the in-memory copy is still printed on a start failure
    }
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const url = `http://${host}`;
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next dev exited:\n${log.slice(-2000)}`);
    try {
      const res = await fetch(`${url}/api/me`);
      if (res.status < 500) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`next dev did not start:\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return {
    url,
    stop: async () => {
      // Kept for diagnosis: the routes log the errors they catch (Step 2
      // review). Already on disk, line by line; closed here.
      try {
        closeSync(logFd);
      } catch {
        // not fatal
      }
      if (!child.pid) return;
      const group = -child.pid;
      try {
        process.kill(group, "SIGTERM");
      } catch {
        return;
      }
      for (let i = 0; i < 20 && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
      try {
        process.kill(group, "SIGKILL");
      } catch {
        // already gone
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}
