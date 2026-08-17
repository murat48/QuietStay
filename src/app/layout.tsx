import type { Metadata } from "next";
import Link from "next/link";

import { Nav } from "@/components/Nav";
import { WalletButton, WalletProvider } from "@/components/WalletProvider";
import { CONTRACT_ID, explorer } from "@/lib/config";

import "./globals.css";

export const metadata: Metadata = {
  title: "QuietStay — tokenized vacation usage rights",
  description:
    "Phase 1 reference application: issue, list, verify, and transfer tokenized vacation usage rights on Stellar testnet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <header className="top">
            <div className="top-inner">
              <Link href="/" className="brand">
                QuietStay<span>testnet</span>
              </Link>
              <Nav />
              <WalletButton />
            </div>
          </header>

          <main className="shell">{children}</main>

          <div className="shell">
            <footer className="foot">
              Phase 1, Stellar testnet only. Transfer of usage rights only — no payment, escrow, or
              settlement, and no legal title transfer. Contract{" "}
              <a href={explorer.contract()} target="_blank" rel="noreferrer">
                <code>{CONTRACT_ID}</code>
              </a>
              .
            </footer>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
