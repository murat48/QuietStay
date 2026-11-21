/**
 * Review an unsigned envelope before the CLI signs it (docs/PHASE3_SPEC.md §13).
 * Called by scripts/mainnet-sign-submit.sh; usable on its own.
 *
 *   npx tsx scripts/tx-review.ts --xdr-file <file> --network mainnet|testnet --source <G…>
 *
 * It prints, in plain words: the source, the fee, the time bounds, each
 * operation (the contract, the function and every argument), and every
 * authorization entry, with its address, the call it authorizes and the
 * ledger its signature expires at. It then re-simulates against the network
 * and prints the resource fee and resources.
 *
 * It exits non-zero, which makes the shell script refuse, when:
 *
 * - the envelope's source is not `--source` (the fee identity named on the
 *   command line);
 * - the envelope is not for `--network`'s passphrase;
 * - any authorization entry's signature expires within the next 60 ledgers;
 * - on mainnet, any i128 argument anywhere in the call tree exceeds the D7
 *   cap of 1 USDC (10,000,000 in USDC's 7-decimal units). On testnet the cap
 *   is 100 USDC (D7);
 * - the simulation fails;
 * - any call, at the top level or anywhere in an authorization tree, is the
 *   network's USDC `transfer` to the rights contract (spec §14: pilot funds
 *   are never sent to the contract directly; USDC sent there that way is
 *   stuck forever, DESIGN.md known limitation 17). The rights contract id
 *   comes from `QS_RIGHTS_CONTRACT`; on mainnet the review refuses without it.
 *
 * It reads no key and signs nothing.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Address, FeeBumpTransaction, rpc, scValToNative, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

const NETWORKS = {
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    rpc: process.env.STELLAR_MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com",
    cap: 10_000_000n,
    // Circle's mainnet USDC SAC (docs/PHASE3_PROGRESS.md, Addresses).
    usdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  },
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    rpc: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    cap: 1_000_000_000n,
    usdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
} as const;

const MIN_AUTH_LEDGERS = 60;

let refusals = 0;
const RIGHTS = process.env.QS_RIGHTS_CONTRACT ?? "";
const refuse = (why: string) => {
  console.log(`  REFUSE: ${why}`);
  refusals++;
};

/** A native value with bytes as 0x-hex and big integers as decimal strings. */
function plain(x: unknown): unknown {
  if (typeof x === "bigint") return x.toString();
  if (x instanceof Uint8Array) return `0x${Buffer.from(x).toString("hex")}`;
  if (Array.isArray(x)) return x.map(plain);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
}

function show(v: xdr.ScVal): string {
  try {
    return JSON.stringify(plain(scValToNative(v)));
  } catch {
    return v.toXDR("base64");
  }
}

/** Every i128 in a value, depth first. */
function i128s(v: xdr.ScVal, out: bigint[] = []): bigint[] {
  switch (v.switch().name) {
    case "scvI128":
      out.push(BigInt(scValToNative(v) as bigint));
      break;
    case "scvVec":
      for (const x of v.vec() ?? []) i128s(x, out);
      break;
    case "scvMap":
      for (const e of v.map() ?? []) {
        i128s(e.key(), out);
        i128s(e.val(), out);
      }
      break;
  }
  return out;
}

/** A USDC `transfer(from, to, amount)` whose `to` is the rights contract. */
function isTransferToRights(contract: string, fn: string, args: xdr.ScVal[], usdc: string): boolean {
  if (contract !== usdc || fn !== "transfer" || !RIGHTS || args.length < 2) return false;
  try {
    return Address.fromScVal(args[1]!).toString() === RIGHTS;
  } catch {
    return false;
  }
}

function describeInvocation(inv: xdr.SorobanAuthorizedInvocation, depth: number, cap: bigint, usdc: string) {
  const pad = "    ".repeat(depth);
  const f = inv.function();
  if (f.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
    const c = f.contractFn();
    const args = c.args();
    console.log(`${pad}${Address.fromScAddress(c.contractAddress()).toString()} ${c.functionName().toString()}(${args.map(show).join(", ")})`);
    for (const a of args) for (const amount of i128s(a)) if (amount > cap) refuse(`an amount of ${amount} exceeds the cap of ${cap}`);
    if (isTransferToRights(Address.fromScAddress(c.contractAddress()).toString(), c.functionName().toString(), args, usdc)) {
      refuse("a USDC transfer straight to the rights contract: it would be stuck there forever (DESIGN.md limitation 17)");
    }
  } else {
    console.log(`${pad}${f.switch().name}`);
  }
  for (const sub of inv.subInvocations()) describeInvocation(sub, depth + 1, cap, usdc);
}

