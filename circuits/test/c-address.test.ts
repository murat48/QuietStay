/**
 * Phase 3, decision D1: a smart wallet (`C…` address) can hold a right with the
 * Phase 2 circuit, keys and verifier unchanged.
 *
 *   npm run zk:test
 *
 * The binding (docs/PHASE3_SPEC.md §1) encodes an address's 32-byte payload as
 * (hi, lo) with a kind tag in hi: hi = t·2^128 + int(k[0..16]), t = 0 for a
 * G… account (Phase 2, unchanged) and t = 1 for a C… contract. These tests
 * make real Groth16 proofs with the committed proving key for a C-address
 * holder and recipient and verify them off-chain against the committed
 * verification key. That is only possible if the circuit puts no 128-bit
 * range check on the account halves. With QS_WRITE_PROOF_DIR set, the C-holder
 * sale proof is also written out in the contract's encoding, so it can be
 * verified on chain (docs/PHASE3_PROGRESS.md, Step 1 review).
 *
 * The tagged encoding lives here until Step 2 moves it into scripts/lib/zk.ts.
 * Until then the CLI still refuses C-addresses.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { groth16 } from "snarkjs";
import { hash, R } from "../gpl/poseidon";
import { PUBLIC_SIGNALS, randomSecret, secretHash, split32, splitRecordDigest } from "../../scripts/lib/zk";
import { encodeProof } from "../../scripts/lib/zk-encode";

const KEYS = resolve("circuits/keys");
const TAG_CONTRACT = 1n << 128n;

/** The Phase 3 address encoding: G → (hi, lo) as Phase 2; C → (2^128 + hi, lo). */
function splitAddress(address: string): [bigint, bigint] {
  if (StrKey.isValidEd25519PublicKey(address)) return split32(StrKey.decodeEd25519PublicKey(address));
  if (StrKey.isValidContract(address)) {
    const [hi, lo] = split32(StrKey.decodeContract(address));
    return [TAG_CONTRACT + hi, lo];
  }
  throw new Error(`${address} is neither a G… account nor a C… contract`);
}

interface Ctx {
  from: string;
  to: string;
  rightId: bigint;
  mode: bigint;
  expiryLedger: bigint;
  nextSecretHash: bigint;
}

async function input(d: { hi: bigint; lo: bigint }, secret: bigint, ctx: Ctx) {
  const [fromHi, fromLo] = splitAddress(ctx.from);
  const [toHi, toLo] = splitAddress(ctx.to);
  const h = await secretHash(secret);
  const values: Record<(typeof PUBLIC_SIGNALS)[number], bigint> = {
    commitment: await hash([d.hi, d.lo, fromHi, fromLo, h]),
    nullifier: await hash([secret, ctx.rightId, toHi, toLo, ctx.mode, ctx.expiryLedger]),
    right_id: ctx.rightId,
    from_hi: fromHi,
    from_lo: fromLo,
    to_hi: toHi,
    to_lo: toLo,
    mode: ctx.mode,
    expiry_ledger: ctx.expiryLedger,
    next_secret_hash: ctx.nextSecretHash,
    next_commitment: await hash([d.hi, d.lo, toHi, toLo, ctx.nextSecretHash]),
  };
  const signals = PUBLIC_SIGNALS.map((k) => values[k]);
  const inp: Record<string, string> = Object.fromEntries(PUBLIC_SIGNALS.map((k) => [k, values[k].toString()]));
  inp.d_hi = d.hi.toString();
  inp.d_lo = d.lo.toString();
  inp.secret = secret.toString();
  return { inp, signals };
}

async function proveAndVerify(d: { hi: bigint; lo: bigint }, secret: bigint, ctx: Ctx) {
  const { inp, signals } = await input(d, secret, ctx);
  const { proof, publicSignals } = await groth16.fullProve(inp, join(KEYS, "transfer.wasm"), join(KEYS, "transfer.zkey"));
  assert.deepEqual(publicSignals.map(BigInt), signals, "snarkjs emitted different public signals");
  const vk = JSON.parse(readFileSync(join(KEYS, "verification_key.json"), "utf8"));
  assert.equal(await groth16.verify(vk, publicSignals, proof), true, "proof does not verify off-chain");
  return { proof, publicSignals };
}

