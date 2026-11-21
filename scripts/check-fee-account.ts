/**
 * The testnet fee account has no other role (docs/PHASE3_SPEC.md §13, D6),
 * checked on chain. Read-only.
 *
 *   npx tsx scripts/check-fee-account.ts --contract <C…> [--fee <G…>]
 *
 * Passes when the fee account (default: FEE_ACCOUNT in src/lib/config.ts,
 * `qs-fee-testnet`):
 *   - holds no USDC: no USDC trustline, or a zero balance (Horizon);
 *   - holds no right on the contract: `balance(fee)` is 0, and it is neither
 *     the title holder nor the current holder of any right 1..next_id;
 *   - is not the contract's issuer or arbiter, nor the testnet sign-in key
 *     (`qs-sep10-server`, read with `stellar keys public-key`).
 * The route is testnet-only; there is no fee account on mainnet.
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { Account, Address, nativeToScVal, Operation, rpc, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

import { FEE_ACCOUNT, HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL, USDC_ISSUER } from "../src/lib/config";
import { RetryingServer } from "../src/lib/rpc-server";

if (NETWORK_PASSPHRASE !== "Test SDF Network ; September 2015") throw new Error("testnet only");
const server = new RetryingServer(RPC_URL);

async function view(contract: string, fn: string, args: xdr.ScVal[], source: string): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(source, "0"), { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return undefined;
  return scValToNative(sim.result.retval);
}

async function main() {
  const { values: a } = parseArgs({ options: { contract: { type: "string" }, fee: { type: "string", default: FEE_ACCOUNT } } });
  const C = a.contract ?? "";
  if (!/^C[A-Z2-7]{55}$/.test(C)) throw new Error("--contract <C…> is required");
  const fee = a.fee!;
  let failed = 0;
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? "✓" : "✗"} ${what}`);
    if (!ok) failed++;
  };
  console.log(`fee account ${fee}, contract ${C} (${new Date().toISOString()})`);

  const acct = (await (await fetch(`${HORIZON_URL}/accounts/${fee}`)).json()) as { balances?: { asset_code?: string; asset_issuer?: string; balance: string }[] };
  const usdc = (acct.balances ?? []).find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
  check(!usdc || Number(usdc.balance) === 0, usdc ? `USDC trustline with balance ${usdc.balance}` : "no USDC trustline, so it holds no USDC");

  const titles = BigInt((await view(C, "balance", [new Address(fee).toScVal()], fee)) as bigint);
  check(titles === 0n, `title count on the contract: ${titles}`);
  const next = Number(await view(C, "next_id", [], fee));
  let held = 0;
  for (let id = 1; id < next; id++) {
    const right = (await view(C, "get_right", [nativeToScVal(BigInt(id), { type: "u64" })], fee)) as { holder?: string } | undefined;
    const holding = (await view(C, "holding", [nativeToScVal(BigInt(id), { type: "u64" })], fee)) as { holder?: string } | undefined;
    if (right?.holder === fee || holding?.holder === fee) held++;
  }
  check(held === 0, `holds none of rights 1..${next - 1} (title or current holder)`);

  const issuer = (await view(C, "issuer", [], fee)) as string;
  const arbiter = (await view(C, "arbiter", [], fee)) as string;
  const sep10 = execFileSync("stellar", ["keys", "public-key", "qs-sep10-server"], { encoding: "utf8" }).trim();
  check(fee !== issuer, `not the issuer (${issuer})`);
  check(fee !== arbiter, `not the arbiter (${arbiter})`);
  check(fee !== sep10, `not the sign-in key qs-sep10-server (${sep10})`);

  if (failed) {
    console.log(`FAIL: ${failed} check(s)`);
    process.exit(1);
  }
  console.log("PASS: the fee account has no other role");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
