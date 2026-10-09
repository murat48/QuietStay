/**
 * Submit a proof-authorized transfer, signing every authorization it needs.
 *
 *   npm run zk:submit -- <contract id> <proof dir> [--send=no]
 *
 * <proof dir> is a `npm run zk:prove` output. The transaction calls
 * `transfer(from, to, right_id, expires_at, proof, public_signals)` with the
 * holder as source account. The RPC's simulation reports which signatures the
 * contract demands — the holder's, and on a sale the buyer's over
 * (right_id, h') — and each is signed with the matching key from .env.local
 * (QUIETSTAY_ISSUER_SECRET, DEMO_OWNER_SECRET, DEMO_RENTER_SECRET,
 * DEMO_BUYER_SECRET). Keys are matched by public key and never printed.
 *
 * Prints the simulated cost (CPU instructions, ledger bytes, minimum resource
 * fee), then — unless --send=no — submits and prints the fee actually charged
 * and the explorer link.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Address,
  authorizeEntry,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { explorer, NETWORK_PASSPHRASE } from "../../src/lib/config";
import { server } from "../../src/lib/contract";
import { fatal, loadEnv, log, requireArg } from "../lib/cli";

const USAGE = "npm run zk:submit -- <contract id> <proof dir> [--send=no]";

interface TransferFile {
  transfer: {
    right_id: string;
    from: string;
    to: string;
    expires_at: string | null;
    expiry_ledger: string;
    next_secret_hash: string;
  };
  proof: { a: string; b: string; c: string };
}

/** Every key .env.local holds, by public key. */
function signers(): Map<string, Keypair> {
  const map = new Map<string, Keypair>();
  for (const name of ["QUIETSTAY_ISSUER_SECRET", "DEMO_OWNER_SECRET", "DEMO_RENTER_SECRET", "DEMO_BUYER_SECRET"]) {
    const secret = process.env[name];
    if (secret) {
      const kp = Keypair.fromSecret(secret);
      map.set(kp.publicKey(), kp);
    }
  }
  return map;
}

const bytes = (hex: string) => nativeToScVal(Buffer.from(hex, "hex"));

export function transferArgs(t: TransferFile, signals: string[]): xdr.ScVal[] {
  const proof = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("a"), val: bytes(t.proof.a) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("b"), val: bytes(t.proof.b) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("c"), val: bytes(t.proof.c) }),
  ]);
  return [
    new Address(t.transfer.from).toScVal(),
    new Address(t.transfer.to).toScVal(),
    nativeToScVal(BigInt(t.transfer.right_id), { type: "u64" }),
    t.transfer.expires_at === null
      ? xdr.ScVal.scvVoid()
      : nativeToScVal(BigInt(t.transfer.expires_at), { type: "u64" }),
    proof,
    xdr.ScVal.scvVec(signals.map((s) => nativeToScVal(BigInt(s), { type: "u256" }))),
  ];
}

async function main() {
  loadEnv();
  const contractId = requireArg(0, USAGE);
  const dir = requireArg(1, USAGE);
  const send = !process.argv.includes("--send=no");

  const t = JSON.parse(readFileSync(join(dir, "transfer.json"), "utf8")) as TransferFile;
  const signals = JSON.parse(readFileSync(join(dir, "public.json"), "utf8")) as string[];
  const keys = signers();
  const holder = keys.get(t.transfer.from);
  if (!holder) throw new Error(`no key in .env.local for the holder ${t.transfer.from}`);

  const account = await server.getAccount(holder.publicKey());
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call("transfer", ...transferArgs(t, signals)))
    .setTimeout(120)
    .build();

  const kind = t.transfer.expires_at === null ? "sale" : `rental until ${t.transfer.expires_at}`;
  log.step(`Simulating a ${kind} of right #${t.transfer.right_id} on ${contractId}`);
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  const res = sim.transactionData.build().resources();
  log.info(`cpu instructions       ${res.instructions()}`);
  log.info(`ledger bytes read      ${res.diskReadBytes()}`);
  log.info(`ledger bytes written   ${res.writeBytes()}`);
  log.info(`min resource fee       ${sim.minResourceFee} stroops`);
  log.info(`latest ledger          ${sim.latestLedger}`);

  // Sign each authorization the contract asked for that the source account's
  // own signature does not already cover.
  const validUntil = sim.latestLedger + 100;
  const auth = await Promise.all(
    (sim.result?.auth ?? []).map(async (entry) => {
      if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return entry;
      const who = Address.fromScAddress(entry.credentials().address().address()).toString();
      const kp = keys.get(who);
      if (!kp) throw new Error(`the contract wants a signature from ${who}, and .env.local has no key for it`);
      log.info(`signature required     ${who}`);
      return authorizeEntry(entry, kp, validUntil, NETWORK_PASSPHRASE);
    }),
  );
  log.info(`signature required     ${holder.publicKey()} (source account)`);

  if (!send) process.exit(0);

  // Re-simulate with the signed entries so the footprint and fee account for
  // signature verification, then submit.
  const func = new Contract(contractId)
    .call("transfer", ...transferArgs(t, signals))
    .body()
    .invokeHostFunctionOp()
    .hostFunction();
  const withAuth = new TransactionBuilder(await server.getAccount(holder.publicKey()), {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(120)
    .build();
  const sim2 = await server.simulateTransaction(withAuth);
  if (rpc.Api.isSimulationError(sim2)) throw new Error(`simulation with signatures failed: ${sim2.error}`);
  const res2 = sim2.transactionData.build().resources();
  log.info(`cpu, with signatures   ${res2.instructions()}  (min resource fee ${sim2.minResourceFee})`);

  const prepared = rpc.assembleTransaction(withAuth, sim2).build();
  prepared.sign(holder);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== "SUCCESS") throw new Error(`transaction ${sent.hash} ended ${done.status}`);
  const charged = done.resultXdr.feeCharged().toString();
  log.ok(`submitted in ledger ${done.ledger}`);
  log.info(`fee charged            ${charged} stroops (${Number(charged) / 1e7} XLM)`);
  log.link("transaction", explorer.tx(sent.hash));
  console.log(sent.hash);
  process.exit(0);
}

main().catch(fatal);
