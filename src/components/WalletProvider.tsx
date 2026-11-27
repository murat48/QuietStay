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
import { createPortal } from "react-dom";

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
import { IS_MAINNET } from "@/lib/config";
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

/**
 * `cli` (2026-11-27): an account signed in by a SEP-10 challenge signed with
 * the Stellar CLI, for the issuer, whose mainnet key lives only in the CLI
 * keystore. Such a session signs nothing in the browser: its transactions
 * are envelopes the CLI signs (scripts/mainnet-sign-submit.sh).
 */
export type AccountKind = "wallet" | "passkey" | "cli";

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
  /** A SEP-10 challenge for `account`, to be signed with the Stellar CLI. */
  cliChallenge: (account: string) => Promise<string>;
  /** Sign in with a challenge the CLI signed (see `cliChallenge`). */
  connectCli: (signedChallenge: string) => Promise<void>;
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
    if (k === "wallet" || k === "passkey" || k === "cli") return k;
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
    const body = (await response.json().catch(() => ({}))) as StandingResponse;
    if (!response.ok) {
      throw Object.assign(new Error(body.error ?? "could not read your standing"), { status: response.status });
    }

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
      // Only the server's refusal (401: expired, or its signing key changed)
      // ends the saved session. Anything else, a network error or a server
      // still starting, is asked again, and the session is kept if it goes on
      // failing: wiping it then made a reload ask to sign in again (found in
      // the CLI test, 2026-11-27).
      for (const wait of [0, 800, 2500]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          await loadStanding(saved.token);
          setToken(saved.token);
          return;
        } catch (caught) {
          if ((caught as { status?: number }).status === 401) return saveSession(null);
        }
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
          // A wallet extension can be slow to answer as the page loads. Ask a
          // few times, and if it still says nothing, keep the saved session
          // for the next load rather than wipe it: a wipe there was one way a
          // reload asked to sign in again (found in the CLI test, 2026-11-27).
          for (const wait of [0, 400, 1200]) {
            if (wait) await new Promise((r) => setTimeout(r, wait));
            const known = await connectedAddress();
            if (known) return await resume(known, "wallet");
          }
          return;
        }
        if (last === "passkey") {
          const pk = await import("@/lib/passkey-wallet");
          const wallet = await pk.restoredPasskeyWallet();
          if (wallet) return await resume(wallet, "passkey");
        }
        // A CLI session has no wallet to ask: its address is the saved one.
        if (last === "cli") {
          const saved = savedSession();
          if (saved?.kind === "cli") return await resume(saved.address, "cli");
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

  const cliChallenge = useCallback(async (account: string): Promise<string> => {
    const res = await fetch(`/api/auth?account=${encodeURIComponent(account.trim())}`);
    const body = (await res.json()) as { transaction?: string; error?: string };
    if (!res.ok || !body.transaction) throw new Error(body.error ?? "could not get an authentication challenge");
    return body.transaction;
  }, []);

  const connectCli = useCallback(
    async (signedChallenge: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transaction: signedChallenge.trim() }),
        });
        const body = (await res.json()) as { token?: string; account?: string; error?: string };
        if (!res.ok || !body.token || !body.account) throw new Error(body.error ?? "authentication failed");
        setAddress(body.account);
        setKind("cli");
        rememberKind("cli");
        setToken(body.token);
        saveSession({ address: body.account, kind: "cli", token: body.token });
        await loadStanding(body.token);
      } catch (caught) {
        setError(describeError(caught));
        throw caught;
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
      if (kind === "cli") {
        throw new Error("this session was signed in with the CLI, which signs nothing in the browser. Sign in with a wallet or a passkey for this, or use the envelope the screen offers.");
      }
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
      cliChallenge,
      connectCli,
      disconnect,
      refreshStanding,
      sign,
      signAuth,
      authFetch,
    }),
    [address, kind, connectPasskey, passkey, submitSigned, signConsent, token, restoring, standing, readOnly, canRequest, busy, error, connect, cliChallenge, connectCli, disconnect, refreshStanding, sign, signAuth, authFetch],
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
  const [cli, setCli] = useState(false);

  // In its own window over the page: inside the header bar the paste box was
  // out of sight (found on the testnet demo, 2026-11-27).
  const cliPanel = cli
    ? createPortal(
        <div className="lightbox" onClick={() => setCli(false)}>
          <div className="lightbox-frame" style={{ width: "min(640px, 100%)" }} onClick={(e) => e.stopPropagation()}>
            <CliSignIn account={kind === "cli" ? address : null} onDone={() => setCli(false)} />
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="wallet">
      {cliPanel}
      {restoring && !authenticated ? (
        <span className="tag" data-testid="session-resuming">
          resuming your session…
        </span>
      ) : address ? (
        <>
          <span className="addr" title={address}>
            {kind === "passkey" ? "🔑 " : kind === "cli" ? "⌨ " : ""}
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
            <button
              onClick={() => (kind === "cli" ? setCli(true) : void (kind === "passkey" ? connectPasskey(false) : connect()))}
              disabled={busy}
            >
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
          <button onClick={() => setCli(true)} disabled={busy} data-testid="cli-sign-in-open">
            Use the CLI
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

/**
 * Sign in with a SEP-10 challenge signed by the Stellar CLI (2026-11-27), for
 * an account whose key is only in the CLI keystore: the issuer on mainnet.
 *
 * The challenge is a transaction with sequence number 0 from the server's
 * sign-in account, so it can never be submitted: signing it proves control of
 * the account and sends nothing. The command below only signs; it prints the
 * signed challenge, which goes back here.
 */
/** The signed challenge out of whatever was pasted: the CLI also prints an "ℹ️ Signing transaction" line. */
export function signedChallengeFrom(pasted: string): string {
  const tokens = pasted.split(/\s+/).filter((t) => /^[A-Za-z0-9+/]+={0,2}$/.test(t) && t.length >= 100);
  return tokens.sort((x, y) => y.length - x.length)[0] ?? "";
}

/** As the server issues it (CHALLENGE_TIMEOUT_SECONDS in src/lib/sep10.ts). */
const CHALLENGE_SECONDS = 300;

export function CliSignIn({ account, onDone }: { account: string | null; onDone: () => void }) {
  const { busy, cliChallenge, connectCli } = useWallet();
  const [who, setWho] = useState(account ?? "");
  const [identity, setIdentity] = useState(IS_MAINNET ? "qs-main-issuer" : "qs-issuer");
  const [challenge, setChallenge] = useState<{ xdr: string; until: number } | null>(null);
  const [signed, setSigned] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!challenge) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [challenge]);
  const left = challenge ? Math.max(0, Math.round((challenge.until - now) / 1000)) : 0;
  const command = challenge
    ? `stellar tx sign --sign-with-key ${identity || "<identity>"} --network ${IS_MAINNET ? "mainnet" : "testnet"} ${challenge.xdr}`
    : "";
  const extracted = signedChallengeFrom(signed);
  const getChallenge = () => {
    setProblem(null);
    setSigned("");
    cliChallenge(who).then(
      (xdr) => {
        setChallenge({ xdr, until: Date.now() + CHALLENGE_SECONDS * 1000 });
        setNow(Date.now());
      },
      (e: unknown) => setProblem(describeError(e)),
    );
  };

  return (
    <div className="card" data-testid="cli-sign-in" style={{ display: "grid", gap: "0.6rem", margin: 0, textAlign: "left" }}>
      <h3 style={{ margin: 0 }}>Sign in with the Stellar CLI</h3>
      <p className="muted" style={{ margin: 0 }}>
        For an account whose key is only in the CLI keystore, such as the issuer. The challenge is a
        transaction with sequence number 0: signing it proves the account is yours, and it can never be
        sent.
      </p>
      <label>
        <strong>1.</strong> The account (G…)
        <input className="mono" value={who} onChange={(e) => setWho(e.target.value.trim())} spellCheck={false} data-testid="cli-account" />
      </label>
      {challenge === null || left === 0 ? (
        <button className="primary" disabled={!/^G[A-Z2-7]{55}$/.test(who)} onClick={getChallenge} data-testid="cli-get-challenge">
          {challenge ? "The challenge expired: get a new one" : "Get the sign-in challenge"}
        </button>
      ) : (
        <>
          <label>
            <strong>2.</strong> Your CLI identity for that account
            <input className="mono" value={identity} onChange={(e) => setIdentity(e.target.value.trim())} spellCheck={false} />
          </label>
          <div>
            <strong>3.</strong> Run this in your terminal ({Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left):
            <textarea readOnly className="mono" value={command} style={{ minHeight: "5rem", width: "100%" }} data-testid="cli-command" onFocus={(e) => e.currentTarget.select()} />
            <button onClick={() => void navigator.clipboard?.writeText(command)}>Copy the command</button>
          </div>
          <label>
            <strong>4.</strong> Paste what it printed <em>here</em> (the long line starting with <code>AAAA</code>; the
            &quot;Signing transaction&quot; line is ignored)
            <textarea
              className="mono"
              value={signed}
              onChange={(e) => setSigned(e.target.value)}
              style={{ minHeight: "5rem", width: "100%" }}
              placeholder="AAAAAgAAAA…"
              data-testid="cli-signed"
            />
          </label>
          {signed.trim() !== "" && extracted === "" ? (
            <span className="note warn" style={{ margin: 0 }}>
              That does not look like a signed challenge: it should be one long line of letters, digits, + and /.
            </span>
          ) : null}
          {extracted !== "" && extracted === challenge.xdr ? (
            <span className="note warn" style={{ margin: 0 }}>
              That is the challenge itself, not yet signed: paste what the command printed.
            </span>
          ) : null}
          <button
            className="primary"
            disabled={busy || extracted === "" || extracted === challenge.xdr}
            onClick={() => {
              setProblem(null);
              connectCli(extracted).then(onDone, (e: unknown) => setProblem(describeError(e)));
            }}
            data-testid="cli-sign-in-submit"
          >
            {busy ? "signing in…" : "5. Sign in"}
          </button>
        </>
      )}
      {problem ? <span className="note bad" style={{ margin: 0 }}>{problem}</span> : null}
      <button onClick={onDone} disabled={busy}>
        Close
      </button>
    </div>
  );
}
