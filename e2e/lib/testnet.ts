/**
 * Testnet set-up for the end-to-end tests: throwaway accounts and a fresh
 * rights contract.
 *
 * Every key here is made by `Keypair.random()` for one run, funded by
 * Friendbot, and dropped when the run ends. None is stored, printed or read
 * from anywhere. The contract's issuer is one of them, so the tests never use
 * the deployment's real issuer key.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Address, Keypair, nativeToScVal, Operation, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE, RPC_URL } from "../../src/lib/config";
import { struct } from "../../scripts/lib/zk-tx";
import { RetryingServer } from "../../src/lib/rpc-server";

// Read-only calls are retried on a dropped connection; sendTransaction never is.
export const server = new RetryingServer(RPC_URL);

/**
 * The Step 2 rights WASM, installed on testnet by its deployment
 * (`CCR2Z4IQ…MAX5`, tx ab335e2b…). The tests deploy new instances of it.
 */
export const RIGHTS_WASM_HASH = "0c6e4b2fdfd3424b9c044c2d8d741b0ed404b884b8f708637541141b4ceff855";

export async function fund(kp: Keypair): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot refused ${kp.publicKey()}: HTTP ${res.status}`);
  // Friendbot answers once Horizon has the account; RPC can lag a ledger or two.
  for (let i = 0; i < 30; i++) {
    try {
      await server.getAccount(kp.publicKey());
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`RPC never saw ${kp.publicKey()} after funding`);
}

export async function submit(tx: ReturnType<TransactionBuilder["build"]>, signer: Keypair) {
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`refused: ${sent.status}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${sent.hash} ended ${done.status}`);
  return { hash: sent.hash, returnValue: done.returnValue };
}

/** Deploy a rights contract with `issuer` as its issuer and the committed key. */
export async function deployRights(issuer: Keypair): Promise<string> {
  const vk = JSON.parse(readFileSync("circuits/keys/verification_key.soroban.json", "utf8")) as {
    alpha: string;
    beta: string;
    gamma: string;
    delta: string;
    ic: string[];
  };
  const b = (hex: string) => nativeToScVal(Buffer.from(hex, "hex"));
  const vkVal = struct({
    alpha: b(vk.alpha),
    beta: b(vk.beta),
    gamma: b(vk.gamma),
    delta: b(vk.delta),
    ic: xdr.ScVal.scvVec(vk.ic.map(b)),
  });
  const account = await server.getAccount(issuer.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.createCustomContract({
        address: new Address(issuer.publicKey()),
        wasmHash: Buffer.from(RIGHTS_WASM_HASH, "hex"),
        salt: randomBytes(32),
        constructorArgs: [
          new Address(issuer.publicKey()).toScVal(),
          nativeToScVal("QuietStay e2e", { type: "string" }),
          nativeToScVal("QSE2E", { type: "string" }),
          vkVal,
        ],
      }),
    )
    .setTimeout(120)
    .build();
  const { returnValue } = await submit(tx, issuer);
  if (!returnValue) throw new Error("deploy returned nothing");
  return Address.fromScVal(returnValue).toString();
}
