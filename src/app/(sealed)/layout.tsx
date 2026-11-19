import type { Metadata } from "next";
import Link from "next/link";

import { WalletButton, WalletProvider } from "@/components/WalletProvider";
import { ProverNotice } from "@/components/ProverNotice";

import "../(site)/globals.css";

/**
 * The root layout for sealed-link pages (/receive), and nothing else
 * (docs/PHASE3_SPEC.md §2, decision D4 change 3).
 *
 * A separate root layout, so that this document loads **no analytics, no
 * third-party script and no external font**: no `SiteAnalytics`, no
 * `next/font`. Next.js turns navigation across root layouts into a full page
 * load, so a script another page loaded never runs here. The page reads the
 * part of the address after `#` and removes it from the address bar before
 * doing anything else. The no-leak test (e2e/no-leak.spec.ts) checks both.
 */

export const metadata: Metadata = {
  title: "QuietStay — sealed record",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function SealedLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <header className="top">
            <div className="top-inner">
              <Link href="/" className="brand" aria-label="QuietStay home">
                <span className="wordmark">
                  <span className="wordmark-quiet">Quiet</span>
                  <span className="wordmark-stay">Stay</span>
                </span>
                <span className="network-label">testnet</span>
              </Link>
              <WalletButton />
            </div>
          </header>
          <main className="shell page-shell" id="main-content">
            {children}
          </main>
          <div className="shell footer-shell">
            <footer className="foot">
              <p className="footer-disclosure">
                This page loads no analytics. What follows the <code>#</code> in its address is read
                in your browser and never sent to any server.
              </p>
              <ProverNotice />
            </footer>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
