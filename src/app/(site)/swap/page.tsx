"use client";

/**
 * Swap ("Swap"): two title holders exchange weeks, both or neither
 * (docs/PHASE3_SPEC.md §7, decision D5; D4a for the records).
 *
 * The three on-chain steps, each signed by its own party:
 *
 *   1. The maker asks on chain for the record of the week they want, receives
 *      it sealed from its holder (/receive) and checks it against the chain,
 *      then offers their own week for it with a fresh h' made here.
 *   2. The other holder asks on chain for the maker's week's record, receives
 *      and checks it the same way, then accepts: their browser proves their
 *      week over to the maker, with the maker's h'. Nothing moves yet, and
 *      nothing is locked.
 *   3. The maker completes: their browser proves their week over to the taker,
 *      with the taker's h'. The contract verifies both proofs in one
 *      transaction, so both weeks move with new commitments, or neither does.
 *
 * Each side receives and checks the other's record before it commits (D4a).
 * Only proofs, hashes and public signals leave the browser; records and
 * secrets stay in its vault. No money is involved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProverNotice } from "@/components/ProverNotice";
import { useWallet } from "@/components/WalletProvider";
import type { RecordRequest, SwapAcceptance, SwapOffer } from "@/lib/contract";
import { OFFER_LEDGERS, RPC_URL, explorer } from "@/lib/config";
import { describeError, formatDate, shortAddress } from "@/lib/format";
import { prover } from "@/lib/prover-client";
import { readOnly } from "@/lib/rpc-retry";
import { requestLink } from "@/lib/sealed";
import { useProverSupported } from "@/lib/use-prover-supported";
import { getRecord, newSealKey, newSecret, resolveHolding, sealKey, secretFor } from "@/lib/vault";

/** Proofs are made valid for this many ledgers (about half an hour); the contract allows 720. */
const PROOF_WINDOW = 360;

type Listed<T> = T & { expired: boolean };

interface Swaps {
  ledger: number;
  swaps: { offer: SwapOffer; acceptance: SwapAcceptance | null; expired: boolean }[];
  requests: Listed<RecordRequest>[];
}

interface ChainRight {
  id: number;
  commitment: string;
  title_holder: string | null;
  effective_holder?: string;
  week: { start: number; end: number };
}

interface Outcome {
  ok: boolean;
  headline: string;
  detail?: string;
  hash?: string;
  explorer?: string;
}

async function latestLedger(): Promise<number> {
  return readOnly("getLatestLedger", async () => {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
    });
    const body = (await res.json()) as { result?: { sequence: number } };
    if (!body.result) throw new Error("could not read the latest ledger");
    return body.result.sequence;
  });
}

async function chainRight(rightId: number): Promise<ChainRight> {
  const res = await fetch(`/api/right/${rightId}`);
  const body = (await res.json()) as ChainRight & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `could not read week #${rightId}`);
  return body;
}

/** Swaps this browser completed, so a finished one can still be shown once it leaves storage. */
const DONE_KEY = "quietstay:swaps-done";
type Done = { id: number; give: number; want: number; by: string; hash: string };
function doneSwaps(): Done[] {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]") as Done[];
  } catch {
    return [];
  }
}
function rememberDone(d: Done): void {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...doneSwaps().filter((x) => x.id !== d.id), d].slice(-50)));
  } catch {
    // display convenience only
  }
}

/**
 * Whether this browser holds the checked record for `rightId` and it still
 * matches the chain: what each side needs before it commits (D4a).
 */
async function recordChecked(rightId: number): Promise<boolean> {
  const [rec, right] = await Promise.all([getRecord(rightId), chainRight(rightId)]);
  return rec !== undefined && rec !== null && rec.commitment === right.commitment;
}

export default function SwapScreen() {
  return (
    <>
      <p className="eyebrow">SWAP WEEKS</p>
      <h1>Swap a week for a week</h1>
      <p className="lede">
        Offer a week you hold for one someone else holds. Both weeks move together, each with a new
        commitment, in one transaction, or neither moves. No money is involved.
      </p>
      <Swap />
    </>
  );
}

