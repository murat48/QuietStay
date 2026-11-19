/**
 * SEP-45: web authentication for contract accounts, so that a `C…` smart
 * wallet signs in with its passkey. `G…` accounts keep SEP-10
 * (src/lib/sep10.ts). Both end in the same session token.
 *
 * Follows SEP-45 v0.1.1 (stellar-protocol `355ed759`), §Challenge and §Token:
 *
 * - **Challenge.** Two authorization entries for one call:
 *   `web_auth_verify({account, home_domain, nonce, web_auth_domain,
 *   web_auth_domain_account})` on the web-auth contract (`WEB_AUTH_CONTRACT_ID`;
 *   contracts/vendor/anchor-web-auth/, pinned and unmodified). One entry is the
 *   server's, signed by the server account (the SEP-10 signing key). The other
 *   is the client's, unsigned. No sub-invocations. No client domain: the
 *   server does not support client-domain verification, and a request naming
 *   one is answered as if it had not.
 * - **Token.** Every check in §Token, in order. Then a simulation of the call
 *   with the client's signed entry in place, so the wallet's own
 *   `__check_auth` (here the OpenZeppelin WebAuthn verifier) decides. A session
 *   is issued only if that simulation succeeds.
 *
 * Replay (§Replay Prevention):
 * - The nonce is single-use, claimed in the deployment's store, and carries
 *   its issue time and an HMAC, so it cannot be forged or aged.
 * - The server's signature expires 60 ledgers out (about 5 minutes).
 * - A client signature valid for more than 120 ledgers is refused.
 *
 * Nothing is submitted: the call is only simulated, from the server account
 * as source (it must exist on the ledger, because `web_auth_verify` asks for
 * its authorization).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  Account,
  Address,
  authorizeEntry,
  hash,
  Keypair,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import { HOME_DOMAIN, NETWORK_PASSPHRASE, RPC_URL, WEB_AUTH_CONTRACT_ID, WEB_AUTH_DOMAIN, sessionSecret } from "./config";
import { claimOnce } from "./once-store";
import { issueSession, serverKeypairForWebAuth } from "./sep10";

export class Sep45Error extends Error {}

const FUNCTION = "web_auth_verify";
const SERVER_SIGNATURE_LEDGERS = 60;
const MAX_CLIENT_SIGNATURE_LEDGERS = 120;
const NONCE_LIFETIME_SECS = 300;

const server = () => new rpc.Server(RPC_URL);

// --- SorobanAuthorizationEntries: an XDR variable-length array -----------------

export function encodeEntries(entries: xdr.SorobanAuthorizationEntry[]): string {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(entries.length);
  return Buffer.concat([head, ...entries.map((e) => e.toXDR())]).toString("base64");
}

/**
 * The inverse of `encodeEntries`. js-xdr's stream reader is not exported, so
 * the array is read as the tail of an `InvokeHostFunctionOp`, whose last field
 * is exactly a `SorobanAuthorizationEntry<>` array: a fixed, empty host
 * function is put in front, and the whole is parsed. That also refuses
 * trailing bytes.
 */
export function decodeEntries(base64: string): xdr.SorobanAuthorizationEntry[] {
  const bytes = Buffer.from(base64, "base64");
  const empty = new xdr.InvokeHostFunctionOp({
    hostFunction: xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.alloc(0)),
    auth: [],
  }).toXDR();
  const prefix = empty.subarray(0, empty.length - 4); // drop its zero-length auth array
  let entries: xdr.SorobanAuthorizationEntry[];
  try {
    entries = xdr.InvokeHostFunctionOp.fromXDR(Buffer.concat([prefix, bytes])).auth();
  } catch {
    throw new Sep45Error("authorization_entries is not valid SorobanAuthorizationEntries XDR");
  }
  if (entries.length !== 2) throw new Sep45Error("authorization_entries must hold exactly 2 entries");
  return entries;
}

// --- the args map ----------------------------------------------------------------

type Args = Record<string, string>;

function argsScVal(args: Args): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(args)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: xdr.ScVal.scvString(args[k]!) })),
  );
}

