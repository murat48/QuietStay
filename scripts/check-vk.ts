/**
 * Step 5 checklist, "Configuration": the verification key a deployed rights
 * contract holds, read from its instance storage, compared with the committed
 * key, and its hash.
 *
 *   npx tsx scripts/check-vk.ts --network testnet|mainnet --contract <C…>
 *
 * Read-only (`getLedgerEntries` of the contract instance). The hash is
 * SHA-256 over the key's bytes in constructor order: alpha ‖ beta ‖ gamma ‖
 * delta ‖ ic[0] ‖ … ‖ ic[n-1], the same bytes as
 * circuits/keys/verification_key.soroban.json (which `npm run zk:encode-vk`
 * derives from circuits/keys/verification_key.json, pinned in
 * circuits/keys/SHA256SUMS). The hash must be identical on both networks.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const NETWORKS = {
  testnet: { rpc: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
  mainnet: { rpc: "https://mainnet.sorobanrpc.com", passphrase: "Public Global Stellar Network ; September 2015" },
} as const;

type Vk = { alpha: string; beta: string; gamma: string; delta: string; ic: string[] };
const vkBytes = (v: Vk) => Buffer.concat([v.alpha, v.beta, v.gamma, v.delta, ...v.ic].map((h) => Buffer.from(h, "hex")));

async function main() {
  const { values: a } = parseArgs({ options: { network: { type: "string", default: "testnet" }, contract: { type: "string" } } });
  const net = NETWORKS[a.network as keyof typeof NETWORKS];
  if (!net) throw new Error("--network testnet|mainnet");
  if (!a.contract || !/^C[A-Z2-7]{55}$/.test(a.contract)) throw new Error("--contract <C…> is required");
  const server = new rpc.Server(net.rpc);
  if ((await server.getNetwork()).passphrase !== net.passphrase) throw new Error("unexpected network passphrase");

  const committed = JSON.parse(readFileSync("circuits/keys/verification_key.soroban.json", "utf8")) as Vk;
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(a.contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const res = await server.getLedgerEntries(key);
  const entry = res.entries[0];
  if (!entry) throw new Error(`no instance for ${a.contract} on ${a.network}`);
  const storage = entry.val.contractData().val().instance().storage() ?? [];
  const found = storage.find((e) => {
    const k = e.key();
    return k.switch().name === "scvVec" && k.vec()?.[0]?.switch().name === "scvSymbol" && k.vec()![0]!.sym().toString() === "VerificationKey";
  });
  if (!found) throw new Error("no VerificationKey in the instance storage");
  const v = scValToNative(found.val()) as { alpha: Buffer; beta: Buffer; gamma: Buffer; delta: Buffer; ic: Buffer[] };
  const onChain: Vk = {
    alpha: Buffer.from(v.alpha).toString("hex"),
    beta: Buffer.from(v.beta).toString("hex"),
    gamma: Buffer.from(v.gamma).toString("hex"),
    delta: Buffer.from(v.delta).toString("hex"),
    ic: v.ic.map((x) => Buffer.from(x).toString("hex")),
  };
  const same =
    onChain.alpha === committed.alpha &&
    onChain.beta === committed.beta &&
    onChain.gamma === committed.gamma &&
    onChain.delta === committed.delta &&
    onChain.ic.length === committed.ic.length &&
    onChain.ic.every((x, i) => x === committed.ic[i]);
  const hash = (v: Vk) => createHash("sha256").update(vkBytes(v)).digest("hex");
  console.log(`network          ${a.network} (ledger ${res.latestLedger})`);
  console.log(`contract         ${a.contract}`);
  console.log(`on-chain VK hash ${hash(onChain)} (${vkBytes(onChain).length} bytes, ${onChain.ic.length} IC points)`);
  console.log(`committed VK     ${hash(committed)} (circuits/keys/verification_key.soroban.json)`);
  console.log(same ? "PASS: the on-chain key equals the committed key, field by field" : "FAIL: the on-chain key differs from the committed key");
  if (!same) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
