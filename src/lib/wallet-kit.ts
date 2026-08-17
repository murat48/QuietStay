/**
 * Stellar Wallets Kit bootstrap.
 *
 * One wallet-agnostic entry point for the app: the user picks Freighter, xBull,
 * Albedo, Rabet, Lobstr, or Hana from the kit's own modal, and everything
 * downstream — SEP-10 challenges, transfer envelopes, offers — is signed through
 * the same three calls.
 *
 * ## Why the modules are listed rather than `allowAllModules()`
 *
 * The convenience helper pulls in every integration the kit ships, including
 * WalletConnect (`@reown/appkit`), Trezor, Ledger, and HOT. Those drag in
 * `@coinbase/cdp-sdk`, `@trezor/connect`, and `elliptic` — hundreds of kilobytes
 * of code this app never executes, some of it carrying published advisories.
 *
 * Naming the six browser wallets keeps that code out of the bundle entirely
 * instead of shipping it and hoping nobody reaches it. Adding hardware or
 * WalletConnect support later is one import each, and a deliberate decision rather
 * than a default.
 *
 * ## Why it is loaded lazily
 *
 * The kit renders its modal with Preact and touches `document` as it initialises,
 * so importing it at module scope would break server rendering. It is imported on
 * first use, in the browser, and the promise is cached so the modal is only ever
 * built once.
 */

import { NETWORK_PASSPHRASE } from "./config";

/** The subset of the kit this app calls. Keeps the dynamic import honest. */
interface Kit {
  authModal(): Promise<{ address: string }>;
  getAddress(): Promise<{ address: string }>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
  disconnect(): Promise<void>;
}

let kitPromise: Promise<Kit> | null = null;

/**
 * Initialise the kit once and hand back the same instance thereafter.
 *
 * The kit's API is static, so "the instance" is the class itself; the promise
 * exists to make sure `init` runs exactly once even if two components ask at the
 * same moment.
 */
export function walletKit(): Promise<Kit> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("the wallet kit is only available in the browser"));
  }

  kitPromise ??= (async () => {
    const [
      { StellarWalletsKit, Networks },
      { FreighterModule },
      { xBullModule },
      { AlbedoModule },
      { RabetModule },
      { LobstrModule },
      { HanaModule },
    ] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      import("@creit.tech/stellar-wallets-kit/modules/xbull"),
      import("@creit.tech/stellar-wallets-kit/modules/albedo"),
      import("@creit.tech/stellar-wallets-kit/modules/rabet"),
      import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
      import("@creit.tech/stellar-wallets-kit/modules/hana"),
    ]);

    StellarWalletsKit.init({
      // Testnet only. Phase 1 does not deploy to mainnet and has no switch for it.
      network: Networks.TESTNET,
      modules: [
        new FreighterModule(),
        new xBullModule(),
        new AlbedoModule(),
        new RabetModule(),
        new LobstrModule(),
        new HanaModule(),
      ],
    });

    return StellarWalletsKit as unknown as Kit;
  })();

  return kitPromise;
}

/** Open the wallet chooser and return the address the user connected. */
export async function connectWallet(): Promise<string> {
  const kit = await walletKit();
  const { address } = await kit.authModal();
  if (!address) throw new Error("no account was selected");
  return address;
}

/** The connected address, or `null` if nothing is connected yet. */
export async function connectedAddress(): Promise<string | null> {
  try {
    const kit = await walletKit();
    const { address } = await kit.getAddress();
    return address || null;
  } catch {
    return null;
  }
}

/**
 * Confirm the wallet is on testnet.
 *
 * Returns the wallet's network name when it can report one. Some wallets (Albedo,
 * for instance) do not expose a network at all, in which case this returns `null`
 * rather than inventing a mismatch — the transaction itself carries the testnet
 * passphrase, so a wallet on the wrong network will refuse or produce a signature
 * the network rejects. Better an honest `null` than a false assurance.
 */
export async function walletNetwork(): Promise<string | null> {
  try {
    const kit = await walletKit();
    const { networkPassphrase, network } = await kit.getNetwork();
    if (!networkPassphrase) return null;
    if (networkPassphrase !== NETWORK_PASSPHRASE) {
      throw new NetworkMismatch(network || networkPassphrase);
    }
    return network || networkPassphrase;
  } catch (error) {
    if (error instanceof NetworkMismatch) throw error;
    return null;
  }
}

export class NetworkMismatch extends Error {
  constructor(readonly walletNetworkName: string) {
    super(
      `Your wallet is on ${walletNetworkName}. QuietStay Phase 1 is testnet only — ` +
        "switch networks and reconnect.",
    );
    this.name = "NetworkMismatch";
  }
}

/** Sign a transaction envelope with the connected wallet. */
export async function signWithWallet(xdr: string, address: string): Promise<string> {
  const kit = await walletKit();
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address,
  });
  if (!signedTxXdr) throw new Error("the wallet returned no signature");
  return signedTxXdr;
}

export async function disconnectWallet(): Promise<void> {
  try {
    const kit = await walletKit();
    await kit.disconnect();
  } catch {
    // Not every module implements disconnect; clearing local session is enough.
  }
}
