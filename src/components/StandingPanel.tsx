"use client";

/**
 * What the signed-in account is, and what that lets them do next.
 *
 * Not mounted on any screen at present. The List screen's "Yours" tab and the
 * header's role tags already answer it, and a dashboard route of its own would
 * be a fifth screen — the deliverable is four, and a fifth is the scope creep
 * the SOW warns against.
 *
 * Nothing here is a permission. It reflects the registry, which the contract
 * enforces regardless of what this renders.
 */

import Link from "next/link";

import { useWallet } from "@/components/WalletProvider";
import { formatDate } from "@/lib/format";
import { ROLE_LABELS, type RightSummary } from "@/lib/roles";

function WeekList({
  rights,
  empty,
  note,
}: {
  rights: RightSummary[];
  empty: string;
  note?: string;
}) {
  if (rights.length === 0) return <p className="muted">{empty}</p>;
  return (
    <>
      <ul className="weeks">
        {rights.map((right) => (
          <li key={right.id}>
            <span className="week-id">#{right.id}</span>
            <span>
              {formatDate(right.week.start)} → {formatDate(right.week.end)}
            </span>
            <span className="row" style={{ gap: "0.3rem" }}>
              {!right.active ? <span className="tag bad">expired</span> : null}
              {right.termEnds !== null ? (
                <span className="tag warn">until {formatDate(right.termEnds)}</span>
              ) : null}
              {right.listing ? (
                <span className="tag accent">
                  {right.listing.termSecs === null ? "for sale" : "for rent"}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {note ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          {note}
        </p>
      ) : null}
    </>
  );
}

export function StandingPanel() {
  const { address, authenticated, standing, busy, error, connect } = useWallet();

  if (!address || !authenticated) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Sign in to see your side of the market</h3>
        <p className="muted">
          Connect any Stellar wallet — Freighter, xBull, Albedo, Rabet, or Hana —
          and prove control of the account with SEP-10. What you see next depends on what
          the registry says you hold: an owner and a renter get different screens, because
          the contract gives them different powers.
        </p>
        <button className="primary" onClick={() => void connect()} disabled={busy}>
          {busy ? "connecting…" : "Connect wallet"}
        </button>
        {error ? (
          <p className="muted" style={{ color: "var(--bad)", marginBottom: 0 }}>
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (!standing) return <p className="muted">Reading your standing from the registry…</p>;

  const { roles, owned, renting, rentedOut, isIssuer } = standing;

  return (
    <div className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Your standing</h3>
        <div className="row" style={{ gap: "0.3rem" }}>
          {roles.map((role) => (
            <span key={role} className="tag accent">
              {ROLE_LABELS[role].en} · {ROLE_LABELS[role].tr}
            </span>
          ))}
        </div>
      </div>

      <p className="muted" style={{ marginTop: "0.4rem" }}>
        {roles.map((role) => role === "lessee"
          ? "Holds a week for a fixed term. Phase 2 transfers require the title holder's ownership proof."
          : ROLE_LABELS[role].blurb).join(" ")}
      </p>
      <p className="muted" style={{ marginTop: "-0.3rem" }}>
        Read from the contract, not chosen — there is no role to pick anywhere in this
        app.
      </p>

      {isIssuer ? (
        <>
          <h3>As the issuer</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            You can create usage rights and attest that weeks are clean. You cannot move,
            freeze, or burn a right anyone holds — the contract refuses, and{" "}
            <Link href="/list">the registry</Link> will show it unchanged if you try.
          </p>
          <Link className="btn" href="/issue">
            Issue a usage right →
          </Link>
        </>
      ) : null}

      {owned.length > 0 || rentedOut.length > 0 ? (
        <>
          <h3>As an owner — kiraya veren</h3>
          <WeekList
            rights={owned}
            empty="No week is free to transfer right now."
            note={
              owned.length > 0
                ? "You hold title to these. You can rent them out for a term, or sell them outright."
                : undefined
            }
          />
          {rentedOut.length > 0 ? (
            <>
              <h4 style={{ margin: "1rem 0 0.4rem", fontSize: "0.88rem" }}>Currently rented out</h4>
              <WeekList
                rights={rentedOut}
                empty=""
                note="Title is yours, but the renter is the holder until the term lapses — so these cannot be transferred yet. They revert to you with no transaction to send."
              />
            </>
          ) : null}
          {owned.some((right) => right.active) ? (
            <p style={{ marginTop: "0.9rem", marginBottom: 0 }}>
              <Link className="btn" href="/transfer">
                Rent out or sell →
              </Link>
            </p>
          ) : null}
        </>
      ) : null}

      {renting.length > 0 ? (
        <>
          <h3>As a renter — kiracı</h3>
          <WeekList
            rights={renting}
            empty=""
            note="You hold these for a fixed term. In Phase 2, transferring requires the record secret held by the title holder, so renters cannot prepare a transfer proof."
          />
          <p style={{ marginTop: "0.9rem", marginBottom: 0 }}>
            <Link className="btn" href="/transfer">
              View transfer requirements →
            </Link>
          </p>
        </>
      ) : null}

      {roles.includes("visitor") ? (
        <>
          <h3>Nothing held yet</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            This account holds no week on this deployment. You can still browse every right
            in the registry and verify any of them — auditing needs no account at all.
          </p>
          <p style={{ marginBottom: 0 }}>
            <Link className="btn" href="/list">
              Browse the registry →
            </Link>{" "}
            <Link className="btn" href="/verify">
              Verify a week →
            </Link>
          </p>
        </>
      ) : null}
    </div>
  );
}
