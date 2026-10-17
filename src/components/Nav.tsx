"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useWallet } from "@/components/WalletProvider";

const PUBLIC_SCREENS = [
  { href: "/list", label: "Marketplace" },
  { href: "/verify", label: "Verify" },
];

export function Nav() {
  const pathname = usePathname();
  // Only matters on a phone, where the links fold behind a menu button.
  const [open, setOpen] = useState(false);
  const { address, standing, authenticated, canRequest, authFetch } = useWallet();
  const signedIn = Boolean(address && authenticated);
  // Asks for this account's weeks that still want an answer. Re-read on every
  // screen change, so the tab goes once the last one is carried out.
  const [awaiting, setAwaiting] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    authFetch("/api/requests")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { incoming?: { status: string }[] } | null) => {
        if (!live || !body?.incoming) return;
        setAwaiting(body.incoming.filter((r) => r.status === "open" || r.status === "accepted").length);
      })
      .catch(() => {
        // The tab simply stays hidden; the List screen still shows every ask.
      });
    return () => {
      live = false;
    };
  }, [signedIn, authFetch, pathname]);
  // Transfer is where an owner carries out an ask, so it appears when one is
  // waiting. Two exceptions: on the screen itself, and on a deployment that
  // cannot keep asks — there a renter's address arrives some other way, so a
  // title holder keeps the tab.
  const holdsTitle = Boolean(standing && standing.owned.length > 0);
  const showTransfer =
    signedIn && (awaiting > 0 || pathname === "/transfer" || (!canRequest && holdsTitle));
  // Issue is for everyone: the issuer issues there, and anyone else asks for
  // their own week to be added — the way a newcomer becomes an owner. The
  // screen itself asks for a wallet when there is none, so the tab does not wait
  // for one. Named for what the reader does there.
  const issueLabel = signedIn && standing?.isIssuer ? "Issue" : "Add my week";
  const screens = [
    ...PUBLIC_SCREENS,
    { href: "/issue", label: issueLabel },
    ...(showTransfer ? [{ href: "/transfer", label: "Transfer", badge: awaiting }] : []),
  ];

  // Without a connected wallet the header stays to the brand and Connect: a
  // visitor reaches the Marketplace and Verify from the home page's two
  // buttons, and both screens work for them without a wallet.
  if (!address) return null;

  return (
    <nav
      className={`screens${open ? " is-open" : ""}`}
      aria-label="Main navigation"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls="nav-links"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true" />
      </button>
      <div id="nav-links" className="nav-links">
        {screens.map((screen) => (
          <Link
            key={screen.href}
            href={screen.href}
            aria-current={pathname === screen.href ? "page" : undefined}
            onClick={() => setOpen(false)}
          >
            {screen.label}
            {"badge" in screen && screen.badge ? (
              <span className="nav-badge" aria-label={`${screen.badge} waiting`}>{screen.badge}</span>
            ) : null}
          </Link>
        ))}
      </div>
    </nav>
  );
}
