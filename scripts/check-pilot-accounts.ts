/**
 * The pilot's accounts, checked on chain before every mainnet transaction
 * (D7 and docs/PHASE3_SPEC.md §14). Read-only.
 *
 *   npx tsx scripts/check-pilot-accounts.ts --network mainnet \
 *     --accounts G…,G…,C… [--contract <rights C…>] [--max-total 50000000]
 *
 * For each account: a G account must have a USDC trustline to Circle's issuer
 * for that network (the token refuses to credit a G account without one; a C
 * account needs none), and its USDC balance is read. The rights contract's
 * own USDC (Funded and Disputed escrows) is added when `--contract` is given.
 * It fails when any G account lacks the trustline, or when the total exceeds
 * `--max-total` in USDC's 7-decimal units: 50,000,000 (5 USDC) by default,
 * the pilot limit on mainnet. Testnet has no total limit; pass a large
 * `--max-total` there to rehearse.
 *
 * Amounts are bigint throughout; nothing is rounded.
 */

import { parseArgs } from "node:util";

import { Account, Address, Operation, rpc, scValToNative, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

const NETWORKS = {
  testnet: {
    rpc: "https://soroban-testnet.stellar.org",
    horizon: "https://horizon-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
  mainnet: {
    rpc: process.env.STELLAR_MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com",
    horizon: "https://horizon.stellar.org",
    passphrase: "Public Global Stellar Network ; September 2015",
    usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
} as const;

/** "12.3456789" → 123456789n, exactly (Horizon prints 7 decimals). */
function units(s: string): bigint {
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
}
const usdc = (u: bigint) => `${u / 10_000_000n}.${(u % 10_000_000n).toString().padStart(7, "0")}`;

async function main() {
  const { values: a } = parseArgs({
    options: {
      network: { type: "string" },
      accounts: { type: "string" },
      contract: { type: "string" },
      "max-total": { type: "string", default: "50000000" },
    },
  });
  const net = NETWORKS[a.network as keyof typeof NETWORKS];
  if (!net) throw new Error("--network testnet|mainnet is required");
  const accounts = (a.accounts ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (accounts.length === 0) throw new Error("--accounts G…,C…,… is required");
  const max = BigInt(a["max-total"]!);
  const server = new rpc.Server(net.rpc);
  if ((await server.getNetwork()).passphrase !== net.passphrase) throw new Error("unexpected network passphrase");

  const sacBalance = async (holder: string): Promise<bigint> => {
    const tx = new TransactionBuilder(new Account(accounts.find((x) => x.startsWith("G")) ?? net.issuer, "0"), { fee: "100", networkPassphrase: net.passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: net.usdc, function: "balance", args: [new Address(holder).toScVal()] }))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`balance(${holder}) could not be read`);
    return BigInt(scValToNative(sim.result.retval) as bigint);
  };

  let failed = 0;
  let total = 0n;
  console.log(`${a.network}, USDC ${net.usdc} (issuer ${net.issuer}), ${new Date().toISOString()}`);
  for (const acct of accounts) {
    if (StrKey.isValidEd25519PublicKey(acct)) {
      const res = await fetch(`${net.horizon}/accounts/${acct}`);
      if (res.status === 404) {
        console.log(`  ✗ ${acct}: no such account on ${a.network}`);
        failed++;
        continue;
      }
      const body = (await res.json()) as { balances: { asset_code?: string; asset_issuer?: string; balance: string }[] };
      const line = body.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === net.issuer);
      if (!line) {
        console.log(`  ✗ ${acct}: no USDC trustline (it could not be paid)`);
        failed++;
        continue;
      }
      const b = units(line.balance);
      total += b;
      console.log(`  ✓ ${acct}: USDC trustline, balance ${usdc(b)}`);
    } else if (StrKey.isValidContract(acct)) {
      const b = await sacBalance(acct);
      total += b;
      console.log(`  ✓ ${acct}: contract account (no trustline needed), balance ${usdc(b)}`);
    } else {
      throw new Error(`not an account address: ${acct}`);
    }
  }
  if (a.contract) {
    const b = await sacBalance(a.contract);
    total += b;
    console.log(`  · rights contract ${a.contract}: ${usdc(b)} USDC held in escrow`);
  }
  const ok = total <= max;
  console.log(`  ${ok ? "✓" : "✗"} total ${usdc(total)} USDC (${total} units), limit ${usdc(max)} (${max})`);
  if (!ok) failed++;
  if (failed) {
    console.log(`FAIL: ${failed} check(s)`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
