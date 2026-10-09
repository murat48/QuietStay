/**
 * Produce the Phase 2 evidence transactions on a deployed contract.
 *
 *   npm run zk:evidence -- <contract id> <deploy tx hash>
 *
 * Needs the inventory issued by `npm run zk:reissue` on the same contract.
 * Seven transactions, each a claim a reviewer can open:
 *
 *   accepted   a proof-authorized rental
 *   accepted   a proof-authorized sale
 *   rejected   a tampered proof                          → Error(Contract, #28) InvalidProof
 *   rejected   a replayed proof                          → Error(Contract, #27) NullifierUsed
 *   rejected   a proof presented by the wrong account    → Error(Contract, #21) WrongAccount
 *   rejected   holder + issuer signatures, no proof      → Error(Contract, #16) WrongSignalCount
 *   rejected   the issuer transferring a held week to itself → Error(Auth, InvalidAction)
 *
 * The rejections are sent with `withSiblingResources` (scripts/lib/zk-tx.ts),
 * the evidence-only path that submits without a successful simulation of its
 * own. Each one's on-chain result is read back from the transaction meta and
 * must be `invokeHostFunctionTrapped` with exactly the expected error — not a
 * resource failure, not a different check. Anything else stops the run and is
 * not recorded.
 *
 * Writes docs/evidence-phase2.json, from which docs/EVIDENCE.md is generated.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Address, Keypair, nativeToScVal, rpc, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";
import { groth16 } from "snarkjs";
import { explorer, issuerSecret } from "../../src/lib/config";
import { server } from "../../src/lib/contract";
import type { JsonValue } from "../../src/lib/canonical";
import { fatal, loadEnv, log, requireArg, writeJson } from "../lib/cli";
import { circuitInput, randomSecret, secretHash, splitRecordDigest, type TransferContext } from "../lib/zk";
import { encodeProof } from "../lib/zk-encode";
import {
  buildCall,
  envSigners,
  handMadeAuth,
  sendAndWait,
  signAuth,
  signersOf,
  simulate,
  transferArgs,
  withSiblingResources,
  type Outcome,
  type ProvenTransfer,
} from "../lib/zk-tx";

const KEYS = "circuits/keys";
const USAGE = "npm run zk:evidence -- <contract id> <deploy tx hash>";

interface Issued {
  contract: string;
  rights: { right_id: number; record_file: string; week: { check_out: string }; owner: string; owner_secret_file: string }[];
}

const day = (iso: string) => BigInt(Date.parse(`${iso}T00:00:00Z`) / 1000);

async function prove(
  recordFile: string,
  secret: bigint,
  ctx: TransferContext,
): Promise<ProvenTransfer> {
  const d = await splitRecordDigest(JSON.parse(readFileSync(recordFile, "utf8")) as JsonValue);
  const { input } = await circuitInput(d, secret, ctx);
  const { proof, publicSignals } = await groth16.fullProve(input, join(KEYS, "transfer.wasm"), join(KEYS, "transfer.zkey"));
  const vk = JSON.parse(readFileSync(join(KEYS, "verification_key.json"), "utf8"));
  if (!(await groth16.verify(vk, publicSignals, proof))) throw new Error("proof does not verify off-chain");
  return { from: ctx.from, to: ctx.to, rightId: ctx.rightId, expiresAt: ctx.expiresAt, proof: encodeProof(proof), signals: publicSignals };
}

/** An authorization entry covered by the source account's own signature. */
function sourceAuth(contractId: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contractId).toScAddress(),
          functionName: "transfer",
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
}

interface Item {
  id: string;
  title: string;
  claim: string;
  expected: string;
  look_for: string;
  right_id: number;
  signers: string[];
  hash: string;
  ledger: number;
  successful: boolean;
  op_result: string;
  error: string | null;
  fee_charged: number;
  declared_instructions?: number;
  explorer: string;
}

