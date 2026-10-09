/**
 * Circuit tests: an honest witness satisfies every constraint, and each way of
 * lying about the secret, the account or the transfer does not.
 *
 *   npm run zk:compile && npm run zk:test
 *
 * A failing witness is detected twice over: circom's generated witness code
 * asserts every `===` as it runs, and for the passing cases snarkjs then checks
 * the full witness against the R1CS. Because the honest inputs come from the
 * JavaScript Poseidon (scripts/lib/poseidon.ts), the passing cases are also the
 * proof that circuit and CLI compute the same Poseidon at every width used.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { wtns } from "snarkjs";
import { hash } from "../../scripts/lib/poseidon";
import {
  circuitInput,
  randomSecret,
  secretHash,
  splitAccount,
  splitRecordDigest,
  type CircuitInput,
  type TransferContext,
} from "../../scripts/lib/zk";

const WASM = resolve("circuits/build/transfer_js/transfer.wasm");
const R1CS = resolve("circuits/build/transfer.r1cs");
const tmp = mkdtempSync(join(tmpdir(), "qs-circuit-"));
let n = 0;

async function witness(input: CircuitInput): Promise<string> {
  const file = join(tmp, `w${n++}.wtns`);
  await wtns.calculate(input, WASM, file);
  return file;
}

async function satisfies(input: CircuitInput): Promise<void> {
  const file = await witness(input);
  assert.equal(await wtns.check(R1CS, file), true, "witness does not satisfy the R1CS");
}

async function refuses(input: CircuitInput): Promise<void> {
  await assert.rejects(witness(input), /Assert Failed/);
}

const owner = Keypair.random().publicKey();
const buyer = Keypair.random().publicKey();
const stranger = Keypair.random().publicKey();
let d: { hi: bigint; lo: bigint };
let secret: bigint;
let buyerHash: bigint;

function sale(over: Partial<TransferContext> = {}): TransferContext {
  return { rightId: 7n, from: owner, to: buyer, expiresAt: null, expiryLedger: 1_000_500n, nextSecretHash: buyerHash, ...over };
}
function rental(over: Partial<TransferContext> = {}): TransferContext {
  return { rightId: 7n, from: owner, to: buyer, expiresAt: 1_790_000_000n, expiryLedger: 1_000_500n, nextSecretHash: 0n, ...over };
}

before(async () => {
  assert.ok(existsSync(WASM), "circuit not compiled — run `npm run zk:compile` first");
  const record = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  d = await splitRecordDigest(record);
  secret = randomSecret();
  buyerHash = await secretHash(randomSecret());
});

// snarkjs caches the curve, with its worker threads, on globalThis; left running
// they keep the process alive after the last test.
after(async () => {
  const cached = (globalThis as { curve_bls12381?: { terminate(): Promise<void> } }).curve_bls12381;
  await cached?.terminate();
});

describe("an honest prover", () => {
  it("satisfies the circuit for a sale", async () => {
    await satisfies((await circuitInput(d, secret, sale())).input);
  });

  it("satisfies the circuit for a rental", async () => {
    await satisfies((await circuitInput(d, secret, rental())).input);
  });

  it("emits public signals in the order CIRCUIT.md §7 fixes", async () => {
    const r1cs = readFileSync(join(resolve("circuits/build"), "transfer.sym"), "utf8").split("\n");
    // .sym rows: label index, witness index, component, name. Wires 1..11 are the public inputs.
    const pub = r1cs
      .map((l) => l.split(","))
      .filter((c) => Number(c[1]) >= 1 && Number(c[1]) <= 11 && c[3]?.startsWith("main.") && !c[3].slice(5).includes("."))
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((c) => c[3]!.slice(5));
    assert.deepEqual(pub, [
      "commitment", "nullifier", "right_id", "from_hi", "from_lo", "to_hi", "to_lo",
      "mode", "expiry_ledger", "next_secret_hash", "next_commitment",
    ]);
  });
});

describe("a dishonest prover", () => {
  it("cannot prove with the wrong secret", async () => {
    const { input } = await circuitInput(d, secret, sale());
    await refuses({ ...input, secret: randomSecret().toString() });
  });

  it("cannot prove from an account the commitment does not name", async () => {
    // The stranger presents the owner's commitment as their own.
    const { input } = await circuitInput(d, secret, sale());
    const [hi, lo] = splitAccount(stranger);
    await refuses({ ...input, from_hi: hi.toString(), from_lo: lo.toString() });
  });

  it("cannot prove a record the commitment does not wrap", async () => {
    const { input } = await circuitInput(d, secret, sale());
    await refuses({ ...input, d_lo: (d.lo ^ 1n).toString() });
  });

  it("cannot reuse a nullifier for a different recipient", async () => {
    const honest = (await circuitInput(d, secret, sale())).input;
    const other = (await circuitInput(d, secret, sale({ to: stranger }))).input;
    await refuses({ ...other, nullifier: honest.nullifier });
  });

  it("cannot reuse a nullifier for a different mode or rental length", async () => {
    const asSale = (await circuitInput(d, secret, sale())).input;
    const asRental = (await circuitInput(d, secret, rental())).input;
    const longer = (await circuitInput(d, secret, rental({ expiresAt: 1_790_604_800n }))).input;
    await refuses({ ...asRental, nullifier: asSale.nullifier });
    await refuses({ ...longer, nullifier: asRental.nullifier });
  });

  it("cannot reuse a nullifier for a different right or deadline", async () => {
    const honest = (await circuitInput(d, secret, sale())).input;
    const otherRight = (await circuitInput(d, secret, sale({ rightId: 8n }))).input;
    const later = (await circuitInput(d, secret, sale({ expiryLedger: 1_000_700n }))).input;
    await refuses({ ...otherRight, nullifier: honest.nullifier });
    await refuses({ ...later, nullifier: honest.nullifier });
  });

  it("cannot pick a nullifier freely", async () => {
    const { input } = await circuitInput(d, secret, sale());
    await refuses({ ...input, nullifier: (BigInt(input.nullifier) + 1n).toString() });
  });

  it("cannot hand the buyer a next commitment for a different secret hash", async () => {
    // The seller swaps in their own h' but keeps the buyer's C' — or the reverse.
    const { input } = await circuitInput(d, secret, sale());
    const sellerHash = await secretHash(randomSecret());
    await refuses({ ...input, next_secret_hash: sellerHash.toString() });
    const plantedC = await hash([d.hi, d.lo, ...splitAccount(buyer), sellerHash]);
    await refuses({ ...input, next_commitment: plantedC.toString() });
  });
});
