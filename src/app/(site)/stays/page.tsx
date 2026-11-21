"use client";

/**
 * **Offers & stays** — paid sales and rentals in USDC (docs/PHASE3_SPEC.md §4–§5).
 *
 * Everything shown is read from the chain (`/api/payments`), and every action
 * is a transaction the signed-in account signs itself:
 *
 * - **Make an offer.** A renter offers a price and a check-in; a buyer first
 *   asks for the record on chain, receives it through a sealed link, checks it
 *   against the commitment, and only then offers (D4a). The USDC stays in the
 *   buyer's account; the contract holds an allowance equal to the buyer's open
 *   offers (D12).
 * - **Offers for your weeks.** The holder proves ownership in this browser and
 *   accepts. A sale moves the week and the money together; a rental grants the
 *   week and puts the money in escrow.
 * - **Stays and payments.** Each escrow's state and what each party can do now:
 *   the owner collects from check-in + 24 h; the renter can release early or
 *   report a problem until then; evidence files are hashed here and only the
 *   hash is sent.
 *
 * The arbiter acts through `scripts/arbiter-resolve`, never through this page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProverNotice } from "@/components/ProverNotice";
import { useWallet } from "@/components/WalletProvider";
import type { Escrow, Offer, RecordRequest } from "@/lib/contract";
import { OFFER_LEDGERS, RPC_URL, USDC_ISSUER, explorer } from "@/lib/config";
import { escrowStatus } from "@/lib/escrow-status";
import { describeError, formatDate, formatDateTime, shortAddress } from "@/lib/format";
import { prover } from "@/lib/prover-client";
import { requestLink } from "@/lib/sealed";
import { formatUsdc, needsUsdcTrustline, parseUsdc } from "@/lib/usdc";
import { readOnly } from "@/lib/rpc-retry";
import { useProverSupported } from "@/lib/use-prover-supported";
import { getRecord, newSealKey, newSecret, resolveHolding, sealKey, secretFor } from "@/lib/vault";

const DAY = 86_400;
/** Proofs are made valid for this many ledgers (about half an hour); the contract allows 720. */
const PROOF_WINDOW = 360;

type Listed<T> = T & { expired: boolean };

interface Payments {
  ledger: number;
  now: number;
  requests: Listed<RecordRequest>[];
  offers: Listed<Offer>[];
  escrows: Escrow[];
  account?: { address: string; usdc: string | null; allowance: string };
}

interface ChainRight {
  id: number;
  commitment: string;
  title_holder: string | null;
  effective_holder?: string;
  week: { start: number; end: number };
  validity?: { from: number; until: number };
}

interface Outcome {
  ok: boolean;
  headline: string;
  detail?: string;
  hash?: string;
  explorer?: string;
}

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

async function chainRight(rightId: number): Promise<ChainRight> {
  const res = await fetch(`/api/right/${rightId}`);
  const body = (await res.json()) as ChainRight & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `could not read week #${rightId}`);
  return body;
}

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Offers this browser made, so an accepted one can still be shown once it leaves storage. */
const MADE_KEY = "quietstay:offers-made";
type Made = { id: number; rightId: number; kind: "sale" | "rental"; by: string };
function madeOffers(): Made[] {
  try {
    return JSON.parse(localStorage.getItem(MADE_KEY) ?? "[]") as Made[];
  } catch {
    return [];
  }
}
function rememberOffer(m: Made): void {
  try {
    localStorage.setItem(MADE_KEY, JSON.stringify([...madeOffers().filter((x) => x.id !== m.id), m].slice(-50)));
  } catch {
    // display convenience only
  }
}

export default function StaysScreen() {
  return (
    <>
      <p className="eyebrow">PAY IN USDC</p>
      <h1>Offers &amp; stays</h1>
      <p className="lede">
        Offer to rent or buy a week, accept offers for yours, and follow each payment. A sale moves
        the week and the money in one transaction. A rental&apos;s money waits in escrow until 24
        hours after check-in.
      </p>
      <div className="note accent phase-note">
        <span className="tag ok">Testnet</span> Payments use testnet USDC. Amounts, addresses and
        evidence hashes are public on chain; the week&apos;s record and your secret are not.
      </div>
      <Stays />
      <ChainSees />
    </>
  );
}