async function main() {
  loadEnv();
  const contractId = requireArg(0, USAGE);
  const deployTx = requireArg(1, USAGE);
  const issued = JSON.parse(readFileSync("inventory/phase2/issued.json", "utf8")) as Issued;
  if (issued.contract !== contractId) throw new Error(`inventory/phase2/issued.json is for ${issued.contract}`);

  const keys = envSigners();
  const issuer = Keypair.fromSecret(issuerSecret());
  const renter = Keypair.fromSecret(process.env.DEMO_RENTER_SECRET!);
  const buyer = Keypair.fromSecret(process.env.DEMO_BUYER_SECRET!);
  const byWeek = (n: string) => {
    const r = issued.rights.find((x) => x.record_file.endsWith(`week-${n}.json`));
    if (!r) throw new Error(`week-${n} not issued`);
    return { ...r, secret: BigInt(JSON.parse(readFileSync(r.owner_secret_file, "utf8")).secret) };
  };
  const w1 = byWeek("01");
  const w2 = byWeek("02");
  const w3 = byWeek("03");
  const w4 = byWeek("04");
  const owner = keys.get(w1.owner);
  if (!owner) throw new Error("no key for the sample owner");

  // The buyer's secret for this contract, kept with the owners'.
  const buyerFile = join(".secrets", contractId.slice(0, 8), "week-01-buyer.json");
  if (!existsSync(buyerFile)) {
    writeFileSync(buyerFile, JSON.stringify({ secret: randomSecret().toString() }, null, 2) + "\n", { mode: 0o600 });
  }
  const buyerHash = await secretHash(BigInt(JSON.parse(readFileSync(buyerFile, "utf8")).secret));

  const latest = (await server.getLatestLedger()).sequence;
  const expiry = BigInt(latest + 360);
  const items: Item[] = [];

  const record = (item: Omit<Item, "hash" | "ledger" | "successful" | "op_result" | "error" | "fee_charged" | "explorer">, out: Outcome, declared?: number) => {
    items.push({
      ...item,
      hash: out.hash,
      ledger: out.ledger,
      successful: out.successful,
      op_result: out.opResult,
      error: out.successful ? null : (out.errors.at(-1) ?? null),
      fee_charged: out.feeCharged,
      declared_instructions: declared,
      explorer: explorer.tx(out.hash),
    });
  };

  /** Simulate, sign the requested authorizations, re-simulate, send. Must succeed. */
  async function accepted(source: Keypair, t: ProvenTransfer) {
    const args = transferArgs(t);
    const first = await simulate(await buildCall(source.publicKey(), contractId, "transfer", args));
    const auth = await signAuth(first.result?.auth ?? [], keys, first.latestLedger + 100);
    const tx = await buildCall(source.publicKey(), contractId, "transfer", args, auth);
    const sim = await simulate(tx);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(source);
    const out = await sendAndWait(prepared);
    if (!out.successful) throw new Error(`expected success, got ${out.opResult} ${out.errors.join(" ")}`);
    return { out, sim, signers: signersOf(auth) };
  }

  /** EVIDENCE ONLY: send a call the contract must refuse, and check how it refused. */
  async function rejected(
    source: Keypair,
    args: xdr.ScVal[],
    auth: xdr.SorobanAuthorizationEntry[],
    sibling: rpc.Api.SimulateTransactionSuccessResponse,
    expectedError: string,
  ) {
    const tx: Transaction = withSiblingResources(
      await buildCall(source.publicKey(), contractId, "transfer", args, auth),
      sibling,
    );
    tx.sign(source);
    const declared = tx.toEnvelope().v1().tx().ext().sorobanData().resources().instructions();
    const out = await sendAndWait(tx);
    if (out.successful) throw new Error(`expected a rejection, but ${out.hash} succeeded`);
    if (out.opResult !== "invokeHostFunctionTrapped") {
      throw new Error(`${out.hash} failed as ${out.opResult}, not at a contract check — not evidence`);
    }
    if (!out.errors.includes(expectedError)) {
      throw new Error(`${out.hash} failed with ${out.errors.join(", ")}, expected ${expectedError}`);
    }
    log.ok(`rejected on chain with ${expectedError} (result ${out.opResult}; ${declared} instructions declared)`);
    return { out, declared };
  }

  // ---- 1. accepted rental -------------------------------------------------
  log.step(`1. Rental — right #${w3.right_id} to the renter, proof-authorized`);
  const rental = await prove(w3.record_file, w3.secret, {
    rightId: BigInt(w3.right_id), from: w3.owner, to: renter.publicKey(),
    expiresAt: day(w3.week.check_out), expiryLedger: expiry, nextSecretHash: 0n,
  });
  const r1 = await accepted(owner, rental);
  log.ok(`succeeded`);
  record({
    id: "rental",
    title: "Rental, authorized by an on-chain proof",
    claim: `The holder rents right #${w3.right_id} to the renter until ${w3.week.check_out}. The contract verifies the ownership proof on chain; the holder's signature is the only one.`,
    expected: "succeeds",
    look_for: "Status: success. One signature, the holder's — no issuer. The call's last two arguments are the proof and its eleven public signals.",
    right_id: w3.right_id,
    signers: r1.signers,
  }, r1.out);

  // ---- 2. accepted sale ---------------------------------------------------
  log.step(`2. Sale — right #${w1.right_id} to the buyer, proof-authorized`);
  const sale = await prove(w1.record_file, w1.secret, {
    rightId: BigInt(w1.right_id), from: w1.owner, to: buyer.publicKey(),
    expiresAt: null, expiryLedger: expiry, nextSecretHash: buyerHash,
  });
  const r2 = await accepted(owner, sale);
  log.ok(`succeeded`);
  record({
    id: "sale",
    title: "Sale, authorized by an on-chain proof",
    claim: `The holder sells right #${w1.right_id} to the buyer. The proof also computes the buyer's new commitment, which replaces the old one, so only the buyer can prove next.`,
    expected: "succeeds",
    look_for: "Status: success. Two signatures — the holder's over the whole call, the buyer's over the right id and the buyer's secret hash. No issuer. The transfer event's commitment is the new one.",
    right_id: w1.right_id,
    signers: r2.signers,
  }, r2.out);

  // An honest proof for week 04 — the sibling whose resources the next two use.
  const honest4 = await prove(w4.record_file, w4.secret, {
    rightId: BigInt(w4.right_id), from: w4.owner, to: renter.publicKey(),
    expiresAt: day(w4.week.check_out), expiryLedger: expiry, nextSecretHash: 0n,
  });
  const sibling4 = await simulate(await buildCall(owner.publicKey(), contractId, "transfer", transferArgs(honest4)));

  // ---- 3. tampered proof --------------------------------------------------
  log.step(`3. Tampered proof — right #${w4.right_id}`);
  const tampered: ProvenTransfer = { ...honest4, proof: { a: honest4.proof.c, b: honest4.proof.b, c: honest4.proof.a } };
  const tArgs = transferArgs(tampered);
  const r3 = await rejected(owner, tArgs, [sourceAuth(contractId, tArgs)], sibling4, "Error(Contract, #28)");
  record({
    id: "rejected-tampered-proof",
    title: "Tampered proof — rejected on chain",
    claim: `A valid rental of right #${w4.right_id} with two of the proof's points swapped. Every public signal matches the transfer, so every check passes up to the pairing check, which fails.`,
    expected: "rejected: Error(Contract, #28) InvalidProof",
    look_for: "Status: failed, result invoke_host_function_trapped. The diagnostic events end in Error(Contract, #28) — InvalidProof.",
    right_id: w4.right_id,
    signers: ["source account"],
  }, r3.out, r3.declared);

  // ---- 4. replayed proof --------------------------------------------------
  log.step(`4. Replayed proof — the rental of right #${w3.right_id} again`);
  const rArgs = transferArgs(rental);
  const r4 = await rejected(owner, rArgs, [sourceAuth(contractId, rArgs)], r1.sim, "Error(Contract, #27)");
  record({
    id: "rejected-replayed-proof",
    title: "Replayed proof — rejected on chain",
    claim: `Transaction 1's call, resubmitted unchanged: the same proof, the same signals. Its nullifier was spent by transaction 1.`,
    expected: "rejected: Error(Contract, #27) NullifierUsed",
    look_for: "Status: failed, result invoke_host_function_trapped. Error(Contract, #27) — NullifierUsed. Compare its arguments with transaction 1's: identical.",
    right_id: w3.right_id,
    signers: ["source account"],
  }, r4.out, r4.declared);

  // ---- 5. wrong account ---------------------------------------------------
  log.step(`5. A proof presented by the wrong account — right #${w4.right_id}`);
  const stolen: ProvenTransfer = { ...honest4, from: renter.publicKey() };
  const wArgs = transferArgs(stolen);
  const r5 = await rejected(renter, wArgs, [sourceAuth(contractId, wArgs)], sibling4, "Error(Contract, #21)");
  record({
    id: "rejected-wrong-account",
    title: "Proof from the wrong account — rejected on chain",
    claim: `The renter signs and submits the owner's valid proof for right #${w4.right_id} as if it were theirs. The proof names the owner's account.`,
    expected: "rejected: Error(Contract, #21) WrongAccount",
    look_for: "Status: failed, result invoke_host_function_trapped. Error(Contract, #21) — WrongAccount. The source account is the renter.",
    right_id: w4.right_id,
    signers: ["source account (the renter)"],
  }, r5.out, r5.declared);

  // A sibling for week 02: the honest sale the next two pretend to be.
  const honest2 = await prove(w2.record_file, w2.secret, {
    rightId: BigInt(w2.right_id), from: w2.owner, to: buyer.publicKey(),
    expiresAt: null, expiryLedger: expiry, nextSecretHash: buyerHash,
  });
  const sibling2 = await simulate(await buildCall(owner.publicKey(), contractId, "transfer", transferArgs(honest2)));
  const noProof = { a: "00".repeat(96), b: "00".repeat(192), c: "00".repeat(96) };

  // ---- 6. issuer authorization, no proof ----------------------------------
  log.step(`6. Holder and issuer sign, no proof — right #${w2.right_id}`);
  const bare: ProvenTransfer = { ...honest2, proof: noProof, signals: [] };
  const bArgs = transferArgs(bare);
  const issuerEntry = await handMadeAuth(issuer, contractId, "transfer", bArgs, latest + 300);
  const r6 = await rejected(owner, bArgs, [sourceAuth(contractId, bArgs), issuerEntry], sibling2, "Error(Contract, #16)");
  record({
    id: "rejected-issuer-signed-no-proof",
    title: "Holder and issuer sign, no proof — rejected on chain",
    claim: `Phase 1's full authorization for a sale of right #${w2.right_id}: the holder's signature and the issuer's. No proof. Under Phase 2 the issuer's signature counts for nothing.`,
    expected: "rejected: Error(Contract, #16) WrongSignalCount",
    look_for: "Status: failed, result invoke_host_function_trapped. Two authorization entries — the holder's and the issuer's — and Error(Contract, #16): no public signals, so no proof.",
    right_id: w2.right_id,
    signers: ["source account (the holder)", issuer.publicKey()],
  }, r6.out, r6.declared);

  // ---- 7. issuer seizure --------------------------------------------------
  log.step(`7. The issuer transferring right #${w2.right_id} to itself`);
  const seize: ProvenTransfer = { ...honest2, to: issuer.publicKey(), proof: noProof, signals: [] };
  const sArgs = transferArgs(seize);
  const r7 = await rejected(issuer, sArgs, [], sibling2, "Error(Auth, InvalidAction)");
  record({
    id: "rejected-issuer-seizure",
    title: "Issuer transferring a held week to itself — rejected on chain",
    claim: `The issuer builds, signs and pays for a transfer of right #${w2.right_id} from its holder to itself. It has neither the holder's signature nor the holder's secret.`,
    expected: "rejected: Error(Auth, InvalidAction)",
    look_for: "Status: failed, result invoke_host_function_trapped. Source account: the issuer. Error(Auth, InvalidAction) — the holder never authorized it, so nothing past the first check ran.",
    right_id: w2.right_id,
    signers: ["source account (the issuer)"],
  }, r7.out, r7.declared);

  // ---- state after --------------------------------------------------------
  const holder = async (id: number) =>
    scValToNative(
      ((await simulate(await buildCall(issuer.publicKey(), contractId, "holder", [nativeToScVal(BigInt(id), { type: "u64" })]))).result!.retval),
    ) as string;
  const after = {
    [w1.right_id]: await holder(w1.right_id),
    [w2.right_id]: await holder(w2.right_id),
    [w3.right_id]: await holder(w3.right_id),
    [w4.right_id]: await holder(w4.right_id),
  };
  log.step("Holders after the run");
  for (const [id, h] of Object.entries(after)) log.info(`#${id}  ${h}`);

  writeJson("docs/evidence-phase2.json", {
    generated_on: new Date().toISOString().slice(0, 10),
    contract: contractId,
    contract_explorer: explorer.contract(contractId),
    deploy_tx: deployTx,
    issuer: issuer.publicKey(),
    accounts: { owner: w1.owner, renter: renter.publicKey(), buyer: buyer.publicKey() },
    holders_after: after,
    transactions: items,
  });
  log.ok("wrote docs/evidence-phase2.json");
  process.exit(0);
}

main().catch(fatal);
