/**
 * The passkey smart wallet, in the browser: smart-account-kit 0.10.0 driving
 * an OpenZeppelin smart account (stellar-accounts v0.8.0, `c514d35e…`) whose
 * signer is a WebAuthn passkey (docs/PHASE3_SPEC.md §1, §12, §13).
 *
 * - No indexer and no relayer. The wallet is created through the shared
 *   deployer's `{func, auth}`, which /api/tx/sponsor pays for. The kit then
 *   verifies the wallet's creation transaction on chain before connecting.
 * - Sign-in is SEP-45 (/api/auth/contract). The challenge is checked here
 *   before the passkey signs it.
 * - Every transaction a passkey approves is built by the app with the fee
 *   account as source. The passkey signs only the wallet's own authorization
 *   entries, and /api/tx/sponsor pays and submits.
 *
 * The kit is loaded on demand, so a regular-wallet user never downloads it.
 * Browser only.
 */

import { Buffer } from "buffer";
import { Address, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import type { SmartAccountKit } from "smart-account-kit";

import { NETWORK_PASSPHRASE, RPC_URL, SMART_ACCOUNT_WASM_HASH, WEBAUTHN_VERIFIER_ID, WEB_AUTH_CONTRACT_ID } from "./config";

/** The wallet's default context rule, whose only signer is its passkey. */
const DEFAULT_RULE = 0;

let kitPromise: Promise<{ kit: SmartAccountKit; storage: import("smart-account-kit").IndexedDBStorage }> | null = null;

function loadKit() {
  kitPromise ??= import("smart-account-kit").then(({ SmartAccountKit, IndexedDBStorage }) => {
    const storage = new IndexedDBStorage();
    const kit = new SmartAccountKit({
      rpcUrl: RPC_URL,
      networkPassphrase: NETWORK_PASSPHRASE,
      accountWasmHash: SMART_ACCOUNT_WASM_HASH,
      webauthnVerifierAddress: WEBAUTHN_VERIFIER_ID,
      indexerUrl: false,
      storage,
      rpName: "QuietStay",
    });
    return { kit, storage };
  });
  return kitPromise;
}

async function latestLedger(): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  const body = (await res.json()) as { result?: { sequence: number } };
  if (!body.result) throw new Error("could not read the latest ledger");
  return body.result.sequence;
}

/**
 * Create a passkey and its smart wallet, and connect to it. The browser asks
 * for the passkey; the fee account pays for the wallet's creation.
 */
export async function createPasskeyWallet(): Promise<string> {
  const { kit, storage } = await loadKit();
  const created = await kit.createWallet("QuietStay", "QuietStay testnet", { autoSubmit: false });
  if (!created.relayerPayload) throw new Error("the kit did not return a deployment to submit");
  const res = await fetch("/api/tx/sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(created.relayerPayload),
  });
  const sent = (await res.json()) as { hash?: string; successful?: boolean; ledger?: number; failure?: string; error?: string };
  if (!res.ok || !sent.successful || !sent.hash || !sent.ledger) {
    throw new Error(sent.error ?? sent.failure ?? "the wallet could not be created");
  }
  // With no indexer, the kit connects from the creation transaction we report,
  // and checks it on chain (code hash, deployer, salt, constructor) first.
  await storage.update(created.credentialId, {
    birthWasmHash: SMART_ACCOUNT_WASM_HASH,
    creationTransactionHash: sent.hash,
    deploymentTransactionHash: sent.hash,
    creationLedger: sent.ledger,
  });
  const connected = await kit.connectWallet({ contractId: created.contractId, credentialId: created.credentialId });
  if (connected?.contractId !== created.contractId) throw new Error("the new wallet could not be connected");
  return created.contractId;
}

/**
 * Connect to a passkey wallet created in this browser. With no indexer, a
 * wallet made on another device cannot be found from its passkey alone: a
 * stated limitation of this pilot.
 */
export async function connectPasskeyWallet(): Promise<string> {
  const { kit } = await loadKit();
  const restored = (await kit.connectWallet()) ?? (await kit.connectWallet({ prompt: true }));
  if (!restored?.contractId) throw new Error("no passkey wallet was created in this browser");
  return restored.contractId;
}

/** The wallet this browser is connected to, without asking for the passkey. */
export async function restoredPasskeyWallet(): Promise<string | null> {
  try {
    const { kit } = await loadKit();
    return (await kit.connectWallet())?.contractId ?? null;
  } catch {
    return null;
  }
}

export async function disconnectPasskeyWallet(): Promise<void> {
  const { kit } = await loadKit();
  await kit.disconnect();
}

/** Sign one authorization entry (base64 XDR) with the passkey, valid through `expiration`. */
export async function signEntry(entryXdr: string, expiration: number): Promise<string> {
  const { kit } = await loadKit();
  return kit.signAuthEntry(entryXdr, { contextRuleIds: [DEFAULT_RULE], expiration });
}

