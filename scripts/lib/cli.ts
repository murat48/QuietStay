/**
 * Shared plumbing for the command-line tools.
 *
 * These scripts are how the evidence in `docs/EVIDENCE.md` was produced. They are
 * checked in so that a reviewer can regenerate every artifact rather than take
 * the numbers on faith.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Set only the named variables from `.env.local` (Step 5 review: no script
 * loads the whole file). A variable already in the environment wins.
 *
 * - Only lines that assign one of `names` are parsed. Every other line is
 *   skipped unparsed, and no other value enters `process.env` or this
 *   process's variables.
 * - Nothing is printed.
 * - The rule (PHASE3_PROMPT.md): `.env.local` holds testnet values only.
 *   Mainnet secrets are never written to a file in the repo.
 *
 * Returns the names it found, for a script to report which are missing.
 */
export function loadEnvVars(names: readonly string[]): string[] {
  const envFile = resolve(process.cwd(), ".env.local");
  if (!existsSync(envFile)) return [];
  const wanted = new Set(names);
  const found: string[] = [];
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !wanted.has(m[1]!)) continue;
    const name = m[1]!;
    const value = parseEnv(line.replace(/^\s*export\s+/, ""))[name];
    if (value !== undefined && process.env[name] === undefined) process.env[name] = value;
    found.push(name);
  }
  return found;
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

/** Write pretty JSON with a trailing newline — for files people read and diff. */
export function writeJson(path: string, value: unknown): void {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Write canonical bytes verbatim, with **no trailing newline**.
 *
 * This matters: the file's SHA-256 is the on-chain commitment, and a newline
 * would change it. A reviewer running `sha256sum` on one of these files must get
 * exactly the value the ledger holds.
 */
export function writeCanonical(path: string, canonicalText: string): void {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, canonicalText, { encoding: "utf8" });
}

export const log = {
  step: (message: string) => console.log(`\n\x1b[1m${message}\x1b[0m`),
  ok: (message: string) => console.log(`  \x1b[32m✓\x1b[0m ${message}`),
  info: (message: string) => console.log(`  ${message}`),
  warn: (message: string) => console.log(`  \x1b[33m!\x1b[0m ${message}`),
  fail: (message: string) => console.log(`  \x1b[31m✗\x1b[0m ${message}`),
  link: (label: string, url: string) => console.log(`  ${label}: \x1b[36m${url}\x1b[0m`),
};

export function requireArg(index: number, usage: string): string {
  const value = process.argv[2 + index];
  if (!value) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
  return value;
}

export function fatal(error: unknown): never {
  console.error(`\n\x1b[31mfailed:\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
}