function readArgs(val: xdr.ScVal): Args {
  if (val.switch().name !== "scvMap") throw new Sep45Error("web_auth_verify's argument is not a map");
  const out: Args = {};
  for (const e of val.map() ?? []) {
    if (e.key().switch().name !== "scvSymbol" || e.val().switch().name !== "scvString") {
      throw new Sep45Error("web_auth_verify's map must be Symbol → String");
    }
    out[e.key().sym().toString()] = e.val().str().toString();
  }
  return out;
}

function invocation(args: Args): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(WEB_AUTH_CONTRACT_ID).toScAddress(),
        functionName: FUNCTION,
        args: [argsScVal(args)],
      }),
    ),
    subInvocations: [],
  });
}

// --- the nonce: single use, dated, and unforgeable -------------------------------

function mac(account: string, issued: number, rand: string): string {
  return createHmac("sha256", sessionSecret()).update(`sep45|${account}|${issued}|${rand}`).digest("hex").slice(0, 32);
}

function makeNonce(account: string): string {
  const issued = Math.floor(Date.now() / 1000);
  const rand = randomBytes(16).toString("hex");
  return `${issued}.${rand}.${mac(account, issued, rand)}`;
}

function checkNonce(account: string, nonce: string): void {
  const [issuedText, rand, tag] = nonce.split(".");
  const issued = Number(issuedText);
  if (!rand || !tag || !Number.isInteger(issued)) throw new Sep45Error("the nonce is malformed");
  const expected = Buffer.from(mac(account, issued, rand));
  if (expected.length !== Buffer.byteLength(tag) || !timingSafeEqual(expected, Buffer.from(tag))) {
    throw new Sep45Error("the nonce was not issued by this server for this account");
  }
  if (Date.now() / 1000 - issued > NONCE_LIFETIME_SECS) throw new Sep45Error("the challenge has expired; ask for a new one");
}

// --- challenge -----------------------------------------------------------------

function expectedArgs(account: string, nonce: string): Args {
  return {
    account,
    home_domain: HOME_DOMAIN,
    nonce,
    web_auth_domain: WEB_AUTH_DOMAIN,
    web_auth_domain_account: serverKeypairForWebAuth().publicKey(),
  };
}

function randomInt64(): xdr.Int64 {
  return xdr.Int64.fromString(BigInt.asIntN(64, randomBytes(8).readBigUInt64BE()).toString());
}

export async function buildChallenge(account: string, homeDomain?: string | null): Promise<{
  authorization_entries: string;
  network_passphrase: string;
}> {
  if (!StrKey.isValidContract(account)) throw new Sep45Error("account must be a contract address (C…); G… accounts use SEP-10");
  if (homeDomain && homeDomain !== HOME_DOMAIN) throw new Sep45Error(`this server authenticates for ${HOME_DOMAIN} only`);
  const serverKp = serverKeypairForWebAuth();
  const args = expectedArgs(account, makeNonce(account));
  const inv = invocation(args);
  const latest = (await server().getLatestLedger()).sequence;

  const entryFor = (address: string) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(address).toScAddress(),
          nonce: randomInt64(),
          signatureExpirationLedger: latest + SERVER_SIGNATURE_LEDGERS,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: inv,
    });

  const serverEntry = await authorizeEntry(
    entryFor(serverKp.publicKey()),
    serverKp,
    latest + SERVER_SIGNATURE_LEDGERS,
    NETWORK_PASSPHRASE,
  );
  return {
    authorization_entries: encodeEntries([serverEntry, entryFor(account)]),
    network_passphrase: NETWORK_PASSPHRASE,
  };
}

// --- token ---------------------------------------------------------------------

/** The payload an address-credential entry's signature is over. */
function payload(entry: xdr.SorobanAuthorizationEntry): Buffer {
  const c = entry.credentials().address();
  return hash(
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
        nonce: c.nonce(),
        signatureExpirationLedger: c.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      }),
    ).toXDR(),
  );
}

/** Does `entry` carry a valid Ed25519 signature from `kp`, as `authorizeEntry` writes it? */
function signedBy(entry: xdr.SorobanAuthorizationEntry, kp: Keypair): boolean {
  const sig = entry.credentials().address().signature();
  if (sig.switch().name !== "scvVec") return false;
  const msg = payload(entry);
  for (const item of sig.vec() ?? []) {
    if (item.switch().name !== "scvMap") continue;
    const fields = Object.fromEntries((item.map() ?? []).map((e) => [e.key().sym().toString(), e.val()]));
    const pk = fields.public_key?.bytes();
    const s = fields.signature?.bytes();
    if (pk && s && Buffer.from(pk).equals(kp.rawPublicKey()) && kp.verify(msg, Buffer.from(s))) return true;
  }
  return false;
}

