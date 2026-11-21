/**
 * Step 5 checklist: a **simulation only** of uploading the final rights WASM
 * to mainnet. Nothing is signed and nothing is sent: this script has no
 * signing key and never calls `sendTransaction`.
 *
 *   npx tsx scripts/mainnet-simulate-upload.ts --source <G… public key> [--wasm <file>]
 *
 * It builds the upload transaction with the given account as source (only
 * its public key and sequence number are read), calls the mainnet RPC's
 * `simulateTransaction`, and prints the instructions, the declared resources,
 * the minimum resource fee and the rent. The deploy (create contract) cannot
 * be simulated before the WASM is on mainnet, and neither can any flow: those
 * are simulated with `--send=no` right after the Step 6 upload, before the
 * deploy and before each first flow.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Account, Operation, rpc, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

async function main() {
  const { values: a } = parseArgs({
    options: { source: { type: "string" }, wasm: { type: "string", default: "contracts/target/wasm32v1-none/release/quietstay_rights.wasm" } },
  });
  if (!a.source || !StrKey.isValidEd25519PublicKey(a.source)) throw new Error("--source <G… public key> is required (a public key, never a secret)");
  const wasm = readFileSync(a.wasm!);
  const hash = createHash("sha256").update(wasm).digest("hex");
  const server = new rpc.Server(MAINNET_RPC);
  const net = await server.getNetwork();
  if (net.passphrase !== MAINNET_PASSPHRASE) throw new Error(`unexpected network: ${net.passphrase}`);
  const acct = await server.getAccount(a.source);
  const tx = new TransactionBuilder(new Account(a.source, acct.sequenceNumber()), { fee: "100", networkPassphrase: MAINNET_PASSPHRASE })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`simulation failed: ${JSON.stringify(sim).slice(0, 600)}`);
  const res = sim.transactionData.build().resources();
  const out = {
    simulated_at: new Date().toISOString(),
    network: "mainnet (simulation only; nothing signed or sent)",
    rpc: MAINNET_RPC,
    protocol: net.protocolVersion,
    latest_ledger: sim.latestLedger,
    source_public_key: a.source,
    wasm: { file: a.wasm, bytes: wasm.length, sha256: hash },
    instructions: res.instructions(),
    disk_read_bytes: res.diskReadBytes(),
    write_bytes: res.writeBytes(),
    footprint: { read_only: res.footprint().readOnly().length, read_write: res.footprint().readWrite().length },
    min_resource_fee_stroops: sim.minResourceFee,
    state_changes: sim.stateChanges?.length ?? 0,
    transaction_size_bytes: tx.toEnvelope().toXDR().length,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