async function main() {
  const { values: a } = parseArgs({
    options: { "xdr-file": { type: "string" }, network: { type: "string" }, source: { type: "string" } },
  });
  const net = NETWORKS[a.network as keyof typeof NETWORKS];
  if (!net) throw new Error("--network must be mainnet or testnet");
  if (!a["xdr-file"] || !a.source) throw new Error("--xdr-file and --source are required");
  const text = readFileSync(a["xdr-file"], "utf8").trim();

  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(text, net.passphrase);
    if (parsed instanceof FeeBumpTransaction) throw new Error("fee-bump envelopes are not handled here");
    tx = parsed;
  } catch (e) {
    throw new Error(`not a ${a.network} transaction envelope: ${(e as Error).message}`);
  }
  if (a.network === "mainnet" && !RIGHTS) refuse("QS_RIGHTS_CONTRACT is not set: the review cannot check for a USDC transfer to the rights contract");
  if (RIGHTS) console.log(`Rights       ${RIGHTS} (QS_RIGHTS_CONTRACT)`);
  const server = new rpc.Server(net.rpc);
  const latest = (await server.getLatestLedger()).sequence;

  console.log(`Network      ${a.network} (${net.passphrase})`);
  console.log(`Source       ${tx.source}${tx.source === a.source ? "" : "   ← NOT the identity given"}`);
  if (tx.source !== a.source) refuse(`the source is ${tx.source}, not ${a.source}`);
  console.log(`Fee          ${tx.fee} stroops (declared, including resources)`);
  console.log(`Sequence     ${tx.sequence}`);
  if (tx.timeBounds) {
    const max = Number(tx.timeBounds.maxTime);
    console.log(`Valid until  ${max ? new Date(max * 1000).toISOString() : "no limit"}`);
    if (max && max < Date.now() / 1000 + 60) refuse("the envelope's time bound has passed, or passes within a minute: rebuild it");
  }
  console.log(`Latest ledger ${latest}`);

  tx.operations.forEach((op, i) => {
    console.log(`Operation ${i + 1}: ${op.type}`);
    if (op.type !== "invokeHostFunction") return;
    const fn = op.func;
    if (fn.switch().name === "hostFunctionTypeInvokeContract") {
      const c = fn.invokeContract();
      console.log(`  contract   ${Address.fromScAddress(c.contractAddress()).toString()}`);
      console.log(`  function   ${c.functionName().toString()}`);
      c.args().forEach((arg, j) => {
        console.log(`  arg ${j}      ${show(arg).slice(0, 400)}`);
        for (const amount of i128s(arg)) if (amount > net.cap) refuse(`an amount of ${amount} exceeds the cap of ${net.cap}`);
      });
      if (isTransferToRights(Address.fromScAddress(c.contractAddress()).toString(), c.functionName().toString(), c.args(), net.usdc)) {
        refuse("a USDC transfer straight to the rights contract: it would be stuck there forever (DESIGN.md limitation 17)");
      }
    } else {
      console.log(`  ${fn.switch().name}`);
    }
    for (const entry of op.auth ?? []) {
      const cred = entry.credentials();
      if (cred.switch().name === "sorobanCredentialsAddress") {
        const ac = cred.address();
        const who = Address.fromScAddress(ac.address()).toString();
        const until = ac.signatureExpirationLedger();
        console.log(`  auth       ${who}, signature valid through ledger ${until} (${until - latest} from now)`);
        if (until < latest + MIN_AUTH_LEDGERS) refuse(`${who}'s signature expires within ${MIN_AUTH_LEDGERS} ledgers`);
        if (who === a.source) refuse("the fee identity appears as an authorizing address");
      } else {
        console.log("  auth       the source account's own signature");
      }
      describeInvocation(entry.rootInvocation(), 1, net.cap, net.usdc);
    }
  });

  console.log("Re-simulating with the signed authorization entries in place…");
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    refuse(`the simulation fails: ${sim.error}`);
  } else {
    const ok = sim as rpc.Api.SimulateTransactionSuccessResponse;
    const res = ok.transactionData.build().resources();
    console.log(`  resource fee ${ok.minResourceFee} stroops`);
    console.log(`  instructions ${res.instructions()}, read ${res.diskReadBytes()} bytes, write ${res.writeBytes()} bytes`);
    const ext = tx.toEnvelope().v1().tx().ext();
    if (ext.switch() !== 1) {
      refuse("the envelope declares no resources (it was never simulated and assembled)");
    } else {
      const declared = ext.sorobanData();
      const declaredFee = BigInt(declared.resourceFee().toString());
      const declaredInstructions = declared.resources().instructions();
      console.log(`  declared     resource fee ${declaredFee} stroops, ${declaredInstructions} instructions`);
      if (declaredFee < BigInt(ok.minResourceFee)) refuse(`the declared resource fee ${declaredFee} is below the ${ok.minResourceFee} needed now`);
      if (declaredInstructions < res.instructions()) refuse(`the declared ${declaredInstructions} instructions are fewer than the ${res.instructions()} needed now`);
    }
  }

  if (refusals > 0) {
    console.log(`\n${refusals} reason(s) to refuse. Nothing was signed.`);
    process.exit(2);
  }
  console.log("\nNo reason to refuse.");
}

main().catch((e) => {
  console.error(`tx-review: ${(e as Error).message}`);
  process.exit(1);
});
