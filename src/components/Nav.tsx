"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useWallet } from "@/components/WalletProvider";

const PUBLIC_SCREENS = [
  { href: "/list", label: "Marketplace" },
  { href: "/verify", label: "Verify" },
];

export function Nav() {
  const pathname = usePathname();
  // Only matters on a phone, where the links fold behind a menu button.
  const [open, setOpen] = useState(false);
  const { address, standing, authenticated } = useWallet();
  const signedIn = Boolean(address && authenticated);
  // Preserve the original role-aware transfer navigation. Screens and APIs
  // retain their own existing authorization checks.
  const showTransfer = signedIn && (!standing || standing.owned.length > 0 || standing.renting.length > 0 || standing.isIssuer);
  const screens = [
    ...PUBLIC_SCREENS,
    ...(signedIn ? [{ href: "/issue", label: "Issue" }] : []),
    ...(showTransfer ? [{ href: "/transfer", label: "Transfer" }] : []),
  ];

  // Keep the welcome screen focused on its introduction and wallet connection.
  // Public routes remain available elsewhere; Verify is linked from the intro.
  if (pathname === "/" && !signedIn) return null;

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
          </Link>
        ))}
      </div>
    </nav>
  );
}
