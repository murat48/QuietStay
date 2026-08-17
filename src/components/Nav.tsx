"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useWallet } from "@/components/WalletProvider";

/**
 * The four screens — four, deliberately; see docs/DESIGN.md on scope.
 *
 * What changes with the signed-in account is which of them are *offered*, not how
 * many exist. Issue is the issuer's screen, so it is hidden from everyone else
 * rather than shown as a link that leads to a refusal. List and Verify need no
 * account at all: anyone can audit the registry, which is rather the point.
 */
const SCREENS = [
  { href: "/issue", label: "Issue", requires: "issuer" as const },
  { href: "/list", label: "List", requires: null },
  { href: "/verify", label: "Verify", requires: null },
  { href: "/transfer", label: "Transfer", requires: "holder" as const },
];

export function Nav() {
  const pathname = usePathname();
  const { standing, authenticated } = useWallet();

  const visible = SCREENS.filter((screen) => {
    if (screen.requires === null) return true;
    // Before sign-in nothing is known, so the role-gated screens stay listed and
    // explain themselves when opened. Hiding them would make the app look broken
    // to someone who has simply not connected yet.
    if (!authenticated || !standing) return true;
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
