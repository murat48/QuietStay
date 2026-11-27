"use client";

/**
 * Screen 2 of 4 — **List**.
 *
 * The registry exactly as the contract has it: every right, who holds it, until
 * when, and what is on offer. Everything on this page is a simulated read from the
 * deployed contract; none of it is a local cache.
 *
 * The holder of a week can publish or withdraw an offer here.
 *
 * **Anyone may browse.** Everything here is read from the public contract, and
 * someone deciding whether QuietStay is for them should not have to install a
 * wallet first. Acting is another matter: asking for a week or offering one
 * takes a SEP-10 session, not merely a connected wallet, because connecting only
 * claims an address and the signature proves it. So `address` below is the
 * *signed-in* account, null for a visitor and for a wallet that has not signed —
 * which is why the controls test only who the account is.
 *
 * Verification stays open to everybody, because a design whose whole claim is
 * that a counterparty can check a week without trusting anyone cannot then
 * require them to sign in first.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import Link from "next/link";
import { createPortal } from "react-dom";

import { photosFor, StayCover, StayGallery } from "@/components/StayPhotos";
import { useWallet } from "@/components/WalletProvider";
import { ATTESTATIONS, NETWORK_LABEL, explorer } from "@/lib/config";
import { describeError, formatDate, formatDays, notYetValid, shortAddress, weekIsOver } from "@/lib/format";
import { unixToIsoDate } from "@/lib/record";
import { requestLink } from "@/lib/sealed";
import { formatUsdc, parseUsdc } from "@/lib/usdc";
import { fileRenewal } from "@/lib/issuance-ask";
import { renewalDetails } from "@/lib/issuer-key";
import { useAutoRenewals } from "@/lib/use-auto-renew";
import { getRecord, sealKey } from "@/lib/vault";

/** What the holder typed as an asking price, in base units, or null if it is not one. */
function typedPrice(text: string | undefined): bigint | null {
  try {
    const units = parseUsdc(text ?? "");
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

interface RightRow {
  id: number;
  week: { start: number; end: number };
  validity: { from: number; until: number };
  commitment: string;
  title_holder: string | null;
  effective_holder: string;
  term_ends: number | null;
  rented_out: boolean;
  chain_depth: number;
  active: boolean;
  listing: {
    by: string;
    term_secs: number | null;
    listed_at: number;
    /** The holder's asking price in USDC base units, kept off chain; null if none. */
    asking_price: string | null;
  } | null;
  /** From the issuer's attestation, not the ledger. `null` = never attested. */
  fees: { current: boolean; paid_through: string } | null;
  /**
   * What the issuer publishes about the place, from the attestation rather than
   * the ledger. `null` = never attested, which is the state a week is in before
   * anyone has vouched for it and which blocks its transfer anyway.
   */
  property: {
    region: string;
    bedrooms: number;
    sleeps?: number;
    features?: string[];
  } | null;
}

interface TransferRequest {
  id: string;
  right_id: number;
  by: string;
  to_holder: string;
  term_secs: number | null;
  requested_at: string;
  status: "open" | "accepted" | "declined" | "withdrawn";
  reason?: string;
  /** A sale ask's consent: the buyer's h', which the holder proves with. */
  consent?: { next_secret_hash: string; valid_until_ledger: number };
  /** Phase 3: the hash of the buyer's sealed-link key. */
  key_hash?: string;
}

/**
 * The buyer's request link for a sale ask, if this browser holds its key. The
 * holder opens it to seal the week's record back to this browser.
 */
function BuyRequestLink({ ask }: { ask: TransferRequest }) {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (!ask.key_hash) return;
    void sealKey(ask.key_hash).then((key) => {
      if (key) setLink(requestLink(window.location.origin, "buy", ask.id, key.publicRaw));
    });
  }, [ask]);
  if (!link) return null;
  return (
    <div style={{ marginTop: "0.5rem", width: "100%" }}>
      <p className="muted" style={{ margin: "0 0 0.3rem" }}>
        Send the holder this link. They open it to seal the week&apos;s record to this browser; open
        the reply link they send back here. Check the record before the sale goes ahead.
      </p>
      <textarea readOnly value={link} style={{ minHeight: "4rem", width: "100%" }} data-testid="buy-request-link" />
    </div>
  );
}

/**
 * What the registry is being narrowed to.
 *
 * Each one answers a question somebody actually arrives with. Two of them —
 * "Yours" and "Awaiting an answer" — are about the reader rather than the
 * registry, and both would be permanently empty without an account.
 *
 * "For rent" and "Rented out" sound alike and are opposites: the first is what
 * can be taken, the second what already has been. A week is in exactly one of
 * them, never both, and separating them is the whole reason the shopping
 * filters stopped returning sub-let offers.
 *
 * "Awaiting an answer" earns its place because an ask is the only thing here
 * that is *waiting on a person*. An offer sits until someone takes it, but a
 * request has somebody on the other end who cannot proceed until this account
 * answers — and buried among a holder's own weeks, each already carrying its
 * facts, fees and offer controls, it was easy to miss entirely.
 */
type Filter = "all" | "rent" | "sale" | "rented" | "yours" | "pending";

/**
 * What an empty result means, which is different enough per filter to be worth
 * saying — "nothing here" and "nothing available" are not the same news.
 *
 * A record rather than the nested ternary this outgrew, so adding a filter is a
 * type error until its empty case is written.
 */
const EMPTY: Record<Filter, string> = {
  all: "The registry is empty.",
  rent: "No week is available to rent right now.",
  sale: "No week is available to buy right now.",
  rented: "No week is out on a term — every one of them is with whoever holds title.",
  yours: "You hold no weeks on this contract — neither owned nor rented.",
  pending:
    "Nothing is waiting on an answer. Asks appear here in both directions — one you sent and are waiting on, or one sent to you about a week you hold.",
};

/**
 * Arrears, or no attestation at all. Shown to anyone looking at the week — it is
 * what a buyer most wants to know — and nothing more: under Phase 2 no
 * attestation is a condition of a transfer, so neither its content nor its
 * absence stops one. An interface that hid or froze the week here would be
 * putting back the issuer gate the contract took away.
 */
const feesWarning = (right: RightRow): boolean => right.fees === null || !right.fees.current;

/**
 * An offer that is a sub-let, and so can never be carried out.
 *
 * A week out on a term can only be listed by the account holding that term —
 * `list` asks the contract for the effective holder — so an offer on a
 * rented-out week is always the renter passing it on. Under Phase 2 no renter
 * can transfer: proving a transfer takes the record secret, which only the title
 * holder has. So nobody should be invited to ask for one.
 */
const isSublet = (right: RightRow): boolean => right.rented_out && right.listing !== null;

/** A week whose check-out has passed. See `weekIsOver`. */
const isOver = (right: RightRow): boolean => weekIsOver(right.week.end);

/** An offer nobody can take up — a sub-let, or a week already over. Kept out of the shop window. */
const isBlocked = (right: RightRow): boolean => isSublet(right) || isOver(right);

