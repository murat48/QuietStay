"use client";

/**
 * The one control that turns a visitor into a participant.
 *
 * Two jobs, and the second is the reason this is a component rather than a
 * button: it knows how far along the reader already is, so the landing page
 * asks for the next step rather than repeating the first. A call to action that
 * ignores what the reader has already done reads as a page that is not paying
 * attention.
 *
 * Three states, because connecting and verifying are two different things and
 * a session exists only after the second. This is the main landing-page control,
 * so if it stopped at "connected" it would leave somebody mid-handshake looking
 * at a landing page with no way onward and no menu.
 */

import Link from "next/link";

import { useWallet } from "@/components/WalletProvider";

export function ConnectGate() {
  const { address, authenticated, busy, error, connect } = useWallet();

  if (address && authenticated) {
    return (
      <Link className="btn primary" href="/list">
        Explore Marketplace
      </Link>
    );
  }

  return (
    <>
      <button className="primary" onClick={() => void connect()} disabled={busy}>
        {address
          ? busy
            ? "signing…"
            : "Sign In to Continue"
          : busy
            ? "connecting…"
            : "Connect Wallet"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
