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
 *
 * **Phase 3: two kinds of account.** A regular wallet (`G…`) signs in with SEP-10,
 * as before. A passkey smart wallet (`C…`, src/lib/passkey-wallet.ts) signs in
 * with SEP-45, and every transaction it approves is paid for by the testnet fee
 * account through /api/tx/sponsor. Screens use `sign`, `submitSigned` and
 * `signConsent`, which do the right thing for either kind.
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
  signAuthEntryWithWallet,
  signWithWallet,
  walletNetwork,
} from "@/lib/wallet-kit";
import { PASSKEY_FALLBACK, passkeySupport } from "@/lib/passkey";
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

export type AccountKind = "wallet" | "passkey";

/** What /api/tx/submit and /api/tx/sponsor both answer. */
export interface SubmitOutcome {
  hash?: string;
  successful?: boolean;
  failure?: string;
  explorer?: string;
  error?: string;
}

interface WalletState {
  address: string | null;
  /** A regular wallet (G…, SEP-10) or a passkey smart wallet (C…, SEP-45). */
  kind: AccountKind | null;
  /** Set only after SEP-10 succeeds. */
  token: string | null;
  authenticated: boolean;
  /**
   * True while the page is still finding the wallet and taking up this tab's
   * saved session after a load. Screens show "resuming" then, not Sign in:
   * a Sign in pressed in that moment asked for the passkey for nothing (found
   * on the testnet demo, 2026-11-25).
   */
  restoring: boolean;
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
  /** Sign in with a passkey smart wallet, creating one first if `create`. */
  connectPasskey: (create: boolean) => Promise<void>;
  /** Whether this browser can use a passkey, and if not, why and what to use instead. */
  passkey: { supported: boolean | null; reason?: string; fallback: string };
  disconnect: () => void;
  /** Re-read the account's standing, e.g. after a transfer changes it. */
  refreshStanding: () => Promise<void>;
  /**
   * A regular wallet signs the envelope. A passkey signs the wallet's own
   * authorization entries; the fee account signs the envelope later.
   */
  sign: (xdr: string) => Promise<string>;
  /** Submit what `sign` returned: /api/tx/submit, or /api/tx/sponsor for a passkey. */
  submitSigned: (signedXdr: string) => Promise<SubmitOutcome & { ok: boolean }>;
  /** Sign a Soroban authorization preimage (a buyer's consent). Freighter and Hana only. */
  signAuth: (preimageXdr: string) => Promise<string>;
  /**
   * A buyer's consent, from /api/requests/consent: a regular wallet signs the
   * preimage (Freighter, Hana); a passkey signs the entry itself.
   */
  signConsent: (toSign: { entry: string; preimage: string; valid_until_ledger: number }) => Promise<
    { signature: string } | { signed_entry: string }
  >;
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
}

const WalletContext = createContext<WalletState | null>(null);

/**
 * The one kind of account this browser last signed in with. One account at a
 * time (your decision, 2026-11-26): on load only that kind is looked for, so a
 * regular wallet still connected to this site does not take the place of a
 * passkey wallet, nor the other way round. Only this choice is kept, never an
 * address or a key. (`quietstay:passkey-wallet` = "1" is the older hint, read
 * as "passkey".)
 */
const LAST_KIND = "quietstay:account-kind";
const PASSKEY_HINT = "quietstay:passkey-wallet";
function lastKind(): AccountKind | null {
  try {
    const k = localStorage.getItem(LAST_KIND);
    if (k === "wallet" || k === "passkey") return k;
    return localStorage.getItem(PASSKEY_HINT) === "1" ? "passkey" : null;
  } catch {
    return null;
  }
}
function rememberKind(k: AccountKind | null): void {
  try {
    localStorage.removeItem(PASSKEY_HINT);
    if (k) localStorage.setItem(LAST_KIND, k);
    else localStorage.removeItem(LAST_KIND);
  } catch {
    // storage unavailable: the user picks again after a reload
  }
}

/**
 * The session token, kept in this browser (localStorage, shared by its tabs),
 * so that a reload, a full page load between screens, or a link opened in a
 * new tab does not ask for the passkey or the wallet again (found on the
 * testnet demo, 2026-11-25 and 11-26; a tab-only store asked again in every
 * new tab). It lasts at most the token's hour, is cleared by Disconnect in
 * every tab, and is used only while unexpired and only for
 * the address the wallet names again on load. The token signs nothing: every
 * transaction still needs the wallet or the passkey.
 */
