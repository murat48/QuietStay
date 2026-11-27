/**
 * Network and deployment configuration.
 *
 * Phase 3, Step 5 (pilot-plan change, 2026-11-23): one build serves both
 * networks, and two settings choose what a deployment is.
 *
 * - `NEXT_PUBLIC_QUIETSTAY_NETWORK`: `testnet` (the default) or `mainnet`.
 *   It picks the passphrase, RPC, Horizon, USDC, explorer links and Friendbot.
 *   Any other value fails the build.
 * - `NEXT_PUBLIC_QUIETSTAY_SIGNING`: `server` (the default on testnet) or
 *   `cli`.
 *   - With `server`, the deployment may hold the testnet issuer and fee keys,
 *     as the testnet demo does.
 *   - With `cli`, it holds neither. Issuing and the passkey fee are envelopes
 *     the owner signs with the CLI (`scripts/mainnet-sign-submit.sh`), and
 *     there is no attestation.
 *   - **Mainnet is always `cli`**: a mainnet build with `server` fails. The
 *     mainnet-like testnet rehearsal sets `cli` on testnet.
 *
 * Both are `NEXT_PUBLIC_` because the browser needs them, and Next.js inlines
 * them at build time. Changing one means a new build.
 */

export type NetworkName = "testnet" | "mainnet";
export type SigningMode = "server" | "cli";

function readNetwork(): NetworkName {
  const v = process.env.NEXT_PUBLIC_QUIETSTAY_NETWORK;
  if (v === undefined || v === "" || v === "testnet") return "testnet";
  if (v === "mainnet") return "mainnet";
  throw new Error(`NEXT_PUBLIC_QUIETSTAY_NETWORK must be "testnet" or "mainnet", not "${v}"`);
}

/** The network this deployment runs on. */
export const NETWORK: NetworkName = readNetwork();
export const IS_MAINNET = NETWORK === "mainnet";

function readSigning(): SigningMode {
  const v = process.env.NEXT_PUBLIC_QUIETSTAY_SIGNING;
  if (v !== undefined && v !== "" && v !== "server" && v !== "cli") {
    throw new Error(`NEXT_PUBLIC_QUIETSTAY_SIGNING must be "server" or "cli", not "${v}"`);
  }
  if (IS_MAINNET) {
    if (v === "server") throw new Error("NEXT_PUBLIC_QUIETSTAY_SIGNING=server is not allowed on mainnet: mainnet signs with the CLI");
    return "cli";
  }
  return v === "cli" ? "cli" : "server";
}

/**
 * How this deployment signs what only the issuer or the fee account can sign.
 * `cli`: the server holds no such key, and `hasIssuerSecret()` is false
 * whatever the environment says.
 */
export const SIGNING: SigningMode = readSigning();
export const CLI_SIGNING = SIGNING === "cli";

/** Attestations are signed by the issuer key on the server, so only in `server` mode (decision 2: none on mainnet). */
export const ATTESTATIONS = SIGNING === "server";

const NETWORKS = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    rpc: "https://soroban-testnet.stellar.org",
    horizon: "https://horizon-testnet.stellar.org",
    explorer: "https://stellar.expert/explorer/testnet",
    friendbot: "https://friendbot.stellar.org",
    label: "testnet",
  },
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    rpc: "https://mainnet.sorobanrpc.com",
    horizon: "https://horizon.stellar.org",
    explorer: "https://stellar.expert/explorer/public",
    friendbot: null,
    label: "mainnet",
  },
} as const;
const NET = NETWORKS[NETWORK];

export const NETWORK_PASSPHRASE: string = NET.passphrase;
export const RPC_URL = process.env.STELLAR_RPC_URL ?? NET.rpc;
export const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? NET.horizon;
/** Friendbot funds testnet accounts only; `null` on mainnet. */
export const FRIENDBOT_URL: string | null = NET.friendbot;
/** The network's name as every screen shows it. */
export const NETWORK_LABEL: string = NET.label;

/**
 * A value this deployment must be given. The testnet demo (testnet, `server`)
 * has defaults. Mainnet, and the mainnet-like rehearsal (`cli`), have none:
 * each id is set explicitly, so a rehearsal never quietly uses the demo's
 * contracts or its fee account.
 */
function perNetwork(value: string | undefined, testnetDefault: string): string {
  if (value) return value;
  return IS_MAINNET || CLI_SIGNING ? "" : testnetDefault;
}

/**
 * The deployed QuietStay rights registry.
 *
 * The literal is the live deployment, not a placeholder, and it has to stay in
 * step with `.env.local`. The CLI scripts read only named variables
 * (`loadEnvVars`), and they do it *after* their imports have already evaluated
 * this module, so a script reads whatever this default says rather than what
 * the env file holds.
 * Changing the deployment means changing both.
 */
export const CONTRACT_ID = perNetwork(
  process.env.NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID ?? process.env.QUIETSTAY_CONTRACT_ID,
  "CCSQRSLC34HLAXB5NSOF7AQFLD6ESSC6PG3JNZKMANZR67YCE7GDF6YD",
);

/**
 * The Phase 1 deployment: issuer-approved transfers. Delivered and closed; its
 * evidence stays on chain and in docs/EVIDENCE.md, and nothing in the app
 * talks to it any more.
 */
export const PHASE1_CONTRACT_ID = "CC3URR3UXTKYPJVU7HWEUTKXPHFEPLZ6X6EXMLYLXY2QDRMQTKMLMF7M";

