/**
 * Client for the deployed QuietStay rights registry.
 *
 * Reads go through simulation, so they cost nothing and need no signature.
 * Writes follow the two-signature flow the contract requires:
 *
 *   1. build the invocation with the holder's account as source
 *   2. simulate — the host reports that the issuer's approval is also required
 *   3. the issuer signs that authorization entry (this is the SEP-8 analogue,
 *      and it happens in `/api/approve-transfer`, never in the browser)
 *   4. the holder signs the transaction envelope and submits
 *
 * Step 3 is what the contract enforces. Skip it and the transfer is rejected on
 * chain — `scripts/produce-evidence.ts` submits exactly that transaction on
 * purpose, so the rejection is a thing a reviewer can open in an explorer.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { toHex } from "./canonical";
import { APPROVAL_VALIDITY_LEDGERS, CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "./config";
import { describeContractFailure } from "./errors";

export const server = new rpc.Server(RPC_URL);

/**
 * Source account used only for read simulations. Simulation never submits and
 * never signs, so any well-formed address does; using the null account keeps it
 * obvious that no real account is involved.
 */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export class ContractCallError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = "ContractCallError";
  }
}

// --- argument encoding ----------------------------------------------------

const u64 = (n: bigint | number): xdr.ScVal => nativeToScVal(BigInt(n), { type: "u64" });
const addr = (g: string): xdr.ScVal => new Address(g).toScVal();
const bytes32 = (hex: string): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

/** `Option<T>`: `None` is `void`, `Some(x)` is `x` itself. */
const option = (value: xdr.ScVal | null): xdr.ScVal => value ?? xdr.ScVal.scvVoid();

/** A `#[contracttype]` struct: an ScMap with symbol keys, sorted as the host requires. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map(
      (key) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(key, { type: "symbol" }),
          val: fields[key]!,
        }),
    );
  return xdr.ScVal.scvMap(entries);
}

const periodScVal = (period: { start: number; end: number }) =>
  struct({ start: u64(period.start), end: u64(period.end) });

const validityScVal = (validity: { from: number; until: number }) =>
  struct({ from: u64(validity.from), until: u64(validity.until) });

// --- decoded shapes -------------------------------------------------------

export interface Holding {
  holder: string;
  /** Unix seconds, or `null` for an open-ended holding (title). */
  expiresAt: number | null;
}

export interface Right {
  id: number;
  issuer: string;
  period: { start: number; end: number };
  validity: { from: number; until: number };
  /** Lowercase hex SHA-256 of the canonical off-chain record. */
  commitment: string;
  /** Title first, then live sub-grants. */
  holdings: Holding[];
}

export interface Listing {
  rightId: number;
  by: string;
  /** `null` means offered open-ended (a sale); a number is a rental term in seconds. */
  termSecs: number | null;
  listedAt: number;
}

const num = (v: unknown): number => Number(v as bigint | number);

function decodeHolding(raw: { holder: string; expires_at: bigint | null }): Holding {
  return {
    holder: raw.holder,
    expiresAt: raw.expires_at === null || raw.expires_at === undefined ? null : num(raw.expires_at),
  };
}

function decodeRight(raw: Record<string, unknown>): Right {
  const period = raw.period as { start: bigint; end: bigint };
  const validity = raw.validity as { from: bigint; until: bigint };
  return {
    id: num(raw.id),
    issuer: raw.issuer as string,
    period: { start: num(period.start), end: num(period.end) },
    validity: { from: num(validity.from), until: num(validity.until) },
    commitment: toHex(new Uint8Array(raw.commitment as Buffer)),
    holdings: (raw.holdings as { holder: string; expires_at: bigint | null }[]).map(decodeHolding),
  };
}

function decodeListing(raw: Record<string, unknown>): Listing {
  return {
    rightId: num(raw.right_id),
    by: raw.by as string,
    termSecs:
      raw.term_secs === null || raw.term_secs === undefined ? null : num(raw.term_secs),
    listedAt: num(raw.listed_at),
  };
}

// --- reads ---------------------------------------------------------------

const contract = (id: string = CONTRACT_ID) => new Contract(id);

