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

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
}): Promise<App> {
  const host = `localhost:${opts.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QUIETSTAY_CONTRACT_ID: opts.contract,
    NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID: opts.contract,
    QUIETSTAY_ISSUER_SECRET: opts.issuer.secret(),
    QUIETSTAY_SEP10_SERVER_SECRET: opts.sep10.secret(),
    QUIETSTAY_SESSION_SECRET: randomBytes(32).toString("hex"),
    QUIETSTAY_HOME_DOMAIN: host,
    QUIETSTAY_WEB_AUTH_DOMAIN: host,
    NEXT_PUBLIC_HOME_DOMAIN: host,
    NEXT_PUBLIC_WEB_AUTH_DOMAIN: host,
    QUIETSTAY_DATA_DIR: mkdtempSync(join(tmpdir(), "qs-e2e-")),
    NEXT_PUBLIC_QS_E2E_WALLET: "1",
    QUIETSTAY_TESTNET_FEE_SECRET: opts.fee?.secret() ?? "",
    NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT: opts.fee?.publicKey() ?? "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    KV_REST_API_URL: "",
    KV_REST_API_TOKEN: "",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // Spawned directly (not through npx) and as its own process group, so that
  // stopping it stops next's own child processes too.
  const child: ChildProcess = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--webpack", "-p", String(opts.port)],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));

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
