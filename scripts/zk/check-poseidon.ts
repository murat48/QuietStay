/**
 * Check that the BLS12-381 Poseidon constants were made the way circomlib's were,
 * and that they compute the Poseidon the authors specified.
 *
 *   npm run zk:check-poseidon
 *
 * Offline, no Docker, no Sage: it works from the reference tool's recorded output
 * in circuits/poseidon/raw/. Three claims, each checked rather than asserted:
 *
 *  1. Same procedure as circomlib. The reference tool, run for BN254 with the
 *     settings generate.sh uses, and fed through the same optimizer, reproduces
 *     the constants inside circomlib's own poseidon_constants.circom — every
 *     value of C, S, M and P, at each width this circuit uses.
 *  2. Same Poseidon as the authors'. The BLS12-381 constants, run through the
 *     reference permutation, give the authors' published test vectors for this
 *     field (poseidonperm_x5_255_3 and _5).
 *  3. Nothing hand-made in between. bls12381.json, bls12381_opt.json and the
 *     generated .circom file are byte-for-byte what build.mjs produces from raw/.
 *
 * That the circuit computes the same function as scripts/lib/poseidon.ts is the
 * circuit tests' job (npm run zk:test).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRaw, WIDTHS } from "../../circuits/poseidon/build.mjs";
import { buildPoseidon } from "../lib/poseidon";

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const dir = resolve("circuits/poseidon");
let failed = 0;

function report(ok: boolean, label: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}

type Raw = { t: number; prime: bigint; C: bigint[]; M: bigint[][] };
const hex = (x: bigint) => "0x" + x.toString(16);
const asBig = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(asBig) : typeof v === "string" ? BigInt(v) : v;

/** circomlib's poseidon_constants.circom, as { C|S|M|P: { t: bigint[] } }, matrices flattened. */
function circomlibConstants(): Record<string, Record<number, bigint[]>> {
  const src = readFileSync(resolve("node_modules/circomlib/circuits/poseidon_constants.circom"), "utf8");
  const out: Record<string, Record<number, bigint[]>> = {};
  for (const name of ["C", "S", "M", "P"]) {
    const body = src.split(`function POSEIDON_${name}(t)`)[1]!.split("\nfunction ")[0]!;
    out[name] = {};
    // circomlib writes `(t==2)` in three functions and `(t == 2)` in POSEIDON_S.
    for (const branch of body.split(/\(t\s*==\s*/).slice(1)) {
      const t = Number(branch.slice(0, branch.indexOf(")")));
      out[name]![t] = [...branch.matchAll(/0x[0-9a-fA-F]+/g)].map((m) => BigInt(m[0]));
    }
  }
  return out;
}

function optimize(prime: bigint, raw: Record<number, Raw>): Record<string, unknown> & { t: number[] } {
  const tmp = mkdtempSync(join(tmpdir(), "qs-poseidon-"));
  const input = Object.fromEntries(
    Object.entries(raw).map(([t, r]) => [t, { C: r.C.map(hex), M: r.M.map((row) => row.map(hex)) }]),
  );
  writeFileSync(join(tmp, "in.json"), JSON.stringify(input));
  execFileSync(process.execPath, [join(dir, "optimize.mjs"), prime.toString(), join(tmp, "in.json"), join(tmp, "out.json")]);
  return JSON.parse(readFileSync(join(tmp, "out.json"), "utf8"));
}

async function main() {
  console.log("1. The reference tool + iden3's optimizer reproduce circomlib (BN254)");
  const bnRaw: Record<number, Raw> = {};
  for (const t of WIDTHS as number[]) {
    const r = parseRaw(join(dir, "raw", `bn254_t${t}.txt`)) as Raw;
    report(r.prime === BN254_R, `raw/bn254_t${t}.txt was generated for BN254`);
    bnRaw[t] = r;
  }
  const bnOpt = optimize(BN254_R, bnRaw);
  const lib = circomlibConstants();
  bnOpt.t.forEach((t, k) => {
    for (const name of ["C", "S", "M", "P"]) {
      const mine = (asBig((bnOpt[name] as unknown[])[k]) as unknown[]).flat() as bigint[];
      const theirs = lib[name]![t]!;
      const same = mine.length === theirs.length && mine.every((x, i) => x === theirs[i]);
      report(same, `t=${t} POSEIDON_${name}: ${mine.length} values, identical to circomlib 2.0.5`);
    }
  });

  console.log("2. The BLS12-381 constants give the authors' test vectors");
  const vectors = readFileSync(join(dir, "raw", "hadeshash_test_vectors.txt"), "utf8");
  for (const t of [3, 5]) {
    const r = parseRaw(join(dir, "raw", `bls12381_t${t}.txt`)) as Raw;
    const p = await buildPoseidon({ [t]: { C: r.C.map(hex), M: r.M.map((row) => row.map(hex)) } });
    const lines = vectors.split(`# poseidonperm_x5_255_${t}\n`)[1]!.split("\n");
    const nums = (s: string) => [...s.matchAll(/0x[0-9a-f]+/g)].map((m) => BigInt(m[0]));
    const input = nums(lines[1]!);
    const expected = nums(lines[3]!);
    const got = p(input.slice(1), input[0], t);
    report(
      got.length === expected.length && got.every((x, i) => x === expected[i]),
      `poseidonperm_x5_255_${t}: all ${t} outputs match`,
    );
  }

  console.log("3. The committed files are exactly what build.mjs makes from raw/");
  const before = ["bls12381.json", "bls12381_opt.json", "../lib/poseidon_constants_bls12381.circom"].map((f) =>
    readFileSync(join(dir, f), "utf8"),
  );
  execFileSync(process.execPath, [join(dir, "build.mjs")]);
  const after = ["bls12381.json", "bls12381_opt.json", "../lib/poseidon_constants_bls12381.circom"].map((f) =>
    readFileSync(join(dir, f), "utf8"),
  );
  ["bls12381.json", "bls12381_opt.json", "lib/poseidon_constants_bls12381.circom"].forEach((f, i) =>
    report(before[i] === after[i], `${f} regenerates byte-for-byte`),
  );

  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