/**
 * Simulate a call and return its decoded result.
 *
 * Read-only calls never leave the RPC server, so this is the whole of a read: no
 * account, no signature, no fee.
 */
async function simulateCall(
  method: string,
  args: xdr.ScVal[],
  contractId: string = CONTRACT_ID,
): Promise<unknown> {
  const source = new Account(SIMULATION_SOURCE, "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractCallError(describeContractFailure(sim.error), sim.error);
  }
  const retval = sim.result?.retval;
  return retval === undefined ? undefined : scValToNative(retval);
}

export const readIssuer = (contractId?: string) =>
  simulateCall("issuer", [], contractId) as Promise<string>;

export const readName = (contractId?: string) =>
  simulateCall("name", [], contractId) as Promise<string>;

export const readSymbol = (contractId?: string) =>
  simulateCall("symbol", [], contractId) as Promise<string>;

export async function readNextId(contractId?: string): Promise<number> {
  return num(await simulateCall("next_id", [], contractId));
}

export async function readRight(rightId: number, contractId?: string): Promise<Right> {
  return decodeRight((await simulateCall("get_right", [u64(rightId)], contractId)) as Record<string, unknown>);
}

export async function readCommitment(rightId: number, contractId?: string): Promise<string> {
  const raw = (await simulateCall("commitment", [u64(rightId)], contractId)) as Buffer;
  return toHex(new Uint8Array(raw));
}

export const readHolder = (rightId: number, contractId?: string) =>
  simulateCall("holder", [u64(rightId)], contractId) as Promise<string>;

export async function readHolding(rightId: number, contractId?: string): Promise<Holding> {
  return decodeHolding(
    (await simulateCall("holding", [u64(rightId)], contractId)) as {
      holder: string;
      expires_at: bigint | null;
    },
  );
}

export const readIsActive = (rightId: number, contractId?: string) =>
  simulateCall("is_active", [u64(rightId)], contractId) as Promise<boolean>;

export async function readBalance(account: string, contractId?: string): Promise<number> {
  return num(await simulateCall("balance", [addr(account)], contractId));
}

export async function readListing(rightId: number, contractId?: string): Promise<Listing | null> {
  const raw = await simulateCall("get_listing", [u64(rightId)], contractId);
  return raw === null || raw === undefined ? null : decodeListing(raw as Record<string, unknown>);
}

/**
 * Every right in the registry, with its listing.
 *
 * Ids are dense in `1..next_id()`, so inventory is enumerable without an
 * unbounded on-chain index. Burned rights leave a gap and are skipped.
 */
export async function readInventory(contractId?: string): Promise<
  { right: Right; listing: Listing | null; holding: Holding; active: boolean }[]
> {
  const next = await readNextId(contractId);
  const ids = Array.from({ length: Math.max(0, next - 1) }, (_, i) => i + 1);

  const rows = await Promise.all(
    ids.map(async (id) => {
      try {
        const [right, listing, holding, active] = await Promise.all([
          readRight(id, contractId),
          readListing(id, contractId),
          readHolding(id, contractId),
          readIsActive(id, contractId),
        ]);
        return { right, listing, holding, active };
      } catch {
        // Burned, or archived beyond its TTL. Not an error for a listing page.
        return null;
      }
    }),
  );
  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
}

// --- writes --------------------------------------------------------------

export interface TransferTerms {
  from: string;
  to: string;
  rightId: number;
  /** Unix seconds for a rental; `null` for a sale. */
  expiresAt: number | null;
}

function transferArgs(terms: TransferTerms): xdr.ScVal[] {
  return [
    addr(terms.from),
    addr(terms.to),
    u64(terms.rightId),
    option(terms.expiresAt === null ? null : u64(terms.expiresAt)),
  ];
}

/** An unsimulated invocation with `source` as the transaction source account. */
async function buildInvocation(
  source: string,
  method: string,
  args: xdr.ScVal[],
  contractId: string = CONTRACT_ID,
): Promise<Transaction> {
  const account = await server.getAccount(source);
  return new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract(contractId).call(method, ...args))
    .setTimeout(180)
    .build();
}