const wallet = StrKey.encodeContract(randomBytes(32)); // a smart wallet
const account = Keypair.random().publicKey();
let d: { hi: bigint; lo: bigint };
let secret: bigint;

before(async () => {
  const record = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  d = await splitRecordDigest(record);
  secret = randomSecret();
});

after(async () => {
  const cached = (globalThis as { curve_bls12381?: { terminate(): Promise<void> } }).curve_bls12381;
  await cached?.terminate();
});

describe("C-address binding (PHASE3_SPEC §1, D1)", () => {
  it("a tagged hi is above 2^128 and still a canonical field element", () => {
    const [hi] = splitAddress(wallet);
    assert.ok(hi >= TAG_CONTRACT && hi < R);
  });

  it("a G account encodes exactly as in Phase 2 (tag 0)", () => {
    assert.deepEqual(splitAddress(account), split32(StrKey.decodeEd25519PublicKey(account)));
  });

  it("the same 32 bytes as G and as C give different encodings and commitments", async () => {
    const bytes = randomBytes(32);
    const g = StrKey.encodeEd25519PublicKey(bytes);
    const c = StrKey.encodeContract(bytes);
    const h = await secretHash(secret);
    const [gHi, gLo] = splitAddress(g);
    const [cHi, cLo] = splitAddress(c);
    assert.equal(gLo, cLo);
    assert.notEqual(gHi, cHi);
    assert.notEqual(await hash([d.hi, d.lo, gHi, gLo, h]), await hash([d.hi, d.lo, cHi, cLo, h]));
  });

  it("proves and verifies a sale from a C-address holder to a G account", async () => {
    const nextSecretHash = await secretHash(randomSecret());
    const ctx = { from: wallet, to: account, rightId: 7n, mode: 0n, expiryLedger: 1_000_500n, nextSecretHash };
    const { proof, publicSignals } = await proveAndVerify(d, secret, ctx);
    assert.ok(BigInt(publicSignals[3]!) >= TAG_CONTRACT, "from_hi carries the contract tag");

    const out = process.env.QS_WRITE_PROOF_DIR;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "proof.json"), JSON.stringify(encodeProof(proof)));
      writeFileSync(join(out, "public.json"), JSON.stringify(publicSignals));
      writeFileSync(join(out, "context.json"), JSON.stringify({ from: wallet, to: account, right_id: 7, mode: "0" }));
    }
  });

  it("proves and verifies a sale from a G account to a C-address recipient", async () => {
    const nextSecretHash = await secretHash(randomSecret());
    await proveAndVerify(d, secret, { from: account, to: wallet, rightId: 7n, mode: 0n, expiryLedger: 1_000_500n, nextSecretHash });
  });

  it("proves and verifies a rental from a C-address holder", async () => {
    await proveAndVerify(d, secret, { from: wallet, to: account, rightId: 7n, mode: 1_790_000_000n, expiryLedger: 1_000_500n, nextSecretHash: 0n });
  });

  it("a proof claiming the untagged encoding of a C-holder's commitment is not satisfiable", async () => {
    // The commitment is made for the tagged wallet; the prover then claims the
    // same 32 bytes untagged as from_hi. The circuit's C === Poseidon(...) fails.
    const { inp } = await input(d, secret, { from: wallet, to: account, rightId: 7n, mode: 0n, expiryLedger: 1_000_500n, nextSecretHash: 5n });
    inp.from_hi = (BigInt(inp.from_hi!) - TAG_CONTRACT).toString();
    await assert.rejects(
      groth16.fullProve(inp, join(KEYS, "transfer.wasm"), join(KEYS, "transfer.zkey")),
      /Assert Failed|Error/,
    );
  });
});
