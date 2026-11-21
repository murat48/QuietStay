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
import { Address, Asset, Keypair, nativeToScVal, Operation, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

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

/**
 * The Step 4 rights WASM (swaps), installed on testnet by the Step 4
 * deployment (`CCSL6J5X…ITK7`, upload tx 1b9ac00a…). Built from `dedad4b`.
 */
export const RIGHTS_STEP4_WASM_HASH = "76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde";

/** Circle's testnet USDC: the SAC and the classic asset behind it (PHASE3_SPEC.md §4). */
export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * Deploy a Step 4 rights contract (Phase 3 constructor) with `issuer` and
 * `arbiter`, Circle's testnet USDC, the committed key and the testnet cap.
 */
export async function deployRightsStep4(issuer: Keypair, arbiter: Keypair): Promise<string> {
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
        wasmHash: Buffer.from(RIGHTS_STEP4_WASM_HASH, "hex"),
        salt: randomBytes(32),
        constructorArgs: [
          new Address(issuer.publicKey()).toScVal(),
          new Address(arbiter.publicKey()).toScVal(),
          new Address(USDC_SAC).toScVal(),
          nativeToScVal("QuietStay e2e", { type: "string" }),
          nativeToScVal("QSE2E", { type: "string" }),
          vkVal,
          nativeToScVal(1_000_000_000n, { type: "i128" }),
        ],
      }),
    )
    .setTimeout(120)
    .build();
  const { returnValue } = await submit(tx, issuer);
  if (!returnValue) throw new Error("deploy returned nothing");
  return Address.fromScVal(returnValue).toString();
}

/** Add a USDC trustline to a throwaway account (a classic change-trust operation). */
export async function addUsdcTrustline(kp: Keypair): Promise<string> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`change-trust refused: ${sent.status}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${sent.hash} ended ${done.status}`);
  return sent.hash;
}

/** Call the rights contract as `kp`, signed here (the caller is the source account). */
export async function invokeAs(kp: Keypair, contract: string, fn: string, args: xdr.ScVal[]) {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(120)
    .build();
  return submit(tx, kp);
}

/** Remove an empty USDC trustline (a change-trust with limit 0). */
export async function removeUsdcTrustline(kp: Keypair): Promise<string> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER), limit: "0" }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`change-trust refused: ${sent.status}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${sent.hash} ended ${done.status}`);
  return sent.hash;
}
