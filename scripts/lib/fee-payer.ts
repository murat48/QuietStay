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
import { rpc, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, RPC_URL } from "../../src/lib/config";

export const server = new rpc.Server(RPC_URL);

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
