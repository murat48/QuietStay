"use client";

/**
 * Wallet (2026-11-27): the signed-in account's address, to copy, its USDC and
 * XLM balances, and, for a passkey wallet, a way to fund it.
 *
 * A passkey wallet (`C…`) pays for stays from its own USDC, approved by its
 * passkey; the network fee is paid by the fee account, so it needs no XLM.
 * It is funded by a transfer from a regular wallet (Freighter) that the user
 * connects here for that one transfer only: the site's session stays the
 * passkey's, and that wallet signs and pays for its own transfer.
 */

import { useCallback, useEffect, useState } from "react";

import { useWallet } from "@/components/WalletProvider";
import { FEE_ACCOUNT, IS_MAINNET, NETWORK_LABEL, explorer } from "@/lib/config";
import { describeError } from "@/lib/format";
import {
  MAINNET_MAX_USDC_HELD,
  buildTopUp,
  readTokenBalance,
  sendSigned,
  topUpProblem,
  type TokenName,
} from "@/lib/token-client";
import { formatUsdc, parseUsdc } from "@/lib/usdc";
import { connectWallet, signWithWallet } from "@/lib/wallet-kit";

type Balances = Record<TokenName, bigint | null>;

export default function WalletScreen() {
  const { address, kind, authenticated, restoring, standing } = useWallet();
  const [balances, setBalances] = useState<Balances | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    setReadError(null);
    try {
      const [usdc, xlm] = await Promise.all([readTokenBalance("USDC", address), readTokenBalance("XLM", address)]);
      setBalances({ USDC: usdc, XLM: xlm });
    } catch (caught) {
      setReadError(describeError(caught));
    }
  }, [address]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  if (restoring && !authenticated) return <p className="muted">Resuming your session…</p>;
  if (!address || !authenticated) {
    return (
      <>
        <p className="eyebrow">WALLET</p>
        <h1>Your wallet</h1>
        <p className="muted">Sign in at the top of the page to see your account and its balances.</p>
      </>
    );
  }

  const isPasskey = kind === "passkey";
  const copy = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <>
      <p className="eyebrow">WALLET</p>
      <h1>Your wallet</h1>
      <p className="lede">
        {isPasskey
          ? "Your passkey wallet pays for stays from its own USDC, and your passkey approves every payment. The network fee is paid for you, so it needs no XLM."
          : "The account you signed in with. Your wallet app shows and moves its funds; this screen only reads them."}
      </p>

      <div className="card" data-testid="wallet-card">
        <h3 style={{ marginTop: 0 }}>{isPasskey ? "🔑 Passkey wallet" : kind === "cli" ? "Account (signed in with the CLI)" : "Account"}</h3>
        <div className="row" style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <code className="mono" style={{ wordBreak: "break-all" }} data-testid="wallet-address">
            {address}
          </code>
          <button onClick={copy} data-testid="wallet-copy">
            {copied ? "Copied ✓" : "Copy address"}
          </button>
          <a href={address.startsWith("C") ? explorer.contract(address) : explorer.account(address)} target="_blank" rel="noreferrer">
            View on Stellar ↗
          </a>
        </div>

        <h4 style={{ marginBottom: "0.3rem" }}>Balances</h4>
        {readError ? <div className="note bad">{readError}</div> : null}
        <dl className="facts">
          <dt>USDC</dt>
          <dd data-testid="wallet-usdc">
            {balances === null ? "reading…" : balances.USDC === null ? "no USDC trustline on this account" : `${formatUsdc(balances.USDC)} USDC`}
          </dd>
          <dt>XLM</dt>
          <dd data-testid="wallet-xlm">
            {balances === null ? "reading…" : balances.XLM === null ? "—" : `${formatUsdc(balances.XLM)} XLM`}
            {isPasskey ? <span className="muted"> · not needed: fees are paid for you</span> : null}
          </dd>
        </dl>
        <button onClick={() => void load()}>Refresh</button>
      </div>

      {isPasskey ? (
        <FundPasskey
          to={address}
          tokens={["USDC", "XLM"]}
          balances={balances}
          onSent={() => void load()}
          title="Fund this wallet"
          intro="Send USDC to it from a regular wallet you hold, such as Freighter. Your wallet opens for this one transfer, signs it and pays its own small fee; you stay signed in here with your passkey. You can also send to the address above from any wallet that can send to a contract address (C…)."
        />
      ) : null}

      {standing?.isIssuer && FEE_ACCOUNT ? <FeeAccount /> : null}
    </>
  );
}