function Swap() {
  const { address, authenticated, kind, standing, sign, submitSigned, authFetch, refreshStanding } = useWallet();
  const supported = useProverSupported();
  const [data, setData] = useState<Swaps | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done[]>([]);

  // Only the latest read may set the data (as on /stays).
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const n = ++latestLoad.current;
    const res = await fetch("/api/swaps");
    const body = (await res.json()) as Swaps & { error?: string };
    if (n !== latestLoad.current) return;
    if (!res.ok) throw new Error(body.error ?? "could not read the swaps");
    setData(body);
    setDone(doneSwaps());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [load]);

  /** Sign and submit an unsigned transaction, then report. */
  const submit = useCallback(
    async (xdr: string, success: string): Promise<{ ok: boolean; hash?: string }> => {
      setStep(kind === "passkey" ? "waiting for your passkey…" : "waiting for your wallet…");
      const signed = await sign(xdr);
      setStep("submitting…");
      const result = await submitSigned(signed);
      if (!result.ok) throw new Error(result.error ?? "submission failed");
      setOutcome(
        result.successful
          ? { ok: true, headline: success, hash: result.hash, explorer: result.explorer }
          : { ok: false, headline: "The contract rejected this", detail: result.failure, hash: result.hash, explorer: result.explorer },
      );
      await load();
      return { ok: Boolean(result.successful), hash: result.hash };
    },
    [kind, sign, submitSigned, load],
  );

  /** A call without a proof, built by /api/tx/build. */
  const run = useCallback(
    async (key: string, body: Record<string, unknown>, success: string): Promise<boolean> => {
      setBusy(key);
      setError(null);
      setOutcome(null);
      try {
        setStep("checking it on chain…");
        const built = await authFetch("/api/tx/build", { method: "POST", body: JSON.stringify({ by: address, ...body }) });
        const b = (await built.json()) as { xdr?: string; error?: string };
        if (!built.ok || !b.xdr) throw new Error(b.error ?? "could not build the transaction");
        return (await submit(b.xdr, success)).ok;
      } catch (e) {
        setError(describeError(e));
        return false;
      } finally {
        setBusy(null);
        setStep(null);
      }
    },
    [address, authFetch, submit],
  );

  /** Ask on chain for a week's record: a key made here, bound to this account (D4a). */
  const askForRecord = useCallback(
    async (rightId: number, purpose: string) => {
      const { keyHash } = await newSealKey(purpose);
      const ledger = await latestLedger();
      await run(
        `request-${rightId}`,
        { action: "request_record", rightId, keyHash, expiresLedger: ledger + OFFER_LEDGERS },
        `Asked on chain for week #${rightId}'s record. Send the link to its holder.`,
      );
    },
    [run],
  );

  /** Prove `rightId` over to `to`, for the week `swapFor`, with the other side's h'. */
  const proveSide = useCallback(
    async (rightId: number, to: string, swapFor: number, nextSecretHash: bigint) => {
      if (!address) throw new Error("not connected");
      const right = await chainRight(rightId);
      const holding = await resolveHolding(rightId, address, BigInt("0x" + right.commitment));
      if (!holding) throw new Error(`this browser holds no record and secret for week #${rightId}, so it cannot prove for it`);
      const secret = await secretFor(BigInt(holding.h));
      if (secret === null) throw new Error(`this browser no longer holds the secret for week #${rightId}`);
      setStep("proving in this browser…");
      const ledger = await latestLedger();
      const proof = await prover.prove(holding.record, secret, {
        rightId: BigInt(rightId),
        from: address,
        to,
        expiresAt: null,
        swapFor: BigInt(swapFor),
        expiryLedger: BigInt(ledger + PROOF_WINDOW),
        nextSecretHash,
      });
      setStep(`proof made in ${(proof.proveMs / 1000).toFixed(1)} s · checking it on chain…`);
      return proof;
    },
    [address],
  );

  const accept = useCallback(
    async (s: SwapOffer, request: RecordRequest) => {
      const key = `accept-${s.id}`;
      setBusy(key);
      setError(null);
      setOutcome(null);
      try {
        // D4a: the maker's record was received and checked here; check again
        // that the chain still holds that commitment before committing.
        if (!(await recordChecked(s.giveRight))) {
          throw new Error(`the record of week #${s.giveRight} in this browser no longer matches the chain. Ask for it again.`);
        }
        // s' for the week this side receives is made and kept before anything is signed.
        const h = await newSecret(`swap #${s.id}: week #${s.giveRight}`);
        const proof = await proveSide(s.wantRight, s.maker, s.giveRight, BigInt(s.makerNextSecretHash));
        const built = await authFetch("/api/tx/swap", {
          method: "POST",
          body: JSON.stringify({
            step: "accept",
            by: address,
            swapId: s.id,
            nextSecretHash: h.toString(),
            requestId: request.id,
            proof: proof.proof,
            signals: proof.signals,
          }),
        });
        const b = (await built.json()) as { xdr?: string; error?: string };
        if (!built.ok || !b.xdr) throw new Error(b.error ?? "could not build the acceptance");
        await submit(
          b.xdr,
          `Accepted swap #${s.id}. Nothing has moved yet: the maker completes it with their proof, and both weeks then move together.`,
        );
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(null);
        setStep(null);
      }
    },
    [address, authFetch, proveSide, submit],
  );

  const complete = useCallback(
    async (s: SwapOffer, a: SwapAcceptance) => {
      const key = `complete-${s.id}`;
      setBusy(key);
      setError(null);
      setOutcome(null);
      try {
        if (!(await recordChecked(s.wantRight))) {
          throw new Error(`the record of week #${s.wantRight} in this browser no longer matches the chain: it has changed hands.`);
        }
        const proof = await proveSide(s.giveRight, a.taker, s.wantRight, BigInt(a.takerNextSecretHash));
        const built = await authFetch("/api/tx/swap", {
          method: "POST",
          body: JSON.stringify({ step: "complete", by: address, swapId: s.id, proof: proof.proof, signals: proof.signals }),
        });
        const b = (await built.json()) as { xdr?: string; error?: string };
        if (!built.ok || !b.xdr) throw new Error(b.error ?? "could not build the completion");
        const r = await submit(
          b.xdr,
          `Swapped: week #${s.giveRight} went to ${shortAddress(a.taker)} and week #${s.wantRight} to you, in this one transaction.`,
        );
        if (r.ok && r.hash) {
          rememberDone({ id: s.id, give: s.giveRight, want: s.wantRight, by: address!, hash: r.hash });
          setDone(doneSwaps());
        }
        await refreshStanding();
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(null);
        setStep(null);
      }
    },
    [address, authFetch, proveSide, submit, refreshStanding],
  );

  if (!address || !authenticated) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Connect to offer or answer a swap</h2>
        <p className="muted">
          Connect a wallet or use a passkey, at the top of the page. Swap offers are public on chain;
          acting on them needs your signature and, for the weeks, your proof.
        </p>
        {data ? (
          <p className="muted" data-testid="swap-summary">
            On chain now: {data.swaps.filter((s) => !s.expired).length} open swap offer
            {data.swaps.filter((s) => !s.expired).length === 1 ? "" : "s"}.
          </p>
        ) : null}
      </div>
    );
  }

  const owned = new Set((standing?.owned ?? []).map((r) => r.id));
  const myRequest = (rightId: number) =>
    (data?.requests ?? []).find((r) => r.requester === address && r.rightId === rightId && !r.expired) ?? null;
  const mine = (data?.swaps ?? []).filter((s) => s.offer.maker === address);
  const forMe = (data?.swaps ?? []).filter(
    (s) => s.offer.maker !== address && !s.expired && (owned.has(s.offer.wantRight) || s.acceptance?.taker === address),
  );
  const shared = { busy, step, supported, myRequest, askForRecord, run };

  return (
    <>
      <MakeSwap address={address} owned={standing?.owned ?? []} data={data} setError={setError} {...shared} />

      <h2>Swap offers for your weeks</h2>
      {forMe.length === 0 ? (
        <p className="muted">No open swap offer asks for a week you hold.</p>
      ) : (
        forMe.map((s) => (
          <IncomingSwap key={s.offer.id} s={s} address={address} accept={accept} {...shared} />
        ))
      )}

      <h2>Your swap offers</h2>
      {mine.length === 0 && done.filter((d) => d.by === address).length === 0 ? (
        <p className="muted">You have made no swap offer.</p>
      ) : null}
      {mine.map((s) => (
        <div className="card" key={s.offer.id} data-testid={`my-swap-${s.offer.id}`}>
          <div className="row" style={{ gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            <span className={`tag ${s.acceptance ? "ok" : ""}`}>
              {s.expired ? "expired" : s.acceptance ? "accepted" : "offer open"}
            </span>
            <strong>
              Swap #{s.offer.id}: your week #{s.offer.giveRight} for week #{s.offer.wantRight}
            </strong>
          </div>
          <p className="muted" style={{ marginBottom: "0.5rem" }}>
            {s.expired
              ? "It can no longer be accepted or completed. Neither week moved."
              : s.acceptance
                ? `Accepted by ${shortAddress(s.acceptance.taker)}; their proof is valid until ledger ${s.acceptance.expiryLedger.toLocaleString()} (now ${data?.ledger.toLocaleString() ?? "…"}). Completing proves your week over to them; both weeks move together, or neither does.`
                : `Open until ledger ${s.offer.expiresLedger.toLocaleString()}. Nothing moves until the holder of week #${s.offer.wantRight} accepts and you complete.`}
          </p>
          {s.acceptance && !s.expired ? (
            <button
              className="primary"
              disabled={busy !== null || supported !== true}
              onClick={() => void complete(s.offer, s.acceptance!)}
              data-testid={`complete-swap-${s.offer.id}`}
            >
              {busy === `complete-${s.offer.id}` ? (step ?? "working…") : "Prove and complete the swap"}
            </button>
          ) : null}{" "}
          {!s.expired ? (
            <button
              disabled={busy !== null}
              onClick={() =>
                void run(`cancel-${s.offer.id}`, { action: "cancel_swap", swapId: s.offer.id }, `Swap #${s.offer.id} cancelled. Neither week moved.`)
              }
              data-testid={`cancel-swap-${s.offer.id}`}
            >
              {busy === `cancel-${s.offer.id}` ? (step ?? "working…") : "Cancel the offer"}
            </button>
          ) : null}
        </div>
      ))}
      {done
        .filter((d) => d.by === address && !mine.some((s) => s.offer.id === d.id))
        .map((d) => (
          <div className="card" key={`done-${d.id}`} data-testid={`done-swap-${d.id}`}>
            <span className="tag ok">completed</span>{" "}
            <strong>
              Swap #{d.id}: week #{d.give} for week #{d.want}
            </strong>
            <p className="muted" style={{ marginBottom: 0 }}>
              Both weeks moved in{" "}
              <a href={explorer.tx(d.hash)} target="_blank" rel="noreferrer">
                {d.hash.slice(0, 12)}…
              </a>
              .
            </p>
          </div>
        ))}

      <ProverNotice compact />
      {error ? <div className="note bad" data-testid="swap-error">{error}</div> : null}
      {outcome ? (
        <div className={`note ${outcome.ok ? "accent" : "bad"}`} data-testid="swap-outcome">
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
      ) : null}
    </>
  );
}

interface Shared {
  busy: string | null;
  step: string | null;
  supported: boolean | null;
  myRequest: (rightId: number) => Listed<RecordRequest> | null;
  askForRecord: (rightId: number, purpose: string) => Promise<void>;
  run: (key: string, body: Record<string, unknown>, success: string) => Promise<boolean>;
}

/** The request link for one of this account's live record requests. */
function useRequestLink(request: RecordRequest | null): string | null {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const k = request ? await sealKey(request.keyHash) : null;
      setLink(request && k ? requestLink(window.location.origin, "offer", String(request.id), k.publicRaw) : null);
    })();
  }, [request]);
  return link;
}

