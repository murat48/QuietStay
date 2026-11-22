/**
 * The testnet fee route's policy (docs/PHASE3_SPEC.md §13, decision D6).
 *
 * A smart wallet cannot be a transaction's source, so the builder-controlled
 * fee account (`qs-fee-testnet`) pays. This file decides what it will pay
 * for. `/api/tx/sponsor` applies it, then signs and submits.
 *
 * The route never signs what the client built. It takes only the host
 * function and its authorization entries, and builds a new transaction from
 * the fee account with its current sequence number. So the client controls
 * neither the source nor the fee nor the time bounds.
 *
 * Refused, unless every rule holds:
 * - testnet only: on any other network passphrase the route does not run,
 *   and not in a `cli` deployment (NEXT_PUBLIC_QUIETSTAY_SIGNING=cli);
 * - the host function is either
 *   - a call to the QuietStay rights contract (any function: the contract
 *     does its own authorization), or
 *   - the creation of a smart wallet: `CreateContractV2` of the pinned
 *     OpenZeppelin account WASM `c514d35e…`;
 * - every authorization entry's call tree stays inside the rights contract
 *   (or is that same wallet creation). The one exception (Step 3, spec §13,
 *   D12): directly under a rights-contract call, the wallet may authorize the
 *   fixed USDC contract's `approve` with the rights contract as spender, which
 *   is how an offer sets its allowance. No other USDC function, no other
 *   spender, and no USDC call at the top of a tree;
 * - the fee account appears nowhere but as source: not as an authorizing
 *   address, and not in any argument;
 * - the fee is at most 10,000,000 stroops (1 XLM);
 * - rate limits: 10 per IP per hour, 20 per smart wallet per day, 300 per day
 *   in total, kept in the deployment's store. If the store cannot be reached,
 *   the route refuses rather than run unlimited.
 *
 * The fee key has no other role. `assertFeeKeyIsolated` refuses to run if the
 * fee address is the issuer, the SEP-10/SEP-45 signing key, or a holder of
 * any right. `scripts/check-fee-account.ts` checks the same on chain.
 */

import { Address, hash, StrKey, xdr } from "@stellar/stellar-sdk";

import { CLI_SIGNING, CONTRACT_ID, NETWORK_PASSPHRASE, SMART_ACCOUNT_WASM_HASH, USDC_CONTRACT_ID } from "./config";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAX_FEE_STROOPS = 10_000_000n;
export const LIMITS = {
  perIpPerHour: 10,
  perWalletPerDay: 20,
  totalPerDay: 300,
} as const;

export class SponsorRefusal extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = "SponsorRefusal";
  }
}

export type SponsoredKind = "call" | "wallet-deployment";

export interface Checked {
  kind: SponsoredKind;
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
  /** The smart wallet the transaction is for: the authorizing C… address, or the one being created. */
  wallet: string | null;
}

/** Every Address inside a value, depth first. */
function addressesIn(v: xdr.ScVal, out: string[] = []): string[] {
  switch (v.switch().name) {
    case "scvAddress":
      out.push(Address.fromScAddress(v.address()).toString());
      break;
    case "scvVec":
      for (const x of v.vec() ?? []) addressesIn(x, out);
      break;
    case "scvMap":
      for (const e of v.map() ?? []) {
        addressesIn(e.key(), out);
        addressesIn(e.val(), out);
      }
      break;
  }
  return out;
}

/** The address of a contract created from `preimage` on this network. */
export function createdContractId(preimage: xdr.ContractIdPreimage): string {
  const id = hash(
    xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({ networkId: hash(Buffer.from(NETWORK_PASSPHRASE)), contractIdPreimage: preimage }),
    ).toXDR(),
  );
  return StrKey.encodeContract(id);
}

function isWalletCreation(args: xdr.CreateContractArgsV2): boolean {
  const exe = args.executable();
  return exe.switch().name === "contractExecutableWasm" && Buffer.from(exe.wasmHash()).toString("hex") === SMART_ACCOUNT_WASM_HASH;
}

/**
 * The offer's allowance: `USDC.approve(from, CONTRACT_ID, amount, expiration)`,
 * directly under a rights-contract call. Its `from` is the authorizing wallet,
 * whose auth the token itself requires.
 */
function isOfferAllowance(c: xdr.InvokeContractArgs, parentIsRights: boolean): boolean {
  if (!parentIsRights) return false;
  if (Address.fromScAddress(c.contractAddress()).toString() !== USDC_CONTRACT_ID) return false;
  if (c.functionName().toString() !== "approve") return false;
  const spender = c.args()[1];
  return spender !== undefined && spender.switch().name === "scvAddress" &&
    Address.fromScAddress(spender.address()).toString() === CONTRACT_ID;
}

