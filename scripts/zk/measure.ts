/**
 * Measure one on-chain proof verification: simulate it, then (with --send)
 * submit it and read what the network actually charged.
 *
 *   npm run zk:measure -- <verifier contract id> <proof dir> [--send]
 *
 * <proof dir> is a `npm run zk:prove` output directory. The source account is
 * QUIETSTAY_ISSUER_SECRET from .env.local — any funded testnet account would do;
 * the verifier has no notion of who calls it.
 *
 * Prints, from the RPC's own simulateTransaction response: CPU instructions,
 * memory bytes, ledger bytes read/written, and the minimum resource fee; with
 * --send, the transaction hash and the fee actually charged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { explorer, issuerSecret, NETWORK_PASSPHRASE } from "../../src/lib/config";
import { server } from "../../src/lib/contract";
import { fatal, loadEnv, log, requireArg } from "../lib/cli";

const bytes = (hex: string) => nativeToScVal(Buffer.from(hex, "hex"));

async function main() {
  loadEnv();
  const contractId = requireArg(0, "npm run zk:measure -- <contract id> <proof dir> [--send]");
  const dir = requireArg(1, "npm run zk:measure -- <contract id> <proof dir> [--send]");
  const send = process.argv.includes("--send");

  const t = JSON.parse(readFileSync(join(dir, "transfer.json"), "utf8")) as {
    proof: { a: string; b: string; c: string };
  };
  const signals = JSON.parse(readFileSync(join(dir, "public.json"), "utf8")) as string[];

  // Struct fields are encoded in key order: a, b, c.
  const proof = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("a"), val: bytes(t.proof.a) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("b"), val: bytes(t.proof.b) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("c"), val: bytes(t.proof.c) }),
  ]);
  const publicSignals = xdr.ScVal.scvVec(signals.map((s) => nativeToScVal(BigInt(s), { type: "u256" })));

  const source = Keypair.fromSecret(issuerSecret());
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call("verify", proof, publicSignals))
    .setTimeout(120)
    .build();

  log.step(`Simulating verify on ${contractId}`);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  const res = sim.transactionData.build().resources();
  const value = sim.result?.retval ? sim.result.retval.value() : undefined;
  log.info(`result                 ${String(value)}`);
  log.info(`cpu instructions       ${res.instructions()}`);
  // The RPC's simulation response carries no memory figure; the local host
  // budget in contracts/quietstay-verifier's tests measures it instead.
  log.info(`ledger bytes read      ${res.diskReadBytes()}`);
  log.info(`ledger bytes written   ${res.writeBytes()}`);
  log.info(`min resource fee       ${sim.minResourceFee} stroops`);
  log.info(`latest ledger          ${sim.latestLedger}`);

  if (!send) {
    process.exit(0);
  }

  log.step("Submitting");
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== "SUCCESS") throw new Error(`transaction ${sent.hash} ended ${done.status}`);
  const meta = done.resultMetaXdr;
  const charged = done.resultXdr.feeCharged().toString();
  const sorobanMeta = meta.switch() >= 3 ? (meta.value() as { sorobanMeta(): xdr.SorobanTransactionMeta | null }).sorobanMeta() : null;
  log.ok(`submitted in ledger ${done.ledger}`);
  log.info(`returned               ${String(done.returnValue?.value())}`);
  log.info(`fee charged            ${charged} stroops (${Number(charged) / 1e7} XLM)`);
  if (sorobanMeta) {
    const ext = sorobanMeta.ext();
    if (ext.switch() === 1) {
      const v1 = ext.v1();
      log.info(`  non-refundable       ${v1.totalNonRefundableResourceFeeCharged()} stroops`);
      log.info(`  refundable           ${v1.totalRefundableResourceFeeCharged()} stroops`);
    }
  }
  log.link("transaction", explorer.tx(sent.hash));
  process.exit(0);
}

main().catch(fatal);
