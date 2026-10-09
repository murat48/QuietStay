/**
 * Building, signing and submitting Phase 2 contract calls from the command line.
 *
 * Shared by `zk:submit`, `zk:reissue` and `zk:evidence`. One part of it —
 * {@link submitUnsimulated} — exists only to put *rejected* transactions on the
 * ledger as evidence, and is labelled as such where it is defined and where it
 * is used.
 */

import { randomBytes } from "node:crypto";
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
  type Transaction,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "../../src/lib/config";
import { server } from "../../src/lib/contract";

/** Every key .env.local holds, by public key. Never printed. */
export function envSigners(): Map<string, Keypair> {
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
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u64 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" });

/** A contracttype struct: a map with its field names in sorted order. */
export function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k]! })),
  );
}

export interface ProvenTransfer {
  from: string;
  to: string;
  rightId: bigint;
  /** null for a sale. */
  expiresAt: bigint | null;
  proof: { a: string; b: string; c: string };
  /** Public signals as decimal strings, in CIRCUIT.md §7 order. */
  signals: string[];
}

export function transferArgs(t: ProvenTransfer): xdr.ScVal[] {
  return [
    new Address(t.from).toScVal(),
    new Address(t.to).toScVal(),
    u64(t.rightId),
    t.expiresAt === null ? xdr.ScVal.scvVoid() : u64(t.expiresAt),
    struct({ a: bytes(t.proof.a), b: bytes(t.proof.b), c: bytes(t.proof.c) }),
    xdr.ScVal.scvVec(t.signals.map((s) => nativeToScVal(BigInt(s), { type: "u256" }))),
  ];
}

export function issueArgs(owner: string, period: { start: number; end: number }, validity: { from: number; until: number }, commitmentHex: string): xdr.ScVal[] {
  return [
    new Address(owner).toScVal(),
    struct({ start: u64(period.start), end: u64(period.end) }),
    struct({ from: u64(validity.from), until: u64(validity.until) }),
    bytes(commitmentHex),
  ];
}

/** An unsigned single-call transaction from `source`. */
export async function buildCall(
  source: string,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[] = [],
): Promise<Transaction> {
  const account = await server.getAccount(source);
  const func = new Contract(contractId).call(fn, ...args).body().invokeHostFunctionOp().hostFunction();
  return new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(180)
    .build();
}

export async function simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  return sim as rpc.Api.SimulateTransactionSuccessResponse;
}

/**
 * Sign each address-credential authorization entry with the matching key. Entries
 * covered by the source account's own signature pass through unchanged.
 */
export async function signAuth(
  entries: xdr.SorobanAuthorizationEntry[],
  keys: Map<string, Keypair>,
  validUntilLedger: number,
): Promise<xdr.SorobanAuthorizationEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return entry;
      const who = Address.fromScAddress(entry.credentials().address().address()).toString();
      const kp = keys.get(who);
      if (!kp) throw new Error(`a signature is required from ${who}, and .env.local has no key for it`);
      return authorizeEntry(entry, kp, validUntilLedger, NETWORK_PASSPHRASE);
    }),
  );
}

/** Who signed each authorization entry: address entries by address, others as "source". */
export function signersOf(entries: xdr.SorobanAuthorizationEntry[]): string[] {
  return entries.map((e) =>
    e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()
      ? Address.fromScAddress(e.credentials().address().address()).toString()
      : "source account",
  );
}

/**
 * An authorization entry for `signer` over a `transfer` call, built by hand rather
 * than requested by simulation — for an authorization the contract never asks
 * for (the issuer's, under Phase 2), so the simulation would never produce it.
 */
export async function handMadeAuth(
  signer: Keypair,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  validUntilLedger: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString(BigInt("0x" + randomBytes(7).toString("hex")).toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contractId).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
  return authorizeEntry(entry, signer, validUntilLedger, NETWORK_PASSPHRASE);
}

