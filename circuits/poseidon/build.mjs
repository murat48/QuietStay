// Turn the reference tool's raw output into the two files the rest of the repo reads.
//
//   raw/bls12381_t{2,6,7}.txt  ── stdout of generate_parameters_grain.sage (see generate.sh)
//        │
//        ├─▶ bls12381.json                         round constants C and MDS matrix M per width,
//        │                                         read by the CLI prover's Poseidon (scripts/lib/poseidon.ts)
//        │
//        └─▶ optimize.mjs ─▶ bls12381_opt.json ─▶ ../lib/poseidon_constants_bls12381.circom
//             (iden3's optimizer,                  POSEIDON_C/S/M/P(t) in circomlib's own format,
//              field made a parameter)             included by the vendored ../lib/poseidon.circom
//
// Nothing here produces a constant. Every value comes from the reference tool;
// this file only parses it, hands it to iden3's optimizer, and writes it out.
//
//   node circuits/poseidon/build.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** BLS12-381 scalar field. */
export const BLS12_381_R =
  52435875175126190479447740508185965837690552500527637822603658699938581184513n;

/** The widths the circuit uses: Poseidon(1), Poseidon(5), Poseidon(6). */
export const WIDTHS = [2, 6, 7];

/**
 * Round numbers per width, as passed to the reference tool in generate.sh.
 * R_P is calc_round_numbers.py's output rounded up to a multiple of t — the rule
 * that reproduces circomlib's BN254 table exactly. The tool does not echo these
 * back, so parseRaw checks them against the number of constants it emitted.
 */
export const R_F = 8;
export const R_P = { 2: 56, 3: 57, 5: 60, 6: 60, 7: 63 };

/** Parse one run of generate_parameters_grain.sage. */
export function parseRaw(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const after = (label) => {
    const i = lines.findIndex((l) => l.startsWith(label));
    if (i < 0) throw new Error(`${file}: no "${label}" line`);
    return lines[i + 1];
  };
  const hexes = (s) => [...s.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => BigInt(m[0]));
  const value = (label) => {
    const line = lines.find((l) => l.startsWith(label));
    if (!line) throw new Error(`${file}: no "${label}" line`);
    return line.slice(label.length).trim();
  };
  const t = Number(value("t:"));
  const C = hexes(after("Round constants for GF(p):"));
  const flat = hexes(after("MDS matrix:"));
  if (flat.length !== t * t) throw new Error(`${file}: MDS matrix is not ${t}x${t}`);
  if (C.length !== t * (R_F + R_P[t])) {
    throw new Error(`${file}: ${C.length} round constants, expected t·(R_F+R_P) = ${t * (R_F + R_P[t])}`);
  }
  // The tool's three checks that the MDS matrix admits no invariant subspace
  // trails. It retries until they pass; a False here would mean a broken run.
  for (const n of [1, 2, 3]) {
    if (!after(`Result Algorithm ${n}:`).includes("True")) throw new Error(`${file}: MDS check ${n} failed`);
  }
  return {
    t,
    R_F,
    R_P: R_P[t],
    prime: BigInt(value("Prime number:").replace("0x0x", "0x")),
    C,
    M: Array.from({ length: t }, (_, i) => flat.slice(i * t, i * t + t)),
  };
}

const hex = (x) => "0x" + x.toString(16);

function main() {
  const raw = {};
  for (const t of WIDTHS) {
    const p = parseRaw(join(here, "raw", `bls12381_t${t}.txt`));
    if (p.prime !== BLS12_381_R) throw new Error(`t=${t}: generated for the wrong field`);
    if (p.t !== t) throw new Error(`t=${t}: file holds width ${p.t}`);
    raw[t] = { R_F: p.R_F, R_P: p.R_P, C: p.C.map(hex), M: p.M.map((r) => r.map(hex)) };
  }
  writeFileSync(join(here, "bls12381.json"), JSON.stringify(raw, null, 1) + "\n");

  // optimize.mjs reads { t: { C, M } } and ignores the round counts it is given.
  execFileSync(process.execPath, [
    join(here, "optimize.mjs"),
    BLS12_381_R.toString(),
    join(here, "bls12381.json"),
    join(here, "bls12381_opt.json"),
  ]);
  const opt = JSON.parse(readFileSync(join(here, "bls12381_opt.json"), "utf8"));

  const fn = (name, key) => {
    const branches = opt.t.map((t, k) => {
      const v = opt[key][k];
      const body = Array.isArray(v[0])
        ? "[\n" + v.map((row) => "            [\n" + row.map((x) => `                ${x}`).join(",\n") + "\n            ]").join(",\n") + "\n        ]"
        : "[\n" + v.map((x) => `            ${x}`).join(",\n") + "\n        ]";
      return `    ${k === 0 ? "if" : "} else if"} (t==${t}) {\n        return ${body};`;
    });
    // circomlib's own fallback: an unsupported width is an error at compile time,
    // and the dummy return matches the branches' dimensions so the typer accepts it.
    const empty = Array.isArray(opt[key][0][0]) ? "[[0]]" : "[0]";
    return `function ${name}(t) {\n${branches.join("\n")}\n    } else {\n        assert(0);\n        return ${empty};\n    }\n}\n`;
  };

  const circom = [
    "// GENERATED by circuits/poseidon/build.mjs — do not edit.",
    "//",
    "// Poseidon constants over the BLS12-381 scalar field, for the widths this repository",
    "// uses (t = " + opt.t.join(", ") + "). Same shape and function names as circomlib's",
    "// poseidon_constants.circom, which holds the BN254 ones.",
    "//",
    "// Round constants and MDS matrices: generate_parameters_grain.sage from the Poseidon",
    "// authors' reference repository, run as recorded in circuits/poseidon/generate.sh.",
    "// Optimized form (C, S, M, P): iden3's poseidon_optimize_constants.js, unchanged",
    "// except that the field is a parameter — see circuits/poseidon/optimize.mjs.",
    "// Provenance and checks: docs/CIRCUIT.md#poseidon-parameters-over-bls12-381.",
    "",
    "pragma circom 2.0.0;",
    "",
    fn("POSEIDON_C", "C"),
    fn("POSEIDON_S", "S"),
    fn("POSEIDON_M", "M"),
    fn("POSEIDON_P", "P"),
  ].join("\n");
  writeFileSync(join(here, "..", "lib", "poseidon_constants_bls12381.circom"), circom);
  console.log(`wrote bls12381.json, bls12381_opt.json, lib/poseidon_constants_bls12381.circom (t = ${opt.t.join(", ")})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