/** Whether this browser holds a checked record for `rightId` that matches the chain now; `undefined` while reading. */
function useRecordChecked(rightId: number | null, refresh: unknown): boolean | undefined {
  const [ok, setOk] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (rightId === null) return;
    void recordChecked(rightId).then(setOk, () => setOk(false));
  }, [rightId, refresh]);
  return ok;
}

function RecordStep(props: {
  rightId: number;
  request: RecordRequest | null;
  checked: boolean | undefined;
  holderLabel: string;
  testid: string;
  busy: string | null;
  step: string | null;
  disabled?: boolean;
  onAsk: () => void;
}) {
  const link = useRequestLink(props.request);
  return (
    <>
      <li>
        <strong>Ask for week #{props.rightId}&apos;s record, on chain.</strong> This binds a key made in this browser to
        your account; {props.holderLabel} seals the record only to it. It moves nothing and obliges no one.
        {props.request ? (
          <span className="tag ok" style={{ marginLeft: "0.5rem" }}>
            asked (request #{props.request.id})
          </span>
        ) : (
          <div>
            <button disabled={props.busy !== null || props.disabled} onClick={props.onAsk} data-testid={`${props.testid}-ask`}>
              {props.busy === `request-${props.rightId}` ? (props.step ?? "working…") : "Ask for the record"}
            </button>
          </div>
        )}
      </li>
      <li>
        <strong>Send the link to {props.holderLabel}</strong>, through a channel you already use. They answer with a
        reply link; open it in this browser, which checks the record against the chain.
        {link ? <textarea readOnly value={link} style={{ minHeight: "4rem", width: "100%" }} data-testid={`${props.testid}-link`} /> : null}
        <div className="muted">
          {props.checked === undefined
            ? "Looking for the record in this browser…"
            : props.checked
              ? `Week #${props.rightId}'s record is in this browser and matches the commitment on chain ✓`
              : "Not yet: this browser has not received and checked the record."}
        </div>
      </li>
    </>
  );
}

function MakeSwap(props: Shared & { address: string; owned: { id: number; week: { start: number; end: number } }[]; data: Swaps | null; setError: (e: string | null) => void }) {
  const { address, owned, data, busy, step, myRequest, askForRecord, run, setError } = props;
  const [give, setGive] = useState<number | null>(null);
  const [wantText, setWantText] = useState("");
  const [want, setWant] = useState<ChainRight | null>(null);
  const giveId = give ?? owned[0]?.id ?? null;

  useEffect(() => {
    const n = Number(wantText);
    if (!Number.isInteger(n) || n < 1) {
      void Promise.resolve().then(() => setWant(null));
      return;
    }
    void chainRight(n).then(setWant, () => setWant(null));
  }, [wantText]);

  const request = want ? myRequest(want.id) : null;
  const checked = useRecordChecked(want?.id ?? null, data);
  const problem = useMemo(() => {
    if (giveId === null) return "you hold no week as title, so there is nothing to offer";
    if (!want) return wantText ? "no week with that id" : "enter the id of the week you want";
    if (want.id === giveId) return "a week cannot be swapped for itself";
    if (want.title_holder === address) return "you already hold that week";
    if (want.effective_holder && want.effective_holder !== want.title_holder) return "that week is rented out right now; its holder cannot swap it until the rental ends";
    return null;
  }, [giveId, want, wantText, address]);

  const offer = async () => {
    if (!want || giveId === null || !request) return;
    try {
      if (!(await recordChecked(want.id))) {
        setError(`the record of week #${want.id} in this browser no longer matches the chain: it has changed hands. Ask again.`);
        return;
      }
      // s' for the week this side receives is made and kept before anything is signed.
      const h = await newSecret(`swap offer: week #${want.id}`);
      const ledger = await latestLedger();
      await run(
        "offer",
        { action: "offer_swap", giveRight: giveId, wantRight: want.id, nextSecretHash: h.toString(), requestId: request.id, expiresLedger: ledger + OFFER_LEDGERS },
        `Swap offered: your week #${giveId} for week #${want.id}. Nothing moves until its holder accepts and you complete.`,
      );
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="card" data-testid="make-swap">
      <h2 style={{ marginTop: 0 }}>Offer a swap</h2>
      <label>
        Your week (held as title)
        <select value={giveId ?? ""} onChange={(e) => setGive(Number(e.target.value))} data-testid="swap-give">
          {owned.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.id} · {formatDate(r.week.start)} → {formatDate(r.week.end)}
            </option>
          ))}
        </select>
      </label>
      <label>
        The week you want (its id)
        <input value={wantText} onChange={(e) => setWantText(e.target.value.trim())} inputMode="numeric" data-testid="swap-want" />
      </label>
      {want ? (
        <p className="muted">
          Week #{want.id}: {formatDate(want.week.start)} → {formatDate(want.week.end)}, held by {shortAddress(want.title_holder)}
        </p>
      ) : null}
      {problem ? <p className="muted" data-testid="swap-problem">{problem}</p> : null}
      {want && !problem ? (
        <ol>
          <RecordStep
            rightId={want.id}
            request={request}
            checked={checked}
            holderLabel="its holder"
            testid="swap-want-record"
            busy={busy}
            step={step}
            onAsk={() => void askForRecord(want.id, `swap offer: week #${want.id}`)}
          />
          <li>
            <strong>Offer the swap.</strong> It moves nothing. Your new secret for week #{want.id} is made in this browser,
            and only its hash goes on chain.
            <div>
              <button
                className="primary"
                disabled={busy !== null || !request || !checked}
                onClick={() => void offer()}
                data-testid="swap-offer"
              >
                {busy === "offer" ? (step ?? "working…") : "Offer the swap"}
              </button>
            </div>
          </li>
        </ol>
      ) : null}
    </div>
  );
}

