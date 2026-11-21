/**
 * Step 5 review, the deploy cost: how much smaller could the rights WASM be
 * without changing what it does? This writes size variants of a WASM into
 * an output directory, for pricing only. It never touches the input file,
 * and nothing it writes is deployed.
 *
 *   npx tsx scripts/wasm-size-variants.ts --wasm <file> --out <dir>
 *
 * Variants (each changes only the custom sections, never the code, data,
 * import, export or any other section the VM runs):
 *   - no-docs:      the interface spec (`contractspecv0`) without its doc
 *                   strings. Every function, type and error stays, so the
 *                   CLI, bindings and explorers still read the interface;
 *                   they lose the doc text.
 *   - no-docs-meta: no-docs, and the free-form `contractmetav0` entries
 *                   (description, Rust and SDK versions) removed.
 *                   `contractenvmetav0` (the protocol the WASM needs) stays.
 *   - no-spec:      no interface spec at all. The contract runs the same, but
 *                   `stellar contract invoke`, `contract info interface`,
 *                   generated bindings and explorers can no longer read its
 *                   interface from the chain. Shown for scale only.
 *
 * It then checks, for each variant, that every non-custom section is
 * byte-identical to the input's.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { contract, xdr } from "@stellar/stellar-sdk";

interface Section {
  id: number;
  name?: string;
  /** The whole section, id and size included. */
  raw: Buffer;
  /** For a custom section, its content after the name. */
  body?: Buffer;
}

function leb(b: Buffer, i: number): [number, number] {
  let r = 0;
  let s = 0;
  for (;;) {
    const x = b[i++]!;
    r |= (x & 0x7f) << s;
    s += 7;
    if (x < 0x80) return [r >>> 0, i];
  }
}

function encLeb(n: number): Buffer {
  const out: number[] = [];
  do {
    let x = n & 0x7f;
    n >>>= 7;
    if (n) x |= 0x80;
    out.push(x);
  } while (n);
  return Buffer.from(out);
}

function sections(wasm: Buffer): Section[] {
  const out: Section[] = [];
  let i = 8;
  while (i < wasm.length) {
    const start = i;
    const id = wasm[i++]!;
    const [size, j] = leb(wasm, i);
    const end = j + size;
    const s: Section = { id, raw: wasm.subarray(start, end) };
    if (id === 0) {
      const [nl, k] = leb(wasm, j);
      s.name = wasm.subarray(k, k + nl).toString();
      s.body = wasm.subarray(k + nl, end);
    }
    out.push(s);
    i = end;
  }
  return out;
}

function custom(name: string, body: Buffer): Buffer {
  const n = Buffer.from(name);
  const content = Buffer.concat([encLeb(n.length), n, body]);
  return Buffer.concat([Buffer.from([0]), encLeb(content.length), content]);
}

/** Clear every doc string in a spec entry; nothing else changes. */
function withoutDocs(e: xdr.ScSpecEntry): xdr.ScSpecEntry {
  const clear = (x: { doc: (v?: string) => unknown }) => x.doc("");
  const v = e.value() as unknown as { doc: (v?: string) => unknown };
  clear(v);
  switch (e.switch().name) {
    case "scSpecEntryFunctionV0": {
      const f = e.functionV0();
      for (const p of f.inputs()) p.doc("");
      break;
    }
    case "scSpecEntryUdtStructV0":
      for (const f of e.udtStructV0().fields()) f.doc("");
      break;
    case "scSpecEntryUdtUnionV0":
      for (const c of e.udtUnionV0().cases()) (c.value() as unknown as { doc: (v?: string) => unknown }).doc("");
      break;
    case "scSpecEntryUdtEnumV0":
      for (const c of e.udtEnumV0().cases()) c.doc("");
      break;
    case "scSpecEntryUdtErrorEnumV0":
      for (const c of e.udtErrorEnumV0().cases()) c.doc("");
      break;
    case "scSpecEntryEventV0": {
      const ev = e.eventV0();
      for (const p of ev.params()) p.doc("");
      break;
    }
  }
  return e;
}

function build(secs: Section[], replace: (s: Section) => Buffer | null): Buffer {
  const parts: Buffer[] = [Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])];
  for (const s of secs) {
    const r = replace(s);
    if (r) parts.push(r);
  }
  return Buffer.concat(parts);
}

function main() {
  const { values: a } = parseArgs({ options: { wasm: { type: "string" }, out: { type: "string" } } });
  if (!a.wasm || !a.out) throw new Error("--wasm <file> --out <dir>");
  const wasm = readFileSync(a.wasm);
  const secs = sections(wasm);
  const spec = contract.Spec.fromWasm(wasm);
  const docBytes = spec.entries.reduce((n, e) => n + e.toXDR().length - withoutDocs(xdr.ScSpecEntry.fromXDR(e.toXDR())).toXDR().length, 0);
  const noDocs = Buffer.concat(spec.entries.map((e) => withoutDocs(xdr.ScSpecEntry.fromXDR(e.toXDR())).toXDR()));
  const keepEnvMeta = (s: Section) => s.id !== 0 || s.name === "contractenvmetav0";

  const variants: Record<string, Buffer> = {
    "no-docs": build(secs, (s) => (s.name === "contractspecv0" ? custom("contractspecv0", noDocs) : s.raw)),
    "no-docs-meta": build(secs, (s) =>
      s.name === "contractspecv0" ? custom("contractspecv0", noDocs) : s.name === "contractmetav0" ? null : s.raw,
    ),
    "no-spec": build(secs, (s) => (keepEnvMeta(s) || s.name === "contractmetav0" ? s.raw : null)),
  };

  mkdirSync(a.out, { recursive: true });
  const runnable = (b: Buffer) => sections(b).filter((s) => s.id !== 0).map((s) => s.raw.toString("hex")).join("|");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  console.log(`input ${a.wasm}: ${wasm.length} B, sha256 ${sha(wasm)}`);
  for (const s of secs) console.log(`  section ${s.id === 0 ? `custom:${s.name}` : s.id}: ${s.raw.length} B`);
  console.log(`  spec entries: ${spec.entries.length}; doc strings in them: ${docBytes} B`);
  for (const [name, b] of Object.entries(variants)) {
    const same = runnable(b) === runnable(wasm);
    if (!same) throw new Error(`${name}: a non-custom section changed`);
    const file = join(a.out, `${name}.wasm`);
    writeFileSync(file, b);
    console.log(`${name}: ${b.length} B (${b.length - wasm.length} B), sha256 ${sha(b)}, every non-custom section identical: ${same}`);
  }
}

main();
