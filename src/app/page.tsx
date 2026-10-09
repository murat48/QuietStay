/**
 * The landing screen.
 *
 * This is the only page that has to explain the protocol before it asks for
 * anything, because the registry now sits behind a wallet: somebody who arrives
 * with no Stellar account should still leave understanding what the thing does
 * and why the record stays off chain.
 *
 * Two doors stay open to them. **Verify** needs no account — that is the whole
 * claim of the design, and a visitor who cannot check a week without signing in
 * would be evidence against it. And the evidence document is a set of explorer
 * links a reviewer can open with nothing installed.
 */

import Link from "next/link";

import { ConnectGate } from "@/components/ConnectGate";
import { CONTRACT_ID, NETWORK_PASSPHRASE, explorer } from "@/lib/config";

export default function Home() {
  return (
    <>
      <section className="hero">
        <p className="eyebrow">Stellar testnet · Soroban</p>
        <h1>Rent or sell a timeshare week without publishing your life</h1>
        <p className="lede">
          An owner who cannot travel this year has no simple way to pass the week on. Transfers are
          slow and broker-dependent, and a buyer cannot easily check who really holds the week or
          whether it carries unpaid maintenance fees. Putting it all on a public ledger fixes the
          trust problem and creates a new one — ownership history and travel plans become visible to
          everyone.
        </p>
        <div className="row">
          <ConnectGate />
          <Link className="btn" href="/verify">
            Verify a week — no account needed
          </Link>
        </div>
      </section>

      <p className="section-title">How it works</p>
      <div className="steps">
        <div className="step">
          <h4>The record stays with you</h4>
          <p>
            Your name, the resort, the unit, the deed, the fee history. One document, held by the
            people it concerns. No endpoint serves it and nothing stores it for you.
          </p>
        </div>
        <div className="step">
          <h4>Only a commitment goes on chain</h4>
          <p>
            32 bytes that wrap the record&apos;s SHA-256 together with your account and the hash of a
            secret only you hold. Nothing in it can be reversed into the record.
          </p>
        </div>
        <div className="step">
          <h4>You prove it to move it</h4>
          <p>
            Renting out or selling takes a zero-knowledge proof that you know the week&apos;s secret,
            made on your own machine and checked by the contract on chain. Nobody approves it.
          </p>
        </div>
        <div className="step">
          <h4>A buyer checks the rest</h4>
          <p>
            The issuer&apos;s signed word on fees, the holder the ledger names, and the proofs the
            contract accepted — in their own browser, with no account.
          </p>
        </div>
      </div>

      <p className="section-title">One transfer primitive</p>
      <div className="chain">
        <span>transfer(from, to, right_id, expires_at, proof, public_signals)</span>
      </div>
      <div className="split" style={{ marginTop: "0.7rem" }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>A sale</h3>
          <p className="muted" style={{ margin: 0 }}>
            <code>expires_at = None</code>. Title moves and stays moved.
          </p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>A rental</h3>
          <p className="muted" style={{ margin: 0 }}>
            <code>expires_at = Some(t)</code>. The week comes back on its own — no return
            transaction, no reminder, no trust. A renter whose term has passed is simply not the
            holder any more.
          </p>
        </div>
      </div>

      <p className="section-title">What reaches the ledger, and what never does</p>
      <div className="split">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Public</h3>
          <ul>
            <li>
              <strong>Two account addresses</strong> — pseudonymous
            </li>
            <li>
              <strong>A right id</strong> and its week
            </li>
            <li>
              <strong>A 32-byte commitment</strong>
            </li>
            <li>
              <strong>A proof</strong> and its public values — none of them reveal the record
            </li>
            <li>A rental&apos;s term end. A sale carries none.</li>
          </ul>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Never on chain</h3>
          <ul>
            <li>
              <strong>Your name and email</strong>
            </li>
            <li>
              <strong>The resort, the unit, the deed</strong>
            </li>
            <li>
              <strong>What you owe</strong>, and to whom
            </li>
            <li>The record itself, in any form, or the secret behind it</li>
          </ul>
        </div>
      </div>
      <p className="muted">
        Checked against the real chain by <code>npm run check-privacy</code>, which reads the
        evidence transactions back and searches every layer. Not asserted —{" "}
        <a href="/docs/EVIDENCE.md">measured</a>.
      </p>

      <p className="section-title">What the issuer can, and cannot, do</p>
      <div className="split">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Cannot — enforced by the contract</h3>
          <ul>
            <li>Move, reassign, freeze or burn a week you hold</li>
            <li>Block or approve your transfers — it has no part in them</li>
            <li>Overwrite a right, alter a commitment, or change the contract&apos;s code</li>
          </ul>
          <p className="muted" style={{ marginBottom: 0 }}>
            Demonstrated on chain: the issuer tries to move a held week to itself, and a transfer
            signed by the holder and the issuer but carrying no proof — both refused.
          </p>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Can — and it is stated, not glossed</h3>
          <ul>
            <li>Issue new weeks</li>
            <li>Attest something untrue about a week&apos;s fees</li>
          </ul>
          <p className="muted" style={{ marginBottom: 0 }}>
            The fee attestation is the issuer&apos;s word, shown to buyers; it never decides whether a
            week can move. And the proving keys come from a development setup, labelled
            non-production — a production ceremony is a later phase.
          </p>
        </div>
      </div>

      <p className="section-title">Reviewing this?</p>
      <div className="card">
        <dl className="facts">
          <dt>Contract</dt>
          <dd>
            <a href={explorer.contract()} target="_blank" rel="noreferrer">
              <code>{CONTRACT_ID}</code>
            </a>
          </dd>
          <dt>Network</dt>
          <dd>
            <code>{NETWORK_PASSPHRASE}</code>
          </dd>
        </dl>
        <p className="muted" style={{ marginBottom: 0 }}>
          Everything a reviewer needs is a set of explorer links with nothing to install — the
          deployed contract, a proof-authorized rental and sale, and five transfers the contract
          refused. See <code>docs/EVIDENCE.md</code> in the repository. The registry itself needs a wallet; verification does not.
        </p>
      </div>
    </>
  );
}
