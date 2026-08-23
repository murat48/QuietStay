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
 * the nav appears only after the second. This is the one control on the page,
 * so if it stopped at "connected" it would leave somebody mid-handshake looking
 * at a landing page with no way onward and no menu.
 */

import Link from "next/link";

import { useWallet } from "@/components/WalletProvider";

export function ConnectGate() {
  const { address, authenticated, busy, connect } = useWallet();

  if (address && authenticated) {
    return (
      <Link className="btn primary" href="/list">
        Open the registry
      </Link>
    );
  }

  return (
    <button className="primary" onClick={() => void connect()} disabled={busy}>
      {address
        ? busy
          ? "signing…"
          : "Sign in to open the registry"
        : busy
          ? "connecting…"
          : "Connect a wallet to browse"}
    </button>
  );
}
