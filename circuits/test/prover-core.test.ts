/**
 * The browser prover computes what the CLI prover computes (Phase 3, Step 2).
 *
 *   npm run zk:test
 *
 * prover-worker/src/core.ts runs in the browser's worker; scripts/lib/zk.ts in
 * the CLI. They are separate code (the CLI's uses Node built-ins), so this
 * checks them against each other: the same record, secret and transfer give
 * the same public signals, for G… and C… addresses, sales and rentals; and
 * src/lib/zk-fields.ts decodes addresses exactly as the Stellar SDK does.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { groth16 } from "snarkjs";

import { circuitPoseidon } from "../gpl/poseidon";
import { makeProver } from "../../prover-worker/src/core";
import { circuitInput, splitAddress as cliSplit, splitRecordDigest, randomSecret, type TransferContext } from "../../scripts/lib/zk";
import { decodeAddress, splitAddress, splitDigest } from "../../src/lib/zk-fields";
import type { JsonValue } from "../../src/lib/canonical";

const KEYS = resolve("circuits/keys");
const record = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8")) as JsonValue;
const vk = JSON.parse(readFileSync(join(KEYS, "verification_key.json"), "utf8"));
const keys = async () => ({
  wasm: new Uint8Array(readFileSync(join(KEYS, "transfer.wasm"))),
  zkey: new Uint8Array(readFileSync(join(KEYS, "transfer.zkey"))),
});

// snarkjs caches the curve, with its worker threads, on globalThis; left running
// they keep the test process alive.
after(async () => {
  const cached = (globalThis as { curve_bls12381?: { terminate(): Promise<void> } }).curve_bls12381;
  await cached?.terminate();
});

describe("the browser's address and digest encoding", () => {
  it("decodes G… and C… addresses as the Stellar SDK does, and splits as the CLI does", () => {
    for (let i = 0; i < 50; i++) {
      const g = Keypair.random().publicKey();
      const c = StrKey.encodeContract(Keypair.random().rawPublicKey());
      assert.deepEqual(decodeAddress(g).bytes, new Uint8Array(StrKey.decodeEd25519PublicKey(g)));
      assert.deepEqual(decodeAddress(c).bytes, new Uint8Array(StrKey.decodeContract(c)));
      assert.deepEqual(splitAddress(g), cliSplit(g));
      assert.deepEqual(splitAddress(c), cliSplit(c));
    }
  });

  it("refuses a bad checksum and other strkey kinds", () => {
    const g = Keypair.random().publicKey();
    const flipped = g.slice(0, 10) + (g[10] === "A" ? "B" : "A") + g.slice(11);
    assert.throws(() => decodeAddress(flipped));
    assert.throws(() => decodeAddress(StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1))));
    assert.throws(() => decodeAddress("S" + g.slice(1)));
  });

  it("splits a record digest as the CLI does", async () => {
    const cli = await splitRecordDigest(record);
    const browser = splitDigest(cli.hex);
    assert.equal(browser.hi, cli.hi);
    assert.equal(browser.lo, cli.lo);
  });
});

describe("the browser prover's core", async () => {
  const prover = makeProver(await circuitPoseidon(), groth16 as never, keys, vk);
  const owner = Keypair.random().publicKey();
  const wallet = StrKey.encodeContract(Keypair.random().rawPublicKey());
  const buyer = Keypair.random().publicKey();
  const s = randomSecret();
  const s2 = randomSecret();

  const cases: [string, TransferContext][] = [
    ["a rental from a G… holder", { rightId: 3n, from: owner, to: buyer, expiresAt: 1_783_728_000n, expiryLedger: 5_000_360n, nextSecretHash: 0n }],
    ["a sale from a G… holder", { rightId: 3n, from: owner, to: buyer, expiresAt: null, expiryLedger: 5_000_360n, nextSecretHash: prover.secretHash(s2) }],
    ["a sale from a C… holder", { rightId: 9n, from: wallet, to: buyer, expiresAt: null, expiryLedger: 7n, nextSecretHash: prover.secretHash(s2) }],
    // Phase 3 Step 4: one side of a swap, mode 2^64 + the week received.
    ["a swap side from a G… holder", { rightId: 3n, from: owner, to: buyer, expiresAt: null, swapFor: 4n, expiryLedger: 5_000_360n, nextSecretHash: prover.secretHash(s2) }],
    ["a swap side from a C… holder", { rightId: 9n, from: wallet, to: buyer, expiresAt: null, swapFor: 3n, expiryLedger: 7n, nextSecretHash: prover.secretHash(s2) }],
    ["a rental to a C… recipient", { rightId: 1n, from: owner, to: wallet, expiresAt: 1_783_728_000n, expiryLedger: 7n, nextSecretHash: 0n }],
  ];

  for (const [name, ctx] of cases) {
    it(`${name}: the same signals as the CLI, and a proof that verifies`, async () => {
      const d = await splitRecordDigest(record);
      const { publicSignals } = await circuitInput(d, s, ctx);
      const got = await prover.prove(record, s, ctx);
      assert.deepEqual(got.signals.map(BigInt), publicSignals);
      assert.equal(got.signalsHex.length, 11);
      assert.match(got.proof.a, /^[0-9a-f]{192}$/);
      assert.match(got.proof.b, /^[0-9a-f]{384}$/);
    });
  }

  it("computes the commitment the contract stores", async () => {
    const d = await splitRecordDigest(record);
    const h = prover.secretHash(s);
    const { publicSignals } = await circuitInput(d, s, cases[0]![1]);
    const c = await prover.commitment(record, owner, h);
    assert.equal(c.d, d.hex);
    assert.equal(c.commitment, publicSignals[0]);
  });

  it("refuses a rental with a next secret hash, and a sale without one", async () => {
    await assert.rejects(prover.prove(record, s, { ...cases[0]![1], nextSecretHash: 5n }));
    await assert.rejects(prover.prove(record, s, { ...cases[1]![1], nextSecretHash: 0n }));
  });
});
