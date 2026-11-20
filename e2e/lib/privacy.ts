/**
 * Run `npm run check-privacy` on a test's evidence transactions, and keep its
 * output in evidence/privacy/ (Step 2 review).
 *
 * Step 3 review: the check must always run before a run's throwaway secrets
 * are gone, including when the test fails. So:
 *
 * 1. A spec calls `evidenceLanded(...)` the moment an evidence transaction
 *    lands, with its records and secrets, before any later assertion can
 *    fail. That registers the check.
 * 2. `checkPendingPrivacy()` runs every registered check. Specs call it from
 *    `test.afterEach`, which Playwright runs whether the test passed or
 *    failed, and they may also call it inline. Every pending check is
 *    attempted before any failure is reported.
 * 3. A check that fails on the network (`fetch failed` and the like) is
 *    retried, up to 3 attempts in all. The records and secrets sit in a
 *    private temporary directory (mode 0700, outside the repository) until a
 *    check completes. If it never completes, the directory is kept and the
 *    failure names it with the exact command to rerun, so the evidence is not
 *    lost. A completed check deletes the directory, leak or no leak.
 *
 * Records and secrets are never written into the repository.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PrivacyCheck {
  txs: Record<string, string>;
  records: unknown[];
  /** Holders' secrets s: s and h are forbidden. */
  secrets: string[];
  /** Buyers' next secrets s': only s' is forbidden, since a sale publishes h'. */
  nextSecrets?: string[];
  out: string;
}

const pending: PrivacyCheck[] = [];

/** Register the check for a transaction that just landed. Run later by `checkPendingPrivacy`. */
export function evidenceLanded(check: PrivacyCheck): void {
  pending.push(check);
}

const NETWORK_FAILURE = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|Horizon HTTP 5\d\d|HTTP 429/;

function runOne(c: PrivacyCheck): string {
  const dir = mkdtempSync(join(tmpdir(), "qs-privacy-"));
  const args = ["tsx", "scripts/check-privacy.ts", "--network", "testnet", "--out", c.out];
  for (const [label, hash] of Object.entries(c.txs)) args.push("--tx", `${label}=${hash}`);
  const file = (name: string, value: unknown) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(value), { mode: 0o600 });
    return f;
  };
  c.records.forEach((r, i) => args.push("--record", file(`record-${i}.json`, r)));
  c.secrets.forEach((s, i) => args.push("--secret", file(`secret-${i}.json`, { secret: s })));
  (c.nextSecrets ?? []).forEach((s, i) => args.push("--next-secret", file(`next-secret-${i}.json`, { secret: s })));

  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const out = execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      rmSync(dir, { recursive: true, force: true });
      return out;
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      last = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
      if (!NETWORK_FAILURE.test(last)) {
        // The check completed and found a problem (or failed for a reason a
        // retry will not fix): the secrets are not needed again.
        rmSync(dir, { recursive: true, force: true });
        throw new Error(`check-privacy failed for ${Object.values(c.txs).join(", ")}:\n${last}`);
      }
      console.warn(`[privacy] attempt ${attempt} of 3 hit a network failure; ${attempt < 3 ? "retrying" : "giving up"}`);
    }
  }
  throw new Error(
    `check-privacy could not reach the network for ${Object.values(c.txs).join(", ")}. ` +
      `The run's records and secrets are kept in ${dir} (mode 0700) so the check can be rerun:\n` +
      `  npx ${args.join(" ")}\n` +
      `Delete that directory once it has passed.\n${last}`,
  );
}

/** Run every registered check; report all failures after all have been attempted. */
export function checkPendingPrivacy(): string[] {
  const outputs: string[] = [];
  const failures: string[] = [];
  while (pending.length > 0) {
    const c = pending.shift()!;
    try {
      outputs.push(runOne(c));
    } catch (error) {
      failures.push((error as Error).message);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n\n"));
  return outputs;
}

/** Register and run at once: for a call site with nothing after it that could fail first. */
export function checkPrivacy(check: PrivacyCheck): string {
  evidenceLanded(check);
  return checkPendingPrivacy().join("\n");
}

/** The tx hash at the end of a stellar.expert link. */
export const hashOf = (link: string | null) => (link ?? "").split("/").pop() ?? "";