const SESSION_KEY = "quietstay:session";
interface SavedSession {
  address: string;
  kind: AccountKind;
  token: string;
}
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
function savedSession(): SavedSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as SavedSession | null;
    const exp = s ? tokenExpiry(s.token) : null;
    // A minute's margin: a token about to end is not worth restoring.
    return s && exp !== null && exp - 60_000 > Date.now() ? s : null;
  } catch {
    return null;
  }
}
function saveSession(s: SavedSession | null): void {
  try {
    // The tab-only copy of earlier builds is dropped, so it cannot come back.
    sessionStorage.removeItem(SESSION_KEY);
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable: the session simply lasts as long as this page
  }
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside <WalletProvider>");
  return context;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<AccountKind | null>(null);
  const [passkey, setPasskey] = useState<WalletState["passkey"]>({ supported: null, fallback: PASSKEY_FALLBACK });
  useEffect(() => {
    void passkeySupport().then((r) => setPasskey({ ...r, fallback: PASSKEY_FALLBACK }));
  }, []);
  const [token, setToken] = useState<string | null>(null);
  const [standing, setStanding] = useState<AccountStanding | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  // Assume it works until told otherwise: the alternative hides a working control.
  const [canRequest, setCanRequest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True on the first render (server and client alike), until the load-time
  // check below has finished or found nothing saved.
  const [restoring, setRestoring] = useState(true);

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

  // Show the address again if a wallet is already connected to this origin, and
  // take up this tab's session if it is still valid for that same address.
  useEffect(() => {
    const resume = async (wallet: string, walletKind: AccountKind) => {
      setAddress(wallet);
      setKind(walletKind);
      const saved = savedSession();
      if (!saved || saved.address !== wallet || saved.kind !== walletKind) return saveSession(null);
      try {
        await loadStanding(saved.token);
        setToken(saved.token);
      } catch {
        // refused (expired, or the server's signing key changed): sign in again
        saveSession(null);
      }
    };
    void (async () => {
      // Nothing saved for this tab: offer sign-in at once, and look for the
      // wallet in the background.
      if (!savedSession()) setRestoring(false);
      try {
        const last = lastKind();
        // Only the kind last signed in with. A passkey wallet's kit is loaded
        // only then, never for regular-wallet users.
        // Disconnect forgets the kind, so nothing is taken up after it, even
        // though the wallet's selection and the passkey kit's session are kept
        // (they make the next sign-in a single prompt).
        if (last === "wallet") {
          const known = await connectedAddress();
          if (known) return await resume(known, "wallet");
        }
        if (last === "passkey") {
          const pk = await import("@/lib/passkey-wallet");
          const wallet = await pk.restoredPasskeyWallet();
          if (wallet) return await resume(wallet, "passkey");
        }
        saveSession(null);
      } finally {
        setRestoring(false);
      }
    })();
  }, [loadStanding]);

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
      // 1. pick a wallet. Signing in again to the same wallet (the session
      // ended, or a new tab) uses the one already picked, so it is one
      // prompt (testnet demo, 2026-11-26). After Disconnect the kind is
      // forgotten and the picker opens, so another wallet or account can be
      // chosen (found on the demo the same day: Disconnect then left no way
      // to sign in with another wallet).
      const sameWallet = lastKind() === "wallet" ? await connectedAddress() : null;
      const connected = sameWallet ?? (await connectWallet());
      setAddress(connected);
      setKind("wallet");
      rememberKind("wallet");

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
      saveSession({ address: connected, kind: "wallet", token: session.token });

      // 3. what the registry says this account is
      await loadStanding(session.token);
    } catch (caught) {
      if (caught instanceof NetworkMismatch) setError(caught.message);
      else setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [loadStanding]);

  const connectPasskey = useCallback(
    async (create: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const support = await passkeySupport();
        if (!support.supported) throw new Error(`${PASSKEY_FALLBACK} (${support.reason})`);
        const pk = await import("@/lib/passkey-wallet");
        // 1. the passkey names its wallet, creating it first if asked
        const wallet = create ? await pk.createPasskeyWallet() : await pk.connectPasskeyWallet();
        setAddress(wallet);
        setKind("passkey");
        rememberKind("passkey");
        // 2. SEP-45: the passkey proves control of the wallet
        const sessionToken = await pk.signInWithPasskey(wallet);
        setToken(sessionToken);
        saveSession({ address: wallet, kind: "passkey", token: sessionToken });
        // 3. what the registry says this account is
        await loadStanding(sessionToken);
      } catch (caught) {
        const name = (caught as { name?: string } | null)?.name;
        setError(name === "NotAllowedError" ? "The passkey prompt was cancelled or failed. Nothing was signed." : describeError(caught));
      } finally {
        setBusy(false);
      }
    },
    [loadStanding],
  );

  // A session lasts an hour (SESSION_LIFETIME in sep10.ts). When it ends, say so
  // and offer Sign in again, rather than keep showing a signed-in account whose
  // every request the server now refuses as "not authenticated".
  const endSession = useCallback(() => {
    setToken(null);
    saveSession(null);
    setError("Your session ended — sign in again to continue.");
  }, []);

  useEffect(() => {
    if (!token) return;
    // An unreadable token is left to the server's 401 (authFetch).
    const expiresAt = tokenExpiry(token);
    if (expiresAt === null) return;
    const timer = setTimeout(endSession, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [token, endSession]);

  const disconnect = useCallback(() => {
    setToken(null);
    saveSession(null);
    setAddress(null);
    setStanding(null);
    setError(null);
    // Signing out ends the session in every tab (the storage listener below).
    // The wallet's selection and the passkey kit's own session are kept: they
    // only name a public address, and keeping them makes the next sign-in one
    // prompt, not two (the passkey kit asked for the passkey once to find the
    // wallet and again to sign in). Nothing signs without a new prompt.
    rememberKind(null);
    setKind(null);
  }, []);

  // Another tab signed out, or signed in as another account: follow it. A new
  // token for the same account (that tab signed in again) is taken up as is.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_KEY) return;
      const next = savedSession();
      if (next && next.address === address && next.kind === kind) {
        setToken(next.token);
        return;
      }
      if (!next && !token) return;
      window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [address, kind, token]);

  const sign = useCallback(
    async (xdr: string): Promise<string> => {
      if (!address) throw new Error("connect a wallet first");
      if (kind === "passkey") {
        const pk = await import("@/lib/passkey-wallet");
        try {
          return await pk.signWalletEntries(xdr, address);
        } catch (caught) {
          if ((caught as { name?: string } | null)?.name === "NotAllowedError") {
            throw new Error("The passkey prompt was cancelled or failed. Nothing was signed or sent.");
          }
          throw caught;
        }
      }
      return signWithWallet(xdr, address);
    },
    [address, kind],
  );

  const signConsent = useCallback<WalletState["signConsent"]>(
    async (toSign) => {
      if (!address) throw new Error("connect a wallet first");
      if (kind === "passkey") {
        const pk = await import("@/lib/passkey-wallet");
        return { signed_entry: await pk.signEntry(toSign.entry, toSign.valid_until_ledger) };
      }
      return { signature: await signAuthEntryWithWallet(toSign.preimage, address) };
    },
    [address, kind],
  );

  const signAuth = useCallback(
    async (preimageXdr: string): Promise<string> => {
      if (!address) throw new Error("connect a wallet first");
      return signAuthEntryWithWallet(preimageXdr, address);
    },
    [address],
  );

  const authFetch = useCallback(
    async (input: string, init: RequestInit = {}) => {
      const response = await fetch(input, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
      // Sent a token and was told there is no session: it expired, or the server's
      // signing settings changed under it. Either way it is gone.
      if (token && response.status === 401) endSession();
      return response;
    },
    [token, endSession],
  );

  const submitSigned = useCallback(
    async (signedXdr: string) => {
      const response = await authFetch(kind === "passkey" ? "/api/tx/sponsor" : "/api/tx/submit", {
        method: "POST",
        body: JSON.stringify({ xdr: signedXdr }),
      });
      return { ...((await response.json()) as SubmitOutcome), ok: response.ok };
    },
    [kind, authFetch],
  );

  const value = useMemo<WalletState>(
    () => ({
      address,
      kind,
      connectPasskey,
      passkey,
      submitSigned,
      signConsent,
      token,
      authenticated: token !== null,
      restoring,
      standing,
      readOnly,
      canRequest,
      busy,
      error,
      connect,
      disconnect,
      refreshStanding,
      sign,
      signAuth,
      authFetch,
    }),
    [address, kind, connectPasskey, passkey, submitSigned, signConsent, token, restoring, standing, readOnly, canRequest, busy, error, connect, disconnect, refreshStanding, sign, signAuth, authFetch],
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
  const { address, kind, authenticated, restoring, standing, busy, error, connect, connectPasskey, passkey, disconnect } = useWallet();
  const [choosing, setChoosing] = useState(false);

  return (
    <div className="wallet">
      {restoring && !authenticated ? (
        <span className="tag" data-testid="session-resuming">
          resuming your session…
        </span>
      ) : address ? (
        <>
          <span className="addr" title={address}>
            {kind === "passkey" ? "🔑 " : ""}
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
            <button onClick={() => void (kind === "passkey" ? connectPasskey(false) : connect())} disabled={busy}>
              {busy ? "signing…" : "Sign in"}
            </button>
          )}
          <button onClick={disconnect}>Disconnect</button>
        </>
      ) : choosing ? (
        <span className="passkey-choice" data-testid="passkey-choice">
          {passkey.supported === false ? (
            <span className="note warn" role="status" data-testid="passkey-unsupported" style={{ margin: 0 }}>
              {passkey.fallback}
            </span>
          ) : (
            <>
              <button className="primary" onClick={() => void connectPasskey(true)} disabled={busy || passkey.supported !== true}>
                {busy ? "waiting for your passkey…" : "Create a passkey wallet"}
              </button>
              <button onClick={() => void connectPasskey(false)} disabled={busy || passkey.supported !== true}>
                Sign in with my passkey
              </button>
            </>
          )}
          <button onClick={() => setChoosing(false)} disabled={busy}>
            Back
          </button>
        </span>
      ) : (
        <>
          <button className="primary" onClick={() => void connect()} disabled={busy}>
            {busy ? "connecting…" : "Connect wallet"}
          </button>
          <button onClick={() => setChoosing(true)} disabled={busy}>
            Use a passkey
          </button>
        </>
      )}

      {error ? (
        <span className="tag bad" title={error} data-testid="wallet-error">
          {error.length > 44 ? `${error.slice(0, 44)}…` : error}
        </span>
      ) : null}
    </div>
  );
}