function checkInvocation(inv: xdr.SorobanAuthorizedInvocation, feeAccount: string, parentIsRights = false): void {
  const f = inv.function();
  let isRights = false;
  switch (f.switch().name) {
    case "sorobanAuthorizedFunctionTypeContractFn": {
      const c = f.contractFn();
      const target = Address.fromScAddress(c.contractAddress()).toString();
      if (target === CONTRACT_ID) {
        isRights = true;
      } else if (!isOfferAllowance(c, parentIsRights)) {
        throw new SponsorRefusal(
          target === USDC_CONTRACT_ID
            ? "the only USDC call sponsored is an offer's approve, with the rights contract as spender"
            : "an authorization reaches a contract other than QuietStay's",
        );
      }
      for (const a of c.args()) {
        if (addressesIn(a).includes(feeAccount)) throw new SponsorRefusal("the fee account appears in an argument");
      }
      break;
    }
    case "sorobanAuthorizedFunctionTypeCreateContractV2HostFn":
      if (!isWalletCreation(f.createContractV2HostFn())) throw new SponsorRefusal("an authorization creates a contract other than a smart wallet");
      break;
    default:
      throw new SponsorRefusal(`an authorization of kind ${f.switch().name} is not sponsored`);
  }
  for (const sub of inv.subInvocations()) checkInvocation(sub, feeAccount, isRights);
}

/** Apply the rules above to a host function and its authorization entries. */
export function checkSponsored(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[],
  feeAccount: string,
  networkPassphrase: string = NETWORK_PASSPHRASE,
): Checked {
  if (networkPassphrase !== TESTNET_PASSPHRASE) throw new SponsorRefusal("the fee route runs on testnet only", 404);
  // A `cli` deployment (the mainnet-like rehearsal) has no fee key: the passkey
  // fee is an envelope signed with the CLI fee identity instead.
  if (CLI_SIGNING) throw new SponsorRefusal("this deployment has no fee route: the passkey fee is signed with the CLI", 404);

  let kind: SponsoredKind;
  let wallet: string | null = null;
  switch (func.switch().name) {
    case "hostFunctionTypeInvokeContract": {
      const c = func.invokeContract();
      if (Address.fromScAddress(c.contractAddress()).toString() !== CONTRACT_ID) {
        throw new SponsorRefusal("only calls to the QuietStay rights contract are sponsored");
      }
      for (const a of c.args()) {
        if (addressesIn(a).includes(feeAccount)) throw new SponsorRefusal("the fee account appears in an argument");
      }
      kind = "call";
      break;
    }
    case "hostFunctionTypeCreateContractV2": {
      const args = func.createContractV2();
      if (!isWalletCreation(args)) throw new SponsorRefusal("only smart wallets of the pinned account WASM are created");
      for (const a of args.constructorArgs()) {
        if (addressesIn(a).includes(feeAccount)) throw new SponsorRefusal("the fee account appears in the wallet's constructor");
      }
      kind = "wallet-deployment";
      wallet = createdContractId(args.contractIdPreimage());
      break;
    }
    default:
      throw new SponsorRefusal(`a host function of kind ${func.switch().name} is not sponsored`);
  }

  for (const entry of auth) {
    const cred = entry.credentials();
    if (cred.switch().name !== "sorobanCredentialsAddress") {
      // Source-account credentials would make the fee account authorize the call.
      throw new SponsorRefusal("an authorization would be signed by the fee account itself");
    }
    const who = Address.fromScAddress(cred.address().address()).toString();
    if (who === feeAccount) throw new SponsorRefusal("the fee account is asked to authorize something");
    if (kind === "call" && who.startsWith("C")) wallet ??= who;
    checkInvocation(entry.rootInvocation(), feeAccount);
  }
  return { kind, func, auth, wallet };
}

/** Refuse to run if the fee key could be anything but a fee key. */
export function assertFeeKeyIsolated(feeAccount: string, others: { issuer: string; signingKey: string; holders: string[] }): void {
  if (feeAccount === others.issuer) throw new SponsorRefusal("the fee account is the issuer; refusing to run", 503);
  if (feeAccount === others.signingKey) throw new SponsorRefusal("the fee account is the sign-in key; refusing to run", 503);
  if (others.holders.includes(feeAccount)) throw new SponsorRefusal("the fee account holds a right; refusing to run", 503);
}