/** Explorer links on this deployment's network, for evidence a reviewer can open without tooling. */
export const explorer = {
  contract: (id: string = CONTRACT_ID) => `${NET.explorer}/contract/${id}`,
  tx: (hash: string) => `${NET.explorer}/tx/${hash}`,
  account: (address: string) => `${NET.explorer}/account/${address}`,
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
  // In `cli` mode (always on mainnet) the server never uses an issuer key, even
  // if one were set by mistake.
  if (CLI_SIGNING) return false;
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
  if (CLI_SIGNING) {
    throw new ConfigurationError("this deployment signs with the CLI (NEXT_PUBLIC_QUIETSTAY_SIGNING=cli, or mainnet): the server holds no issuer key.");
  }
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
export const WEB_AUTH_CONTRACT_ID = perNetwork(
  process.env.NEXT_PUBLIC_QUIETSTAY_WEB_AUTH_CONTRACT_ID,
  "CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM",
);

/** The OpenZeppelin smart-account build new wallets use (spec §12). */
export const SMART_ACCOUNT_WASM_HASH = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
/**
 * The WebAuthn verifier every new passkey wallet calls: QuietStay's own
 * instance of OpenZeppelin's uploaded verifier WASM `e63a030d…` (no
 * constructor, no admin, no `upgrade`). It was deployed by `qs-issuer` on
 * 2026-11-22, tx 38bbd549…. Before that the app used the kit's manifest
 * instance `CC7EKIHQ…OM3F`, which is someone else's instance (Step 5 review,
 * checklist §5.4). The mainnet instance is deployed in Step 6 and set per
 * deployment with NEXT_PUBLIC_QUIETSTAY_WEBAUTHN_VERIFIER_ID.
 */
export const WEBAUTHN_VERIFIER_ID = perNetwork(
  process.env.NEXT_PUBLIC_QUIETSTAY_WEBAUTHN_VERIFIER_ID,
  "CBK3H55VKCKZ4LRIZSETP3ZYP4OI4IIBN3SCCCFNYI5WDFC45PSWWEEL",
);
/** The verifier WASM it must run, checked on chain (scripts/check-deployment.ts). */
export const WEBAUTHN_VERIFIER_WASM_HASH = "e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76";

/**
 * The fee account's public address (decision D6). Public: a passkey
 * transaction names it as source.
 * - In `server` mode it is `qs-fee-testnet`, and its secret is server-only.
 * - In `cli` mode it is the CLI fee identity (`qs-main-fee` on mainnet), which
 *   the owner signs with; the server holds no fee key.
 */
export const FEE_ACCOUNT = perNetwork(
  process.env.NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT,
  "GCGDZWCLYUC5DLB5TWV5U4MRS4LVR36T5JP5IB6PIYAZKYNVVQGRL77Z",
);

/**
 * Server-only: the fee key, for /api/tx/sponsor and nothing else.
 *
 * D18 (2026-11-27): on mainnet too, so a passkey user never waits for anyone.
 * `QUIETSTAY_FEE_SECRET` is the one setting, on any network and in either
 * signing mode; you set it in Vercel, it is never in a file. Its account
 * holds only a few XLM, and the fee route's rules and limits bound what it
 * pays. The issuer and arbiter keys stay out of the server in `cli` mode.
 * `QUIETSTAY_TESTNET_FEE_SECRET`, the older name, is still read on a testnet
 * `server` deployment (the demo).
 */
export function feeSecret(): string {
  const secret =
    process.env.QUIETSTAY_FEE_SECRET ||
    (!IS_MAINNET && !CLI_SIGNING ? process.env.QUIETSTAY_TESTNET_FEE_SECRET : undefined);
  if (!secret) throw missing("QUIETSTAY_FEE_SECRET", "the fee key that pays passkey fees (D18).");
  return secret;
}

/** Whether this deployment can pay passkey fees (see `feeSecret`). */
export function hasFeeKey(): boolean {
  try {
    return feeSecret().length > 0;
  } catch {
    return false;
  }
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
export const USDC_CONTRACT_ID = IS_MAINNET
  ? // Circle's mainnet issuer GA5ZSEJY…KZVN, same source; `stellar contract id asset --asset USDC:GA5Z…KZVN` (Addresses).
    "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
  : "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** The same issuer, as a wallet asks for it when adding a USDC trustline. Same source. */
export const USDC_ISSUER = IS_MAINNET
  ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * What this deployment still needs before it can run, for the network screen
 * and the health check: mainnet has no defaults for its contract ids.
 */
export function missingConfiguration(): string[] {
  const out: string[] = [];
  if (!CONTRACT_ID) out.push("NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID");
  if (!WEB_AUTH_CONTRACT_ID) out.push("NEXT_PUBLIC_QUIETSTAY_WEB_AUTH_CONTRACT_ID");
  if (!WEBAUTHN_VERIFIER_ID) out.push("NEXT_PUBLIC_QUIETSTAY_WEBAUTHN_VERIFIER_ID");
  if (!FEE_ACCOUNT) out.push("NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT");
  return out;
}

/** USDC has 7 decimals on Stellar: amounts are i128 counts of 10^-7 USDC. */
export const USDC_DECIMALS = 7;

/** How long a new offer or record request stays open by default: 7 days of ~5 s ledgers (D9). */
export const OFFER_LEDGERS = 120_960;
