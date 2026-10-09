/**
 * Client for the deployed QuietStay rights registry.
 *
 * Reads go through simulation, so they cost nothing and need no signature.
 * A transfer (Phase 2) is built from an ownership proof the holder made with the
 * command-line prover:
 *
 *   1. build `transfer(from, to, right_id, expires_at, proof, public_signals)`
 *      with the holder's account as source
 *   2. simulate — the host reports which signatures the contract wants: the
 *      holder's, which the envelope signature covers, and on a sale the buyer's
 *      over `(right_id, h')`
 *   3. on a sale, put in the consent the buyer signed when asking for the week
 *   4. the holder's wallet signs the envelope and it is submitted
 *
 * The issuer appears nowhere in a transfer. The contract verifies the proof on
 * chain; a transaction carrying a bad one is refused there, which is what
 * docs/EVIDENCE.md's rejected transactions show.
 */

import {
  Account,
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { toHex } from "./canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL } from "./config";
import { describeContractFailure, isRightNotFound } from "./errors";

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

  /*
   * Bounded concurrency, and only `RightNotFound` may remove a week.
   *
   * This used to be `catch { return null }` over every id at once, with a
   * comment about burned rights. It did drop burned rights correctly, and it
   * also dropped every right whose read happened to fail — and four reads per
   * id, all fired together, is a burst that grows with the registry: at
   * twenty-nine rights it is a hundred and sixteen simulated calls arriving at
   * a public RPC endpoint simultaneously. Some are refused. Observed directly:
   * the same registry answered 29 rights, then 28, then 17, with no error shown
   * either time.
   *
   * A week silently absent is worse than an error. The owner sees their listing
   * gone with nothing to act on; a buyer never learns it existed. So a read that
   * fails for any other reason is retried, and if it still fails the whole call
   * does — a page that says it could not read the registry is at least true.
   *
   * The limit is what makes the retries rarely needed rather than a crutch.
   * Reading one id at a time fixed the truncation and cost nine seconds; five
   * at a time is twenty calls in flight, which the endpoint serves without
   * complaint.
   */
  const CONCURRENCY = 5;
  type Row = { right: Right; listing: Listing | null; holding: Holding; active: boolean };
  const rows: (Row | null)[] = new Array(ids.length).fill(null);

  const readOne = async (id: number): Promise<Row | null> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [right, listing, holding, active] = await Promise.all([
          readRight(id, contractId),
          readListing(id, contractId),
          readHolding(id, contractId),
          readIsActive(id, contractId),
        ]);
        return { right, listing, holding, active };
      } catch (error) {
        // Burned, or never issued. Genuinely absent, so genuinely omitted.
        if (isRightNotFound(error instanceof ContractCallError ? error.raw : error)) return null;
        lastError = error;
        // 150ms, then 300ms. Long enough for a rate limiter to forget us.
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw new ContractCallError(
      `could not read right #${id} from the contract after 3 attempts — ` +
        "the registry is not being shown incomplete",
      lastError,
    );
  };

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= ids.length) return;
        rows[index] = await readOne(ids[index]!);
      }
    }),
  );

  return rows.filter((row): row is Row => row !== null);
}

// --- writes --------------------------------------------------------------

/** A transfer as the command-line prover wrote it (`transfer.json`). */
export interface ProvenTransfer {
  from: string;
  to: string;
  rightId: number;
  /** Unix seconds for a rental; `null` for a sale. */
  expiresAt: number | null;
  /** G1, G2, G1 in Soroban's byte layout, hex. */
  proof: { a: string; b: string; c: string };
  /** The eleven public signals, decimal, in docs/CIRCUIT.md §7 order. */
  signals: string[];
}

const bytesHex = (hex: string): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));

