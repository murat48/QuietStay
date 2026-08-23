"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useWallet } from "@/components/WalletProvider";

/**
 * The four screens — four, deliberately; see docs/DESIGN.md on scope.
 *
 * **Nothing is listed until the account is verified.** Not merely connected:
 * connecting claims an address, and only the SEP-10 handshake proves it. Until
 * then the header is a name and a connect button, and the landing page does the
 * explaining — a menu of four screens means nothing to somebody who has not been
 * told what the thing does, and three of the four would refuse them anyway.
 *
 * Verify is the exception that is worth stating, because it needs no account and
 * that is a claim the design rests on. It stays reachable — the landing page and
 * the registry's own gate both offer it by name — it is simply not in a menu
 * aimed at people who are already inside.
 *
 * Once connected, what changes is which screens are *offered*, not how many
 * exist. Issue is the issuer's screen, so it is hidden from everyone else rather
 * than shown as a link that leads to a refusal.
 */
const SCREENS = [
  { href: "/issue", label: "Issue", requires: "issuer" as const },
  { href: "/list", label: "List", requires: null },
  { href: "/verify", label: "Verify", requires: null },
  { href: "/transfer", label: "Transfer", requires: "holder" as const },
];

export function Nav() {
  const pathname = usePathname();
  const { address, standing, authenticated } = useWallet();

  // Unproven, no menu. The landing page is the way in.
  if (!address || !authenticated) return null;

  const visible = SCREENS.filter((screen) => {
    if (screen.requires === null) return true;
    // Signed in, but standing has not come back yet: nothing is known about the
    // account, so the role-gated screens stay listed and explain themselves when
    // opened. Hiding them would make the menu flicker as the answer arrives.
    if (!standing) return true;
    if (screen.requires === "issuer") return standing.isIssuer;
    return standing.owned.length > 0 || standing.renting.length > 0 || standing.isIssuer;
  });

  return (
    <nav className="screens">
      {visible.map((screen) => (
        <Link
          key={screen.href}
          href={screen.href}
          aria-current={pathname === screen.href ? "page" : undefined}
        >
          {screen.label}
        </Link>
      ))}
    </nav>
  );
}