export const buildTransferTx = (terms: TransferTerms, contractId?: string) =>
  buildInvocation(terms.from, "transfer", transferArgs(terms), contractId);

export const buildIssueTx = (
  params: {
    issuer: string;
    owner: string;
    period: { start: number; end: number };
    validity: { from: number; until: number };
    commitment: string;
  },
  contractId?: string,
) =>
  buildInvocation(
    params.issuer,
    "issue",
    [addr(params.owner), periodScVal(params.period), validityScVal(params.validity), bytes32(params.commitment)],
    contractId,
  );

export const buildListTx = (
  params: { by: string; rightId: number; termSecs: number | null },
  contractId?: string,
) =>
  buildInvocation(
    params.by,
    "list",
    [
      addr(params.by),
      u64(params.rightId),
      option(params.termSecs === null ? null : u64(params.termSecs)),
    ],
    contractId,
  );

export const buildUnlistTx = (params: { by: string; rightId: number }, contractId?: string) =>
  buildInvocation(params.by, "unlist", [addr(params.by), u64(params.rightId)], contractId);

/** Which address a simulation-produced authorization entry belongs to. */
function entryAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") return null;
  return Address.fromScAddress(credentials.address().address()).toString();
}

/**
 * Rebuild a transaction with a different set of authorization entries, keeping
 * everything else — crucially the Soroban resource footprint.
 *
 * `TransactionBuilder.cloneFrom` deliberately does *not* carry `sorobanData`
 * over unless the caller passes it (only `assembleTransaction` does). Cloning
 * without it yields an invocation with no declared resources, which the network
 * rejects as `txMalformed` at submission — before it reaches a ledger, and so
 * before the contract gets to reject it. For the unapproved-transfer evidence
 * that distinction is the whole artifact, so the footprint is preserved here.
 *
 * The fee is left to `cloneFrom`, which subtracts the resource fee to recover the
 * classic portion; the builder adds it back when `sorobanData` is present.
 */
function rebuildWithAuth(
  tx: Transaction,
  auth: xdr.SorobanAuthorizationEntry[],
): Transaction {
  const op = tx.operations[0];
  if (!op || op.type !== "invokeHostFunction") {
    throw new Error("expected a single invokeHostFunction operation");
  }
  const sorobanData = tx.toEnvelope().v1().tx().ext().value() ?? undefined;
  return TransactionBuilder.cloneFrom(tx, sorobanData ? { sorobanData } : {})
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .build();
}

export function simulationAuthEntries(
  sim: rpc.Api.SimulateTransactionSuccessResponse,
): xdr.SorobanAuthorizationEntry[] {
  return sim.result?.auth ?? [];
}

async function simulateOrThrow(
  tx: Transaction,
): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractCallError(describeContractFailure(sim.error), sim.error);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new ContractCallError("simulation returned no result", sim);
  }
  return sim;
}

/**
 * Sign the issuer's authorization entry and return a transaction that is ready
 * for the holder to sign and submit.
 *
 * The issuer signs *one* entry out of the transaction's authorization tree — the
 * one bound to the invocation `(contract, "transfer", from, to, right_id,
 * expires_at)`. It does not sign the envelope, so it cannot alter the terms, add
 * operations, or submit anything by itself. That asymmetry is the whole reason a
 * trusted-attester issuer is not also an issuer that can take your week.
 */
export async function approveTransferAsIssuer(
  tx: Transaction,
  issuer: Keypair,
): Promise<{ tx: Transaction; approvedEntries: string[]; validUntilLedger: number }> {
  const sim = await simulateOrThrow(tx);
  const entries = simulationAuthEntries(sim);

  const { sequence } = await server.getLatestLedger();
  const validUntilLedger = sequence + APPROVAL_VALIDITY_LEDGERS;

  const approvedEntries: string[] = [];
  const signed = await Promise.all(
    entries.map(async (entry) => {
      const address = entryAddress(entry);
      if (address !== issuer.publicKey()) return entry;
      approvedEntries.push(address);
      return authorizeEntry(entry, issuer, validUntilLedger, NETWORK_PASSPHRASE);
    }),
  );

  if (approvedEntries.length === 0) {
    throw new ContractCallError(
      "this transaction does not ask for the issuer's approval — nothing to sign",
      entries.map(entryAddress),
    );
  }

  // Re-simulate with the signatures attached so the resource footprint accounts
  // for their size, then keep our signed entries (assembleTransaction preserves
  // existing auth) while taking the fresh resources.
  const authed = rebuildWithAuth(tx, signed);
  const finalSim = await simulateOrThrow(authed);
  return {
    tx: rpc.assembleTransaction(authed, finalSim).build(),
    approvedEntries,
    validUntilLedger,
  };
}

