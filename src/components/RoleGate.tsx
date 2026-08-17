"use client";

/**
 * Gate a screen on what the registry says the account is.
 *
 * This is an interface convenience, not a security boundary, and the distinction
 * matters enough to be explicit: every route behind a gate re-checks the caller
 * server-side against the SEP-10 session, and the contract re-checks again on
 * chain. Deleting this component would make the app ruder, not less safe.
 *
 * What it buys is an honest refusal. A screen that renders a form and then fails
 * on submit has wasted the user's time and a signature; one that says "this is the
 * issuer's screen, and you are signed in as someone else" has told them the truth
 * up front.
 */

import type { ReactNode } from "react";

import { useWallet } from "@/components/WalletProvider";

interface Props {
  /** What the account must be for the children to render. */
  requires: "issuer" | "holder";
  /** Shown in the refusal, e.g. "Issuing usage rights". */
  action: string;
  children: ReactNode;
}

export function RoleGate({ requires, action, children }: Props) {
  const { address, authenticated, standing, busy, connect } = useWallet();

  if (!address || !authenticated) {
    return (
      <div className="note">
        <strong>{action} needs a verified account.</strong>
        <p style={{ margin: "0.5rem 0 0.75rem" }}>
          Connect a wallet and complete the SEP-10 handshake. Reading the registry and
          verifying a week need neither — those are open to anyone.
        </p>
        <button className="primary" onClick={() => void connect()} disabled={busy}>
          {busy ? "connecting…" : "Connect wallet"}
        </button>
      </div>
    );
  }

  if (!standing) {
    return <p className="muted">Reading your standing from the registry…</p>;
  }

  if (requires === "issuer" && !standing.isIssuer) {
    return (
      <div className="note warn">
        <strong>This is the issuer&apos;s screen.</strong>
        <p style={{ marginBottom: 0 }}>
          You are signed in as <code>{standing.account}</code>, which is not this
          deployment&apos;s issuer. Only the account the contract records as{" "}
          <code>issuer()</code> can create usage rights, and the contract enforces that
          independently of this page — an issuance from your account would be rejected on
          chain.
        </p>
      </div>
    );
  }

  if (requires === "holder") {
    const holdsSomething = standing.owned.length > 0 || standing.renting.length > 0;
    if (!holdsSomething) {
      const waitingOnRental = standing.rentedOut.length > 0;
      return (
        <div className="note warn">
          <strong>You have no week to transfer right now.</strong>
          {waitingOnRental ? (
            <p style={{ marginBottom: 0 }}>
              You hold title to {standing.rentedOut.length} week
              {standing.rentedOut.length === 1 ? "" : "s"} that {standing.rentedOut.length === 1 ? "is" : "are"}{" "}
              currently out on rental. Until the term lapses the renter is the holder, so
              the week is not yours to move — that is the protection working, not a fault.
              It comes back on its own, with no transaction to send.
            </p>
          ) : (
            <p style={{ marginBottom: 0 }}>
              This account holds nothing on this deployment. The{" "}
              <a href="/list">registry</a> shows who holds what.
            </p>
          )}
        </div>
      );
    }
  }

  return <>{children}</>;
}