function FundPasskey({
  to,
  tokens,
  balances,
  onSent,
  title,
  intro,
}: {
  to: string;
  tokens: TokenName[];
  balances: Balances | null;
  onSent: () => void;
  title: string;
  intro: string;
}) {
  const [token, setToken] = useState<TokenName>(tokens[0]!);
  const [amount, setAmount] = useState("1");
  const [step, setStep] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  let units: bigint | null = null;
  try {
    units = parseUsdc(amount);
  } catch {
    units = null;
  }
  const problem = units === null ? "enter an amount like 1 or 0.5" : topUpProblem(token, units, balances?.[token] ?? null);

  const send = async () => {
    if (units === null || problem) return;
    setError(null);
    setDone(null);
    try {
      setStep("choose the wallet to send from…");
      const from = await connectWallet();
      if (from === to) throw new Error("that is this wallet itself");
      if (!from.startsWith("G")) throw new Error("send from a regular wallet account (G…)");
      setStep("preparing the transfer…");
      const xdr = await buildTopUp(token, from, to, units);
      setStep("approve it in your wallet…");
      const signed = await signWithWallet(xdr, from);
      setStep("sending…");
      const hash = await sendSigned(signed);
      setDone({ hash, text: `Sent ${formatUsdc(units)} ${token} from ${from.slice(0, 6)}…${from.slice(-4)} to ${to.slice(0, 6)}…${to.slice(-4)}.` });
      onSent();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setStep(null);
    }
  };

  return (
    <div className="card" data-testid={tokens.includes("USDC") ? "wallet-fund" : "fee-fund"}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <p className="muted">{intro}</p>
      <div className="row" style={{ gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
        <label>
          Token
          <select value={token} onChange={(e) => setToken(e.target.value as TokenName)} data-testid="fund-token">
            {tokens.includes("USDC") ? <option value="USDC">USDC (pays for stays)</option> : null}
            {tokens.includes("XLM") ? <option value="XLM">{tokens.includes("USDC") ? "XLM (not needed)" : "XLM"}</option> : null}
          </select>
        </label>
        <label>
          Amount
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" style={{ width: "8rem" }} data-testid="fund-amount" />
        </label>
        <button className="primary" disabled={step !== null || problem !== null} onClick={() => void send()} data-testid="fund-send">
          {step ?? `Send from my wallet`}
        </button>
      </div>
      {problem ? <p className="muted" data-testid="fund-problem">{problem}</p> : null}
      {!tokens.includes("USDC") ? null : IS_MAINNET ? (
        <p className="muted">
          Pilot limits on {NETWORK_LABEL}: at most 1 USDC in one payment, and at most{" "}
          {formatUsdc(MAINNET_MAX_USDC_HELD)} USDC held.
        </p>
      ) : (
        <p className="muted">
          On {NETWORK_LABEL} this is test USDC. If your Freighter account has none, Circle&apos;s faucet sends test
          USDC to a G… account with a USDC trustline:{" "}
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
            faucet.circle.com ↗
          </a>
          .
        </p>
      )}
      {error ? <div className="note bad" data-testid="fund-error">{error}</div> : null}
      {done ? (
        <div className="note accent" data-testid="fund-done">
          {done.text}{" "}
          <a href={explorer.tx(done.hash)} target="_blank" rel="noreferrer">
            {done.hash.slice(0, 12)}… ↗
          </a>
        </div>
      ) : null}
    </div>
  );
}

/** Below this, the fee account warns: about a few dozen passkey transactions are left. */
const FEE_LOW_STROOPS = 30_000_000n;

/**
 * The fee account (D18, 2026-11-27), shown to the issuer: the `G…` account
 * whose key is on the server and pays passkey users' network fees. It holds
 * only a few XLM; it is topped up by sending XLM to its address, from
 * Freighter here, from an exchange or from any wallet. No CLI.
 */
function FeeAccount() {
  const [xlm, setXlm] = useState<bigint | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try {
      setXlm(await readTokenBalance("XLM", FEE_ACCOUNT));
    } catch {
      setXlm(null);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  const low = typeof xlm === "bigint" && xlm < FEE_LOW_STROOPS;
  return (
    <>
      <div className="card" data-testid="fee-account">
        <h3 style={{ marginTop: 0 }}>Fee account</h3>
        <p className="muted">
          Pays the network fee of every passkey user&apos;s transaction, so they never need XLM. Its key is on the
          server (set in Vercel), it holds only a few XLM, and it pays for nothing but QuietStay calls, within daily
          limits. Top it up by sending XLM to this address, from here or from any wallet or exchange.
        </p>
        <div className="row" style={{ gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <code className="mono" style={{ wordBreak: "break-all" }} data-testid="fee-address">
            {FEE_ACCOUNT}
          </code>
          <button
            onClick={() =>
              void navigator.clipboard?.writeText(FEE_ACCOUNT).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? "Copied ✓" : "Copy address"}
          </button>
          <a href={explorer.account(FEE_ACCOUNT)} target="_blank" rel="noreferrer">
            View on Stellar ↗
          </a>
        </div>
        <dl className="facts">
          <dt>XLM</dt>
          <dd data-testid="fee-xlm">
            {xlm === undefined ? "reading…" : xlm === null ? "the account does not exist yet: send it XLM to create it" : `${formatUsdc(xlm)} XLM`}
          </dd>
        </dl>
        {low ? (
          <div className="note warn" data-testid="fee-low">
            Running low: below {formatUsdc(FEE_LOW_STROOPS)} XLM. Passkey users&apos; transactions stop when it cannot
            pay. Top it up.
          </div>
        ) : null}
        <button onClick={() => void load()}>Refresh</button>
      </div>
      <FundPasskey
        to={FEE_ACCOUNT}
        tokens={["XLM"]}
        balances={null}
        onSent={() => void load()}
        title="Top up the fee account"
        intro="Send XLM from a regular wallet you hold, such as Freighter: it opens for this one transfer, signs it and pays its own fee."
      />
    </>
  );
}
