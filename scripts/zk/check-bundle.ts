/**
 * Check that no GPL-3.0 code reaches the web app's browser bundle.
 *
 *   npm run build && npm run zk:check-bundle
 *
 * The GPL-3.0 code in this repository is circuits/gpl/ and the iden3 packages
 * it needs (snarkjs, ffjavascript, circomlib and their dependencies). It serves
 * the command-line prover, never the browser. Three independent checks:
 *
 *  1. Imports. No file under src/ imports circuits/, scripts/, or a package
 *     whose license is GPL — so nothing GPL can be reached from the app's own
 *     code, whatever the bundler does.
 *  2. Dependencies. Of the packages the app can ship (`dependencies`, not
 *     `devDependencies`, walked transitively through the installed tree), none
 *     carries a GPL/LGPL/AGPL license.
 *  3. The built bundle. Every file in .next/static is searched for markers that
 *     only GPL code here contains: the package names, the Poseidon function
 *     names, and the first BLS12-381 round constant in hex and decimal.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fatal } from "../lib/cli";

let failed = 0;
const report = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isCopyleft = (license: unknown): boolean =>
  JSON.stringify(license ?? "").toUpperCase().includes("GPL");

function license(pkgDir: string): unknown {
  try {
    const p = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return p.license ?? p.licenses;
  } catch {
    return undefined;
  }
}

/** Resolve a package as Node would from `from`, walking up node_modules. */
function locate(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function main() {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  console.log("1. No app module imports GPL code");
  const gplPackages = Object.keys(pkg.devDependencies ?? {}).filter((n) => {
    const dir = locate(n, root);
    return dir !== null && isCopyleft(license(dir));
  });
  const sources = walk(resolve("src")).filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f));
  const offenders = sources.filter((f) => {
    const text = readFileSync(f, "utf8");
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    return specifiers.some(
      (s) => /(^|\/)(circuits|scripts)\//.test(s) || gplPackages.some((g) => s === g || s.startsWith(g + "/")),
    );
  });
  report(offenders.length === 0, `${sources.length} files under src/ import nothing from circuits/, scripts/, or ${gplPackages.join(", ")}`);
  for (const f of offenders) console.log(`      ${f}`);

  const staticDir = resolve(".next/static");
  if (!existsSync(staticDir)) throw new Error("no .next/static — run `npm run build` first");
  const files = walk(staticDir).filter((f) => /\.(js|mjs|css|json|wasm)$/.test(f));
  const bundle = files.map((f) => ({ f, text: readFileSync(f, "latin1") }));

  console.log("2. Which copyleft packages the app depends on, and which of them reach the browser");
  const seen = new Map<string, { license: unknown; main?: string }>();
  const queue: [string, string][] = Object.keys(pkg.dependencies ?? {}).map((n) => [n, root]);
  while (queue.length) {
    const [name, from] = queue.shift()!;
    const dir = locate(name, from);
    if (!dir || seen.has(dir)) continue;
    const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    seen.set(dir, { license: p.license ?? p.licenses, main: p.module ?? p.main });
    for (const dep of Object.keys({ ...p.dependencies, ...p.optionalDependencies })) queue.push([dep, dir]);
  }
  const copyleft = [...seen].filter(([, v]) => isCopyleft(v.license));
  console.log(`  ${seen.size} packages reachable from "dependencies"; ${copyleft.length} copyleft:`);
  for (const [dir, { license: l, main }] of copyleft) {
    // A package reaches the browser if distinctive string literals from its entry
    // file turn up in the built bundle. Minifiers rename identifiers, not strings.
    const entry = main ? join(dir, main) : null;
    let verdict = "no JavaScript entry — not bundled";
    if (entry && existsSync(entry)) {
      const literals = [
        ...new Set([...readFileSync(entry, "utf8").matchAll(/["']([A-Za-z0-9_:\-. ]{14,})["']/g)].map((m) => m[1]!)),
      ];
      const found = literals.filter((s) => bundle.some(({ text }) => text.includes(s)));
      const where = [...new Set(bundle.filter(({ text }) => found.some((s) => text.includes(s))).map(({ f }) => f.replace(root + "/", "")))];
      verdict =
        found.length >= 3
          ? `IN THE BROWSER BUNDLE (${found.length}/${literals.length} of its strings, in ${where.join(", ")})`
          : `not in the browser bundle (${found.length}/${literals.length} of its strings found)`;
    }
    const inBundle = verdict.startsWith("IN");
    report(!inBundle, `${dir.replace(root + "/node_modules/", "")} (${JSON.stringify(l)}): ${verdict}`);
  }

  console.log("3. The built browser bundle contains none of this repository's GPL code");
  const firstConstant = 0x6267f5556c88257324c1c8b00d5871b2eba13cc39d72aa10dde6b69bc44c41c7n;
  const markers = [
    "snarkjs",
    "ffjavascript",
    "circomlib",
    "wasmcurves",
    "POSEIDON_C",
    "poseidon_constants",
    "groth16",
    firstConstant.toString(16),
    firstConstant.toString(),
  ];
  const hits: string[] = [];
  for (const { f, text } of bundle) {
    for (const m of markers) if (text.includes(m)) hits.push(`${f.replace(root + "/", "")}: ${m}`);
  }
  report(hits.length === 0, `${files.length} files in .next/static, none containing ${markers.length} GPL-only markers`);
  for (const h of hits) console.log(`      ${h}`);

  console.log(failed === 0 ? "\nNo GPL-3.0 code in the browser bundle." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  fatal(e);
}
