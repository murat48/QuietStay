/**
 * Check that no GPL-3.0 code reaches the web app's browser bundle, except the
 * separate prover worker (Phase 3, decision D2).
 *
 *   npm run build && npm run zk:check-bundle
 *
 * Phase 3 proves in the browser, which cannot avoid GPL code: the compiled
 * circuit itself derives from circomlib's Poseidon. All of it lives in one
 * separately built file, public/zk/prover.worker.js (source: prover-worker/,
 * GPL-3.0), which the Apache-2.0 app talks to only by postMessage. The checks
 * below therefore cover the app's own bundle (.next/static, where none may
 * appear), and section 4 checks the worker: that the markers are there and
 * nowhere else, that its first line names the license and the source, and
 * that the GPL text and the in-app notice ship with it.
 *
 * The GPL-3.0 code in this repository is circuits/gpl/ and the iden3 packages
 * it needs (snarkjs, ffjavascript, circomlib and their dependencies). It serves
 * the command-line prover and one server route — /api/issue computes the
 * commitment C with Poseidon — and never the browser. Three independent checks:
 *
 *  1. Imports. No file under src/ imports circuits/, scripts/, or a package
 *     whose license is GPL, except the server-only route handlers listed in
 *     SERVER_ONLY — and nothing imports those, so nothing GPL can be reached
 *     from a page, whatever the bundler does.
 *  2. Dependencies. Of the packages the app can ship (`dependencies`, not
 *     `devDependencies`, walked transitively through the installed tree), none
 *     carries a GPL/LGPL/AGPL license.
 *  3. The built bundle. Every file in .next/static is searched for markers that
 *     only GPL code here contains: the package names, the Poseidon function
 *     names, the first BLS12-381 round constant in hex and decimal, and an
 *     error message only circuits/gpl/poseidon.ts has. As a
 *     control, the server build must contain them — so the search is known to
 *     find this code where it is.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fatal } from "../lib/cli";

/**
 * Route handlers allowed to import GPL code. A route handler runs on the server
 * only: Next.js never sends it to a browser, and no other module can import it.
 */
const SERVER_ONLY = ["src/app/api/issue/route.ts"];
/**
 * Server modules allowed to import GPL code (2026-11-28): the issuance checks
 * and the commitment, moved out of /api/issue for plan item 3 and shared with
 * /api/issue/confirm. Allowed only while every module importing them is a
 * route handler under src/app/api/, so no page can pull them in.
 */
