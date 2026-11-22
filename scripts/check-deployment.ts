/**
 * Read-only check of a fresh deployment: the rights contract, the SEP-45
 * web-auth contract and QuietStay's own WebAuthn verifier instance
 * (docs/MAINNET_REHEARSAL.md Part 5; Step 6 on mainnet). Nothing is signed or
 * sent; views are simulated with a public key as source.
 *
 *   npx tsx scripts/check-deployment.ts --network testnet|mainnet \
 *     --rights C… --web-auth C… --verifier C… --issuer G… --arbiter G… [--max-payment 10000000]
 *
 * It checks:
 *   - each instance runs its pinned WASM: rights 76d69e79…, web-auth 708cacdc…,
 *     verifier e63a030d…;
 *   - the rights contract's issuer(), arbiter(), usdc() and max_payment() are
 *     the expected ones (usdc: the network's Circle USDC; max_payment: 1 USDC
 *     unless given);
 *   - its verification key equals the committed key (scripts/check-vk.ts);
 *   - the web-auth contract can never be upgraded (scripts/check-web-auth.ts);
 *   - every code entry and instance is live (scripts/check-ttl.ts).
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { Account, Address, Contract, rpc, scValToNative, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

const NETS = {
  testnet: { rpc: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015", usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" },
  mainnet: { rpc: "https://mainnet.sorobanrpc.com", passphrase: "Public Global Stellar Network ; September 2015", usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" },
} as const;
const WASM = {
  rights: "76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde",
  verifier: "e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76",
};

let failed = 0;
const check = (ok: boolean, line: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${line}`);
  if (!ok) failed++;
};

async function main() {
  const { values: a } = parseArgs({
    options: {
      network: { type: "string" },
      rights: { type: "string" },
      "web-auth": { type: "string" },
      verifier: { type: "string" },
      issuer: { type: "string" },
      arbiter: { type: "string" },
      "max-payment": { type: "string", default: "10000000" },
    },
  });
  const name = a.network as keyof typeof NETS;
  const net = NETS[name];
  if (!net) throw new Error("--network testnet|mainnet is required");
  for (const k of ["rights", "web-auth", "verifier"] as const) if (!StrKey.isValidContract(a[k] ?? "")) throw new Error(`--${k} <C…> is required`);
  for (const k of ["issuer", "arbiter"] as const) if (!StrKey.isValidEd25519PublicKey(a[k] ?? "")) throw new Error(`--${k} <G…> is required`);
  const server = new rpc.Server(net.rpc);
  if ((await server.getNetwork()).passphrase !== net.passphrase) throw new Error("unexpected network passphrase");
  console.log(`check-deployment on ${name}, ${new Date().toISOString()} (read only; nothing signed or sent)`);

  const instanceWasm = async (id: string): Promise<string> => {
    const res = await server.getLedgerEntries(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({ contract: new Address(id).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }),
      ),
    );
    const e = res.entries[0];
    if (!e) return "(no instance)";
    const exe = e.val.contractData().val().instance().executable();
    return exe.switch().name === "contractExecutableWasm" ? Buffer.from(exe.wasmHash()).toString("hex") : exe.switch().name;
  };
  const view = async (fn: string): Promise<unknown> => {
    const tx = new TransactionBuilder(new Account(a.issuer!, "0"), { fee: "100", networkPassphrase: net.passphrase })
      .addOperation(new Contract(a.rights!).call(fn))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result) throw new Error(`${fn}() could not be read`);
    return scValToNative(sim.result.retval);
  };

  const rw = await instanceWasm(a.rights!);
  check(rw === WASM.rights, `rights ${a.rights} runs ${rw}`);
  const vw = await instanceWasm(a.verifier!);
  check(vw === WASM.verifier, `verifier ${a.verifier} runs ${vw} (OZ WebAuthn verifier, our own instance)`);
  const issuer = String(await view("issuer"));
  check(issuer === a.issuer, `issuer() = ${issuer}`);
  const arbiter = String(await view("arbiter"));
  check(arbiter === a.arbiter && arbiter !== issuer, `arbiter() = ${arbiter} (not the issuer)`);
  const usdc = String(await view("usdc"));
  check(usdc === net.usdc, `usdc() = ${usdc} (${name}'s Circle USDC)`);
  const maxPayment = BigInt(await view("max_payment") as bigint);
  check(maxPayment === BigInt(a["max-payment"]!), `max_payment() = ${maxPayment} (expected ${a["max-payment"]})`);

  const sub = (label: string, args: string[]) => {
    console.log(`\n${label}: npx tsx ${args.join(" ")}`);
    try {
      execFileSync("npx", ["tsx", ...args], { stdio: ["ignore", "inherit", "inherit"] });
      check(true, label);
    } catch {
      check(false, label);
    }
  };
  sub("verification key", ["scripts/check-vk.ts", "--network", name, "--contract", a.rights!]);
  sub("web-auth cannot be upgraded", ["scripts/check-web-auth.ts", "--network", name, "--id", a["web-auth"]!]);
  sub("every entry live", ["scripts/check-ttl.ts", "--network", name, "--rights", a.rights!, "--web-auth", a["web-auth"]!, "--verifier", a.verifier!]);

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
