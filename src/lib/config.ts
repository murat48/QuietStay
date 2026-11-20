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
  "CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD";

/**
 * The Phase 1 deployment: issuer-approved transfers. Delivered and closed; its
 * evidence stays on chain and in docs/EVIDENCE.md, and nothing in the app
 * talks to it any more.
 */
export const PHASE1_CONTRACT_ID = "CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M";

/** Explorer links, for evidence a reviewer can open without tooling. */
export const explorer = {
  contract: (id: string = CONTRACT_ID) =>
    `https://stellar.expert/explorer/testnet/contract/${id}`,
  tx: (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
  account: (address: string) => `https://stellar.expert/explorer/testnet/account/${address}`,
};

/**
 * How long a buyer's signed consent to a sale stays usable, in ledgers (~5s
 * each): about a week. The buyer signs when asking for a week; the holder then
 * has this long to prove ownership and submit. The signature covers only the
 * right and the buyer's own secret hash, so it authorizes nothing else.
 */
export const BUYER_CONSENT_LEDGERS = 120_960;

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

/**
 * A secret the deployment needs and does not have.
 *
 * Distinct from every other failure because the cause is not the request: the
 * caller did nothing wrong and cannot do anything differently. Routes answer it
 * as a server fault and repeat the message, which names the variable — a
 * deployment missing one of these otherwise fails in whatever code touched it
 * first, and the operator reads a symptom instead of the cause.
 */
export class ConfigurationError extends Error {}

/** Where to fill a missing variable in, phrased for whoever is reading it. */
function missing(name: string, note: string): ConfigurationError {
  return new ConfigurationError(
    `${name} is not set — ${note} Locally that means .env.local (copy .env.example); ` +
      "on a host it means the project's environment variables. " +
      "See docs/SETUP.md, or docs/VERCEL.md for a deployment.",
  );
}

/** Server-only. Absent in the browser bundle, and absent from the repository. */
export function issuerSecret(): string {
  const secret = process.env.QUIETSTAY_ISSUER_SECRET;
  if (!secret) {
    throw missing("QUIETSTAY_ISSUER_SECRET", "the issuer's signing key.");
  }
  return secret;
}

/**
 * A host, as SEP-10 wants it: a domain, optionally with a port, and nothing else.
 *
 * The value gets pasted from a browser's address bar more often than it gets
 * typed, so it arrives with a scheme, a trailing slash, or both. Those are
 * unambiguous about what was meant — `https://example.com/` is the host
 * `example.com` — and the spec admits only one spelling, so they are corrected
 * rather than carried into a challenge nobody's wallet would recognise.
 *
 * The port survives: `localhost:3000` is a legitimate home domain and is what
 * development uses.
 */
function asHost(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/.*$/, "");
}

/**
 * The SEP-10 home domain this deployment authenticates for.
 *
 * Read at runtime, not baked into the bundle: `sep10.ts` is the only consumer and
 * it never runs in a browser, so the value has no reason to ship to one. That
 * also means changing the domain takes effect on the next request rather than
 * requiring a rebuild — which matters, because on a host the URL is not known
 * until the first deploy has already happened.
 *
 * `NEXT_PUBLIC_HOME_DOMAIN` still works, so a deployment configured before this
 * keeps authenticating. It is not secret either way — the home domain is the site
 * somebody is already looking at.
 */
export const HOME_DOMAIN = asHost(
  process.env.QUIETSTAY_HOME_DOMAIN ?? process.env.NEXT_PUBLIC_HOME_DOMAIN ?? "localhost:3000",
);

export const WEB_AUTH_DOMAIN = asHost(
  process.env.QUIETSTAY_WEB_AUTH_DOMAIN ?? process.env.NEXT_PUBLIC_WEB_AUTH_DOMAIN ?? HOME_DOMAIN,
);

/** Server-only: the SEP-10 challenge signing key and session secret. */
export function sep10ServerSecret(): string {
  const secret = process.env.QUIETSTAY_SEP10_SERVER_SECRET;
  if (!secret) {
    throw missing(
      "QUIETSTAY_SEP10_SERVER_SECRET",
      "the key that signs SEP-10 challenges, so nobody can sign in.",
    );
  }
  return secret;
}

export function sessionSecret(): Uint8Array {
  const secret = process.env.QUIETSTAY_SESSION_SECRET;
  if (!secret) {
    throw missing(
      "QUIETSTAY_SESSION_SECRET",
      "the key that signs session tokens, so nobody can sign in.",
    );
  }
  if (secret.length < 32) {
    throw new ConfigurationError(
      `QUIETSTAY_SESSION_SECRET is ${secret.length} characters; it must be at least 32. ` +
        "See docs/SETUP.md.",
    );
  }
  return new TextEncoder().encode(secret);
}

/** The customer-discovery survey linked from the home page and the footer. */
export const SURVEY_URL = "https://forms.gle/X3ismSnCbhAjkAu1A";

// --- Phase 3: passkey smart wallets ------------------------------------------

/**
 * The SEP-45 web-auth contract (contracts/vendor/anchor-web-auth/, pinned and
 * unmodified), deployed on testnet in Step 2 with an admin nobody can
 * authorize. It holds nothing and the rights contract never calls it.
 */
export const WEB_AUTH_CONTRACT_ID =
  process.env.NEXT_PUBLIC_QUIETSTAY_WEB_AUTH_CONTRACT_ID ?? "CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM";

/** The OpenZeppelin smart-account build new wallets use (spec §12). */
export const SMART_ACCOUNT_WASM_HASH = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
/** The OpenZeppelin WebAuthn verifier on testnet (checked on chain in Step 2). */
export const WEBAUTHN_VERIFIER_ID = "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";

/**
 * The testnet fee account's public address (`qs-fee-testnet`, decision D6).
 * Public: a passkey transaction names it as source. Its secret is server-only.
 */
export const FEE_ACCOUNT =
  process.env.NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT ?? "GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z";

/** Server-only: the testnet fee key, for /api/tx/sponsor and nothing else. */
export function testnetFeeSecret(): string {
  const secret = process.env.QUIETSTAY_TESTNET_FEE_SECRET;
  if (!secret) throw missing("QUIETSTAY_TESTNET_FEE_SECRET", "the testnet fee key (qs-fee-testnet).");
  return secret;
}

/**
 * The USDC Stellar Asset Contract the rights contract is constructed with on
 * testnet (docs/PHASE3_SPEC.md §4). Circle's testnet issuer
 * `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, from
 * developers.circle.com/stablecoins/usdc-contract-addresses, read 2026-11-19;
 * contract id from `stellar contract id asset --asset USDC:GBBD…LLA5 --network testnet`.
 *
 * The contract, not this constant, is the authority: it fixes the token in its
 * constructor and `usdc()` reads it back. The fee route uses this constant to
 * recognise the one USDC call it lets a smart wallet authorize (§13).
 */
export const USDC_CONTRACT_ID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** USDC has 7 decimals on Stellar: amounts are i128 counts of 10^-7 USDC. */
export const USDC_DECIMALS = 7;

/** How long a new offer or record request stays open by default: 7 days of ~5 s ledgers (D9). */
export const OFFER_LEDGERS = 120_960;