/** Has this entry's address `wallet` and no signature yet? */
function needsWallet(entry: xdr.SorobanAuthorizationEntry, wallet: string): boolean {
  const c = entry.credentials();
  if (c.switch().name !== "sorobanCredentialsAddress") return false;
  return Address.fromScAddress(c.address().address()).toString() === wallet && c.address().signature().switch().name === "scvVoid";
}

/**
 * Sign every authorization entry in `txXdr` that `wallet` must give, and
 * return the envelope with them in place (not signed by anyone: the fee
 * account signs it in /api/tx/sponsor). Signatures are valid for about half
 * an hour, which covers a proof's own window.
 */
export async function signWalletEntries(txXdr: string, wallet: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;
  const env = tx.toEnvelope();
  const op = env.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
  if (!op) throw new Error("expected one contract call");
  const expiration = (await latestLedger()) + 360;
  let signed = 0;
  const auth = await Promise.all(
    op.auth().map(async (entry) => {
      if (!needsWallet(entry, wallet)) return entry;
      signed += 1;
      return xdr.SorobanAuthorizationEntry.fromXDR(await signEntry(entry.toXDR("base64"), expiration), "base64");
    }),
  );
  if (signed === 0) throw new Error("this transaction asks nothing of your wallet");
  op.auth(auth);
  return env.toXDR("base64");
}

// --- SEP-45 sign-in ------------------------------------------------------------------

function decodeEntries(base64: string): xdr.SorobanAuthorizationEntry[] {
  const empty = new xdr.InvokeHostFunctionOp({
    hostFunction: xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.alloc(0)),
    auth: [],
  }).toXDR();
  return xdr.InvokeHostFunctionOp.fromXDR(
    Buffer.concat([empty.subarray(0, empty.length - 4), Buffer.from(base64, "base64")]),
  ).auth();
}

function encodeEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(entries.length);
  return Buffer.concat([head, ...entries.map((e) => e.toXDR())]).toString("base64");
}

/**
 * Sign in with SEP-45: fetch a challenge, check it as SEP-45 tells a client
 * to, sign the wallet's entry with the passkey, and return the session token.
 */
export async function signInWithPasskey(wallet: string): Promise<string> {
  // The domains a challenge must name are this page's own host: the server
  // authenticates for the deployment the browser is talking to.
  const host = window.location.host;
  const res = await fetch(`/api/auth/contract?account=${encodeURIComponent(wallet)}&home_domain=${encodeURIComponent(host)}`);
  const body = (await res.json()) as { authorization_entries?: string; network_passphrase?: string; error?: string };
  if (!res.ok || !body.authorization_entries) throw new Error(body.error ?? "could not get a sign-in challenge");
  if (body.network_passphrase !== NETWORK_PASSPHRASE) throw new Error("the sign-in challenge is for another network");

  const entries = decodeEntries(body.authorization_entries);
  let serverSigned = false;
  let clientIndex = -1;
  entries.forEach((e, i) => {
    const root = e.rootInvocation();
    const call = root.function().contractFn();
    if (root.subInvocations().length !== 0) throw new Error("the sign-in challenge has sub-invocations; refusing to sign it");
    if (Address.fromScAddress(call.contractAddress()).toString() !== WEB_AUTH_CONTRACT_ID) {
      throw new Error("the sign-in challenge is for an unexpected contract; refusing to sign it");
    }
    if (call.functionName().toString() !== "web_auth_verify") throw new Error("the sign-in challenge calls an unexpected function");
    const args = Object.fromEntries((call.args()[0]?.map() ?? []).map((m) => [m.key().sym().toString(), m.val().str().toString()]));
    if (args.account !== wallet || args.home_domain !== host || args.web_auth_domain !== host) {
      throw new Error("the sign-in challenge names another account or domain; refusing to sign it");
    }
    const who = Address.fromScAddress(e.credentials().address().address()).toString();
    if (who === wallet) clientIndex = i;
    else if (who === args.web_auth_domain_account && e.credentials().address().signature().switch().name !== "scvVoid") serverSigned = true;
  });
  if (clientIndex < 0 || !serverSigned) throw new Error("the sign-in challenge is incomplete");

  // A near expiry, as SEP-45 recommends: a stolen signed challenge is soon useless.
  const expiration = (await latestLedger()) + 20;
  entries[clientIndex] = xdr.SorobanAuthorizationEntry.fromXDR(
    await signEntry(entries[clientIndex]!.toXDR("base64"), expiration),
    "base64",
  );
  const post = await fetch("/api/auth/contract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorization_entries: encodeEntries(entries) }),
  });
  const session = (await post.json()) as { token?: string; error?: string };
  if (!post.ok || !session.token) throw new Error(session.error ?? "sign-in failed");
  return session.token;
}