function transferArgs(t: ProvenTransfer): xdr.ScVal[] {
  return [
    addr(t.from),
    addr(t.to),
    u64(t.rightId),
    option(t.expiresAt === null ? null : u64(t.expiresAt)),
    struct({ a: bytesHex(t.proof.a), b: bytesHex(t.proof.b), c: bytesHex(t.proof.c) }),
    xdr.ScVal.scvVec(t.signals.map((s) => nativeToScVal(BigInt(s), { type: "u256" }))),
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
 * over unless the caller passes it (only `assembleTransaction` does), so it is
 * preserved here when present.
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
 * A proof-authorized transfer, ready for the holder's wallet to sign.
 *
 * Simulated twice. The first run reports which signatures the contract wants;
 * a buyer's, on a sale, is replaced by the consent the buyer signed in advance
 * (`src/lib/consent.ts`). The second run, with that signed consent in place,
 * checks the whole call — proof included — and sets the resources. A proof the
 * contract would refuse fails here, with the contract's reason, before the
 * holder is asked to sign anything.
 */
export async function buildProvenTransferTx(
  t: ProvenTransfer,
  buyerConsent: string | null,
  contractId: string = CONTRACT_ID,
): Promise<Transaction> {
  const tx = await buildInvocation(t.from, "transfer", transferArgs(t), contractId);
  const first = await simulateOrThrow(tx);

  const auth = simulationAuthEntries(first).map((entry) => {
    const who = entryAddress(entry);
    if (who === null) return entry; // the holder, covered by the envelope signature
    if (who === t.to && t.expiresAt === null) {
      if (!buyerConsent) {
        throw new ContractCallError(
          "a sale needs the buyer's signed consent, which the buyer gives when asking for the week",
          who,
        );
      }
      return xdr.SorobanAuthorizationEntry.fromXDR(buyerConsent, "base64");
    }
    throw new ContractCallError(`the contract asks for a signature from ${who}, which this app cannot supply`, who);
  });

  const withAuth = rebuildWithAuth(tx, auth);
  const second = await simulateOrThrow(withAuth);
  return rpc.assembleTransaction(withAuth, second).build();
}

/** One `transfer` the contract accepted, as its event records it. */
export interface TransferEvent {
  txHash: string;
  ledger: number;
  closedAt: string;
  from: string;
  to: string;
  rightId: number;
  expiresAt: number | null;
  commitment: string;
}

/**
 * The accepted transfers of a right that the RPC still remembers.
 *
 * Every one of them is a proof the contract verified: `transfer` emits its
 * event only after the pairing check passes, and there is no other way to move a
 * right. The RPC keeps events for a limited window (about a week on testnet), so
 * an empty answer means "none recently", not "never".
 */
export async function readTransferEvents(rightId: number, contractId: string = CONTRACT_ID): Promise<TransferEvent[]> {
  const latest = await server.getLatestLedger();
  const topic = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const filters = [{ type: "contract" as const, contractIds: [contractId], topics: [[topic, "*", "*"]] }];

  // The node scans a bounded range of ledgers per request (about 10,000 on
  // testnet) and hands back a cursor, so a window reaching back a week takes a
  // dozen pages. A cursor is "<toid>-<index>" and a toid carries the ledger
  // sequence in its top 32 bits, which is how the loop knows it has caught up.
  const ledgerOf = (cursor: string) => Number(BigInt(cursor.split("-")[0] ?? "0") >> 32n);
  const events: rpc.Api.EventResponse[] = [];
  let page = await server.getEvents({ startLedger: Math.max(1, latest.sequence - 120_000), filters, limit: 200 });
  events.push(...page.events);
  for (let i = 0; i < 30 && page.cursor && ledgerOf(page.cursor) < page.latestLedger; i += 1) {
    page = await server.getEvents({ cursor: page.cursor, filters, limit: 200 });
    events.push(...page.events);
  }

  const out: TransferEvent[] = [];
  for (const event of events) {
    const topics = event.topic.map((t) => scValToNative(t));
    const data = scValToNative(event.value) as { right_id: bigint; expires_at: bigint | null; commitment: Buffer };
    if (Number(data.right_id) !== rightId) continue;
    out.push({
      txHash: event.txHash,
      ledger: event.ledger,
      closedAt: event.ledgerClosedAt,
      from: String(topics[1]),
      to: String(topics[2]),
      rightId,
      expiresAt: data.expires_at === null || data.expires_at === undefined ? null : Number(data.expires_at),
      commitment: toHex(new Uint8Array(data.commitment)),
    });
  }
  return out;
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
