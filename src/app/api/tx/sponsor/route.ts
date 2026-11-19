/**
 * The testnet fee route (docs/PHASE3_SPEC.md §13, D6): pay for and submit a
 * passkey-authorized transaction, or a smart wallet's creation.
 *
 *   POST /api/tx/sponsor  { xdr }           a transaction the app built, with
 *                                            the wallet's entries passkey-signed
 *   POST /api/tx/sponsor  { func, auth[] }  smart-account-kit's wallet creation
 *     → { hash, successful, failure?, explorer, ledger?, wallet? }
 *
 * Only the host function and its authorization entries are taken from the
 * request. The route builds a new transaction from the fee account, checks
 * it against src/lib/sponsor.ts, simulates it with the signatures in place,
 * adds headroom, signs it with `QUIETSTAY_TESTNET_FEE_SECRET` and submits it.
 * No session is needed: a wallet is created before it can sign in, and the
 * contract authorizes every call on its own. Each sponsored transaction
 * counts against the rate limits, whatever its outcome.
 */

import {
  Keypair,
  Operation,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { ConfigurationError, NETWORK_PASSPHRASE, testnetFeeSecret } from "@/lib/config";
import { readInventory, readIssuer, server, submit } from "@/lib/contract";
import { countInWindow } from "@/lib/once-store";
import { serverAccount } from "@/lib/sep10";
import { assertFeeKeyIsolated, checkSponsored, LIMITS, MAX_FEE_STROOPS, SponsorRefusal } from "@/lib/sponsor";

export const dynamic = "force-dynamic";

let isolated: Promise<void> | null = null;

function feeKeypair(): Keypair {
  try {
    return Keypair.fromSecret(testnetFeeSecret());
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("QUIETSTAY_TESTNET_FEE_SECRET is not a Stellar secret seed");
  }
}

function parseBody(body: { xdr?: unknown; func?: unknown; auth?: unknown }): {
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
} {
  if (typeof body.xdr === "string") {
    const tx = TransactionBuilder.fromXDR(body.xdr, NETWORK_PASSPHRASE) as Transaction;
    if (tx.operations.length !== 1 || tx.operations[0]!.type !== "invokeHostFunction") {
      throw new SponsorRefusal("exactly one InvokeHostFunction operation is sponsored", 400);
    }
    const op = tx.operations[0] as Operation.InvokeHostFunction;
    return { func: op.func, auth: op.auth ?? [] };
  }
  if (typeof body.func === "string" && Array.isArray(body.auth)) {
    return {
      func: xdr.HostFunction.fromXDR(body.func, "base64"),
      auth: body.auth.map((a) => xdr.SorobanAuthorizationEntry.fromXDR(String(a), "base64")),
    };
  }
  throw new SponsorRefusal("expected { xdr } or { func, auth }", 400);
}

async function rateLimit(ip: string, wallet: string | null): Promise<void> {
  let counts: number[];
  try {
    counts = await Promise.all([
      countInWindow(`sponsor:ip:${ip}`, 3600),
      countInWindow("sponsor:all", 86_400),
      wallet ? countInWindow(`sponsor:wallet:${wallet}`, 86_400) : Promise.resolve(0),
    ]);
  } catch {
    throw new SponsorRefusal("the rate-limit store cannot be reached, so nothing is sponsored", 503);
  }
  const [perIp, total, perWallet] = counts as [number, number, number];
  if (perIp > LIMITS.perIpPerHour) throw new SponsorRefusal(`more than ${LIMITS.perIpPerHour} sponsored transactions from this address this hour`, 429);
  if (total > LIMITS.totalPerDay) throw new SponsorRefusal(`the daily limit of ${LIMITS.totalPerDay} sponsored transactions is reached`, 429);
  if (perWallet > LIMITS.perWalletPerDay) throw new SponsorRefusal(`more than ${LIMITS.perWalletPerDay} sponsored transactions for this wallet today`, 429);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const fee = feeKeypair();
    const feeAccount = fee.publicKey();
    isolated ??= (async () => {
      const [issuer, rows] = await Promise.all([readIssuer(), readInventory()]);
      assertFeeKeyIsolated(feeAccount, {
        issuer,
        signingKey: serverAccount(),
        holders: rows.flatMap((r) => r.right.holdings.map((h) => h.holder)),
      });
    })().catch((e) => {
      isolated = null;
      throw e;
    });
    await isolated;

    const { func, auth } = parseBody((await request.json()) as Record<string, unknown>);
    const checked = checkSponsored(func, auth, feeAccount);
    const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "local";
    await rateLimit(ip, checked.wallet);

    const account = await server.getAccount(feeAccount);
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.invokeHostFunction({ func: checked.func, auth: checked.auth }))
      .setTimeout(120)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      return Response.json({ error: `the network refuses this transaction: ${sim.error.split("\n")[0]}` }, { status: 400 });
    }
    const ok = sim as rpc.Api.SimulateTransactionSuccessResponse;
    // Headroom: a passkey signature was already in place for this simulation,
    // but resource estimates still move a little before inclusion.
    const data = ok.transactionData.build();
    data.resources().instructions(Math.ceil(data.resources().instructions() * 1.1));
    const resourceFee = (BigInt(ok.minResourceFee) * 115n) / 100n;
    data.resourceFee(xdr.Int64.fromString(resourceFee.toString()));
    const assembled = rpc
      .assembleTransaction(tx, { ...ok, minResourceFee: resourceFee.toString(), transactionData: new SorobanDataBuilder(data) })
      .build();
    if (BigInt(assembled.fee) > MAX_FEE_STROOPS) {
      return Response.json({ error: `the fee ${assembled.fee} exceeds the ${MAX_FEE_STROOPS}-stroop cap` }, { status: 403 });
    }
    assembled.sign(fee);
    const result = await submit(assembled);
    let ledger: number | undefined;
    if (result.successful) {
      const got = await server.getTransaction(result.hash);
      if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) ledger = got.ledger;
    }
    return Response.json({ ...result, ledger, kind: checked.kind, wallet: checked.wallet });
  } catch (error) {
    if (error instanceof SponsorRefusal) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof ConfigurationError) {
      return Response.json({ error: `this deployment does not sponsor transactions: ${error.message}` }, { status: 503 });
    }
    return Response.json({ error: error instanceof Error ? error.message : "could not sponsor this transaction" }, { status: 500 });
  }
}