const SERVER_LIBS = ["src/lib/issuance.ts"];

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
  const specifiersOf = (f: string) =>
    [...readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
  const importers = sources.filter((f) =>
    specifiersOf(f).some(
      (s) => /(^|\/)(circuits|scripts)\//.test(s) || gplPackages.some((g) => s === g || s.startsWith(g + "/")),
    ),
  );
  const serverOnly = new Set([...SERVER_ONLY, ...SERVER_LIBS].map((f) => resolve(f)));
  const offenders = importers.filter((f) => !serverOnly.has(f));
  report(
    offenders.length === 0,
    `${sources.length} files under src/ import nothing from circuits/, scripts/, or ${gplPackages.join(", ") || "a GPL package"}, ` +
      `except ${[...SERVER_ONLY, ...SERVER_LIBS].join(", ")}`,
  );
  for (const f of offenders) console.log(`      ${f}`);
  const notRoutes = SERVER_ONLY.filter((f) => !/^src\/app\/api\/.+\/route\.ts$/.test(f) || !existsSync(f));
  // Any import of a route handler at all — none is needed, and one would be the
  // only way a page could pull the route's imports in.
  const importedBy = sources.filter((f) => specifiersOf(f).some((s) => /(^|\/)route(\.tsx?)?$/.test(s)));
  report(
    notRoutes.length === 0 && importedBy.length === 0,
    "those are route handlers under src/app/api/, and no module imports them",
  );
  for (const f of [...notRoutes, ...importedBy]) console.log(`      ${f}`);
  // Each server module is imported only by route handlers.
  const libImporters = SERVER_LIBS.flatMap((lib) => {
    const name = lib.replace(/^src\//, "@/").replace(/\.tsx?$/, "");
    return sources
      .filter((f) => specifiersOf(f).some((s) => s === name || s.endsWith("/" + lib.split("/").pop()!.replace(/\.tsx?$/, ""))))
      .filter((f) => resolve(f) !== resolve(lib))
      .map((f) => ({ lib, f }));
  });
  const badLib = libImporters.filter(({ f }) => !/\/src\/app\/api\/.+\/route\.ts$/.test(f));
  report(
    badLib.length === 0 && SERVER_LIBS.every((l) => existsSync(l)),
    `${SERVER_LIBS.join(", ")}: imported only by route handlers (${libImporters.map(({ f }) => f.replace(root + "/", "")).join(", ") || "none"})`,
  );
  for (const { lib, f } of badLib) console.log(`      ${f} imports ${lib}`);

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
  // Entry files of every permissively licensed package in the same tree. A
  // string a copyleft package shares with one of these proves nothing — the
  // bundle may hold the permissive package's copy — so only strings unique to
  // the copyleft package count. (Lobstr's message names REQUEST_ACCESS and
  // SIGN_TRANSACTION, for one, also appear in Freighter's Apache-2.0 API.)
  const permissiveEntries = [...seen]
    .filter(([, v]) => !isCopyleft(v.license) && v.main)
    .map(([dir, v]) => join(dir, v.main!))
    .filter((f) => existsSync(f) && statSync(f).isFile())
    .map((f) => readFileSync(f, "latin1"));
  for (const [dir, { license: l, main }] of copyleft) {
    // A package reaches the browser if string literals unique to its entry file
    // turn up in the built bundle. Minifiers rename identifiers, not strings.
    const entry = main ? join(dir, main) : null;
    let verdict = "no JavaScript entry — not bundled";
    if (entry && existsSync(entry)) {
      const literals = [
        ...new Set([...readFileSync(entry, "utf8").matchAll(/["']([A-Za-z0-9_:\-. ]{14,})["']/g)].map((m) => m[1]!)),
      ].filter((s) => !permissiveEntries.some((text) => text.includes(s)));
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
    // An error message unique to circuits/gpl/poseidon.ts; strings survive minification.
    "Poseidon: bad arity",
  ];
  // The in-app license notice (D2) names snarkjs and circomlib in words. That
  // one sentence is removed before searching; the names anywhere else still count.
  const NOTICE =
    "Proofs are made by an in-browser prover licensed under the GPL-3.0 (source: prover-worker/, " +
    "built from snarkjs and circomlib). The rest of QuietStay is Apache-2.0.";
  const hits: string[] = [];
  for (const { f, text } of bundle) {
    const code = text.split(NOTICE).join("");
    for (const m of markers) if (code.includes(m)) hits.push(`${f.replace(root + "/", "")}: ${m}`);
  }
  report(hits.length === 0, `${files.length} files in .next/static, none containing ${markers.length} GPL-only markers`);
  for (const h of hits) console.log(`      ${h}`);
  // The control: the same search over the server build finds the code /api/issue
  // runs, so an empty result above is the code's absence, not a blind search.
  const serverDir = resolve(".next/server");
  const serverHits = existsSync(serverDir)
    ? walk(serverDir)
        .filter((f) => /\.(js|mjs|json)$/.test(f))
        .filter((f) => {
          const text = readFileSync(f, "latin1");
          return text.includes("Poseidon: bad arity");
        })
    : [];
  report(serverHits.length > 0, `control: the server build does contain it (${serverHits.length} files under .next/server)`);

  console.log("4. The GPL prover worker is separate, labelled, and licensed (D2)");
  const workerFile = resolve("public/zk/prover.worker.js");
  if (!existsSync(workerFile)) throw new Error("no public/zk/prover.worker.js — run `npm run zk:build-worker` first");
  const worker = readFileSync(workerFile, "latin1");
  const firstLine = worker.split("\n", 1)[0]!;
  report(
    firstLine.includes("SPDX-License-Identifier: GPL-3.0") && firstLine.includes("prover-worker/"),
    "public/zk/prover.worker.js: its first line names GPL-3.0 and its source, prover-worker/",
  );
  const inWorker = markers.filter((m) => worker.includes(m));
  report(inWorker.length >= 3, `control: the worker does contain the GPL code (${inWorker.length}/${markers.length} markers)`);
  const gplText = (f: string) => existsSync(f) && readFileSync(f, "utf8").includes("GNU GENERAL PUBLIC LICENSE");
  report(gplText(resolve("prover-worker/LICENSE")), "prover-worker/LICENSE is the GPL-3.0 text");
  report(gplText(resolve("public/zk/LICENSE")), "public/zk/LICENSE is served with the worker");
  report(
    bundle.some(({ text }) => text.includes(NOTICE)),
    "the in-app license notice is in the built app",
  );
  // The app reaches the worker by URL only; no module under src/ imports its source.
  const workerImporters = sources.filter((f) => specifiersOf(f).some((sp) => sp.includes("prover-worker")));
  report(workerImporters.length === 0, "no module under src/ imports prover-worker/ (the app loads it by URL)");
  for (const f of workerImporters) console.log(`      ${f}`);

  console.log(
    failed === 0
      ? "\nNo GPL-3.0 code in the app's browser bundle; all of it is in the separate prover worker."
      : `\n${failed} check(s) FAILED.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  fatal(e);
}