export interface Outcome {
  hash: string;
  ledger: number;
  successful: boolean;
  feeCharged: number;
  /** The operation's result code, e.g. `invokeHostFunctionTrapped`. */
  opResult: string;
  /** Every `Error(…)` the diagnostic events report, outermost last. */
  errors: string[];
  returnValue?: unknown;
}

/** Send a signed transaction and wait for it to settle, success or failure. */
export async function sendAndWait(tx: Transaction): Promise<Outcome> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(
      `the network refused ${sent.hash} at submission (${sent.errorResult?.result().switch().name}); ` +
        "it never reached a ledger",
    );
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const got = await server.getTransaction(sent.hash);
    if (got.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
    const resultXdr = got.resultXdr;
    const opResults = resultXdr.result().results();
    const opResult = opResults[0]?.tr().invokeHostFunctionResult().switch().name ?? resultXdr.result().switch().name;
    // Read the error from the transaction meta itself — the ledger record an
    // explorer stores and renders — not from the RPC node's side channel. Testnet
    // meta (v4) carries the diagnostic events.
    const meta = got.resultMetaXdr;
    const metaValue = meta.value() as { diagnosticEvents?: () => xdr.DiagnosticEvent[] };
    const diagnostics =
      typeof metaValue.diagnosticEvents === "function"
        ? metaValue.diagnosticEvents()
        : ((got as { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }).diagnosticEventsXdr ?? []);
    const errors = diagnostics
      .map((d) => d.event().body().v0().topics().map((t) => t.switch().name === "scvError" ? describeScError(t.error()) : null))
      .flat()
      .filter((x): x is string => x !== null);
    return {
      hash: sent.hash,
      ledger: got.ledger,
      successful: got.status === rpc.Api.GetTransactionStatus.SUCCESS,
      feeCharged: Number(resultXdr.feeCharged().toString()),
      opResult,
      errors,
      returnValue:
        got.status === rpc.Api.GetTransactionStatus.SUCCESS ? got.returnValue : undefined,
    };
  }
  throw new Error(`${sent.hash} did not settle in time`);
}

/** `Error(Contract, #28)`, `Error(Auth, InvalidAction)` — the form explorers print. */
export function describeScError(e: xdr.ScError): string {
  const type = e.switch().name.replace(/^sce/, "");
  if (type === "Contract") return `Error(Contract, #${e.contractCode()})`;
  const code = e.code().name.replace(/^scec/, "");
  return `Error(${type}, ${code})`;
}

/**
 * EVIDENCE ONLY — submit a transaction the contract is expected to reject, so the
 * rejection is on the ledger for a reviewer to open.
 *
 * A transaction that fails simulation cannot be assembled from that simulation,
 * so its resources are taken from the simulation of a *valid* sibling — the same
 * call with honest inputs — and raised: CPU to twice the sibling's (at least
 * 150 M), the resource fee to match, and the sibling's footprint unchanged. The
 * transaction then fails at the contract's check, not for want of resources; the
 * caller confirms that from the result code and the diagnostic error.
 *
 * Never used to send a transaction meant to succeed.
 */
export function withSiblingResources(
  tx: Transaction,
  sibling: rpc.Api.SimulateTransactionSuccessResponse,
): Transaction {
  const data = sibling.transactionData.build();
  const res = data.resources();
  const instructions = Math.min(400_000_000, Math.max(150_000_000, res.instructions() * 2));
  const raised = new xdr.SorobanTransactionData({
    ext: data.ext(),
    resources: new xdr.SorobanResources({
      footprint: res.footprint(),
      instructions,
      diskReadBytes: res.diskReadBytes() + 10_000,
      writeBytes: res.writeBytes() + 10_000,
    }),
    resourceFee: xdr.Int64.fromString(String(Number(sibling.minResourceFee) * 3 + 1_000_000)),
  });
  // The builder adds the resource fee to this inclusion fee itself.
  return TransactionBuilder.cloneFrom(tx, { fee: "100", sorobanData: raised }).build();
}
