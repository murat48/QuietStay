/**
 * Pay for and submit a transaction from a builder-controlled fee account,
 * signed by the Stellar CLI (decision D6).
 *
 * The fee account is a CLI identity (testnet: `qs-fee-testnet`, which has no
 * other role). Its secret never enters this process: the envelope goes to
 * `stellar tx sign --sign-with-key <alias>` on stdin and comes back signed.
 * Authorization entries (a passkey's, say) are already inside the transaction
 * and are not touched here.
 */

import { execFileSync } from "node:child_process";
import { rpc, SorobanDataBuilder, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL } from "../../src/lib/config";
import { RetryingServer } from "../../src/lib/rpc-server";

// Read-only calls are retried on a dropped connection; sendTransaction never is.
export const server = new RetryingServer(RPC_URL);

/** The fee account's public address, from the CLI keystore. */
export function feeAccount(alias: string): string {
  return execFileSync("stellar", ["keys", "address", alias], { encoding: "utf8" }).trim();
}

export interface Submitted {
  hash: string;
  ledger: number;
  /** The resource fee the simulation charged, in stroops. */
  minResourceFee: string;
  /** The return value, if the call returned one. */
  returnValue?: rpc.Api.GetSuccessfulTransactionResponse["returnValue"];
}

/**
 * Simulate (with the auth entries already in `tx`, so a signed entry is checked
 * for real), assemble, have the CLI sign as `alias`, submit and wait.
 */
export async function payAndSubmit(tx: Transaction, alias: string): Promise<Submitted> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  const assembled = rpc.assembleTransaction(tx, sim).build();

  const signedXdr = execFileSync(
    "stellar",
    ["tx", "sign", "--sign-with-key", alias, "--network", "testnet"],
    { input: assembled.toXDR(), encoding: "utf8" },
  ).trim();
  const signed = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as Transaction;

  const sent = await server.sendTransaction(signed);
  if (sent.status !== "PENDING") {
    throw new Error(`submission refused (${sent.status}): ${sent.errorResult?.toXDR("base64") ?? ""}`);
  }
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} ended ${done.status}`);
  }
  return {
    hash: sent.hash,
    ledger: done.ledger,
    minResourceFee: (sim as rpc.Api.SimulateTransactionSuccessResponse).minResourceFee,
    returnValue: done.returnValue,
  };
}

/**
 * Assemble `tx` from a simulation with headroom: resource estimates move a
 * little between simulations (rent and write fees, instruction counts), and
 * an envelope that will be signed later by hand must still cover them then.
 * Adds 15% to the instructions and 25% to the resource fee.
 */
export function assembleWithMargin(tx: Transaction, sim: rpc.Api.SimulateTransactionSuccessResponse): Transaction {
  const data = sim.transactionData.build();
  const res = data.resources();
  res.instructions(Math.ceil(res.instructions() * 1.15));
  const resourceFee = (BigInt(sim.minResourceFee) * 125n) / 100n;
  data.resourceFee(xdr.Int64.fromString(resourceFee.toString()));
  const padded = { ...sim, minResourceFee: resourceFee.toString(), transactionData: new SorobanDataBuilder(data) };
  return rpc.assembleTransaction(tx, padded).build();
}