export async function verifyChallenge(entriesBase64: string): Promise<{ account: string; token: string }> {
  const serverKp = serverKeypairForWebAuth();
  const entries = decodeEntries(entriesBase64);

  // §Token 1–4: every entry is web_auth_verify on our contract, with no
  // sub-invocations and identical arguments.
  let args: Args | null = null;
  let argsXdr: string | null = null;
  for (const e of entries) {
    if (e.credentials().switch().name !== "sorobanCredentialsAddress") {
      throw new Sep45Error("every entry must carry address credentials");
    }
    const root = e.rootInvocation();
    if (root.subInvocations().length !== 0) throw new Sep45Error("an entry has sub-invocations");
    const fn = root.function();
    if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Sep45Error("an entry is not a contract call");
    const call = fn.contractFn();
    if (Address.fromScAddress(call.contractAddress()).toString() !== WEB_AUTH_CONTRACT_ID) {
      throw new Sep45Error("an entry is for a different contract than this server's web-auth contract");
    }
    if (call.functionName().toString() !== FUNCTION) throw new Sep45Error(`an entry is not ${FUNCTION}`);
    if (call.args().length !== 1) throw new Sep45Error(`${FUNCTION} takes one argument`);
    const x = call.args()[0]!.toXDR("base64");
    if (argsXdr !== null && x !== argsXdr) throw new Sep45Error("the entries' arguments differ");
    argsXdr = x;
    args = readArgs(call.args()[0]!);
  }
  if (!args) throw new Sep45Error("no entries");

  const account = args.account ?? "";
  if (!StrKey.isValidContract(account)) throw new Sep45Error("account must be a contract address (C…)");
  const want = expectedArgs(account, args.nonce ?? "");
  for (const k of Object.keys({ ...want, ...args })) {
    if (args[k] !== want[k]) throw new Sep45Error(`the challenge's ${k} is not this server's`);
  }

  // §Token 5: the nonce is ours, recent, and used once.
  checkNonce(account, args.nonce!);

  // §Token 6–7: the server's entry carries our signature; the client's entry is there.
  const byAddress = new Map(
    entries.map((e) => [Address.fromScAddress(e.credentials().address().address()).toString(), e]),
  );
  if (byAddress.size !== entries.length || entries.length !== 2) throw new Sep45Error("expected one server entry and one client entry");
  const serverEntry = byAddress.get(serverKp.publicKey());
  const clientEntry = byAddress.get(account);
  if (!serverEntry || !signedBy(serverEntry, serverKp)) throw new Sep45Error("the server's entry does not carry this server's signature");
  if (!clientEntry) throw new Sep45Error("there is no entry for the account");

  const latest = (await server().getLatestLedger()).sequence;
  const until = clientEntry.credentials().address().signatureExpirationLedger();
  if (until < latest) throw new Sep45Error("the account's signature has expired");
  if (until > latest + MAX_CLIENT_SIGNATURE_LEDGERS) {
    throw new Sep45Error(`the account's signature is valid for too long (at most ${MAX_CLIENT_SIGNATURE_LEDGERS} ledgers)`);
  }

  // §Token 8–9: simulate web_auth_verify with the signed entries. The wallet's
  // __check_auth runs here: a passkey that did not sign makes this fail.
  const tx = new TransactionBuilder(new Account(serverKp.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: WEB_AUTH_CONTRACT_ID,
        function: FUNCTION,
        args: [argsScVal(args)],
        auth: entries,
      }),
    )
    .setTimeout(60)
    .build();
  const sim = await server().simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Sep45Error(`the account did not authorize this sign-in: ${sim.error.split("\n")[0]}`);
  }

  // Claimed last, so a challenge that failed a check above can be retried.
  if (!(await claimOnce(`sep45-nonce:${args.nonce}`, NONCE_LIFETIME_SECS * 2))) {
    throw new Sep45Error("this challenge has already been used");
  }
  return { account, token: await issueSession(account) };
}
