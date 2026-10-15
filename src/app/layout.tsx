import type { Metadata } from "next";
import { Montserrat, Plus_Jakarta_Sans } from "next/font/google";
import Image from "next/image";
import Link from "next/link";

import { Nav } from "@/components/Nav";
import { SiteAnalytics } from "@/components/SiteAnalytics";
import { WalletButton, WalletProvider } from "@/components/WalletProvider";
import { CONTRACT_ID, explorer } from "@/lib/config";

import mark from "../../public/brand/quietstay-mark.png";
import "./globals.css";

// Body text, and the logo's own geometric capitals for the wordmark.
const sans = Plus_Jakarta_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-sans" });
const brand = Montserrat({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-brand" });

export const metadata: Metadata = {
  title: "QuietStay — Timeshare Rights Marketplace",
  description:
    "Verify, list, rent or sell your timeshare rights with privacy and trust. Explore the QuietStay testnet MVP, built on Stellar.",
  openGraph: { images: ["/brand/quietstay-logo.png"] },
};

function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-quiet">Quiet</span>
      <span className="wordmark-stay">Stay</span>
    </span>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${brand.variable}`}>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <WalletProvider>
          <header className="top">
            <div className="top-inner">
              <Link href="/" className="brand" aria-label="QuietStay home">
                <Image className="brand-mark" src={mark} alt="" width={38} height={38} preload />
                <Wordmark />
                <span className="network-label">testnet</span>
              </Link>
              <Nav />
              <WalletButton />
            </div>
          </header>

          <main className="shell page-shell" id="main-content" tabIndex={-1}>{children}</main>

          <div className="shell footer-shell">
            <footer className="foot">
              <div className="footer-top">
                <Link className="brand" href="/" aria-label="QuietStay home">
                  <Image className="brand-mark" src={mark} alt="" width={30} height={30} />
                  <Wordmark />
                </Link>
                <p>A little more freedom. A lot more peace of mind.</p>
                <a href={explorer.contract()} target="_blank" rel="noreferrer">View on Stellar ↗</a>
              </div>
              <p className="footer-disclosure">
                Phase 2, Stellar testnet only. Transfer of usage rights only — no payment, escrow, or
                settlement, and no legal title transfer. Contract{" "}
                <a href={explorer.contract()} target="_blank" rel="noreferrer">
                  <code>{CONTRACT_ID}</code>
                </a>
                .
              </p>
            </footer>
          </div>
        </WalletProvider>
        <SiteAnalytics />
      </body>
    </html>
  );
}