/** Plainly, what a payment puts on the public ledger (docs/DESIGN.md § what the ledger reveals). */
function ChainSees() {
  return (
    <section className="card" data-testid="what-the-chain-sees">
      <h2 style={{ marginTop: 0 }}>What the chain sees</h2>
      <p>
        <strong>Payment amounts and addresses are public.</strong> Anyone can read, for every offer and
        every payment:
      </p>
      <ul>
        <li>the buyer&apos;s or renter&apos;s address, the holder&apos;s address, and the arbiter&apos;s;</li>
        <li>the price in USDC, the allowance given to the contract, and every payment out of escrow;</li>
        <li>the week&apos;s id and dates, the check-in time and when the rental ends;</li>
        <li>whether a problem was reported, and how the dispute ended;</li>
        <li>
          the SHA-256 hash of each evidence file and of the arbiter&apos;s decision. Not the files: they stay
          on your computer, and anyone holding one can re-hash it to check it.
        </li>
      </ul>
      <p style={{ marginBottom: 0 }}>
        <strong>Never on chain:</strong> the week&apos;s ownership record (names, resort, unit, deed), its digest,
        and your record secret. The proof shows you know the secret without revealing it.
      </p>
    </section>
  );
}

function Stays() {
  const { address, authenticated, kind, standing, sign, submitSigned, authFetch, refreshStanding } = useWallet();
  const supported = useProverSupported();
  const [data, setData] = useState<Payments | null>(null);
  const [focus, setFocus] = useState<{ rightId: number; kind: "rent" | "buy" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rightsById, setRightsById] = useState<Record<number, ChainRight>>({});

  // The week to make an offer for, from the link that brought the reader here.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const right = Number(q.get("right"));
    if (!Number.isInteger(right) || right < 1) return;
    void Promise.resolve().then(() => setFocus({ rightId: right, kind: q.get("kind") === "buy" ? "buy" : "rent" }));
  }, []);

  // Only the latest read may set the data: an earlier one (made before the
  // address was known, say) can finish later and would drop the account's
  // balance, and with it the trustline notice (found by the Step 4 browser test).
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const n = ++latestLoad.current;
    const res = await fetch(`/api/payments${address ? `?account=${address}` : ""}`);
    const body = (await res.json()) as Payments & { error?: string };
    if (n !== latestLoad.current) return;
    if (!res.ok) throw new Error(body.error ?? "could not read the payment state");
    setData(body);
    const ids = new Set<number>([
      ...body.offers.map((o) => o.rightId),
      ...body.escrows.map((e) => e.rightId),
      ...madeOffers().map((m) => m.rightId),
    ]);
    const out: Record<number, ChainRight> = {};
    for (const id of ids) out[id] = await chainRight(id).catch(() => ({ id, commitment: "", title_holder: null, week: { start: 0, end: 0 } }));
    setRightsById(out);
  }, [address]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [load]);

  /** Build with /api/tx/build, sign, submit, and report. */
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
        setStep(kind === "passkey" ? "waiting for your passkey…" : "waiting for your wallet…");
        const signed = await sign(b.xdr);
        setStep("submitting…");
        const result = await submitSigned(signed);
        if (!result.ok) throw new Error(result.error ?? "submission failed");
        setOutcome(
          result.successful
            ? { ok: true, headline: success, hash: result.hash, explorer: result.explorer }
            : { ok: false, headline: "The contract rejected this", detail: result.failure, hash: result.hash, explorer: result.explorer },
        );
        await load();
        return Boolean(result.successful);
      } catch (e) {
        setError(describeError(e));
        return false;
      } finally {
        setBusy(null);
        setStep(null);
      }
    },
    [address, kind, authFetch, sign, submitSigned, load],
  );

  /** Prove in this browser against an offer, then accept it. */
  const accept = useCallback(
    async (offer: Offer) => {
      if (!address) return;
      const key = `accept-${offer.id}`;
      setBusy(key);
      setError(null);
      setOutcome(null);
      try {
        const right = await chainRight(offer.rightId);
        const holding = await resolveHolding(offer.rightId, address, BigInt("0x" + right.commitment));
        if (!holding) throw new Error("this browser holds no record and secret for this week, so it cannot prove for it");
        const secret = await secretFor(BigInt(holding.h));
        if (secret === null) throw new Error("this browser no longer holds the secret for this week");
        const sale = offer.terms.kind === "sale";

        setStep("proving in this browser…");
        const ledger = await latestLedger();
        const proof = await prover.prove(holding.record, secret, {
          rightId: BigInt(offer.rightId),
          from: address,
          to: offer.buyer,
          expiresAt: offer.terms.kind === "rental" ? BigInt(offer.terms.expiresAt) : null,
          expiryLedger: BigInt(ledger + PROOF_WINDOW),
          nextSecretHash: offer.terms.kind === "sale" ? BigInt(offer.terms.nextSecretHash) : 0n,
        });

        setStep(`proof made in ${(proof.proveMs / 1000).toFixed(1)} s · checking it on chain…`);
        const built = await authFetch("/api/tx/accept-offer", {
          method: "POST",
          body: JSON.stringify({ by: address, offerId: offer.id, price: offer.price, proof: proof.proof, signals: proof.signals }),
        });
        const b = (await built.json()) as { xdr?: string; error?: string };
        if (!built.ok || !b.xdr) throw new Error(b.error ?? "could not build the acceptance");
        setStep(kind === "passkey" ? "waiting for your passkey…" : "waiting for your wallet…");
        const signed = await sign(b.xdr);
        setStep("submitting…");
        const result = await submitSigned(signed);
        if (!result.ok) throw new Error(result.error ?? "submission failed");
        const price = formatUsdc(BigInt(offer.price));
        setOutcome(
          result.successful
            ? {
                ok: true,
                headline: sale
                  ? `Sold for ${price} USDC. Week #${offer.rightId} and the payment moved together, in this one transaction.`
                  : `Rented out for ${price} USDC. The payment is in escrow; you can collect it from 24 hours after check-in.`,
                detail: `The contract verified your ownership proof on chain. The proof took ${(proof.proveMs / 1000).toFixed(1)} s in this browser.`,
                hash: result.hash,
                explorer: result.explorer,
              }
            : { ok: false, headline: "The contract rejected this acceptance", detail: result.failure, hash: result.hash, explorer: result.explorer },
        );
        await refreshStanding();
        await load();
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(null);
        setStep(null);
      }
    },
    [address, kind, authFetch, sign, submitSigned, refreshStanding, load],
  );

  if (!address || !authenticated) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Connect to make or answer an offer</h2>
        <p className="muted">
          Connect a wallet or use a passkey, at the top of the page. Offers and escrows are public on
          chain; acting on them needs your signature.
        </p>
        {data ? <PublicSummary data={data} /> : null}
      </div>
    );
  }

  // The server's clock at the last read; escrow windows are shown from it.
  const now = data?.now ?? 0;
  const mine = (o: Offer) => o.buyer === address;
  const holdable = new Set<number>([
    ...(standing?.owned ?? []).map((r) => r.id),
    ...(standing?.renting ?? []).map((r) => r.id),
  ]);
  const myOffers = (data?.offers ?? []).filter(mine);
  const forMe = (data?.offers ?? []).filter((o) => !mine(o) && !o.expired && holdable.has(o.rightId));
  const myEscrows = (data?.escrows ?? []).filter((e) => e.owner === address || e.renter === address);
  // A seller is paid on acceptance and an owner on collect; a G… account
  // without a USDC trustline can receive neither, so it is told before accepting.
  const noTrustline = needsUsdcTrustline(address, data?.account?.usdc);

  return (
    <>
      {data?.account ? (
        <p className="muted" data-testid="usdc-balance">
          Your USDC: {data.account.usdc === null ? "no USDC trustline on this account" : `${formatUsdc(BigInt(data.account.usdc))} USDC`}
          {" · "}allowance to QuietStay: {formatUsdc(BigInt(data.account.allowance))} USDC (the sum of your open offers)
        </p>
      ) : null}

      {focus ? (
        <MakeOffer
          focus={focus}
          setFocus={setFocus}
          data={data}
          address={address}
          busy={busy}
          step={step}
          run={run}
          onMade={(m) => rememberOffer(m)}
          setError={setError}
        />
      ) : null}

      <h2>Offers for your weeks</h2>
      {forMe.length === 0 ? (
        <p className="muted">No open offers for a week you hold.</p>
      ) : (
        forMe.map((o) => (
          <div className="card" key={o.id} data-testid={`incoming-offer-${o.id}`}>
            <div className="row" style={{ gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
              <span className="tag ok">offer open</span>
              <strong>
                #{o.rightId} · {o.terms.kind === "sale" ? "to buy" : "to rent"} · {formatUsdc(BigInt(o.price))} USDC
              </strong>
              <span className="muted">from {shortAddress(o.buyer)}</span>
            </div>
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              {o.terms.kind === "rental"
                ? `Check-in ${formatDateTime(o.terms.checkIn)}, ends ${formatDateTime(o.terms.expiresAt)}. On acceptance the payment goes into escrow; you can collect it from ${formatDateTime(o.terms.checkIn + DAY)}.`
                : "On acceptance the week moves to the buyer and the price moves to you, together."}{" "}
              Open until ledger {o.expiresLedger.toLocaleString()}.
            </p>
            {noTrustline ? (
              <TrustlineNotice
                testid={`no-trustline-${o.id}`}
                before="accept"
                why={
                  o.terms.kind === "sale"
                    ? "This account has no USDC trustline, so it cannot receive the payment: the sale would be refused and nothing would move."
                    : "This account has no USDC trustline, so you could not collect the payment from escrow; it would wait there until you add one."
                }
              />
            ) : null}
            <button
              className="primary"
              disabled={busy !== null || supported !== true || noTrustline}
              onClick={() => void accept(o)}
              data-testid={`accept-offer-${o.id}`}
            >
              {busy === `accept-${o.id}` ? (step ?? "working…") : o.terms.kind === "sale" ? "Prove and sell" : "Prove and rent out"}
            </button>
          </div>
        ))
      )}

      <h2>Your offers</h2>
      <YourOffers
        offers={myOffers}
        data={data}
        address={address}
        rights={rightsById}
        busy={busy}
        step={step}
        onCancel={(o) => void run(`cancel-${o.id}`, { action: "cancel_offer", offerId: o.id }, `Offer #${o.id} cancelled. Your allowance now covers only your remaining offers.`)}
      />

      <h2>Stays and payments</h2>
      {myEscrows.length === 0 ? (
        <p className="muted">No rental payments involve this account yet.</p>
      ) : (
        myEscrows.map((e) => (
          <EscrowCard key={e.id} e={e} now={now} address={address} busy={busy} step={step} run={run} noTrustline={noTrustline} />
        ))
      )}

      <ProverNotice compact />
      {error ? <div className="note bad" data-testid="stays-error">{error}</div> : null}
      {outcome ? (
        <div className={`note ${outcome.ok ? "accent" : "bad"}`} data-testid="stays-outcome">
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

function PublicSummary({ data }: { data: Payments }) {
  const open = data.offers.filter((o) => !o.expired).length;
  const held = data.escrows.filter((e) => e.state === "Funded" || e.state === "Disputed");
  const total = held.reduce((sum, e) => sum + BigInt(e.amount), 0n);
  return (
    <p className="muted" data-testid="public-summary">
      On chain now: {open} open offer{open === 1 ? "" : "s"}, {held.length} payment{held.length === 1 ? "" : "s"} in escrow (
      {formatUsdc(total)} USDC).
    </p>
  );
}

// --- making an offer ------------------------------------------------------------

function MakeOffer(props: {
  focus: { rightId: number; kind: "rent" | "buy" };
  setFocus: (f: { rightId: number; kind: "rent" | "buy" } | null) => void;
  data: Payments | null;
  address: string;
  busy: string | null;
  step: string | null;
  run: (key: string, body: Record<string, unknown>, success: string) => Promise<boolean>;
  onMade: (m: Made) => void;
  setError: (e: string | null) => void;
}) {
  const { focus, setFocus, data, address, busy, step, run, onMade, setError } = props;
  const [right, setRight] = useState<ChainRight | null>(null);
  const [price, setPrice] = useState("1");
  const [checkIn, setCheckIn] = useState<string>("");
  const [record, setRecord] = useState<{ commitment: string } | null | undefined>(undefined);
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    void chainRight(focus.rightId)
      .then((r) => {
        setRight(r);
        setCheckIn(new Date(r.week.start * 1000).toISOString().slice(0, 16));
      })
      .catch((e) => setError(describeError(e)));
    void getRecord(focus.rightId).then((r) => setRecord(r ? { commitment: r.commitment } : null));
  }, [focus.rightId, setError]);

  const myRequest = useMemo(
    () => (data?.requests ?? []).find((r) => r.requester === address && r.rightId === focus.rightId && !r.expired) ?? null,
    [data, address, focus.rightId],
  );

  useEffect(() => {
    void (async () => {
      const k = myRequest ? await sealKey(myRequest.keyHash) : null;
      setLink(myRequest && k ? requestLink(window.location.origin, "offer", String(myRequest.id), k.publicRaw) : null);
    })();
  }, [myRequest]);

  const parsedPrice = (() => {
    try {
      return parseUsdc(price);
    } catch {
      return null;
    }
  })();

  const offerRental = async () => {
    if (!right || parsedPrice === null) return;
    const checkInSecs = Math.floor(new Date(`${checkIn}Z`).getTime() / 1000);
    const ledger = await latestLedger();
    const before = new Set((data?.offers ?? []).map((o) => o.id));
    const ok = await run(
      "offer",
      {
        action: "create_rental_offer",
        rightId: right.id,
        price: parsedPrice.toString(),
        expiresAt: right.week.end,
        checkIn: checkInSecs,
        expiresLedger: ledger + OFFER_LEDGERS,
      },
      `Offer made: ${formatUsdc(parsedPrice)} USDC to rent week #${right.id}. The USDC stays in your account until the holder accepts.`,
    );
    if (ok) {
      const res = await fetch(`/api/payments`);
      const after = (await res.json()) as Payments;
      const made = after.offers.find((o) => !before.has(o.id) && o.buyer === address && o.rightId === right.id);
      if (made) onMade({ id: made.id, rightId: right.id, kind: "rental", by: address });
    }
  };

  const askForRecord = async () => {
    if (!right) return;
    const { keyHash } = await newSealKey(`paid offer for right ${right.id}`);
    const ledger = await latestLedger();
    await run(
      "request",
      { action: "request_record", rightId: right.id, keyHash, expiresLedger: ledger + OFFER_LEDGERS },
      `Asked on chain for week #${right.id}'s record. Send the link below to its holder.`,
    );
  };

  const offerSale = async () => {
    if (!right || !myRequest || parsedPrice === null) return;
    // D4: the record was checked against the commitment when it arrived; check
    // again that the chain still holds that commitment before offering.
    const now = await chainRight(right.id);
    if (!record || record.commitment !== now.commitment) {
      setError("the record in this browser no longer matches the week's commitment on chain: it has changed hands. Ask again.");
      return;
    }
    // s' is made and kept before anything is signed; only h' leaves the browser.
    const h = await newSecret(`paid offer for right ${right.id}`);
    const ledger = await latestLedger();
    const before = new Set((data?.offers ?? []).map((o) => o.id));
    const ok = await run(
      "offer",
      {
        action: "create_sale_offer",
        requestId: myRequest.id,
        price: parsedPrice.toString(),
        nextSecretHash: h.toString(),
        expiresLedger: ledger + OFFER_LEDGERS,
      },
      `Offer made: ${formatUsdc(parsedPrice)} USDC for week #${right.id}. The USDC stays in your account until the holder accepts; then the week and the payment move together.`,
    );
    if (ok) {
      const res = await fetch(`/api/payments`);
      const after = (await res.json()) as Payments;
      const made = after.offers.find((o) => !before.has(o.id) && o.buyer === address && o.rightId === right.id);
      if (made) onMade({ id: made.id, rightId: right.id, kind: "sale", by: address });
    }
  };

  if (!right) return <p className="muted">Reading week #{focus.rightId}…</p>;
  const holder = right.effective_holder ?? right.title_holder;
  const priceProblem = parsedPrice === null ? "enter an amount like 1 or 0.5" : parsedPrice <= 0n ? "the price must be above zero" : null;

  return (
    <div className="card" data-testid="make-offer">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ marginTop: 0 }}>
          {focus.kind === "rent" ? "Offer to rent" : "Offer to buy"} week #{right.id}
        </h2>
        <div className="row" style={{ gap: "0.4rem" }}>
          <button onClick={() => setFocus({ ...focus, kind: "rent" })} aria-pressed={focus.kind === "rent"}>
            Rent
          </button>
          <button onClick={() => setFocus({ ...focus, kind: "buy" })} aria-pressed={focus.kind === "buy"}>
            Buy
          </button>
          <button onClick={() => setFocus(null)}>Close</button>
        </div>
      </div>
      <p className="muted">
        {formatDate(right.week.start)} → {formatDate(right.week.end)} · held by {shortAddress(holder)}
      </p>
      {holder === address ? <div className="note">You hold this week, so there is nothing to offer for.</div> : null}

      <label>
        Price, USDC
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" data-testid="offer-price" />
      </label>
      {priceProblem ? <p className="muted">{priceProblem}</p> : null}

      {focus.kind === "rent" ? (
        <>
          <label>
            Check-in (UTC)
            <input type="datetime-local" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} data-testid="offer-check-in" />
          </label>
          <p className="muted">
            The rental ends {formatDateTime(right.week.end)}. The owner can collect your payment from 24 hours after
            check-in. Until then you can release it early, or report a problem.
          </p>
          <button
            className="primary"
            disabled={busy !== null || priceProblem !== null || holder === address}
            onClick={() => void offerRental()}
            data-testid="offer-rent"
          >
            {busy === "offer" ? (step ?? "working…") : "Make the rental offer"}
          </button>
        </>
      ) : (
        <ol>
          <li>
            <strong>Ask for the record, on chain.</strong> This binds a key made in this browser to your account; the
            holder seals the record only to it. It moves no money and obliges the holder to nothing.
            {myRequest ? (
              <span className="tag ok" style={{ marginLeft: "0.5rem" }}>
                asked (request #{myRequest.id})
              </span>
            ) : (
              <div>
                <button disabled={busy !== null || holder === address} onClick={() => void askForRecord()} data-testid="ask-record">
                  {busy === "request" ? (step ?? "working…") : "Ask for the record"}
                </button>
              </div>
            )}
          </li>
          <li>
            <strong>Send the request link to the holder</strong>, through a channel you already use. They answer with a
            reply link; open it in this browser.
            {link ? <textarea readOnly value={link} style={{ minHeight: "4rem", width: "100%" }} data-testid="offer-request-link" /> : null}
            {link && myRequest ? (
              <div>
                <button onClick={() => void navigator.clipboard.writeText(link)}>Copy</button>{" "}
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    void run("cancel-request", { action: "cancel_record_request", requestId: myRequest.id }, "Record request withdrawn.")
                  }
                >
                  Withdraw the request
                </button>
              </div>
            ) : null}
          </li>
          <li>
            <strong>Make the offer.</strong>{" "}
            {record === undefined
              ? "Looking for the record in this browser…"
              : record === null
                ? "Not yet: this browser has not received and checked the record."
                : record.commitment === right.commitment
                  ? "The record in this browser matches the commitment on chain ✓"
                  : "The record in this browser is for an earlier holder: ask again."}
            <div>
              <button
                className="primary"
                disabled={busy !== null || priceProblem !== null || !myRequest || !record || record.commitment !== right.commitment}
                onClick={() => void offerSale()}
                data-testid="offer-buy"
              >
                {busy === "offer" ? (step ?? "working…") : "Make the purchase offer"}
              </button>
            </div>
          </li>
        </ol>
      )}
    </div>
  );
}

