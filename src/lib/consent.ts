/**
 * A buyer's consent to a sale — the one signature Phase 2 asks of a buyer.
 *
 * On a sale the contract calls `to.require_auth_for_args((right_id, h'))`: the
 * buyer must sign the right and the hash of the record secret they chose, so a
 * seller cannot plant a commitment the buyer could never prove against
 * (docs/CIRCUIT.md §3). Those arguments do not depend on the seller's proof, so
 * the buyer can sign them *when asking* for the week, and the holder can submit
 * the sale later without the buyer present.
 *
 * The signing is split so that only a signature ever leaves the wallet:
 *
 *   1. {@link consentToSign} builds the authorization entry and the exact
 *      preimage its signature covers — network, a random nonce, an expiry
 *      ledger, and the invocation `transfer(right_id, h')` on this contract.
 *   2. The buyer's wallet signs the preimage (`signAuthEntry`; Freighter and
 *      Hana support it).
 *   3. {@link assembleConsent} puts the signature into the entry. stellar-sdk's
 *      `authorizeEntry` verifies it against the buyer's key before returning, so
 *      a bad signature is refused here rather than on chain.
 *
 * Server-side only. No cryptography is implemented here: the entry format and
 * the signature check are stellar-sdk's.
 */

import { randomBytes } from "node:crypto";
import {
  Address,
  authorizeEntry,
  hash,
  Keypair,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import { BUYER_CONSENT_LEDGERS, CONTRACT_ID, NETWORK_PASSPHRASE } from "./config";
import { server } from "./contract";
import { parseSecretHash } from "./secret-hash";

// Parsed the same way everywhere — here, at issuance, and in the browser.
export { parseSecretHash };

function invocation(rightId: number, nextSecretHash: bigint): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(CONTRACT_ID).toScAddress(),
        functionName: "transfer",
        args: [
          nativeToScVal(BigInt(rightId), { type: "u64" }),
          nativeToScVal(nextSecretHash, { type: "u256" }),
        ],
      }),
    ),
    subInvocations: [],
  });
}

export interface ConsentToSign {
  /** The unsigned entry, base64 XDR. Sent back with the signature. */
  entry: string;
  /** What the wallet signs: the HashIdPreimage, base64 XDR. */
  preimage: string;
  valid_until_ledger: number;
}

/** Step 1: the entry, and the preimage the buyer's wallet must sign. */
export async function consentToSign(
  buyer: string,
  rightId: number,
  nextSecretHash: bigint,
): Promise<ConsentToSign> {
  const { sequence } = await server.getLatestLedger();
  const validUntil = sequence + BUYER_CONSENT_LEDGERS;
  const nonce = xdr.Int64.fromString(BigInt("0x" + randomBytes(7).toString("hex")).toString());
  const root = invocation(rightId, nextSecretHash);

  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(buyer).toScAddress(),
        nonce,
        signatureExpirationLedger: validUntil,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
      nonce,
      signatureExpirationLedger: validUntil,
      invocation: root,
    }),
  );

  return { entry: entry.toXDR("base64"), preimage: preimage.toXDR("base64"), valid_until_ledger: validUntil };
}

/**
 * Step 3: the signed entry, checked. Refuses an entry that is not for `buyer`,
 * not for `transfer(right_id, h')` on this contract, or whose signature does not
 * verify.
 */
export async function assembleConsent(params: {
  buyer: string;
  rightId: number;
  nextSecretHash: bigint;
  entry: string;
  signature: string;
  validUntilLedger: number;
}): Promise<string> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(params.entry, "base64");
  const creds = entry.credentials().address();
  if (Address.fromScAddress(creds.address()).toString() !== params.buyer) {
    throw new Error("this consent was prepared for a different account");
  }
  const expected = invocation(params.rightId, params.nextSecretHash).toXDR("base64");
  if (entry.rootInvocation().toXDR("base64") !== expected) {
    throw new Error("this consent is not for this week and this secret hash");
  }
  const signature = Buffer.from(params.signature, "base64");
  const signed = await authorizeEntry(
    entry,
    async () => ({ signature, publicKey: params.buyer }),
    params.validUntilLedger,
    NETWORK_PASSPHRASE,
  );
  return signed.toXDR("base64");
}

/** For scripts and tests: sign a consent with a local key, as a wallet would. */
export async function signConsentLocally(
  buyer: Keypair,
  rightId: number,
  nextSecretHash: bigint,
): Promise<string> {
  const toSign = await consentToSign(buyer.publicKey(), rightId, nextSecretHash);
  const signature = buyer.sign(hash(Buffer.from(toSign.preimage, "base64"))).toString("base64");
  return assembleConsent({
    buyer: buyer.publicKey(),
    rightId,
    nextSecretHash,
    entry: toSign.entry,
    signature,
    validUntilLedger: toSign.valid_until_ledger,
  });
}
