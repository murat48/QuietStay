// SPDX-License-Identifier: GPL-3.0
// Part of the QuietStay in-browser prover (prover-worker/). See ../LICENSE and ../README.md.

/**
 * The prover worker: a dedicated Web Worker that holds every piece of GPL code
 * the browser runs (snarkjs, ffjavascript, the circomlib-derived Poseidon and
 * the compiled circuit). The Apache-2.0 app talks to it only by `postMessage`
 * (decision D2).
 *
 * Before its first proof it fetches `transfer.wasm` and `transfer.zkey` from
 * its own folder and refuses to use them unless their SHA-256 equals the
 * hashes compiled in at build time from `circuits/keys/SHA256SUMS`. The hashes
 * are never fetched.
 *
 * It makes no network request other than those two files. It keeps nothing:
 * the record and the secret arrive in a message, are used, and are dropped.
 *
 * Messages: `{ id, op, ...args }` in, `{ id, ok: true, result }` or
 * `{ id, ok: false, error }` out. Big numbers travel as decimal strings.
 */

import { groth16 } from "snarkjs";
import { buildPoseidon, type WidthConstants } from "../../circuits/gpl/poseidon-core";
import constants from "../../circuits/poseidon/bls12381.json";
import vk from "../../circuits/keys/verification_key.json";
import type { JsonValue } from "../../src/lib/canonical";
import { makeProver, type Keys, type Prover } from "./core";

declare const __WASM_SHA256__: string;
declare const __ZKEY_SHA256__: string;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchChecked(name: string, expected: string): Promise<Uint8Array> {
  const res = await fetch(new URL(name, self.location.href), { cache: "force-cache" });
  if (!res.ok) throw new Error(`could not load ${name} (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = await sha256Hex(bytes);
  if (got !== expected) {
    throw new Error(`${name} does not match the committed hash (expected ${expected}, got ${got}); refusing to prove`);
  }
  return bytes;
}

let keys: Promise<Keys> | null = null;
const loadKeys = () =>
  (keys ??= Promise.all([
    fetchChecked("transfer.wasm", __WASM_SHA256__),
    fetchChecked("transfer.zkey", __ZKEY_SHA256__),
  ]).then(([wasm, zkey]) => ({ wasm, zkey }))).catch((e) => {
    keys = null;
    throw e;
  });

let prover: Promise<Prover> | null = null;
const getProver = () =>
  (prover ??= buildPoseidon(constants as unknown as Record<number, WidthConstants>).then((poseidon) =>
    makeProver(poseidon, groth16 as never, loadKeys, vk),
  ));

type Request =
  | { id: number; op: "selfCheck" }
  | { id: number; op: "secretHash"; secret: string }
  | { id: number; op: "commitment"; record: JsonValue; holder: string; h: string }
  | {
      id: number;
      op: "prove";
      record: JsonValue;
      secret: string;
      ctx: {
        rightId: string;
        from: string;
        to: string;
        expiresAt: string | null;
        expiryLedger: string;
        nextSecretHash: string;
        swapFor?: string;
      };
    };

async function handle(req: Request): Promise<unknown> {
  const p = await getProver();
  switch (req.op) {
    case "selfCheck": {
      await loadKeys();
      return { wasm: __WASM_SHA256__, zkey: __ZKEY_SHA256__ };
    }
    case "secretHash":
      return p.secretHash(BigInt(req.secret)).toString();
    case "commitment": {
      const { d, commitment } = await p.commitment(req.record, req.holder, BigInt(req.h));
      return { d, commitment: commitment.toString() };
    }
    case "prove": {
      const c = req.ctx;
      return p.prove(req.record, BigInt(req.secret), {
        rightId: BigInt(c.rightId),
        from: c.from,
        to: c.to,
        expiresAt: c.expiresAt === null ? null : BigInt(c.expiresAt),
        expiryLedger: BigInt(c.expiryLedger),
        nextSecretHash: BigInt(c.nextSecretHash),
        ...(c.swapFor === undefined ? {} : { swapFor: BigInt(c.swapFor) }),
      });
    }
    default:
      throw new Error("unknown operation");
  }
}

self.onmessage = (event: MessageEvent<Request>) => {
  const req = event.data;
  handle(req).then(
    (result) => self.postMessage({ id: req.id, ok: true, result }),
    (error: unknown) =>
      self.postMessage({ id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
};
