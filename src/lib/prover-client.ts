/**
 * The app's side of the prover worker (decision D2).
 *
 * All GPL code runs in `public/zk/prover.worker.js`, built from
 * `prover-worker/` (GPL-3.0). This file is Apache-2.0 and talks to it only
 * with `postMessage`; nothing here imports it. The worker loads the circuit
 * and proving key from its own folder and checks them against the committed
 * SHA-256 hashes before proving.
 *
 * Browser only.
 */

import type { JsonValue } from "./canonical";
import type { TransferContext } from "./zk-fields";

export const PROVER_LICENSE_NOTICE =
  "Proofs are made by an in-browser prover licensed under the GPL-3.0 (source: prover-worker/, " +
  "built from snarkjs and circomlib). The rest of QuietStay is Apache-2.0.";
export const PROVER_SOURCE_URL = "https://github.com/murat48/QuietStay/tree/main/prover-worker";
export const PROVER_LICENSE_URL = "/zk/LICENSE";

export interface BrowserProof {
  proof: { a: string; b: string; c: string };
  signals: string[];
  signalsHex: string[];
  proveMs: number;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

/** Whether this browser can run the prover at all. */
export function proverSupported(): boolean {
  return typeof Worker !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker("/zk/prover.worker.js");
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.ok(e.data.result);
    else p.fail(new Error(e.data.error ?? "the prover failed"));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.fail(new Error(`the prover could not start: ${e.message}`));
    pending.clear();
    worker = null;
  };
  return worker;
}

function call<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((ok, fail) => {
    pending.set(id, { ok: ok as (v: unknown) => void, fail });
    getWorker().postMessage({ id, op, ...args });
  });
}

export const prover = {
  /** Load and hash-check the circuit and key. */
  selfCheck: () => call<{ wasm: string; zkey: string }>("selfCheck", {}),
  secretHash: async (secret: bigint) => BigInt(await call<string>("secretHash", { secret: secret.toString() })),
  commitment: async (record: JsonValue, holder: string, h: bigint) => {
    const r = await call<{ d: string; commitment: string }>("commitment", { record, holder, h: h.toString() });
    return { d: r.d, commitment: BigInt(r.commitment) };
  },
  prove: (record: JsonValue, secret: bigint, ctx: TransferContext) =>
    call<BrowserProof>("prove", {
      record,
      secret: secret.toString(),
      ctx: {
        rightId: ctx.rightId.toString(),
        from: ctx.from,
        to: ctx.to,
        expiresAt: ctx.expiresAt === null ? null : ctx.expiresAt.toString(),
        expiryLedger: ctx.expiryLedger.toString(),
        nextSecretHash: ctx.nextSecretHash.toString(),
      },
    }),
};
