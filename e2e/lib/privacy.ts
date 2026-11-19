/**
 * Run `npm run check-privacy` on a test's evidence transactions right after
 * they land (Step 2 review), and keep its output in evidence/privacy/.
 *
 * The run's own records and secrets go to a private temporary directory
 * (mode 0700), so the check can search the ledger for them, and are deleted
 * afterwards. They are never written into the repository.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function checkPrivacy(opts: {
  txs: Record<string, string>;
  records: unknown[];
  /** Holders' secrets s: s and h are forbidden. */
  secrets: string[];
  /** Buyers' next secrets s': only s' is forbidden, since a sale publishes h'. */
  nextSecrets?: string[];
  out: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "qs-privacy-"));
  try {
    const args = ["tsx", "scripts/check-privacy.ts", "--network", "testnet", "--out", opts.out];
    for (const [label, hash] of Object.entries(opts.txs)) args.push("--tx", `${label}=${hash}`);
    opts.records.forEach((r, i) => {
      const f = join(dir, `record-${i}.json`);
      writeFileSync(f, JSON.stringify(r), { mode: 0o600 });
      args.push("--record", f);
    });
    opts.secrets.forEach((s, i) => {
      const f = join(dir, `secret-${i}.json`);
      writeFileSync(f, JSON.stringify({ secret: s }), { mode: 0o600 });
      args.push("--secret", f);
    });
    (opts.nextSecrets ?? []).forEach((s, i) => {
      const f = join(dir, `next-secret-${i}.json`);
      writeFileSync(f, JSON.stringify({ secret: s }), { mode: 0o600 });
      args.push("--next-secret", f);
    });
    // Throws (failing the test) if the check finds a problem.
    return execFileSync("npx", args, { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The tx hash at the end of a stellar.expert link. */
export const hashOf = (link: string | null) => (link ?? "").split("/").pop() ?? "";