function IncomingSwap(
  props: Shared & {
    s: { offer: SwapOffer; acceptance: SwapAcceptance | null };
    address: string;
    accept: (s: SwapOffer, request: RecordRequest) => Promise<void>;
  },
) {
  const { s, address, busy, step, supported, myRequest, askForRecord, run, accept } = props;
  const o = s.offer;
  const request = myRequest(o.giveRight);
  const checked = useRecordChecked(o.giveRight, request);
  const acceptedByMe = s.acceptance?.taker === address;
  const takenByOther = s.acceptance !== null && !acceptedByMe;
  return (
    <div className="card" data-testid={`incoming-swap-${o.id}`}>
      <div className="row" style={{ gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
        <span className={`tag ${acceptedByMe ? "ok" : ""}`}>{acceptedByMe ? "accepted" : takenByOther ? "accepted by someone else" : "offer open"}</span>
        <strong>
          Swap #{o.id}: week #{o.giveRight} for your week #{o.wantRight}
        </strong>
        <span className="muted">from {shortAddress(o.maker)}</span>
      </div>
      {acceptedByMe ? (
        <>
          <p className="muted" style={{ marginBottom: "0.5rem" }}>
            You accepted; your proof is valid until ledger {s.acceptance!.expiryLedger.toLocaleString()}. Nothing has moved,
            and your week is not locked: if you sell or rent it out first, the swap cannot complete. The maker completes it.
          </p>
          <button
            disabled={busy !== null}
            onClick={() =>
              void run(
                `withdraw-${o.id}`,
                { action: "withdraw_swap_acceptance", swapId: o.id },
                `Acceptance of swap #${o.id} withdrawn. Your proof can no longer be used; the offer stays open.`,
              )
            }
            data-testid={`withdraw-swap-${o.id}`}
          >
            {busy === `withdraw-${o.id}` ? (step ?? "working…") : "Withdraw my acceptance"}
          </button>
        </>
      ) : takenByOther ? (
        <p className="muted">Someone else has a live acceptance on this swap.</p>
      ) : (
        <ol>
          <RecordStep
            rightId={o.giveRight}
            request={request}
            checked={checked}
            holderLabel="the maker"
            testid={`swap-${o.id}-record`}
            busy={busy}
            step={step}
            onAsk={() => void askForRecord(o.giveRight, `swap #${o.id}: week #${o.giveRight}`)}
          />
          <li>
            <strong>Prove and accept.</strong> Your browser proves week #{o.wantRight} over to the maker. It moves nothing
            until the maker completes; your new secret for week #{o.giveRight} is made here.
            <div>
              <button
                className="primary"
                disabled={busy !== null || supported !== true || !request || !checked}
                onClick={() => request && void accept(o, request)}
                data-testid={`accept-swap-${o.id}`}
              >
                {busy === `accept-${o.id}` ? (step ?? "working…") : "Prove and accept"}
              </button>
            </div>
          </li>
        </ol>
      )}
    </div>
  );
}
