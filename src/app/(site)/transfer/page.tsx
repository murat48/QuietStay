"use client";

/**
 * Screen 4 of 4 — **Transfer**.
 *
 * One primitive, two modes: a rental carries the week's end as its term, a sale
 * carries none. Either one is authorized by an **ownership proof** the contract
 * verifies on chain, and by nobody's permission.
 *
 * Phase 3 makes the proof here, in this browser (docs/PHASE3_SPEC.md §2):
 *
 *   1. **Pick an ask.** Each week this account holds title to is listed with the
 *      open asks for it, from the List screen. The asker's account, and on a
 *      sale their `h'` and signed consent, come from the ask: nothing is typed.
 *   2. **Prove.** The prover worker (GPL-3.0, `public/zk/prover.worker.js`)
 *      proves with the record and secret this browser's vault keeps. They pass
 *      to the worker by `postMessage` and never leave the browser. Only the
 *      proof and its public signals, which go on chain anyway, are sent.
 *   3. **Sign.** The server simulates the call, so the contract checks the proof
 *      before anything is signed; the holder's wallet signs; it is submitted.
 *
 * No command line and no file. Who can use it is read from the registry: only a
 * title holder can prove, so a renter is shown why not.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProverNotice } from "@/components/ProverNotice";
import { RoleGate } from "@/components/RoleGate";
import { useWallet } from "@/components/WalletProvider";
import { RPC_URL, explorer } from "@/lib/config";
import { describeError, formatDate, formatDays, shortAddress } from "@/lib/format";
import { prover, proverSupported } from "@/lib/prover-client";
import { readOnly } from "@/lib/rpc-retry";
import { useProverSupported } from "@/lib/use-prover-supported";
import { transferableRights, type RightSummary } from "@/lib/roles";
import { resolveHolding, secretFor, type Holding } from "@/lib/vault";
import { PUBLIC_SIGNALS } from "@/lib/zk-fields";

interface Outcome {
  kind: "confirmed" | "rejected-on-chain";
  headline: string;
  detail?: string;
  hash?: string;
  explorer?: string;
}

interface Ask {
  id: string;
  right_id: number;
  by: string;
  term_secs: number | null;
  status: string;
  consent?: { next_secret_hash: string };
}

/** Proofs are made valid for this many ledgers (about half an hour); the contract allows 720. */
const PROOF_WINDOW = 360;

async function latestLedger(): Promise<number> {
  return readOnly("getLatestLedger", readLatestLedger);
}

async function readLatestLedger(): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  const body = (await res.json()) as { result?: { sequence: number } };
  if (!body.result) throw new Error("could not read the latest ledger");
  return body.result.sequence;
}

export default function TransferScreen() {
  const supported = useProverSupported();
  return (
    <>
      <p className="eyebrow">YOUR NEXT CHAPTER</p>
      <h1>Rent out or sell a week</h1>
      <p className="lede">
        You prove you own the week, and the contract checks that proof on chain. Nobody approves
        it — not the issuer, not this site — and nothing about you or the week&apos;s record is
        revealed by the proof.
      </p>
      <div className="note accent phase-note">
        <span className="tag ok">Phase 3</span> Your browser makes the proof, with one click. Your
        record and secret stay in this browser; only the proof is sent.
      </div>
      {supported === false ? (
        <div className="note bad" data-testid="prover-unsupported">
          This browser cannot run the in-browser prover: it needs Web Workers, WebCrypto and
          IndexedDB. Use a current desktop Chrome or Firefox.
        </div>
      ) : null}
      <RoleGate requires="holder" action="Transferring a week">
        <TransferForm />
      </RoleGate>
    </>
  );
}

