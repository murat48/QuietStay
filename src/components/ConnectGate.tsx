"use client";

/**
 * The one control that turns a visitor into a participant.
 *
 * Two jobs, and the second is the reason this is a component rather than a
 * button: it knows whether the wallet is already connected, so the landing page
 * says "Open the registry" to someone who has been here before and "Connect a
 * wallet" to someone who has not. A call to action that ignores what the reader
 * has already done reads as a page that is not paying attention.
 */

import Link from "next/link";

import { useWallet } from "@/components/WalletProvider";

export function ConnectGate() {
  const { address, busy, connect } = useWallet();

  if (address) {
    return (
      <Link className="btn primary" href="/list">
        Open the registry
      </Link>
    );
  }

  return (
    <button className="primary" onClick={() => void connect()} disabled={busy}>
      {busy ? "connecting…" : "Connect a wallet to browse"}
    </button>
  );
}
