/**
 * The browser's side of the issuer's intake key (./issuer-key.ts, D16).
 *
 * The owner's browser fetches the published key and checks it itself: the
 * issuer it was signed by is read straight from the chain through the public
 * RPC, not through this app's server, so a server that swapped in its own key
 * is caught. Only then are the details sealed.
 *
 * The issuer's browser keeps the private half in its vault and publishes the
 * public half once, signed with the issuer's wallet.
 */

import { Account, BASE_FEE, Contract, Keypair, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";

import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "./config";
import {
  INTAKE_PURPOSE,
  intakeKeyMessage,
  intakeSignatureIsValid,
  type IntakeKey,
  type OwnerDetails,
  type SealedDetails,
} from "./issuer-key";
import { open, seal, sha256Hex, unb64u, b64u } from "./sealed";
import { newSealKey, sealKey } from "./vault";

/** The contract's issuer, read from the chain by this browser. */
export async function chainIssuer(): Promise<string> {
  const server = new rpc.Server(RPC_URL);
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(CONTRACT_ID).call("issuer"))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("could not read the issuer from the chain");
  return scValToNative(sim.result.retval) as string;
}

async function publishedKey(): Promise<IntakeKey | null> {
  const res = await fetch("/api/issuer-key", { cache: "no-store" });
  const body = (await res.json()) as { key?: IntakeKey | null; error?: string };
  if (!res.ok) throw new Error(body.error ?? "could not read the issuer's intake key");
  return body.key ?? null;
}

/**
 * The issuer's intake key, checked: signed by the issuer the chain names, for
 * this contract and network, and hashing to what was signed. `null` when the
 * issuer has published none. Throws when one is published but fails a check.
 */
export async function verifiedIntakeKey(): Promise<{ publicRaw: Uint8Array; keyHash: string } | null> {
  const [key, issuer] = await Promise.all([publishedKey(), chainIssuer()]);
  if (!key) return null;
  const publicRaw = unb64u(key.public_key);
  const keyHash = await sha256Hex(publicRaw);
  const message = intakeKeyMessage({ contract: CONTRACT_ID, network: NETWORK_PASSPHRASE, keyHash });
  if (key.issuer !== issuer || keyHash !== key.key_hash || !intakeSignatureIsValid(issuer, message, key.signature)) {
    throw new Error("the issuer's intake key is not signed by the issuer on chain; nothing was sent");
  }
  return { publicRaw, keyHash };
}

/** Seal the owner's details to the issuer's checked key. */
export async function sealDetails(
  key: { publicRaw: Uint8Array; keyHash: string },
  owner: string,
  details: OwnerDetails,
): Promise<{ blob: string; key_hash: string }> {
  const payload: SealedDetails = { v: 1, kind: "issuance details", contract: CONTRACT_ID, owner, details };
  return { blob: await seal(key.publicRaw, key.keyHash, payload), key_hash: key.keyHash };
}

/**
 * The issuer's side: whether this browser holds the published intake key.
 * `"ready"` when it does, `"missing"` when none is published or the published
 * one was made in another browser.
 */
export async function intakeStatus(issuer: string): Promise<"ready" | "missing"> {
  const key = await publishedKey();
  if (!key || key.issuer !== issuer) return "missing";
  return (await sealKey(key.key_hash)) ? "ready" : "missing";
}

/** Make an intake key in this browser and publish it, signed by the issuer's wallet. */
export async function publishIntakeKey(
  signMessage: (message: string) => Promise<string>,
  authFetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const key = await newSealKey(INTAKE_PURPOSE);
  const message = intakeKeyMessage({ contract: CONTRACT_ID, network: NETWORK_PASSPHRASE, keyHash: key.keyHash });
  const signature = await signMessage(message);
  const res = await authFetch("/api/issuer-key", {
    method: "POST",
    body: JSON.stringify({ public_key: b64u(key.publicRaw), signature }),
  });
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "the intake key was not published");
}

/** Open an ask's sealed details in the issuer's browser, checked against the ask. */
export async function openDetails(ask: { by: string; sealed_details?: { blob: string; key_hash: string } }): Promise<OwnerDetails> {
  if (!ask.sealed_details) throw new Error("this ask carries no details");
  const entry = await sealKey(ask.sealed_details.key_hash);
  if (!entry) throw new Error("these details were sealed to an intake key this browser does not hold");
  const payload = (await open(entry.privateKey, entry.keyHash, ask.sealed_details.blob)) as SealedDetails;
  if (payload?.v !== 1 || payload.kind !== "issuance details" || payload.contract !== CONTRACT_ID || payload.owner !== ask.by) {
    throw new Error("the sealed details are not for this ask");
  }
  return payload.details ?? {};
}
