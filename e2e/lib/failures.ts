/**
 * Capture every failed response a browser context gets from the app, with
 * its body (Step 2 review), so an intermittent 500 or 502 leaves its cause
 * behind. On a test failure the captured bodies are printed; either way they
 * are written to e2e/results/logs/failed-requests-<spec>-<run>.json, one file per run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { BrowserContext, TestInfo } from "@playwright/test";

export interface FailedResponse {
  who: string;
  at: string;
  status: number;
  method: string;
  url: string;
  body: string;
}

export function captureFailures(who: string, context: BrowserContext, into: FailedResponse[]): void {
  context.on("response", async (res) => {
    if (res.status() < 400) return;
    const url = res.url();
    // The app's own routes; third-party noise (wallet probes, fonts) is not the question.
    if (!new URL(url).pathname.startsWith("/api/")) return;
    let body = "";
    try {
      body = (await res.text()).slice(0, 2000);
    } catch {
      body = "(body unavailable)";
    }
    into.push({ who, at: new Date().toISOString(), status: res.status(), method: res.request().method(), url, body });
  });
}

/**
 * One file per test run (Step 5 checklist item), named by the run's start
 * time and a random suffix. Within a run it is rewritten with the growing
 * list; a later run never touches it.
 */
const RUN = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;

export function reportFailures(spec: string, failures: FailedResponse[], info: TestInfo): void {
  mkdirSync("e2e/results/logs", { recursive: true });
  writeFileSync(`e2e/results/logs/failed-requests-${spec}-${RUN}.json`, JSON.stringify(failures, null, 2) + "\n");
  if (info.status !== info.expectedStatus) {
    for (const f of failures) console.log(`[failed request] ${f.who} ${f.status} ${f.method} ${f.url}\n  ${f.body}`);
  }
}