interface Inventory {
  contract: string;
  contract_explorer: string;
  token: { name: string; symbol: string; decimals: number };
  issuer: string;
  now: number;
  rights: RightRow[];
}

export default function ListScreen() {
  const {
    address: walletAddress,
    kind,
    authenticated,
    restoring,
    readOnly,
    sign,
    submitSigned,
    authFetch,
    connect,
    connectPasskey,
    busy,
  } = useWallet();
  // A recognised passkey wallet signs in with its passkey, not with a regular
  // wallet (found on the testnet demo, 2026-11-25: these buttons opened the
  // regular-wallet picker for a passkey user).
  const signIn = () => void (walletAddress && kind === "passkey" ? connectPasskey(false) : connect());
  // Anyone may browse; only a proved account acts. A wallet connected but not
  // signed in is treated as a visitor, so no owner's control is offered to an
  // address nobody has proved.
  const address = authenticated ? walletAddress : null;
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRight, setBusyRight] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The date the issuer is settling fees through, per right. Keyed rather than
  // held once, so two cards on screen cannot share one input.
  const [paidThrough, setPaidThrough] = useState<Record<number, string>>({});
  // The asking price the holder is typing, per week, in USDC.
  const [askPrice, setAskPrice] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  // Which card is showing the placeholder's explanation. Per right, so two cards
  // with arrears cannot share one open notice.
  const [payNotice, setPayNotice] = useState<number | null>(null);
  // The one card opened into its full view: photos, then everything else.
  const [opened, setOpened] = useState<number | null>(null);
  // Only on a larger screen. On a phone the card already shows everything a
  // gallery would, and the cover is just a picture.
  const openCard = (id: number) => {
    if (window.matchMedia("(max-width: 900px)").matches) return;
    setOpened(id);
  };
  // While a card is open as a lightbox: Escape closes it, and the page behind
  // holds still rather than scrolling under the overlay.
  useEffect(() => {
    if (opened === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpened(null);
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [opened]);
  // Automatic renewals carry on by themselves once their week is in this browser.
  useAutoRenewals();
  // This account's issuance asks, for each week's renewal status (2026-11-27).
  const [myAsks, setMyAsks] = useState<OwnIssuanceAsk[]>([]);
  // A renewed week starts from the price its renewal carried (2026-11-27).
  const renewalPriceFor = (rightId: number): string => {
    const from = myAsks.find((a) => a.status === "issued" && a.right_id === rightId && a.price);
    return from?.price ? formatUsdc(BigInt(from.price)) : "";
  };
  const loadMyAsks = useCallback(async () => {
    if (!authenticated) return setMyAsks([]);
    try {
      const res = await authFetch("/api/requests/issuance");
      const body = (await res.json()) as { requests?: OwnIssuanceAsk[] };
      if (res.ok) setMyAsks(body.requests ?? []);
    } catch {
      // shown again on the next load
    }
  }, [authenticated, authFetch]);
  useEffect(() => {
    void Promise.resolve().then(loadMyAsks);
  }, [loadMyAsks]);
  const [requests, setRequests] = useState<{ incoming: TransferRequest[]; outgoing: TransferRequest[] }>(
    { incoming: [], outgoing: [] },
  );
  // One-shot, so landing on your own weeks does not fight a filter you picked.
  const autoSelected = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      const body = (await response.json()) as Inventory & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "could not read the registry");
      setInventory(body);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  /**
   * The asks this account is party to. Served only to the two parties, so this
   * returns an empty pair for a visitor rather than failing.
   */
  const loadRequests = useCallback(async () => {
    if (!authenticated) {
      setRequests({ incoming: [], outgoing: [] });
      return;
    }
    try {
      const response = await authFetch("/api/requests", { method: "GET" });
      const body = (await response.json()) as {
        incoming?: TransferRequest[];
        outgoing?: TransferRequest[];
      };
      setRequests({ incoming: body.incoming ?? [], outgoing: body.outgoing ?? [] });
    } catch {
      // A registry that still reads is worth more than an error banner about a
      // side panel, so this stays quiet.
    }
  }, [authenticated, authFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  /**
   * Whether one right belongs in one filter.
   *
   * "Yours" is held either way round: the week you own and the week you are
   * renting are both yours to be shown, and a renter arriving at the registry is
   * looking for the one they took, not the one they hold title to — they hold
   * title to nothing.
   *
   * "For rent" and "For sale" are shopping filters, and so they answer *can I
   * take this one*, not *does it carry an offer*. A week already rented out
   * carries the renter's sub-let offer, which no renter can carry out. It stays
   * visible under "All" and "Yours" — where its holder needs to find it — but it
   * is not available, so it does not belong in a list of what is. A week in
   * arrears *is* available — no attestation stops a transfer — and its card
   * says what is owed.
   */
  const matches = useCallback(
    (right: RightRow, which: Filter): boolean => {
      switch (which) {
        case "rent":
          return right.listing?.term_secs != null && !isBlocked(right);
        case "sale":
          return right.listing !== null && right.listing.term_secs === null && !isBlocked(right);
        // Occupied on a finite term, whoever holds it. The card's own tags say
        // which side of it the reader is on, so this stays registry-wide rather
        // than quietly becoming a second "Yours".
        case "rented":
          return right.rented_out;
        case "yours":
          return (
            address !== null &&
            (right.effective_holder === address || right.title_holder === address)
          );
        // Both directions, because both are unfinished business: one is waiting
        // on this account to answer, the other on somebody else. The API serves
        // only the two parties to a request, so anything here is already ours.
        case "pending":
          return (
            requests.incoming.some((r) => r.right_id === right.id && r.status === "open") ||
            requests.outgoing.some((r) => r.right_id === right.id && r.status === "open")
          );
        default:
          return true;
      }
    },
    [address, requests],
  );

  const counts = useMemo(() => {
    const rights = inventory?.rights ?? [];
    return {
      all: rights.length,
      rent: rights.filter((r) => matches(r, "rent")).length,
      sale: rights.filter((r) => matches(r, "sale")).length,
      rented: rights.filter((r) => matches(r, "rented")).length,
      yours: rights.filter((r) => matches(r, "yours")).length,
      pending: rights.filter((r) => matches(r, "pending")).length,
    };
  }, [inventory, matches]);

  /**
   * How many of those are waiting on *this* account, which is a different number
   * from the tab's: a request you sent is pending too, but there is nothing for
   * you to do about it. Only this one is worth pulling somebody towards.
   */
  const awaitingYou = useMemo(
    () => new Set(requests.incoming.filter((r) => r.status === "open").map((r) => r.right_id)).size,
    [requests],
  );

  // Someone who holds a week almost always came to look at it — unless somebody
  // is waiting on them, which comes first. Done once either way, so a filter you
  // picked is never overruled, and a visitor with nothing is left on "all".
  useEffect(() => {
    if (autoSelected.current || address === null) return;
    if (awaitingYou > 0) {
      autoSelected.current = true;
      setFilter("pending");
    } else if (counts.yours > 0) {
      autoSelected.current = true;
      setFilter("yours");
    }
  }, [address, awaitingYou, counts.yours]);

  // Filtering to a set that turns out to be empty leaves a blank page with no
  // explanation, so the empty case is rendered rather than fallen into.
  const shown = (inventory?.rights ?? [])
    .filter((right) => matches(right, filter))
    // Under "All" and "Yours" a sub-let sorts last rather than vanishing:
    // it is genuinely in the registry, and its holder has to see the card to
    // clear whatever is blocking it. The shopping filters exclude it instead —
    // there it would be an offer nobody can take.
    .sort((a, b) => Number(isBlocked(a)) - Number(isBlocked(b)));


  /** Save the asking price for a week already listed by this account. */
  const savePrice = useCallback(
    async (rightId: number, units: bigint) => {
      const response = await authFetch("/api/asking-price", {
        method: "POST",
        body: JSON.stringify({ right_id: rightId, price: formatUsdc(units) }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "could not save the asking price");
    },
    [authFetch],
  );

  const changePrice = useCallback(
    async (rightId: number, units: bigint) => {
      setBusyRight(rightId);
      setMessage(null);
      setError(null);
      try {
        await savePrice(rightId, units);
        setMessage(`Asking price for right #${rightId} set to ${formatUsdc(units)} USDC`);
        await load();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [savePrice, load],
  );

  const changeOffer = useCallback(
    async (rightId: number, action: "list" | "unlist", termSecs: number | null, price: bigint | null = null) => {
      if (!address) return;
      setBusyRight(rightId);
      setMessage(null);
      setError(null);
      try {
        const built = await authFetch("/api/tx/build", {
          method: "POST",
          body: JSON.stringify({ action, by: address, rightId, termSecs }),
        });
        const builtBody = (await built.json()) as { xdr?: string; error?: string };
        if (!built.ok || !builtBody.xdr) throw new Error(builtBody.error ?? "could not build");

        const signed = await sign(builtBody.xdr);

        // A regular wallet's transaction goes to /api/tx/submit; a passkey's, with
        // its fee paid by the testnet fee account, to /api/tx/sponsor.
        const result = await submitSigned(signed);
        if (!result.ok) throw new Error(result.error ?? "submission failed");
        if (!result.successful) throw new Error(result.failure ?? "the contract rejected it");

        setMessage(
          `${action === "list" ? "Offer published" : "Offer withdrawn"} for right #${rightId} — ${result.hash}`,
        );
        // The price is kept off chain, beside the listing just made. If saving it
        // fails the listing still stands, and the price can be set again below.
        if (action === "list" && price !== null) {
          try {
            await savePrice(rightId, price);
          } catch (caught) {
            setError(`The week is listed, but its asking price was not saved: ${describeError(caught)}`);
          }
        }
        await load();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [address, authFetch, sign, submitSigned, load, savePrice],
  );

  /** Decline an ask, or take your own back. Neither touches the chain. */
  const answerRequest = useCallback(
    async (req: TransferRequest, action: "decline" | "withdraw") => {
      setBusyRight(req.right_id);
      setMessage(null);
      setError(null);
      try {
        const response = await authFetch(`/api/requests/${req.id}`, {
          method: "POST",
          body: JSON.stringify({ right_id: req.right_id, action }),
        });
        const body = (await response.json()) as { note?: string; error?: string };
        if (!response.ok) throw new Error(body.error ?? "could not answer the request");
        setMessage(`Right #${req.right_id} — ${body.note ?? "answered"}`);
        await loadRequests();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [authFetch, loadRequests],
  );

  /**
   * Record that a week's maintenance fees have been settled.
   *
   * No transaction and no signature from the holder: this re-signs the issuer's
   * attestation and touches neither the record nor the ledger. The commitment
   * stands, the right is untouched, and what changes is only what the issuer
   * currently vouches for, which is what a buyer reads.
   */
  const settleFees = useCallback(
    async (rightId: number, through: string, current: boolean) => {
      setBusyRight(rightId);
      setMessage(null);
      setError(null);
      try {
        const response = await authFetch("/api/settle-fees", {
          method: "POST",
          body: JSON.stringify({
            right_id: rightId,
            paid_through: through,
            fees_current: current,
          }),
        });
        const body = (await response.json()) as { note?: string; error?: string };
        if (!response.ok) throw new Error(body.error ?? "could not record the settlement");
        setMessage(`Right #${rightId} — ${body.note ?? "attestation re-signed"}`);
        await load();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [authFetch, load],
  );

  return (
    <>
      <p className="eyebrow">EXPLORE QUIETSTAY</p>
      <h1>Find your next week away</h1>
      <p className="lede">
        The shop window and the public record in one, read live from {NETWORK_LABEL}. A week&apos;s date
        range and its use year are public, because an offer has to say what it is offering. Who owns
        it, which resort it is, and the deed behind it are not on the ledger at all — only the hash
        is.
      </p>
      <p className="lede" style={{ marginTop: "-1rem" }}>
        <strong>What the place is comes from the issuer, not the chain.</strong> A commitment covers
        the whole record, so no single field of it can be revealed and checked on its own — which
        would leave a registry that says when a week is and nothing else. Nobody takes a week
        without knowing where it is, how many it sleeps, and what it offers, so the issuer signs
        those alongside the fee status. The town but not the resort, what the place is but not which
        apartment: the resort, the unit and the deed stay in the record, and the seller discloses
        those once, to a buyer, who can then check the whole document against the hash below.
      </p>
      <p className="lede" style={{ marginTop: "-1rem" }}>
        <strong>Publishing an offer needs nobody&apos;s approval.</strong> If a week below is yours,
        the controls to offer or withdraw it appear on its card and go straight to the contract. The
        issuer is not involved in listing — nor, under Phase 2, in the week changing hands: that
        takes the holder&apos;s ownership proof, which the contract checks itself.
      </p>

      {/*
        Browsing needs no wallet: everything here is read from the public
        contract. Signing in is asked for only to act — to offer for a week, or to
        offer one you hold.
      */}
      {restoring && !authenticated ? (
        <p className="muted">Resuming your session…</p>
      ) : !authenticated ? (
        <div className="note accent">
          You are browsing as a visitor. <strong>Sign in</strong> to rent or buy a week, or to manage
          your own.{" "}
          <button className="primary" onClick={signIn} disabled={busy}>
            {walletAddress ? (busy ? "signing…" : "Sign in") : busy ? "connecting…" : "Connect wallet"}
          </button>
        </div>
      ) : null}

      {error ? <div className="note bad">{error}</div> : null}
      {message ? <div className="note accent">{message}</div> : null}

      {inventory ? (
        <>
          {/*
            The count is the only line here anyone browsing needs; the token's
            symbol and the issuer's account answer questions they have not asked.
            Kept, one click down, because a reviewer opens this first.
          */}
          <div className="card tight">
            <dl className="facts">
              <dt>Weeks in the registry</dt>
              <dd>{inventory.rights.length}</dd>
            </dl>
            <details className="tech">
              <summary>Contract and issuer</summary>
              <dl className="facts">
                <dt>Token</dt>
                <dd>
                  {inventory.token.name} (<code>{inventory.token.symbol}</code>), decimals{" "}
                  {inventory.token.decimals} — a week is not divisible
                </dd>
                <dt>Issuer</dt>
                <dd>
                  <a href={explorer.account(inventory.issuer)} target="_blank" rel="noreferrer">
                    <code>{inventory.issuer}</code>
                  </a>
                </dd>
                <dt>Contract</dt>
                <dd>
                  <a href={inventory.contract_explorer} target="_blank" rel="noreferrer">
                    <code>{inventory.contract}</code>
                  </a>
                </dd>
              </dl>
            </details>
          </div>

          {/*
            Counts are on the labels rather than discovered by clicking: a filter
            that turns out to be empty has wasted the click, and "for sale 0" is
            itself the answer to what someone came to ask.
          */}
          <div className="tabs" role="tablist" aria-label="Filter the registry">
            {([
              ["all", "All", counts.all],
              ["rent", "For rent", counts.rent],
              ["sale", "For sale", counts.sale],
              ["rented", "Rented out", counts.rented],
              // Only for a connected account. For anyone else it is always empty,
              // and a permanently empty control is just a question mark.
              ...(address !== null
                ? ([
                    ["yours", "Yours", counts.yours],
                    ["pending", "Awaiting an answer", counts.pending],
                  ] as const)
                : []),
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}{" "}
                {/*
                  The count on this one tab stops being a footnote when somebody
                  is waiting on an answer, because then it is the only number on
                  the strip that is asking the reader for something.
                */}
                <span className={key === "pending" && awaitingYou > 0 ? "tag accent" : "muted"}>
                  {count}
                </span>
              </button>
            ))}
          </div>

          {/*
            The counts do not add up to "All", and without this they look like
            arithmetic that went wrong. They are answers to different questions:
            a week can be in two of them, and one nobody has offered is in none.
            Said plainly rather than as a note box, which would make a permanent
            fact of the registry look like a warning about it.
          */}
          <p className="tabs-hint">
            <strong>All</strong> is every week here. The rest are different questions, not
            slices — a week can appear in two of them, and a week nobody has offered
            appears in none.
          </p>

          {shown.length === 0 ? (
            <div className="note">
              {EMPTY[filter]}{" "}
              {filter === "all" ? null : (
                <button onClick={() => setFilter("all")}>Show all {counts.all}</button>
              )}
            </div>
          ) : null}

          <div className="grid">
            {shown.map((right) => {
              const mine = address !== null && right.effective_holder === address;
              const isTitleHolder = address !== null && right.title_holder === address;
              // Title held by this account but occupied by someone else: still
              // "yours", and worth distinguishing from a week you can act on.
              const ownedButRentedOut = isTitleHolder && !mine;
              // You hold the week, but on a term someone else granted you.
              const iAmTheRenter = mine && !isTitleHolder;
              const isIssuer = address !== null && address === inventory.issuer;
              // A week nothing vouches for is as untransferable as one in
              // arrears, so the two are treated alike rather than only the loud
              // one being shown.
              const owesFees = feesWarning(right);
              // An offer on a week that is out on a term is a sub-let, which this
              // issuer declines and which no later phase has committed to.
              const sublet = isSublet(right);
              const over = isOver(right);
              // Under "Awaiting an answer" the card is on screen for exactly one
              // reason, so the controls for *running* a week — the issuer's fee
              // entry, the holder's own offer — stand down. Answering an ask is a
              // decision about somebody else's plans, and the surrounding
              // machinery is what made it easy to overlook. Both are one tab away.
              const answering = filter === "pending";
              /*
               * Who may publish an offer at all: the title holder, and nobody
               * else. A renter listing the week they are staying in is a
               * sub-let. The contract permits it — `list` asks only the
               * effective holder — but this issuer declines every transfer of
               * one, so the offer would be dead the moment it appeared: kept
               * out of "For rent" by `isSublet`, shown to no buyer, and refused
               * if anyone asked anyway. Offering the button was inviting
               * somebody to pay a fee for a listing nothing could come of.
               *
               * `!rented_out` is redundant here — a title holder whose week is
               * out on a term is not the effective holder, so `mine` is already
               * false — and is kept because the rule is easier to read than to
               * re-derive.
               */
              const mayOffer = isTitleHolder && !right.rented_out;
              // Asks for this week that are still open: incoming when it is
              // yours, outgoing when it is not.
              const asks = requests.incoming.filter(
                (r) => r.right_id === right.id && r.status === "open",
              );
              const myRequest =
                requests.outgoing.find((r) => r.right_id === right.id && r.status === "open") ??
                null;
              // The dues year runs to the day before the use year closes.
              const defaultThrough = unixToIsoDate(right.validity.until - 86_400);
              // Photos only for a week the issuer has described: with no country
              // and no features, any picture would be a claim nobody made.
              const photos =
                right.property === null
                  ? null
                  : photosFor(right.id, right.property.region, right.property.features);
              const isOpen = opened === right.id && photos !== null;

              // The card, the same whether it sits in the grid or opens over the page.
              const card = (
                <div
                  className={`card listing${isOpen ? " is-open" : ""}`}
                  id={`right-${right.id}`}
                  role={isOpen ? "dialog" : undefined}
                  aria-modal={isOpen ? true : undefined}
                  aria-label={isOpen ? `${right.property?.region ?? "Week"}, right #${right.id}` : undefined}
                >
                  {isOpen ? (
                    <button
                      type="button"
                      className="lightbox-close"
                      aria-label="Close"
                      autoFocus
                      onClick={() => setOpened(null)}
                    >
                      ✕
                    </button>
                  ) : null}
                  {photos === null ? null : isOpen ? (
                    <StayGallery photos={photos} />
                  ) : (
                    <StayCover photos={photos} onOpen={() => openCard(right.id)} />
                  )}
                  <div className="spread">
                    <h3 style={{ margin: 0 }}>
                      {right.property?.region ?? `Right #${right.id}`}
                      {right.property ? <span className="muted listing-id"> · Right #{right.id}</span> : null}
                    </h3>
                    <div className="row" style={{ gap: "0.3rem" }}>
                      {right.active ? null : notYetValid(right.validity.from) ? (
                        <span className="tag warn" data-testid={`opens-${right.id}`}>
                          opens {formatDate(right.validity.from)}
                        </span>
                      ) : (
                        <span className="tag bad">expired</span>
                      )}
                      {right.active && over ? <span className="tag">week over</span> : null}
                      {right.fees !== null && !right.fees.current ? (
                        <span className="tag bad">fees due</span>
                      ) : null}
                      {right.fees === null ? <span className="tag warn">not attested</span> : null}
                      {/*
                        "rented out" is said from the title holder's side, so it
                        contradicts itself when the reader is the renter — the
                        week is not out to someone else, it is out to them. The
                        tag below says the same thing more precisely, so this one
                        stands down rather than both appearing.
                      */}
                      {right.rented_out && !iAmTheRenter ? (
                        <span className="tag warn">rented out</span>
                      ) : null}
                      {right.listing ? (
                        <span className="tag accent">
                          {right.listing.term_secs === null
                            ? "for sale"
                            : `for rent · ${formatDays(right.listing.term_secs)}`}
                          {right.listing.asking_price
                            ? ` · ${formatUsdc(BigInt(right.listing.asking_price))} USDC`
                            : null}
                        </span>
                      ) : null}
                      {mine && isTitleHolder ? <span className="tag ok">you own it</span> : null}
                      {iAmTheRenter ? <span className="tag ok">you are renting it</span> : null}
                      {ownedButRentedOut ? <span className="tag ok">yours, on loan</span> : null}
                    </div>
                  </div>

                  <dl className="facts" style={{ marginTop: "0.6rem" }}>
                    {/*
                      First, because these are the first things anyone shopping
                      asks and none of them can come from the ledger — a
                      commitment hashes the whole record, so no part of it can be
                      revealed on its own. They come from the issuer's signed
                      attestation instead, which is why it is a town and not an
                      address.
                    */}
                    <dt>Where</dt>
                    <dd>
                      {right.property !== null ? (
                        right.property.region
                      ) : right.fees === null ? (
                        // No attestation at all. Already reported by the tag and
                        // the note below, and the reason a transfer would be
                        // declined, so this only needs to not claim otherwise.
                        <span className="muted">
                          nothing has been attested for this week yet
                        </span>
                      ) : (
                        // Attested, but before the issuer published descriptions.
                        // A different thing from the above, and worth saying so:
                        // this week can still change hands.
                        <span className="muted">
                          the issuer has vouched for this week but never described it
                        </span>
                      )}
                    </dd>
                    {right.property === null ? null : (
                      <>
                        <dt>Sleeps</dt>
                        <dd>
                          {right.property.sleeps === undefined ? (
                            <span className="muted">not stated</span>
                          ) : (
                            `${right.property.sleeps} people`
                          )}
                          <span className="muted">
                            {" "}
                            · {right.property.bedrooms}{" "}
                            {right.property.bedrooms === 1 ? "bedroom" : "bedrooms"}
                          </span>
                        </dd>
                        {right.property.features?.length ? (
                          <>
                            <dt>Features</dt>
                            <dd>{right.property.features.join(" · ")}</dd>
                          </>
                        ) : null}
                      </>
                    )}
                    <dt>Week</dt>
                    <dd>
                      {formatDate(right.week.start)} → {formatDate(right.week.end)}
                    </dd>
                    {/*
                      Who holds it, said the way somebody shopping would ask it.
                      The accounts themselves are below, under the fold: an
                      address answers "which key" when the question was "can I
                      have it, and when".
                    */}
                    {right.term_ends !== null ? (
                      <>
                        <dt>Availability</dt>
                        <dd>
                          taken until {formatDate(right.term_ends)}
                          <span className="muted"> — then it returns to its owner</span>
                        </dd>
                      </>
                    ) : null}
                    <dt>Maintenance fees</dt>
                    <dd>
                      {right.fees === null ? (
                        <span className="muted">the issuer has attested nothing for this week</span>
                      ) : right.fees.current ? (
                        <>
                          current{" "}
                          <span className="muted">— paid through {right.fees.paid_through}</span>
                        </>
                      ) : (
                        <>
                          <strong>outstanding</strong>{" "}
                          <span className="muted">
                            — paid only through {right.fees.paid_through}
                          </span>
                        </>
                      )}
                    </dd>
                  </dl>

                  {/*
                    The question a card cannot leave unanswered once the week is
                    yours: where am I actually staying?

                    Only on a week you hold — somebody shopping has not earned
                    the question yet. It points at the wallet rather than at the
                    seller on purpose: the seller has been paid and has no reason
                    left to answer, and a last step that depends on their goodwill
                    is not a last step. See docs/DESIGN.md on the credential being
                    the chain.
                  */}
                  {mine ? (
                    <p className="muted" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
                      <strong>Staying here.</strong> The town is above; the resort and the unit are
                      in the ownership record, which is not published. You do not need it to arrive
                      — the issuer knows which unit this week is and can read from the contract that
                      you hold it, so your wallet is the credential. Ask for the record only to see
                      the full document, and check it on{" "}
                      <Link href="/verify">Verify</Link>.
                    </p>
                  ) : null}

                  {/*
                    The ledger's own view, folded away.

                    Not deleted. A registry that says a week is verified while
                    hiding what it was verified against is asking to be taken on
                    faith, and that is the one thing this project does not ask
                    for. One click, on every card, for anyone who wants it.
                  */}
                  <details className="tech">
                    <summary>On the ledger</summary>
                    <dl className="facts">
                      <dt>Held by</dt>
                      <dd>
                        <code>{shortAddress(right.effective_holder)}</code>
                        {right.term_ends === null ? (
                          " (outright)"
                        ) : (
                          <> until {formatDate(right.term_ends)}</>
                        )}
                      </dd>
                      {right.rented_out ? (
                        <>
                          <dt>Title</dt>
                          <dd>
                            <code>{shortAddress(right.title_holder)}</code>{" "}
                            <span className="muted">— reverts here when the term lapses</span>
                          </dd>
                        </>
                      ) : null}
                      <dt>Use year</dt>
                      <dd>
                        {formatDate(right.validity.from)} → {formatDate(right.validity.until)}
                      </dd>
                      <dt>Commitment</dt>
                      <dd className="hash">{right.commitment}</dd>
                    </dl>
                  </details>

                  {owesFees ? (
                    <div className="note warn">
                      {right.fees === null && !ATTESTATIONS
                        ? `QuietStay signs no attestations on ${NETWORK_LABEL}, so nothing here vouches for this week's maintenance fees.`
                        : right.fees === null
                        ? "The issuer has signed no attestation for this week, so nothing vouches for its maintenance fees."
                        : "The issuer attests this week carries unpaid maintenance fees."}{" "}
                      Worth knowing before taking it on — but it does not stop a transfer: no
                      attestation does. The amount owed is in the off-chain record and is not
                      published here.
                      {/*
                        Who owes is the question anyone reading this warning has,
                        and the card did not answer it. Arrears follow the deed,
                        so they are the title holder's — a renter holds a term
                        granted from that title and never became a party to it,
                        and might otherwise read this as a bill of their own.
                      */}
                      {right.fees === null ? null : (
                        <>
                          {" "}
                          Maintenance fees are owed to the resort by whoever holds title —{" "}
                          <code>{shortAddress(right.title_holder)}</code>
                          {iAmTheRenter ? ", not by you: you hold a term, not the deed" : null}
                          {isTitleHolder ? " — that is you" : null}. Settle them with the resort as
                          usual, then ask the issuer to record it; no money moves through this app.
                        </>
                      )}

                      {/*
                        A placeholder, and it must stay one. Settling for real
                        would mean either moving money — which this phase excludes —
                        or flipping the fee state without any, which is both a
                        lie and a power that belongs to the issuer alone. So it
                        marks where payment will go and says why it is not there,
                        rather than doing a convincing nothing.
                      */}
                      {right.fees === null ? null : (
                        <div className="row" style={{ marginTop: "0.6rem", gap: "0.5rem" }}>
                          <button onClick={() => setPayNotice(payNotice === right.id ? null : right.id)}>
                            Pay maintenance fees
                          </button>
                          <span className="tag warn">out of scope</span>
                        </div>
                      )}
                      {payNotice === right.id ? (
                        <div className="note bad" style={{ marginTop: "0.6rem" }}>
                          <strong>Not implemented, and deliberately so.</strong> Payment, escrow and
                          settlement of consideration are out of scope — this app
                          transfers rights and never money, which is why a listing carries a term
                          but no price. This button marks where settlement would attach if a later
                          phase funds it; unlike swaps, an audit and mainnet, nothing has promised
                          that it will.
                          <br />
                          <br />
                          Today: the title holder pays the resort directly, as they always have, and
                          the issuer records that it happened. Nothing about this week has changed
                          by clicking.
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/*
                    The two sides of an ask, on the same card.

                    A visitor who wants the week says so here rather than sending
                    the holder an address to type: a mistyped account is a week
                    given to a stranger, and by design nobody — the issuer least of
                    all — can bring it back.
                  */}
                  {right.listing && over && !mine ? (
                    <p className="muted" style={{ marginTop: "0.7rem", marginBottom: 0 }}>
                      This week ended on {formatDate(right.week.end)}. The offer is still on the
                      ledger, but it can no longer be taken: a rental would end in the past, which
                      the contract refuses.
                    </p>
                  ) : null}

                  {right.listing && !sublet && !over && !authenticated && !restoring ? (
                    <div style={{ marginTop: "0.7rem" }}>
                      <button className="primary" onClick={signIn} disabled={busy}>
                        {busy
                          ? "signing in…"
                          : right.listing.term_secs === null
                            ? "Sign in to buy it"
                            : "Sign in to rent it"}
                      </button>
                    </div>
                  ) : null}

                  {/*
                    Phase 3: a paid offer in USDC, on chain. The sale moves the
                    week and the money together; a rental's money waits in
                    escrow until 24 hours after check-in. The unpaid asks below
                    stay as they were, for regular wallets. A passkey wallet is
                    offered only the paid offer, as its main action (asked for
                    on the testnet demo, 2026-11-26).
                  */}
                  {right.listing && !over ? (
                    <p style={{ marginTop: "0.7rem", marginBottom: 0 }} data-testid={`asking-price-shown-${right.id}`}>
                      {right.listing.asking_price ? (
                        <>
                          <strong style={{ fontSize: "1.15rem" }}>
                            {formatUsdc(BigInt(right.listing.asking_price))} USDC
                          </strong>{" "}
                          <span className="muted">
                            {right.listing.term_secs === null ? "asking price" : "asking price for the stay"} — the
                            holder&apos;s ask; the price that counts is the one in the offer you make.
                          </span>
                        </>
                      ) : (
                        <span className="muted">No asking price set — make the offer you think fair.</span>
                      )}
                    </p>
                  ) : null}

                  {right.listing && !sublet && !over && authenticated && !mine ? (
                    <p style={{ marginTop: "0.7rem", marginBottom: 0 }}>
                      <Link
                        className="btn primary"
                        href={`/stays?right=${right.id}&kind=${right.listing.term_secs === null ? "buy" : "rent"}`}
                        data-testid={`paid-offer-${right.id}`}
                      >
                        {right.listing.term_secs === null ? "Offer to buy it in USDC" : "Offer to rent it in USDC"}
                      </Link>
                    </p>
                  ) : null}

                  {/*
                    The unpaid asks of Phase 2 are gone from this screen (your decision,
                    2026-11-26): a week is rented or bought with a USDC offer. An ask made
                    before then can still be withdrawn here, or answered on /transfer.
                  */}
                  {right.listing && !sublet && !over && authenticated && !mine && myRequest ? (
                    <div style={{ marginTop: "0.7rem" }}>
                      {myRequest ? (
                        <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
                          <span className="tag accent">you asked for this</span>
                          <button
                            disabled={busyRight === right.id}
                            onClick={() => void answerRequest(myRequest, "withdraw")}
                          >
                            Withdraw request
                          </button>
                          <BuyRequestLink ask={myRequest} />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {asks.length > 0 && mine ? (
                    <fieldset style={{ marginTop: "0.8rem" }}>
                      <legend>
                        {asks.length === 1 ? "One account is asking" : `${asks.length} accounts are asking`}
                      </legend>
                      <p className="muted" style={{ marginTop: 0 }}>
                        To accept, open the <Link href="/transfer">Transfer</Link> screen: your browser
                        proves you own the week, with the record and secret it keeps, and the ask
                        fills in the asker&apos;s account
                        {asks.some((r) => r.term_secs === null) ? " and, for a sale, their h'" : ""}, so
                        there is no address to type. A buyer will also send you a request link for the
                        week&apos;s record; open it in this browser.
                      </p>
                      {asks.map((req) => (
                        <div key={req.id} style={{ marginTop: "0.6rem" }}>
                          <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
                            <code>{shortAddress(req.by)}</code>
                            <span className="muted">
                              {req.term_secs === null ? "wants to buy it" : `wants it for ${formatDays(req.term_secs)}`}
                            </span>
                            <button
                              disabled={busyRight === right.id}
                              onClick={() => void answerRequest(req, "decline")}
                            >
                              Decline
                            </button>
                          </div>
                        </div>
                      ))}
                      {sublet ? (
                        <p className="muted" style={{ marginBottom: 0 }}>
                          This is a sub-let — you hold the week on a term — and only the title holder
                          can prove a transfer, so it cannot be accepted. The requests keep.
                        </p>
                      ) : null}
                    </fieldset>
                  ) : null}

                  {/*
                    The issuer's own control. Money moves with the resort the way
                    it always has; what happens here is the issuer recording that
                    it did, by re-signing its attestation. Nothing is written to
                    the ledger and the commitment is untouched.
                  */}
                  {isIssuer && !answering && !readOnly && ATTESTATIONS ? (
                    <fieldset style={{ marginTop: "0.85rem", marginBottom: 0 }}>
                      <legend>Issuer — fee status</legend>
                      <div className="row" style={{ alignItems: "flex-end" }}>
                        <div style={{ maxWidth: "11rem" }}>
                          <label htmlFor={`paid-through-${right.id}`}>Paid through</label>
                          <input
                            id={`paid-through-${right.id}`}
                            type="date"
                            value={paidThrough[right.id] ?? defaultThrough}
                            onChange={(event) =>
                              setPaidThrough((current) => ({
                                ...current,
                                [right.id]: event.target.value,
                              }))
                            }
                          />
                        </div>
                        {right.fees?.current === true ? (
                          <button
                            disabled={busyRight === right.id}
                            onClick={() =>
                              void settleFees(
                                right.id,
                                paidThrough[right.id] ?? defaultThrough,
                                false,
                              )
                            }
                          >
                            {busyRight === right.id ? "working…" : "Mark fees outstanding"}
                          </button>
                        ) : (
                          <button
                            className="primary"
                            disabled={busyRight === right.id || right.fees === null}
                            onClick={() =>
                              void settleFees(right.id, paidThrough[right.id] ?? defaultThrough, true)
                            }
                          >
                            {busyRight === right.id ? "working…" : "Mark fees settled"}
                          </button>
                        )}
                      </div>
                      {right.fees === null ? (
                        <p className="muted" style={{ margin: "0.4rem 0 0" }}>
                          There is no attestation to update. Sign the first one at issuance or with{" "}
                          <code>npm run attest</code> — <code>week_valid</code> is a claim about the
                          week itself that this control has no basis to originate.
                        </p>
                      ) : (
                        <p className="muted" style={{ margin: "0.4rem 0 0" }}>
                          Re-signs the attestation. The ownership record and the on-chain commitment
                          do not change, and no transaction is submitted.
                        </p>
                      )}
                    </fieldset>
                  ) : null}

                  {/*
                    Renewal (2026-11-27). The contract cannot move a right's
                    dates, so next year's week is a new right the issuer
                    issues; the title holder asks for it, filled in from the
                    record in this browser.
                  */}
                  {isTitleHolder && address ? (
                    <RenewWeek
                      rightId={right.id}
                      weekEnd={right.week.end}
                      validityUntil={right.validity.until}
                      listedPrice={
                        right.listing?.asking_price
                          ? formatUsdc(BigInt(right.listing.asking_price))
                          : renewalPriceFor(right.id)
                      }
                      address={address}
                      asks={myAsks.filter((a) => a.renew_of === right.id)}
                      onFiled={() => void loadMyAsks()}
                    />
                  ) : null}

                  {mine && !answering ? (
                    <div className="row" style={{ marginTop: "0.85rem" }}>
                      {right.listing ? (
                        <>
                          <label className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                            Asking price (USDC)
                            <input
                              style={{ width: "7rem" }}
                              inputMode="decimal"
                              placeholder={
                                right.listing.asking_price ? formatUsdc(BigInt(right.listing.asking_price)) : "e.g. 1"
                              }
                              value={askPrice[right.id] ?? ""}
                              onChange={(e) => setAskPrice({ ...askPrice, [right.id]: e.target.value })}
                              data-testid={`asking-price-${right.id}`}
                            />
                          </label>
                          <button
                            disabled={busyRight === right.id || typedPrice(askPrice[right.id]) === null}
                            onClick={() => {
                              const units = typedPrice(askPrice[right.id]);
                              if (units !== null) void changePrice(right.id, units);
                            }}
                          >
                            {right.listing.asking_price ? "Change price" : "Set price"}
                          </button>
                          <button
                            disabled={busyRight === right.id}
                            onClick={() => void changeOffer(right.id, "unlist", null)}
                          >
                            {busyRight === right.id ? "working…" : "Withdraw offer"}
                          </button>
                        </>
                      ) : mayOffer && over ? (
                        <p className="muted" style={{ margin: 0 }}>
                          This week ended on {formatDate(right.week.end)}, so there is nothing left
                          to offer: a rental would end in the past, which the contract refuses, and
                          a sale would pass on a week already used.
                        </p>
                      ) : mayOffer ? (
                        <>
                          {/*
                            The asking price is asked first, so no listing goes
                            up without one. It is kept off chain, beside the
                            listing; the contract's listing has no price.
                          */}
                          <label className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                            Asking price (USDC)
                            <input
                              style={{ width: "7rem" }}
                              inputMode="decimal"
                              placeholder="e.g. 1"
                              value={askPrice[right.id] ?? renewalPriceFor(right.id)}
                              onChange={(e) => setAskPrice({ ...askPrice, [right.id]: e.target.value })}
                              data-testid={`asking-price-${right.id}`}
                            />
                          </label>
                          <button
                            disabled={busyRight === right.id || !right.active || typedPrice(askPrice[right.id] ?? renewalPriceFor(right.id)) === null}
                            onClick={() => void changeOffer(right.id, "list", null, typedPrice(askPrice[right.id] ?? renewalPriceFor(right.id)))}
                          >
                            Offer for sale
                          </button>
                          {/*
                            No term to choose. The week is the week: a renter
                            takes those dates or takes nothing, and there is no
                            such thing as four days of it.
                          */}
                          <button
                            disabled={busyRight === right.id || !right.active || typedPrice(askPrice[right.id] ?? renewalPriceFor(right.id)) === null}
                            onClick={() =>
                              void changeOffer(
                                right.id,
                                "list",
                                right.week.end - right.week.start,
                                typedPrice(askPrice[right.id] ?? renewalPriceFor(right.id)),
                              )
                            }
                          >
                            Offer for rent — {formatDate(right.week.start)} to{" "}
                            {formatDate(right.week.end)}
                          </button>
                        </>
                      ) : (
                        <p className="muted" style={{ margin: 0 }}>
                          You hold this week until {formatDate(right.week.end)} and it is yours to
                          use. Passing it on would be a sub-let, and only the title holder can prove
                          a transfer, so there is nothing to publish.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              );

              if (!isOpen || photos === null) return <Fragment key={right.id}>{card}</Fragment>;

              return (
                <Fragment key={right.id}>
                  {/*
                    A stand-in keeps the card's place in the grid, so nothing
                    behind the lightbox moves. The lightbox itself is portalled to
                    <body>: inside the page, an animated or stacked ancestor could
                    pin it in the wrong place or under the header.
                  */}
                  <div className="card listing listing-ghost" aria-hidden="true">
                    <StayCover photos={photos} onOpen={() => openCard(right.id)} />
                    <h3 style={{ margin: 0 }}>{right.property?.region ?? `Right #${right.id}`}</h3>
                  </div>
                  {createPortal(
                    <div className="lightbox" onClick={() => setOpened(null)}>
                      <div className="lightbox-frame" onClick={(event) => event.stopPropagation()}>
                        {card}
                      </div>
                    </div>,
                    document.body,
                  )}
                </Fragment>
              );
            })}
          </div>

          <div className="note">
            A listing on the ledger records availability and term. The asking price beside it is
            the holder&apos;s, kept off chain, and binds nobody: payment is the USDC offer a buyer
            or renter makes on chain, which the holder accepts or not.
          </div>
        </>
      ) : error ? null : (
        <p className="muted">Reading the contract…</p>
      )}
    </>
  );
}

/** One of this account's issuance asks, as /api/requests/issuance serves it to the asker. */
interface OwnIssuanceAsk {
  id: string;
  status: "open" | "issued" | "declined" | "cancelled";
  requested_at: string;
  renew_of?: number;
  auto_renew?: boolean;
  open_from?: string;
  right_id?: number;
  reason?: string;
  price?: string;
}

/**
 * Renew a week for next year, now or automatically (2026-11-27).
 *
 * Once per week, and a manual renewal only from the day after the week's
 * check-out, so renewals cannot run years ahead. Automatic: filed now, it goes to the issuer
 * when this week's use year is over; once that week is issued and in this
 * browser, the next year's is filed the same way (useAutoRenewals). A renewal
 * carries the price to list the new week at; while it waits the owner can
 * change that price or cancel it. Either way the issuer checks and issues it:
 * only the issuer can.
 */
function RenewWeek(props: {
  rightId: number;
  weekEnd: number;
  validityUntil: number;
  /** This week's asking price as typed USDC, the default for next year's. */
  listedPrice: string;
  address: string;
  asks: OwnIssuanceAsk[];
  onFiled: () => void;
}) {
  const { rightId, weekEnd, validityUntil, listedPrice, address, asks, onFiled } = props;
  const { authFetch, kind } = useWallet();
  const [hasRecord, setHasRecord] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"manual" | "auto" | "save" | "cancel" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Read once when the card opens: what "ended" and "opens later" are said against.
  const [now] = useState(() => Date.now());
  useEffect(() => {
    void getRecord(rightId).then((r) => setHasRecord(r !== null));
  }, [rightId]);

  const waiting = asks.find((a) => a.status === "open");
  const issued = asks.find((a) => a.status === "issued");
  const declined = [...asks].reverse().find((a) => a.status === "declined" || a.status === "cancelled");
  const opensLater = waiting?.open_from && Date.parse(waiting.open_from) > now;
  // When this week's use year is over: when an automatic renewal opens.
  const yearEnd = validityUntil;
  const yearOver = yearEnd * 1000 <= now;
  // By hand from the day after check-out (renewableFrom on the server).
  const manualFrom = weekEnd + 86_400;
  const manualAllowed = now / 1000 >= manualFrom;

  const typed = price ?? (editing && waiting?.price ? formatUsdc(BigInt(waiting.price)) : listedPrice);
  const typedOk = typed.trim() === "" || typedPrice(typed) !== null;

  const renew = async (auto: boolean) => {
    setBusy(auto ? "auto" : "manual");
    setProblem(null);
    try {
      const rec = await getRecord(rightId);
      if (!rec) throw new Error("this browser does not hold this week's record, so it cannot fill the renewal in");
      await fileRenewal({ address, rightId, details: renewalDetails(rec.record), auto, price: typed.trim() || undefined, authFetch });
      setPrice(null);
      onFiled();
    } catch (caught) {
      setProblem(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  const change = async (what: "save" | "cancel") => {
    if (!waiting) return;
    setBusy(what);
    setProblem(null);
    try {
      const res = await authFetch("/api/requests/issuance/renewal", {
        method: "POST",
        body: JSON.stringify(what === "cancel" ? { id: waiting.id, cancel: true } : { id: waiting.id, price: typed.trim() }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "the renewal was not changed");
      setEditing(false);
      setPrice(null);
      onFiled();
    } catch (caught) {
      setProblem(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  const priceInput = (
    <label className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
      Asking price for next year (USDC)
      <input
        style={{ width: "7rem" }}
        inputMode="decimal"
        placeholder="e.g. 1"
        value={typed}
        onChange={(e) => setPrice(e.target.value)}
        data-testid={`renew-price-${rightId}`}
      />
    </label>
  );

  return (
    <div className="note" style={{ marginTop: "0.7rem" }} data-testid={`renew-${rightId}`}>
      <strong>Next year&apos;s week</strong>{" "}
      {issued?.right_id !== undefined ? (
        <span data-testid={`renew-issued-${rightId}`}>
          · renewed as week #{issued.right_id}
          {issued.price ? ` at ${formatUsdc(BigInt(issued.price))} USDC` : ""}
          {issued.auto_renew ? " (renews automatically each year)" : ""}. Renew that week when its year comes.
        </span>
      ) : waiting ? (
        <>
          <span data-testid={`renew-waiting-${rightId}`}>
            ·{" "}
            {opensLater
              ? `automatic renewal filed: it goes to the issuer on ${formatDate(Date.parse(waiting.open_from!) / 1000)}, when this week's year is over`
              : "renewal waiting for the issuer"}
            {waiting.price ? ` · asking ${formatUsdc(BigInt(waiting.price))} USDC` : " · no price set"}.
          </span>
          {kind === "cli" ? null : editing ? (
            <div className="row" style={{ gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
              {priceInput}
              <button
                className="primary"
                disabled={busy !== null || typed.trim() === "" || !typedOk}
                onClick={() => void change("save")}
                data-testid={`renew-save-${rightId}`}
              >
                {busy === "save" ? "saving…" : "Save price"}
              </button>
              <button disabled={busy !== null} onClick={() => (setEditing(false), setPrice(null))}>
                Back
              </button>
            </div>
          ) : (
            <div className="row" style={{ gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
              <button disabled={busy !== null} onClick={() => setEditing(true)} data-testid={`renew-edit-${rightId}`}>
                Edit renewal
              </button>
              <button disabled={busy !== null} onClick={() => void change("cancel")} data-testid={`renew-cancel-${rightId}`}>
                {busy === "cancel" ? "cancelling…" : "Cancel renewal"}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {declined ? (
            <span className="muted">
              · the last renewal was {declined.status === "cancelled" ? "cancelled" : "declined"}
              {declined.reason ? `: “${declined.reason}”` : ""}.{" "}
            </span>
          ) : null}
          <span className="muted">
            A week is one year&apos;s dates, so next year&apos;s is a new week the issuer issues. This browser fills
            the request in from this week&apos;s record, 52 weeks later.
          </span>
          {kind === "cli" ? null : hasRecord === false ? (
            <p className="muted" style={{ margin: "0.4rem 0 0" }}>
              This browser does not hold this week&apos;s record, so it cannot renew it from here.
            </p>
          ) : (
            <>
              <div className="row" style={{ gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                {priceInput}
              </div>
              <div className="row" style={{ gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                <button
                  disabled={busy !== null || hasRecord !== true || !manualAllowed || !typedOk}
                  onClick={() => void renew(false)}
                  data-testid={`renew-now-${rightId}`}
                >
                  {busy === "manual" ? "asking…" : "Renew for next year"}
                </button>
                <button
                  disabled={busy !== null || hasRecord !== true || !typedOk}
                  onClick={() => void renew(true)}
                  data-testid={`renew-auto-${rightId}`}
                >
                  {busy === "auto" ? "filing…" : "Renew automatically each year"}
                </button>
              </div>
              <p className="muted" style={{ margin: "0.4rem 0 0" }} data-testid={`renew-when-${rightId}`}>
                {manualAllowed
                  ? null
                  : `By hand from ${formatDate(manualFrom)}, the day after check-out. `}
                {yearOver
                  ? "Automatic: it goes to the issuer now, as this week's year is over."
                  : `Automatic: it goes to the issuer when this week's year is over (${formatDate(yearEnd)}), and each year after.`}
              </p>
            </>
          )}
        </>
      )}
      {problem ? <div className="note bad" style={{ marginTop: "0.5rem" }}>{problem}</div> : null}
    </div>
  );
}
