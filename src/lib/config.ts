/**
 * Network and deployment configuration.
 *
 * Everything here is testnet. Phase 1 does not deploy to mainnet, and there is
 * deliberately no switch that would let it.
 */

export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * The deployed QuietStay rights registry.
 *
 * The literal is the live deployment, not a placeholder, and it has to stay in
 * step with `.env.local`: the CLI scripts call `loadEnv()` in their own file
 * body, which runs *after* their imports have already evaluated this module, so
 * a script reads whatever this default says rather than what the env file holds.
 * Changing the deployment means changing both.
 */
export const CONTRACT_ID =
  process.env.NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID ??
  process.env.QUIETSTAY_CONTRACT_ID ??
  "CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M";

/** Explorer links, for evidence a reviewer can open without tooling. */
export const explorer = {
  contract: (id: string = CONTRACT_ID) =>
    `https://stellar.expert/explorer/testnet/contract/${id}`,
  tx: (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
  account: (address: string) => `https://stellar.expert/explorer/testnet/account/${address}`,
};

/**
 * How long an issuer approval stays usable, in ledgers (~5s each). Short on
 * purpose: an approval is for one transfer happening now, not a standing
 * permission.
 */
export const APPROVAL_VALIDITY_LEDGERS = 120;

/**
 * Where this deployment may write.
 *
 * The repository in development, and on a host with a disk that persists,
 * wherever that disk is mounted. Files that shipped with the build are still
 * read from the working directory — see `attestation-store.ts` on why both are
 * searched rather than one replacing the other.
 *
 * A serverless host has no such place at all. `requests.ts` refuses to write
 * there rather than using `/tmp`, which would take somebody's request and lose
 * it before the holder saw it.
 */
export const DATA_ROOT = process.env.QUIETSTAY_DATA_DIR ?? process.cwd();

/**
 * Whether this deployment holds the issuer key.
 *
 * A public deployment is expected **not** to. The key signs attestations and
 * authorizes every transfer, and unlike the other two secrets it cannot be
 * rotated — the contract fixed its issuer at construction — so a deployment that
 * leaked it could never take that back. Issuing, attesting and approving are
 * therefore done from wherever the key already lives, and the hosted app serves
 * the parts that need no key at all: the registry, verification, and asking for
 * a week.
 *
 * The routes that need it say so plainly rather than failing on a missing
 * environment variable, and the interface stops offering them.
 */
export function hasIssuerSecret(): boolean {
  return (process.env.QUIETSTAY_ISSUER_SECRET ?? "").length > 0;
}

/** Server-only. Absent in the browser bundle, and absent from the repository. */
export function issuerSecret(): string {
  const secret = process.env.QUIETSTAY_ISSUER_SECRET;
  if (!secret) {
    throw new Error(
      "QUIETSTAY_ISSUER_SECRET is not set. Copy .env.example to .env.local and fill it in — " +
        "see docs/SETUP.md.",
    );
  }
  return secret;
}

/** The SEP-10 home domain this deployment authenticates for. */
export const HOME_DOMAIN = process.env.NEXT_PUBLIC_HOME_DOMAIN ?? "localhost:3000";
export const WEB_AUTH_DOMAIN = process.env.NEXT_PUBLIC_WEB_AUTH_DOMAIN ?? HOME_DOMAIN;

/** Server-only: the SEP-10 challenge signing key and session secret. */
export function sep10ServerSecret(): string {
  const secret = process.env.QUIETSTAY_SEP10_SERVER_SECRET;
  if (!secret) {
    throw new Error(
      "QUIETSTAY_SEP10_SERVER_SECRET is not set. Copy .env.example to .env.local — see docs/SETUP.md.",
    );
  }
  return secret;
}

export function sessionSecret(): Uint8Array {
  const secret = process.env.QUIETSTAY_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "QUIETSTAY_SESSION_SECRET must be set to at least 32 characters — see docs/SETUP.md.",
    );
  }
  return new TextEncoder().encode(secret);
}
