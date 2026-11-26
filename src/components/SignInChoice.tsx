"use client";

/**
 * The sign-in offered inside a gated screen (RoleGate, and the owner's
 * "Request issuance" on /issue).
 *
 * It matches the header's WalletButton (found on the testnet app,
 * 2026-11-24):
 * - When the tab's session ends (or in a new tab), a passkey wallet is still
 *   recognised (`kind === "passkey"`) but has no session. While a saved
 *   session is being taken up after a page load, nothing is offered: a sign-in
 *   then would ask for the passkey for nothing.
 * - The gate used to offer only "Connect wallet" (Freighter, SEP-10), which
 *   left a passkey user with no way back in from the page.
 * - Now a recognised passkey wallet signs in again with its passkey (SEP-45),
 *   and with nothing connected both choices are offered.
 */

import { useState } from "react";

import { CliSignIn, useWallet } from "@/components/WalletProvider";

export function SignInChoice({ busyLabel = "connecting…" }: { busyLabel?: string }) {
  const { address, kind, busy, restoring, connect, connectPasskey, passkey } = useWallet();
  // 2026-11-27: an account whose key is only in the CLI keystore (the issuer
  // on mainnet) signs the SEP-10 challenge with the Stellar CLI.
  const [cli, setCli] = useState(false);

  if (restoring) {
    return <p className="muted" style={{ margin: "0.5rem 0 0" }}>Resuming your session…</p>;
  }

  if (cli || (address && kind === "cli")) {
    return (
      <div style={{ marginTop: "0.5rem" }}>
        <CliSignIn account={kind === "cli" ? address : null} onDone={() => setCli(false)} />
      </div>
    );
  }

  if (address && kind === "passkey") {
    return (
      <>
        <p style={{ margin: "0.5rem 0 0.75rem" }}>
          Your passkey wallet <code>{address.slice(0, 6)}…{address.slice(-6)}</code> is recognised; sign in
          with its passkey (SEP-45) to continue.
        </p>
        <button className="primary" onClick={() => void connectPasskey(false)} disabled={busy} data-testid="gate-passkey-sign-in">
          {busy ? "waiting for your passkey…" : "Sign in with passkey"}
        </button>
      </>
    );
  }

  return (
    <>
      <p style={{ margin: "0.5rem 0 0.75rem" }}>
        Connect a wallet (SEP-10), or sign in with a passkey wallet (SEP-45). Reading the registry and verifying a
        week need neither — those are open to anyone.
      </p>
      <span className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <button className="primary" onClick={() => void connect()} disabled={busy}>
          {busy ? busyLabel : "Connect wallet"}
        </button>
        {passkey.supported === true ? (
          <button onClick={() => void connectPasskey(false)} disabled={busy} data-testid="gate-passkey-sign-in">
            Sign in with passkey
          </button>
        ) : null}
        <button onClick={() => setCli(true)} disabled={busy} data-testid="gate-cli-sign-in">
          Sign in with the CLI
        </button>
      </span>
    </>
  );
}
