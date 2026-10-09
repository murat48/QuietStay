/**
 * Real proofs for the contract's unit tests.
 *
 *   npm run zk:test-fixtures
 *
 * Every transfer in contracts/quietstay-rights/src/test.rs carries a genuine
 * Groth16 proof made with the committed development keys — the tests exercise
 * the same verification the deployed contract runs, not a stub. Accounts and
 * secrets are derived from fixed labels so the fixtures are reproducible in
 * substance (the proofs themselves are randomized, so their bytes differ run to
 * run); they are test values and protect nothing.
 *
 * Writes contracts/quietstay-rights/tests/fixtures/: one JSON file per scenario,
 * common.json with the accounts and commitments, and a copy of the encoded
 * verification key.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { groth16 } from "snarkjs";
import type { JsonValue } from "../../src/lib/canonical";
import { fatal, log } from "../lib/cli";
import { circuitInput, commitment, R, secretHash, splitRecordDigest, type TransferContext } from "../lib/zk";
import { encodeProof, fr } from "../lib/zk-encode";

const OUT = resolve("contracts/quietstay-rights/tests/fixtures");
const KEYS = resolve("circuits/keys");

// Must match the constants in contracts/quietstay-rights/src/test.rs.
const BASE_LEDGER = 1000n;
const WINDOW = 360n;
const DAY = 86_400n;
const WEEK_END = 1_783_728_000n;

const account = (label: string) =>
  Keypair.fromRawEd25519Seed(createHash("sha256").update(`quietstay-test-account:${label}`).digest());
const secret = (label: string) =>
  BigInt("0x" + createHash("sha256").update(`quietstay-test-secret:${label}`).digest("hex")) % R;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const record = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8")) as JsonValue;
  const d = await splitRecordDigest(record);

  const who = Object.fromEntries(
    ["issuer", "owner", "renter", "buyer", "stranger"].map((n) => [n, account(n).publicKey()]),
  ) as Record<"issuer" | "owner" | "renter" | "buyer" | "stranger", string>;
  const s = Object.fromEntries(
    ["owner", "renter", "buyer", "stranger", "planted"].map((n) => [n, secret(n)]),
  ) as Record<"owner" | "renter" | "buyer" | "stranger" | "planted", bigint>;
  const h = {
    owner: await secretHash(s.owner),
    renter: await secretHash(s.renter),
    buyer: await secretHash(s.buyer),
    stranger: await secretHash(s.stranger),
    planted: await secretHash(s.planted),
  };
  const ownerCommitment = await commitment(d, who.owner, h.owner);
  const buyerCommitment = await commitment(d, who.buyer, h.buyer);

  const exp = BASE_LEDGER + WINDOW;
  const scenarios: Record<string, { secret: bigint; ctx: TransferContext; note: string }> = {
    rental: {
      note: "owner rents to renter until WEEK_END",
      secret: s.owner,
      ctx: { rightId: 1n, from: who.owner, to: who.renter, expiresAt: WEEK_END, expiryLedger: exp, nextSecretHash: 0n },
    },
    sale: {
      note: "owner sells to buyer, with the buyer's h'",
      secret: s.owner,
      ctx: { rightId: 1n, from: who.owner, to: who.buyer, expiresAt: null, expiryLedger: exp, nextSecretHash: h.buyer },
    },
    sale_planted: {
      note: "owner sells to buyer but plants an h' of the seller's own choosing",
      secret: s.owner,
      ctx: { rightId: 1n, from: who.owner, to: who.buyer, expiresAt: null, expiryLedger: exp, nextSecretHash: h.planted },
    },
    resale: {
      note: "after `sale`, the buyer sells on to stranger with the buyer's own secret",
      secret: s.buyer,
      ctx: { rightId: 1n, from: who.buyer, to: who.stranger, expiresAt: null, expiryLedger: exp, nextSecretHash: h.stranger },
    },
    old_owner_resale: {
      note: "after `sale`, the old owner tries to sell again with the old secret",
      secret: s.owner,
      ctx: { rightId: 1n, from: who.owner, to: who.stranger, expiresAt: null, expiryLedger: exp, nextSecretHash: h.stranger },
    },
    renter_sale: {
      note: "the renter tries to sell, proving with a secret of their own",
      secret: s.renter,
      ctx: { rightId: 1n, from: who.renter, to: who.stranger, expiresAt: null, expiryLedger: exp, nextSecretHash: h.stranger },
    },
    rental_edge: {
      note: "owner rents to renter; the proof's window is the full 720 ledgers",
      secret: s.owner,
      ctx: { rightId: 1n, from: who.owner, to: who.renter, expiresAt: WEEK_END, expiryLedger: BASE_LEDGER + 720n, nextSecretHash: 0n },
    },
    rental_again: {
      note: "after the first rental lapses, at ledger 2000, the owner rents to stranger for a later week",
      secret: s.owner,
      ctx: { rightId: 1n, from: who.owner, to: who.stranger, expiresAt: WEEK_END + 7n * DAY, expiryLedger: 2000n + WINDOW, nextSecretHash: 0n },
    },
  };

  for (const [name, { secret: sec, ctx, note }] of Object.entries(scenarios)) {
    const { input, publicSignals } = await circuitInput(d, sec, ctx);
    const { proof, publicSignals: emitted } = await groth16.fullProve(
      input,
      join(KEYS, "transfer.wasm"),
      join(KEYS, "transfer.zkey"),
    );
    if (emitted.some((x, i) => BigInt(x) !== publicSignals[i])) throw new Error(`${name}: signal order`);
    const vk = JSON.parse(readFileSync(join(KEYS, "verification_key.json"), "utf8"));
    if (!(await groth16.verify(vk, emitted, proof))) throw new Error(`${name}: does not verify`);
    writeFileSync(
      join(OUT, `${name}.json`),
      JSON.stringify(
        {
          note,
          from: ctx.from,
          to: ctx.to,
          right_id: Number(ctx.rightId),
          expires_at: ctx.expiresAt === null ? null : Number(ctx.expiresAt),
          expiry_ledger: Number(ctx.expiryLedger),
          next_secret_hash: fr(ctx.nextSecretHash),
          proof: encodeProof(proof),
          signals: emitted.map((x) => fr(x)),
        },
        null,
        2,
      ) + "\n",
    );
    log.ok(`${name}: ${note}`);
  }

  writeFileSync(
    join(OUT, "common.json"),
    JSON.stringify(
      {
        accounts: who,
        owner_commitment: fr(ownerCommitment),
        buyer_commitment: fr(buyerCommitment),
        base_ledger: Number(BASE_LEDGER),
      },
      null,
      2,
    ) + "\n",
  );
  copyFileSync(join(KEYS, "verification_key.soroban.json"), join(OUT, "verification_key.soroban.json"));
  log.ok(`wrote ${OUT}`);
  process.exit(0);
}

main().catch(fatal);
