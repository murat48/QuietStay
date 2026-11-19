/**
 * Check the deployed SEP-45 web-auth contract can never be upgraded.
 *
 *   npx tsx scripts/check-web-auth.ts --network testnet|mainnet [--id <C…>]
 *
 * Prints and checks, from the chain:
 *   1. the contract's WASM hash equals the pinned build (708cacdc…);
 *   2. its stored `Admin` is the unauthorizable address, the contract id
 *      SHA-256("QuietStay SEP-45 web-auth: no admin");
 *   3. no contract instance exists at that address.
 * Exits non-zero if any check fails. Part of the pre-launch checklist, on
 * both networks.
 */

import { parseArgs } from "node:util";
import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { noAdminAddress, WEB_AUTH_WASM_SHA256 } from "./deploy-web-auth";

const NETWORKS = {
  testnet: { rpc: "https://soroban-testnet.stellar.org", id: "CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM" },
  mainnet: { rpc: process.env.STELLAR_MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com", id: "" },
} as const;

const instanceKey = (c: string) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(c).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

async function main() {
  const { values: a } = parseArgs({ options: { network: { type: "string" }, id: { type: "string" } } });
  const net = NETWORKS[a.network as keyof typeof NETWORKS];
  if (!net) throw new Error("--network testnet|mainnet is required");
  const id = a.id ?? net.id;
  if (!id) throw new Error("--id <C…> is required on mainnet until it is deployed");
  const server = new rpc.Server(net.rpc);
  const admin = noAdminAddress();
  let failed = 0;
  const report = (ok: boolean, msg: string) => {
    console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
    if (!ok) failed++;
  };

  console.log(`${a.network} web-auth contract ${id} (${new Date().toISOString()})`);
  const { entries } = await server.getLedgerEntries(instanceKey(id), instanceKey(admin));
  const own = entries.find((e) => Address.fromScAddress(e.val.contractData().contract()).toString() === id);
  const atAdmin = entries.find((e) => Address.fromScAddress(e.val.contractData().contract()).toString() === admin);
  if (!own) throw new Error("the web-auth contract has no instance on this network");
  const instance = own.val.contractData().val().instance();
  const wasm = Buffer.from(instance.executable().wasmHash()).toString("hex");
  report(wasm === WEB_AUTH_WASM_SHA256, `WASM ${wasm} ${wasm === WEB_AUTH_WASM_SHA256 ? "=" : "≠"} the pinned build`);
  const stored = (instance.storage() ?? []).find((m) => JSON.stringify(scValToNative(m.key())) === '["Admin"]');
  const storedAdmin = stored ? String(scValToNative(stored.val())) : "(none)";
  report(storedAdmin === admin, `stored Admin ${storedAdmin} ${storedAdmin === admin ? "=" : "≠"} the unauthorizable ${admin}`);
  report(!atAdmin, `no contract instance at ${admin}`);
  console.log(failed === 0 ? "upgrade() can never be authorized." : `${failed} check(s) FAILED.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