// --- your offers ------------------------------------------------------------------

function YourOffers(props: {
  offers: Listed<Offer>[];
  data: Payments | null;
  address: string;
  rights: Record<number, ChainRight>;
  busy: string | null;
  step: string | null;
  onCancel: (o: Offer) => void;
}) {
  const { offers, data, address, rights, busy, step, onCancel } = props;
  const live = new Set(offers.map((o) => o.id));
  // Offers this browser made that have left storage: accepted, or closed.
  const gone = madeOffers().filter((m) => m.by === address && !live.has(m.id));
  if (offers.length === 0 && gone.length === 0) return <p className="muted">You have no offers.</p>;
  return (
    <>
      {offers.map((o) => (
        <div className="card" key={o.id} data-testid={`my-offer-${o.id}`}>
          <div className="row" style={{ gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            <span className={`tag ${o.expired ? "warn" : "ok"}`}>{o.expired ? "offer expired" : "offer open"}</span>
            <strong>
              #{o.rightId} · {o.terms.kind === "sale" ? "to buy" : "to rent"} · {formatUsdc(BigInt(o.price))} USDC
            </strong>
          </div>
          <p className="muted" style={{ marginBottom: "0.5rem" }}>
            {o.expired
              ? "It can no longer be accepted. Its amount stays in your allowance until your next offer call, and cannot be pulled."
              : `Open until ledger ${o.expiresLedger.toLocaleString()} (now ${data?.ledger.toLocaleString() ?? "…"}). The USDC is still in your account.`}
          </p>
          {!o.expired ? (
            <button disabled={busy !== null} onClick={() => onCancel(o)} data-testid={`cancel-offer-${o.id}`}>
              {busy === `cancel-${o.id}` ? (step ?? "working…") : "Cancel the offer"}
            </button>
          ) : null}
        </div>
      ))}
      {gone.map((m) => {
        const escrow = data?.escrows.find((e) => e.offerId === m.id);
        const right = rights[m.rightId];
        const accepted = m.kind === "rental" ? escrow !== undefined : right?.title_holder === address;
        return (
          <div className="card" key={`gone-${m.id}`} data-testid={`my-offer-${m.id}`}>
            <span className={`tag ${accepted ? "ok" : ""}`}>{accepted ? "accepted" : "closed"}</span>{" "}
            <strong>
              #{m.rightId} · {m.kind === "sale" ? "to buy" : "to rent"}
            </strong>
            <p className="muted" style={{ marginBottom: 0 }}>
              {accepted
                ? m.kind === "rental"
                  ? `Accepted: escrow #${escrow!.id} below holds your payment.`
                  : "Accepted: the week is yours, and the payment went to the seller in the same transaction."
                : "Cancelled or expired. Nothing moved."}
            </p>
          </div>
        );
      })}
    </>
  );
}

// --- escrows ------------------------------------------------------------------

function EscrowCard(props: {
  e: Escrow;
  now: number;
  address: string;
  busy: string | null;
  step: string | null;
  run: (key: string, body: Record<string, unknown>, success: string) => Promise<boolean>;
  /** This account is a G… account with no USDC trustline: it cannot be paid. */
  noTrustline: boolean;
}) {
  const { e, now, address, busy, step, run, noTrustline } = props;
  const [file, setFile] = useState<{ name: string; hash: string } | null>(null);
  const status = escrowStatus(e, now);
  const isOwner = e.owner === address;
  const isRenter = e.renter === address;
  const amount = formatUsdc(BigInt(e.amount));
  const windowOpen = now < e.checkIn + DAY;
  const myEvidence = isOwner ? e.ownerEvidence : e.renterEvidence;
  const key = (a: string) => `${a}-${e.id}`;
  const label = (a: string, text: string) => (busy === key(a) ? (step ?? "working…") : text);

  const pick = async (f: File | undefined) => {
    if (!f) return setFile(null);
    // Hashed here. The file itself is never uploaded anywhere.
    setFile({ name: f.name, hash: await sha256File(f) });
  };

  return (
    <div className="card" data-testid={`escrow-${e.id}`}>
      <div className="row" style={{ gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
        <span className={`tag ${status.tone}`} data-testid={`escrow-${e.id}-status`}>
          {status.label}
        </span>
        <strong>
          Escrow #{e.id} · week #{e.rightId} · {amount} USDC
        </strong>
        <span className="muted">{isOwner ? `you rented it out to ${shortAddress(e.renter)}` : `you rent it from ${shortAddress(e.owner)}`}</span>
      </div>
      <dl className="facts">
        <dt>Check-in</dt>
        <dd>{formatDateTime(e.checkIn)}</dd>
        <dt>Owner can collect from</dt>
        <dd>{formatDateTime(e.checkIn + DAY)}</dd>
        <dt>Rental ends</dt>
        <dd>{formatDateTime(e.expiresAt)}</dd>
        {e.reportHash ? (
          <>
            <dt>Problem report (SHA-256)</dt>
            <dd className="hash">{e.reportHash}</dd>
          </>
        ) : null}
        {e.ownerEvidence.length + e.renterEvidence.length > 0 ? (
          <>
            <dt>Evidence (SHA-256)</dt>
            <dd className="hash">
              {e.ownerEvidence.map((h) => `owner ${h}`).concat(e.renterEvidence.map((h) => `renter ${h}`)).join("\n")}
            </dd>
          </>
        ) : null}
        {e.decisionHash ? (
          <>
            <dt>Arbiter&apos;s decision (SHA-256)</dt>
            <dd className="hash">{e.decisionHash}</dd>
          </>
        ) : null}
      </dl>
      <p className="muted" style={{ fontSize: "0.85em" }}>
        Times are shown from this computer&apos;s clock; the contract decides by the ledger&apos;s time.
      </p>

      {e.state === "Disputed" ? (
        <div className="note bad">
          A problem was reported. Either party can still settle it: the renter can release the payment, the owner can
          refund it. Otherwise the pilot arbiter decides, and can only pay the owner or refund the renter.
        </div>
      ) : null}

      {isOwner && noTrustline && (e.state === "Funded" || e.state === "Disputed") ? (
        <TrustlineNotice
          testid={`escrow-no-trustline-${e.id}`}
          before="collect"
          why="This account has no USDC trustline, so the token cannot pay it: collecting would be refused, and so would the renter's release or an arbiter's payout to you. The payment stays in escrow until you add one."
        />
      ) : null}

      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        {isOwner && e.state === "Funded" ? (
          <button
            className="primary"
            disabled={busy !== null || windowOpen || noTrustline}
            title={windowOpen ? "available from 24 hours after check-in" : undefined}
            onClick={() => void run(key("collect"), { action: "collect", escrowId: e.id }, `Collected ${amount} USDC.`)}
            data-testid={`collect-${e.id}`}
          >
            {label("collect", windowOpen ? `Collect (from ${formatDateTime(e.checkIn + DAY)})` : "Collect the payment")}
          </button>
        ) : null}
        {isRenter && (e.state === "Funded" || e.state === "Disputed") ? (
          <button
            disabled={busy !== null}
            onClick={() => void run(key("confirm"), { action: "confirm", escrowId: e.id }, `Released ${amount} USDC to the owner.`)}
            data-testid={`confirm-${e.id}`}
          >
            {label("confirm", e.state === "Disputed" ? "Release the payment after all" : "All good: release the payment now")}
          </button>
        ) : null}
        {isOwner && e.state === "Disputed" ? (
          <button
            disabled={busy !== null}
            onClick={() => void run(key("refund"), { action: "refund", escrowId: e.id }, `Refunded ${amount} USDC to the renter.`)}
            data-testid={`refund-${e.id}`}
          >
            {label("refund", "Refund the renter")}
          </button>
        ) : null}
      </div>

      {(isRenter && e.state === "Funded" && windowOpen) || (e.state === "Disputed" && myEvidence.length < 4) ? (
        <div style={{ marginTop: "0.8rem" }}>
          <label>
            {e.state === "Funded" ? "Report a problem: choose a file describing it" : `Add evidence (${myEvidence.length} of 4 used)`}
            <input type="file" onChange={(ev) => void pick(ev.target.files?.[0])} data-testid={`evidence-file-${e.id}`} />
          </label>
          {file ? (
            <p className="muted">
              {file.name}: SHA-256 <code>{file.hash}</code>. Only this hash is sent; the file stays on this computer.
            </p>
          ) : null}
          <button
            disabled={busy !== null || !file}
            onClick={() =>
              void run(
                key("evidence"),
                e.state === "Funded"
                  ? { action: "report_problem", escrowId: e.id, evidenceHash: file!.hash }
                  : { action: "submit_evidence", escrowId: e.id, evidenceHash: file!.hash },
                e.state === "Funded" ? "Problem reported. The escrow is now disputed." : "Evidence hash recorded on chain.",
              ).then((ok) => ok && setFile(null))
            }
            data-testid={`${e.state === "Funded" ? "report" : "evidence"}-${e.id}`}
          >
            {label("evidence", e.state === "Funded" ? "Report the problem" : "Submit the evidence hash")}
          </button>
        </div>
      ) : null}
      {isRenter && e.state === "Funded" && !windowOpen ? (
        <p className="muted">The window to report a problem closed 24 hours after check-in.</p>
      ) : null}
    </div>
  );
}

/**
 * The notice for a G… account with no USDC trustline (Step 3 trustline item):
 * shown wherever this account is about to be paid, and the action that would
 * pay it is disabled with it.
 */
function TrustlineNotice({ testid, before, why }: { testid: string; before: "accept" | "collect"; why: string }) {
  return (
    <div className="note bad" data-testid={testid}>
      <strong>Add a USDC trustline before you {before}.</strong> {why} In your wallet, add the asset USDC issued by{" "}
      <code>{shortAddress(USDC_ISSUER)}</code> ({USDC_ISSUER}), then reload this page.
    </div>
  );
}
