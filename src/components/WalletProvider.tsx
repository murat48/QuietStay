"use client";

/**
 * Wallet connection, SEP-10 session, and the account's standing on the registry.
 *
 * Connecting is three steps, and the app treats them as three different amounts of
 * knowledge:
 *
 *   1. **A wallet names an address.** That is a claim. It buys a read-only view and
 *      nothing else.
 *   2. **SEP-10 proves control of it.** The server issues a challenge, the wallet
 *      signs it, and the server checks the signature against the account's real
 *      signer set before minting a session token. Every route that acts on someone's
 *      behalf requires that token.
 *   3. **The registry says what the account is.** Issuer, owner, renter, or none —
 *      read from the contract, never declared. See `src/lib/roles.ts`.
 *
 * Step 3 decides what the interface offers. It never decides what the contract
 * allows; the contract enforces all of it independently.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  NetworkMismatch,
  connectWallet,
  connectedAddress,
  disconnectWallet,
  signWithWallet,
  walletNetwork,
} from "@/lib/wallet-kit";
import type { AccountStanding, Role, RightSummary } from "@/lib/roles";
import { describeError } from "@/lib/format";

interface StandingResponse {
  account: string;
  roles: Role[];
  is_issuer: boolean;
  owned: RightSummary[];
  renting: RightSummary[];
  rented_out: RightSummary[];
  read_only?: boolean;
  can_request?: boolean;
  error?: string;
}

interface WalletState {
  address: string | null;
  /** Set only after SEP-10 succeeds. */
  token: string | null;
  authenticated: boolean;
  /** Roles read off the registry. `null` until signed in. */
  standing: AccountStanding | null;
  /**
   * Whether this deployment holds the issuer key. A public one is not expected
   * to, so screens hide what it could not sign. `false` until known, which is
   * the safe way round: a control that appears late is better than one that
   * flashes and disappears.
   */
  readOnly: boolean;
  /**
   * Whether this deployment can record a transfer request. False on a host with
   * a read-only filesystem, where the ask would be taken and then lost.
   */
  canRequest: boolean;
  busy: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Re-read the account's standing, e.g. after a transfer changes it. */
  refreshStanding: () => Promise<void>;
  sign: (xdr: string) => Promise<string>;
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
}

const WalletContext = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside <WalletProvider>");
  return context;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [standing, setStanding] = useState<AccountStanding | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  // Assume it works until told otherwise: the alternative hides a working control.
  const [canRequest, setCanRequest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the address again if a wallet is already connected to this origin. This
  // does not restore a session: the SEP-10 signature is what grants one, and it is
  // deliberately not persisted.
  useEffect(() => {
    void (async () => {
      const known = await connectedAddress();
      if (known) setAddress(known);
    })();
  }, []);

  const loadStanding = useCallback(async (sessionToken: string) => {
    const response = await fetch("/api/me", {
      headers: { authorization: `Bearer ${sessionToken}` },
      cache: "no-store",
    });
    const body = (await response.json()) as StandingResponse;
    if (!response.ok) throw new Error(body.error ?? "could not read your standing");

    setReadOnly(body.read_only === true);
    setCanRequest(body.can_request !== false);
    setStanding({
      account: body.account,
      roles: body.roles,
      isIssuer: body.is_issuer,
      owned: body.owned,
      renting: body.renting,
      rentedOut: body.rented_out,
    });
  }, []);

  const refreshStanding = useCallback(async () => {
    if (!token) return;
    try {
      await loadStanding(token);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [token, loadStanding]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // 1. pick a wallet
      const connected = await connectWallet();
      setAddress(connected);

      // Surfaces a wrong-network wallet before asking for a signature that could
      // not be used. Wallets that do not report a network return null and are
      // allowed through — the transaction carries the passphrase regardless.
      await walletNetwork();

      // 2. SEP-10
      const challengeResponse = await fetch(
        `/api/auth?account=${encodeURIComponent(connected)}`,
      );
      const challenge = (await challengeResponse.json()) as {
        transaction?: string;
        error?: string;
      };
      if (!challengeResponse.ok || !challenge.transaction) {
        throw new Error(challenge.error ?? "could not get an authentication challenge");
      }

      const signedChallenge = await signWithWallet(challenge.transaction, connected);

      const sessionResponse = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: signedChallenge }),
      });
      const session = (await sessionResponse.json()) as { token?: string; error?: string };
      if (!sessionResponse.ok || !session.token) {
        throw new Error(session.error ?? "authentication failed");
      }

      setToken(session.token);

      // 3. what the registry says this account is
      await loadStanding(session.token);
    } catch (caught) {
      if (caught instanceof NetworkMismatch) setError(caught.message);
      else setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [loadStanding]);

  const disconnect = useCallback(() => {
    setToken(null);
    setAddress(null);
    setStanding(null);
    setError(null);
    void disconnectWallet();
  }, []);

  const sign = useCallback(
    async (xdr: string): Promise<string> => {
      if (!address) throw new Error("connect a wallet first");
      return signWithWallet(xdr, address);
    },
    [address],
  );

  const authFetch = useCallback(
    (input: string, init: RequestInit = {}) =>
      fetch(input, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      }),
    [token],
  );

  const value = useMemo<WalletState>(
    () => ({
      address,
      token,
      authenticated: token !== null,
      standing,
      readOnly,
      canRequest,
      busy,
      error,
      connect,
      disconnect,
      refreshStanding,
      sign,
      authFetch,
    }),
    [address, token, standing, readOnly, canRequest, busy, error, connect, disconnect, refreshStanding, sign, authFetch],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Short label for each role, shown next to the address once signed in. */
const ROLE_TAG: Record<Role, { text: string; tone: string }> = {
  issuer: { text: "Issuer", tone: "accent" },
  lessor: { text: "Owner", tone: "ok" },
  lessee: { text: "Renter", tone: "warn" },
  visitor: { text: "Visitor", tone: "" },
};

/**
 * The connect control.
 *
 * States, in order of how much is actually known: nothing connected, an address
 * claimed but unproven, and an account proven with its roles shown. The middle
 * state is labelled rather than hidden, because "connected" and "verified" are not
 * the same thing and conflating them is how interfaces start lying.
 */
export function WalletButton() {
  const { address, authenticated, standing, busy, error, connect, disconnect } = useWallet();

  return (
    <div className="wallet">
      {address ? (
        <>
          <span className="addr" title={address}>
            {address.slice(0, 6)}…{address.slice(-6)}
          </span>

          {authenticated && standing ? (
            standing.roles.map((role) => (
              <span key={role} className={`tag ${ROLE_TAG[role].tone}`}>
                {ROLE_TAG[role].text}
              </span>
            ))
          ) : (
            <span className="tag warn">not verified</span>
          )}

          {authenticated ? null : (
            <button onClick={() => void connect()} disabled={busy}>
              {busy ? "signing…" : "Sign in"}
            </button>
          )}
          <button onClick={disconnect}>Disconnect</button>
        </>
      ) : (
        <button className="primary" onClick={() => void connect()} disabled={busy}>
          {busy ? "connecting…" : "Connect wallet"}
        </button>
      )}

      {error ? (
        <span className="tag bad" title={error}>
          {error.length > 44 ? `${error.slice(0, 44)}…` : error}
        </span>
      ) : null}
    </div>
  );
}