/**
 * Prepare a transfer with the issuer's approval deliberately withheld.
 *
 * The footprint comes from an approved simulation, so the transaction is valid
 * enough to reach the ledger — and is then rejected by the contract when the
 * missing authorization is checked. That is the point: it produces a real,
 * openable transaction hash showing enforcement, rather than a claim that
 * enforcement exists.
 */
export async function prepareUnapprovedTransfer(
  tx: Transaction,
  issuer: Keypair,
): Promise<Transaction> {
  const approved = await approveTransferAsIssuer(tx, issuer);
  const op = approved.tx.operations[0];
  if (!op || op.type !== "invokeHostFunction") {
    throw new Error("expected a single invokeHostFunction operation");
  }
  const withoutIssuer = (op.auth ?? []).filter((e) => entryAddress(e) !== issuer.publicKey());
  return rebuildWithAuth(approved.tx, withoutIssuer);
}

/** Simulate, apply resources, and return a transaction ready to sign. */
export async function prepare(tx: Transaction): Promise<Transaction> {
  const sim = await simulateOrThrow(tx);
  return rpc.assembleTransaction(tx, sim).build();
}

export interface SubmitResult {
  hash: string;
  successful: boolean;
  /** Present when the transaction was rejected. */
  failure?: string;
  explorer: string;
}

/**
 * Submit a signed transaction and wait for the ledger to include it.
 *
 * A rejected transaction is a result, not an exception: Deliverable 2's evidence
 * is a transfer the contract refused, and it needs a hash a reviewer can open.
 */
export async function submit(tx: Transaction): Promise<SubmitResult> {
  const sent = await server.sendTransaction(tx);
  const hash = sent.hash;
  const explorerLink = `https://stellar.expert/explorer/testnet/tx/${hash}`;

  if (sent.status === "ERROR") {
    const code = sent.errorResult?.result().switch().name ?? "unknown";
    // Rejected before inclusion, so there is nothing on the ledger to look at.
    // Worth saying plainly: a hash that never reached a ledger is not evidence.
    return {
      hash,
      successful: false,
      failure:
        `the network refused the transaction at submission (${code}); ` +
        "it was never included in a ledger, so this hash will not open in an explorer",
      explorer: explorerLink,
    };
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await server.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash, successful: true, explorer: explorerLink };
    }

    // Included in a ledger and rejected during apply. The interesting case: the
    // diagnostic events say which host or contract error stopped it.
    const diagnostics = (result as rpc.Api.GetFailedTransactionResponse).diagnosticEventsXdr ?? [];
    const detail = diagnostics.map((event) => event.toXDR("base64")).join(" ");
    const reason =
      diagnostics
        .map((event) => JSON.stringify(event.event().body().v0().data()))
        .find((text) => /Contract, #\d+|InvalidAction/.test(text)) ?? detail;

    return {
      hash,
      successful: false,
      failure: describeContractFailure(reason || "the contract rejected this call"),
      explorer: explorerLink,
    };
  }
  throw new ContractCallError(`transaction ${hash} did not settle in time`, hash);
}

/** Sign with a local keypair. Used by scripts; the web app signs with Freighter. */
export function signWith(tx: Transaction, ...keypairs: Keypair[]): Transaction {
  const copy = TransactionBuilder.fromXDR(tx.toXDR(), NETWORK_PASSPHRASE) as Transaction;
  for (const keypair of keypairs) copy.sign(keypair);
  return copy;
}