function TransferForm() {
  const { address, kind, standing, sign, submitSigned, authFetch, refreshStanding } = useWallet();
  const supported = useProverSupported();
  const options = useMemo(() => transferableRights(standing), [standing]);
  const owned = useMemo(() => options.filter((o) => o.maySell), [options]);
  const rented = useMemo(() => options.filter((o) => !o.maySell), [options]);

  const [asks, setAsks] = useState<Ask[]>([]);
  const [holdings, setHoldings] = useState<Record<number, Holding | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAsks = useCallback(async () => {
    const res = await authFetch("/api/requests");
    const body = (await res.json()) as { incoming?: Ask[] };
    setAsks((body.incoming ?? []).filter((r) => r.status === "open"));
  }, [authFetch]);

  useEffect(() => {
    void (async () => {
      try {
        await loadAsks();
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [loadAsks]);

  // What this browser can prove with, for each week held as title.
  useEffect(() => {
    if (!address || !proverSupported()) return;
    void (async () => {
      const out: Record<number, Holding | null> = {};
      for (const o of owned) {
        out[o.right.id] = await resolveHolding(o.right.id, address, BigInt("0x" + o.right.commitment)).catch(() => null);
      }
      setHoldings(out);
    })();
  }, [address, owned]);

  /** Prove in this browser, build with the proof, sign, submit. */
  const accept = useCallback(
    async (right: RightSummary, maxTermEnds: number, ask: Ask) => {
      if (!address) return;
      const holding = holdings[right.id];
      if (!holding) return;
      setBusy(ask.id);
      setError(null);
      setOutcome(null);
      try {
        const secret = await secretFor(BigInt(holding.h));
        if (secret === null) throw new Error("this browser no longer holds the secret for this week");
        const sale = ask.term_secs === null;
        const expiresAt = sale ? null : Math.min(right.week.end, maxTermEnds);
        const nextSecretHash = sale ? ask.consent?.next_secret_hash : "0";
        if (nextSecretHash === undefined) throw new Error("this ask to buy carries no h'; the buyer must ask again");

        setStep("proving in this browser…");
        const ledger = await latestLedger();
        const proof = await prover.prove(holding.record, secret, {
          rightId: BigInt(right.id),
          from: address,
          to: ask.by,
          expiresAt: expiresAt === null ? null : BigInt(expiresAt),
          expiryLedger: BigInt(ledger + PROOF_WINDOW),
          nextSecretHash: BigInt(nextSecretHash),
        });

        // The same shape as the CLI's transfer.json: the transfer's terms, the
        // proof, and its public signals. No record, no secret, no d.
        const transfer = {
          transfer: {
            right_id: String(right.id),
            from: address,
            to: ask.by,
            expires_at: expiresAt === null ? null : String(expiresAt),
            expiry_ledger: String(ledger + PROOF_WINDOW),
            next_secret_hash: nextSecretHash,
          },
          proof: proof.proof,
          public_signals: Object.fromEntries(PUBLIC_SIGNALS.map((k, i) => [k, proof.signals[i]!])),
        };

        setStep(`proof made in ${(proof.proveMs / 1000).toFixed(1)} s · checking it on chain…`);
        const built = await authFetch("/api/tx/proven-transfer", { method: "POST", body: JSON.stringify({ transfer }) });
        const builtBody = (await built.json()) as { xdr?: string; error?: string; request_id?: string };
        if (!built.ok || !builtBody.xdr) throw new Error(builtBody.error ?? "could not build the transfer");

        setStep(kind === "passkey" ? "waiting for your passkey…" : "waiting for your wallet…");
        const signed = await sign(builtBody.xdr);
        setStep(kind === "passkey" ? "submitting (fee paid by the testnet fee account)…" : "submitting…");
        const result = await submitSigned(signed);
        if (!result.ok) throw new Error(result.error ?? "submission failed");

        if (result.successful && builtBody.request_id) {
          await authFetch(`/api/requests/${builtBody.request_id}`, {
            method: "POST",
            body: JSON.stringify({ right_id: right.id, action: "accepted", tx: result.hash }),
          });
        }
        setOutcome(
          result.successful
            ? {
                kind: "confirmed",
                headline: sale
                  ? `Sold. Right #${right.id} now belongs to ${shortAddress(ask.by)}, and only they can prove it next.`
                  : `Rented out until ${formatDate(expiresAt!)}. Title stays with you and the week comes back on its own.`,
                detail: `The contract verified your ownership proof on chain before accepting this. The proof took ${(proof.proveMs / 1000).toFixed(1)} s in this browser.`,
                hash: result.hash,
                explorer: result.explorer,
              }
            : {
                kind: "rejected-on-chain",
                headline: "The contract rejected this transfer",
                detail: result.failure,
                hash: result.hash,
                explorer: result.explorer,
              },
        );
        await refreshStanding();
        await loadAsks();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusy(null);
        setStep(null);
      }
    },
    [address, kind, holdings, authFetch, sign, submitSigned, refreshStanding, loadAsks],
  );

  return (
    <>
      {standing && standing.rentedOut.length > 0 ? (
        <div className="note">
          {standing.rentedOut.length} week{standing.rentedOut.length === 1 ? "" : "s"} you own{" "}
          {standing.rentedOut.length === 1 ? "is" : "are"} out on rental. Until the term lapses the
          renter is the holder — the week returns to you with no transaction to send.
        </div>
      ) : null}

      {rented.length > 0 ? (
        <div className="note warn">
          You are renting {rented.map((o) => `#${o.right.id}`).join(", ")} until{" "}
          {formatDate(rented[0]!.maxTermEnds)}. It is yours to use, not to pass on: transferring a
          week takes the record secret, which only the owner holds.
        </div>
      ) : null}

      {owned.length === 0 ? (
        <p className="muted">You hold title to no week at the moment, so there is nothing to prove.</p>
      ) : (
        owned.map((o) => {
          const holding = holdings[o.right.id];
          const forThis = asks.filter((a) => a.right_id === o.right.id);
          return (
            <div className="card" key={o.right.id} data-testid={`transfer-right-${o.right.id}`}>
              <h2 style={{ marginTop: 0 }}>
                #{o.right.id} — {formatDate(o.right.week.start)} → {formatDate(o.right.week.end)}
              </h2>
              {holding === undefined ? (
                <p className="muted">Looking for this week&apos;s record in this browser…</p>
              ) : holding === null ? (
                <div className="note warn">
                  This browser holds no record and secret for this week, so it cannot prove for it.
                  If the week was issued to you, open the reply link the issuer sent you, in this
                  browser. If you bought it, open the seller&apos;s reply link here, before the sale.
                  If this browser&apos;s storage was cleared, the ability to prove for this week is
                  gone for good — the week is still yours.
                </div>
              ) : forThis.length === 0 ? (
                <p className="muted">
                  Ready to prove. No open asks for it: asks without payment are no longer made.
                  Offers in USDC appear on the <Link href="/stays">Offers &amp; stays</Link> screen.
                </p>
              ) : (
                forThis.map((ask) => (
                  <div key={ask.id} className="row" style={{ gap: "0.6rem", alignItems: "center", marginTop: "0.5rem" }}>
                    <code>{shortAddress(ask.by)}</code>
                    <span className="muted">
                      {ask.term_secs === null ? "wants to buy it" : `wants it for ${formatDays(ask.term_secs)}`}
                    </span>
                    <button
                      className="primary"
                      disabled={busy !== null || supported !== true}
                      onClick={() => void accept(o.right, o.maxTermEnds, ask)}
                      data-testid={`accept-${ask.id}`}
                    >
                      {busy === ask.id ? (step ?? "working…") : ask.term_secs === null ? "Prove and sell" : "Prove and rent out"}
                    </button>
                  </div>
                ))
              )}
            </div>
          );
        })
      )}

      <ProverNotice compact />

      {error ? <div className="note bad">{error}</div> : null}

      {outcome ? (
        <>
          <h2>Outcome</h2>
          <div className={`note ${outcome.kind === "confirmed" ? "accent" : "bad"}`} data-testid="transfer-outcome">
            <strong>{outcome.headline}</strong>
            {outcome.detail ? <pre style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{outcome.detail}</pre> : null}
            {outcome.hash ? (
              <p style={{ marginBottom: 0, marginTop: "0.6rem" }}>
                <a href={outcome.explorer ?? explorer.tx(outcome.hash)} target="_blank" rel="noreferrer">
                  Open {outcome.hash.slice(0, 12)}… in stellar.expert
                </a>
              </p>
            ) : null}
          </div>
          <div className="note">
            Open that transaction and look at what it shows: two account addresses, a right id, an
            opaque commitment, and a proof with its public signals. No name, no document, no resort,
            and no secret.
          </div>
        </>
      ) : null}
    </>
  );
}
