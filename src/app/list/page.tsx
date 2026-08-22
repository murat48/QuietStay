"use client";

/**
 * Screen 2 of 4 — **List**.
 *
 * The registry exactly as the contract has it: every right, who holds it, until
 * when, and what is on offer. Everything on this page is a simulated read from the
 * deployed contract; none of it is a local cache.
 *
 * The holder of a week can publish or withdraw an offer here. That needs their
 * signature, so it needs a SEP-10 session — the page will say so rather than
 * offering a button that cannot work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useWallet } from "@/components/WalletProvider";
import { explorer } from "@/lib/config";
import { formatDate, formatDays, shortAddress } from "@/lib/format";
import { unixToIsoDate } from "@/lib/record";

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
  listing: { by: string; term_secs: number | null; listed_at: number } | null;
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
}

/**
 * What the registry is being narrowed to.
 *
 * Deliberately four, and all four answer a question somebody actually arrives
 * with. "Yours" appears only for a connected account, because for everyone else
 * it would always be empty.
 */
type Filter = "all" | "rent" | "sale" | "yours";

interface Inventory {
  contract: string;
  contract_explorer: string;
  token: { name: string; symbol: string; decimals: number };
  issuer: string;
  now: number;
  rights: RightRow[];
}

export default function ListScreen() {
  const { address, authenticated, sign, authFetch } = useWallet();
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRight, setBusyRight] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [termDays, setTermDays] = useState("7");
  // The date the issuer is settling fees through, per right. Keyed rather than
  // held once, so two cards on screen cannot share one input.
  const [paidThrough, setPaidThrough] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState<Filter>("all");
  // Which card is showing the placeholder's explanation. Per right, so two cards
  // with arrears cannot share one open notice.
  const [payNotice, setPayNotice] = useState<number | null>(null);
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
      setError(caught instanceof Error ? caught.message : String(caught));
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
   */
  const matches = useCallback(
    (right: RightRow, which: Filter): boolean => {
      switch (which) {
        case "rent":
          return right.listing?.term_secs != null;
        case "sale":
          return right.listing !== null && right.listing.term_secs === null;
        case "yours":
          return (
            address !== null &&
            (right.effective_holder === address || right.title_holder === address)
          );
        default:
          return true;
      }
    },
    [address],
  );

  const counts = useMemo(() => {
    const rights = inventory?.rights ?? [];
    return {
      all: rights.length,
      rent: rights.filter((r) => matches(r, "rent")).length,
      sale: rights.filter((r) => matches(r, "sale")).length,
      yours: rights.filter((r) => matches(r, "yours")).length,
    };
  }, [inventory, matches]);

  // Someone who holds a week almost always came to look at it. Done once, and
  // only when they hold something, so a visitor is never moved off "all".
  useEffect(() => {
    if (autoSelected.current || address === null || counts.yours === 0) return;
    autoSelected.current = true;
    setFilter("yours");
  }, [address, counts.yours]);

  /** Arrears, or no attestation at all: the issuer will decline a transfer. */
  const feesBlock = (right: RightRow): boolean => right.fees === null || !right.fees.current;

  /**
   * An offer that is a sub-let, and so will be declined whoever asks.
   *
   * A week out on a term can only be listed by the account holding that term —
   * `list` asks the contract for the effective holder — so an offer on a
   * rented-out week is always the renter passing it on. The contract permits
   * that; this issuer does not approve it, because the account holding title is
   * not consulted by `transfer` and would have no say. Sub-letting is a question
   * for a later phase, so nobody should be invited to ask for one.
   */
  const isSublet = (right: RightRow): boolean => right.rented_out && right.listing !== null;

  /**
   * A week the issuer will not approve a transfer of, whatever its offer says.
   *
   * Listing needs nobody's approval — the contract asks only the holder — so a
   * week can be advertised while every transfer of it would be declined. That is
   * the right division of power, but it puts a dead offer in the shop window.
   */
  const isBlocked = (right: RightRow): boolean => feesBlock(right) || isSublet(right);

  // Filtering to a set that turns out to be empty leaves a blank page with no
  // explanation, so the empty case is rendered rather than fallen into.
  const shown = (inventory?.rights ?? [])
    .filter((right) => matches(right, filter))
    // Blocked weeks sort last rather than being hidden. Hiding them would be a
    // second kind of dishonesty — they are genuinely in the registry, and their
    // holder needs to see the card in order to act on it.
    .sort((a, b) => Number(isBlocked(a)) - Number(isBlocked(b)));


  const changeOffer = useCallback(
    async (rightId: number, action: "list" | "unlist", termSecs: number | null) => {
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

        const sent = await authFetch("/api/tx/submit", {
          method: "POST",
          body: JSON.stringify({ xdr: signed }),
        });
        const result = (await sent.json()) as {
          hash?: string;
          successful?: boolean;
          failure?: string;
          error?: string;
        };
        if (!sent.ok) throw new Error(result.error ?? "submission failed");
        if (!result.successful) throw new Error(result.failure ?? "the contract rejected it");

        setMessage(
          `${action === "list" ? "Offer published" : "Offer withdrawn"} for right #${rightId} — ${result.hash}`,
        );
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [address, authFetch, sign, load],
  );

  /** Ask for a week on the terms its holder published. */
  const askFor = useCallback(
    async (rightId: number) => {
      setBusyRight(rightId);
      setMessage(null);
      setError(null);
      try {
        const response = await authFetch("/api/requests", {
          method: "POST",
          body: JSON.stringify({ right_id: rightId }),
        });
        const body = (await response.json()) as { note?: string; error?: string };
        if (!response.ok) throw new Error(body.error ?? "could not record the request");
        setMessage(`Right #${rightId} — ${body.note ?? "request sent"}`);
        await loadRequests();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [authFetch, loadRequests],
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
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [authFetch, loadRequests],
  );

  /**
   * Accept an ask: run the transfer that was always there, then record it.
   *
   * The recipient comes from the request, which carried it from the asker's own
   * SEP-10 session — nobody types an address, and a week sent to a wrong-but-valid
   * account cannot be recovered by anyone, including the issuer.
   *
   * Nothing here bypasses anything. This is the same approve-sign-submit path the
   * transfer screen uses, so the issuer's policy still runs and the contract still
   * requires both signatures. Recording the acceptance happens afterwards and is
   * checked against the chain, so it cannot log a transfer that did not happen.
   */
  const acceptRequest = useCallback(
    async (req: TransferRequest) => {
      if (!address) return;
      setBusyRight(req.right_id);
      setMessage(null);
      setError(null);
      try {
        const expiresAt =
          req.term_secs === null ? null : Math.floor(Date.now() / 1000) + req.term_secs;

        const approval = await authFetch("/api/approve-transfer", {
          method: "POST",
          body: JSON.stringify({
            from: address,
            to: req.by,
            rightId: req.right_id,
            expiresAt,
          }),
        });
        const approvalBody = (await approval.json()) as { xdr?: string; error?: string };
        if (!approval.ok || !approvalBody.xdr) {
          throw new Error(approvalBody.error ?? "the issuer declined to approve this transfer");
        }

        const signed = await sign(approvalBody.xdr);
        const sent = await authFetch("/api/tx/submit", {
          method: "POST",
          body: JSON.stringify({ xdr: signed }),
        });
        const result = (await sent.json()) as {
          hash?: string;
          successful?: boolean;
          failure?: string;
          error?: string;
        };
        if (!sent.ok) throw new Error(result.error ?? "submission failed");
        if (!result.successful) throw new Error(result.failure ?? "the contract rejected it");

        await authFetch(`/api/requests/${req.id}`, {
          method: "POST",
          body: JSON.stringify({ right_id: req.right_id, action: "accepted", tx: result.hash }),
        });

        setMessage(
          `Right #${req.right_id} — ${req.term_secs === null ? "sold" : "rented out"} to ` +
            `${shortAddress(req.by)}. ${result.hash}`,
        );
        await Promise.all([load(), loadRequests()]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [address, authFetch, sign, load, loadRequests],
  );

  /**
   * Record that a week's maintenance fees have been settled.
   *
   * No transaction and no signature from the holder: this re-signs the issuer's
   * attestation and touches neither the record nor the ledger. The commitment
   * stands, the right is untouched, and what changes is only what the issuer
   * currently vouches for — which is the thing a transfer approval reads.
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
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyRight(null);
      }
    },
    [authFetch, load],
  );

  return (
    <>
      <h1>The registry — every week, and what is on offer</h1>
      <p className="lede">
        The shop window and the public record in one, read live from testnet. A week&apos;s date
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
        issuer is not involved in listing at all — its approval is required only later, at the
        moment the week actually changes hands.
      </p>

      {error ? <div className="note bad">{error}</div> : null}
      {message ? <div className="note accent">{message}</div> : null}

      {inventory ? (
        <>
          <div className="card tight">
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
              <dt>Rights</dt>
              <dd>{inventory.rights.length}</dd>
            </dl>
          </div>

          {authenticated ? null : (
            <div className="note">
              Connect and sign in to publish or withdraw an offer on a week you hold. Reading needs
              nothing.
            </div>
          )}

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
              // Only for a connected account. For anyone else it is always empty,
              // and a permanently empty control is just a question mark.
              ...(address !== null ? ([["yours", "Yours", counts.yours]] as const) : []),
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                onClick={() => setFilter(key)}
              >
                {label} <span className="muted">{count}</span>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="note">
              {filter === "yours"
                ? "You hold no weeks on this contract — neither owned nor rented."
                : filter === "rent"
                  ? "No week is offered for rent right now."
                  : filter === "sale"
                    ? "No week is offered for sale right now."
                    : "The registry is empty."}{" "}
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
              const blocked = feesBlock(right);
              // An offer on a week that is out on a term is a sub-let, which this
              // issuer declines and which no later phase has committed to.
              const sublet = isSublet(right);
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

              return (
                <div className="card" key={right.id}>
                  <div className="spread">
                    <h3 style={{ margin: 0 }}>Right #{right.id}</h3>
                    <div className="row" style={{ gap: "0.3rem" }}>
                      {right.active ? null : <span className="tag bad">expired</span>}
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
                    <dt>Use year</dt>
                    <dd>
                      {formatDate(right.validity.from)} → {formatDate(right.validity.until)}
                    </dd>
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
                    <dt>Commitment</dt>
                    <dd className="hash">{right.commitment}</dd>
                  </dl>

                  {blocked ? (
                    <div className="note warn">
                      {right.fees === null
                        ? "The issuer has signed no attestation for this week, so it will not approve a transfer of it."
                        : "The issuer will decline a transfer of this week until the arrears are settled."}{" "}
                      The holder keeps it either way — declining is not seizing. The amount owed is
                      in the off-chain record and is not published here.
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
                        would mean either moving money — which Phase 1 excludes —
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
                          settlement of consideration are out of scope for Phase 1 — this app
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
                  {right.listing && !sublet && !mine && authenticated ? (
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
                        </div>
                      ) : (
                        <button
                          className="primary"
                          disabled={busyRight === right.id}
                          onClick={() => void askFor(right.id)}
                        >
                          {right.listing.term_secs === null
                            ? "Ask to buy this week"
                            : `Ask to rent it for ${formatDays(right.listing.term_secs)}`}
                        </button>
                      )}
                    </div>
                  ) : null}

                  {asks.length > 0 && mine ? (
                    <fieldset style={{ marginTop: "0.8rem" }}>
                      <legend>
                        {asks.length === 1 ? "One account is asking" : `${asks.length} accounts are asking`}
                      </legend>
                      <p className="muted" style={{ marginTop: 0 }}>
                        Accepting runs the ordinary transfer — your signature, the issuer&apos;s
                        approval, the contract checking both. The address comes from the request, so
                        there is none to type.
                      </p>
                      {asks.map((req) => (
                        <div
                          key={req.id}
                          className="row"
                          style={{ gap: "0.5rem", alignItems: "center", marginTop: "0.4rem" }}
                        >
                          <code>{shortAddress(req.by)}</code>
                          <span className="muted">
                            {req.term_secs === null
                              ? "wants to buy it"
                              : `wants it for ${formatDays(req.term_secs)}`}
                          </span>
                          <button
                            className="primary"
                            disabled={busyRight === right.id || blocked || sublet}
                            onClick={() => void acceptRequest(req)}
                          >
                            Accept
                          </button>
                          <button
                            disabled={busyRight === right.id}
                            onClick={() => void answerRequest(req, "decline")}
                          >
                            Decline
                          </button>
                        </div>
                      ))}
                      {blocked || sublet ? (
                        <p className="muted" style={{ marginBottom: 0 }}>
                          {sublet
                            ? "Accepting is disabled because passing on a week you hold on a term is a sub-let, which this issuer does not approve."
                            : "Accepting is disabled while this week cannot change hands — the issuer would decline the transfer. Settle the fees first; the requests keep."}
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
                  {isIssuer && authenticated ? (
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

                  {mine && authenticated ? (
                    <div className="row" style={{ marginTop: "0.85rem" }}>
                      {right.listing ? (
                        <button
                          disabled={busyRight === right.id}
                          onClick={() => void changeOffer(right.id, "unlist", null)}
                        >
                          {busyRight === right.id ? "working…" : "Withdraw offer"}
                        </button>
                      ) : (
                        <>
                          {isTitleHolder && !right.rented_out ? (
                            <button
                              disabled={busyRight === right.id || !right.active}
                              onClick={() => void changeOffer(right.id, "list", null)}
                            >
                              Offer for sale
                            </button>
                          ) : null}
                          <div className="row" style={{ gap: "0.35rem" }}>
                            <input
                              style={{ width: "4.5rem" }}
                              type="number"
                              min="1"
                              value={termDays}
                              onChange={(event) => setTermDays(event.target.value)}
                              aria-label="rental term in days"
                            />
                            <span className="muted">days</span>
                            <button
                              disabled={busyRight === right.id || !right.active}
                              onClick={() =>
                                void changeOffer(
                                  right.id,
                                  "list",
                                  Math.max(1, Number(termDays) || 1) * 86_400,
                                )
                              }
                            >
                              Offer for rent
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="note">
            No price appears anywhere on this page or on the ledger. Payment, escrow, and settlement
            of consideration are out of scope for Phase 1 — an offer records availability and term,
            and the parties settle however they already do.
          </div>
        </>
      ) : error ? null : (
        <p className="muted">Reading the contract…</p>
      )}
    </>
  );
}
