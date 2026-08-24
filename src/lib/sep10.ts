/**
 * SEP-10 wallet authentication, server side.
 *
 * Proves that whoever is using the app controls a particular Stellar account. The
 * app needs this in two places: the issue screen must only work for the issuer,
 * and the transfer screen must only ask for approval on behalf of the account
 * that actually holds the week.
 *
 * The whole handshake is `WebAuth` out of `@stellar/stellar-sdk`. Nothing here
 * builds or checks a signature by hand:
 *
 *   1. `buildChallengeTx` — a transaction with sequence number 0 that can never be
 *      submitted, carrying a `<home domain> auth` manage-data operation.
 *   2. the wallet signs it.
 *   3. `readChallengeTx` then `verifyChallengeTxThreshold` (or
 *      `verifyChallengeTxSigners` for an account that does not exist yet) checks
 *      the signatures against the account's real signer set.
 *   4. a short-lived session token is issued.
 *
 * Step 3 uses the account's medium threshold and its actual signers when the
 * account exists on the network, so a multisig account cannot be authenticated by
 * one of several required keys. For an account Horizon has never seen, SEP-10
 * permits accepting the master key alone, and that is what happens.
 */

import { Horizon, Keypair, WebAuth } from "@stellar/stellar-sdk";
import { SignJWT, jwtVerify } from "jose";

import {
  ConfigurationError,
  HOME_DOMAIN,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  WEB_AUTH_DOMAIN,
  sep10ServerSecret,
  sessionSecret,
} from "./config";

/** How long a challenge may sit unanswered. */
const CHALLENGE_TIMEOUT_SECONDS = 300;
/** How long a session lasts once established. */
const SESSION_LIFETIME = "1h";

export class Sep10Error extends Error {}

/**
 * The challenge signing key.
 *
 * `fromSecret` rejects anything that is not a well-formed `S...` seed, and the
 * ways that happens on a host are all the same mistake — a value pasted with
 * quotes, a trailing newline, or the `G...` public key where the seed belongs.
 * Reported as configuration rather than as a bad key, because the person who can
 * fix it is looking at an environment variable, not at cryptography.
 */
function serverKeypair(): Keypair {
  const secret = sep10ServerSecret();
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new ConfigurationError(
      "QUIETSTAY_SEP10_SERVER_SECRET is set but is not a Stellar secret seed — it must " +
        "start with S and be 56 characters, with no quotes or surrounding whitespace.",
    );
  }
}

/** The account a client must add as a signer trust anchor. Public information. */
export function serverAccount(): string {
  return serverKeypair().publicKey();
}

/** Step 1: a challenge for `account` to sign. */
export function buildChallenge(account: string): {
  transaction: string;
  network_passphrase: string;
} {
  if (!/^G[A-Z2-7]{55}$/.test(account)) {
    throw new Sep10Error("account must be a Stellar public key (G...)");
  }

  const transaction = WebAuth.buildChallengeTx(
    serverKeypair(),
    account,
    HOME_DOMAIN,
    CHALLENGE_TIMEOUT_SECONDS,
    NETWORK_PASSPHRASE,
    WEB_AUTH_DOMAIN,
  );

  return { transaction, network_passphrase: NETWORK_PASSPHRASE };
}

/**
 * Step 3: validate a signed challenge and mint a session token.
 *
 * Returns the authenticated account. Throws if the challenge was altered, is for
 * another domain or network, has expired, or is not signed to the account's own
 * threshold.
 */
export async function verifyChallenge(signedTransaction: string): Promise<{
  account: string;
  token: string;
}> {
  const serverAccountId = serverKeypair().publicKey();

  let parsed: ReturnType<typeof WebAuth.readChallengeTx>;
  try {
    parsed = WebAuth.readChallengeTx(
      signedTransaction,
      serverAccountId,
      NETWORK_PASSPHRASE,
      HOME_DOMAIN,
      WEB_AUTH_DOMAIN,
    );
  } catch (error) {
    throw new Sep10Error(
      `challenge rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const client = parsed.clientAccountID;
  const horizon = new Horizon.Server(HORIZON_URL);

  let signers: Horizon.ServerApi.AccountRecordSigners[] | null = null;
  let medThreshold = 0;
  try {
    const account = await horizon.loadAccount(client);
    signers = account.signers;
    medThreshold = account.thresholds.med_threshold;
  } catch {
    // Not on the network yet. SEP-10 allows authenticating such an account with
    // its master key, since there is no signer configuration to respect.
    signers = null;
  }

  try {
    if (signers && medThreshold > 0) {
      WebAuth.verifyChallengeTxThreshold(
        signedTransaction,
        serverAccountId,
        NETWORK_PASSPHRASE,
        medThreshold,
        signers,
        HOME_DOMAIN,
        WEB_AUTH_DOMAIN,
      );
    } else {
      WebAuth.verifyChallengeTxSigners(
        signedTransaction,
        serverAccountId,
        NETWORK_PASSPHRASE,
        [client],
        HOME_DOMAIN,
        WEB_AUTH_DOMAIN,
      );
    }
  } catch (error) {
    throw new Sep10Error(
      `signature check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const token = await new SignJWT({ sub: client, aud: WEB_AUTH_DOMAIN })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(HOME_DOMAIN)
    .setIssuedAt()
    .setExpirationTime(SESSION_LIFETIME)
    .sign(sessionSecret());

  return { account: client, token };
}

/**
 * The account a bearer token authenticates, or `null`.
 *
 * Every route that acts on someone's behalf calls this. A route that skipped it
 * would be taking the browser's word for who the caller is.
 */
export async function authenticatedAccount(request: Request): Promise<string | null> {
  const header = request.headers.get("authorization");
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, sessionSecret(), {
      issuer: HOME_DOMAIN,
      audience: WEB_AUTH_DOMAIN,
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
