/**
 * Balances and top-ups for the Wallet screen (2026-11-27), in the browser,
 * straight through the public RPC.
 *
 * Both USDC and XLM are read through their Stellar Asset Contracts, which
 * hold a balance for a `G…` account (USDC needs its trustline) and for a
 * `C…` passkey wallet alike. A top-up is a plain SAC `transfer` from a
 * regular wallet the user connects for that one transfer (Freighter): its own
 * account is the source, so it signs and pays the fee itself. Nothing goes
 * through this app's server, and no QuietStay key is involved.
 */

import { Account, Address, Asset, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";

import { IS_MAINNET, NETWORK_PASSPHRASE, RPC_URL, USDC_CONTRACT_ID } from "./config";

export type TokenName = "USDC" | "XLM";

/** The SAC of each token on this network. */
export function tokenContract(token: TokenName): string {
  return token === "USDC" ? USDC_CONTRACT_ID : Asset.native().contractId(NETWORK_PASSPHRASE);
}

/** Both tokens use 7 decimals on Stellar. */
export const TOKEN_DECIMALS = 7;

/**
 * Pilot limits on mainnet (docs/PHASE3_PROMPT.md): no single payment above
 * 1 USDC, and no more than 5 USDC held across the pilot accounts. A top-up is
 * a payment too, so the screen keeps to both.
 */
export const MAINNET_MAX_USDC_TOPUP = 10_000_000n;
export const MAINNET_MAX_USDC_HELD = 50_000_000n;

const server = () => new rpc.Server(RPC_URL);

/** A token balance in base units, or `null` when it has none (a `G…` without the USDC trustline). */
export async function readTokenBalance(token: TokenName, holder: string): Promise<bigint | null> {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(tokenContract(token)).call("balance", new Address(holder).toScVal()))
    .setTimeout(60)
    .build();
  const sim = await server().simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
  return BigInt(scValToNative(sim.result.retval) as bigint | number | string);
}

/** Why a top-up may not be sent, or `null`. */
export function topUpProblem(token: TokenName, amount: bigint, currentBalance: bigint | null): string | null {
  if (amount <= 0n) return "the amount must be above zero";
  if (IS_MAINNET && token === "USDC") {
    if (amount > MAINNET_MAX_USDC_TOPUP) return "the pilot allows at most 1 USDC in one payment";
    if ((currentBalance ?? 0n) + amount > MAINNET_MAX_USDC_HELD) return "the pilot allows at most 5 USDC held in all";
  }
  return null;
}

/** The unsigned, simulated `transfer` from `from` (a `G…` the user signs with) to `to`. */
export async function buildTopUp(token: TokenName, from: string, to: string, amount: bigint): Promise<string> {
  const s = server();
  const account = await s.getAccount(from);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(tokenContract(token)).call(
        "transfer",
        new Address(from).toScVal(),
        new Address(to).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ),
    )
    .setTimeout(300)
    .build();
  const prepared = await s.prepareTransaction(tx);
  return prepared.toXDR();
}

/** Send a signed envelope and wait for it. Returns the hash; throws if it did not succeed. */
export async function sendSigned(signedXdr: string): Promise<string> {
  const s = server();
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const sent = await s.sendTransaction(tx);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new Error(`the network did not take it (${sent.status})`);
  }
  const done = await s.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`the transfer ended ${done.status} (${sent.hash})`);
  return sent.hash;
}
