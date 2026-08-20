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

import { useCallback, useEffect, useState } from "react";

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
}

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

  useEffect(() => {
    void load();
  }, [load]);

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

          <div className="grid">
            {inventory.rights.map((right) => {
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
              const blocked = right.fees === null || !right.fees.current;
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
                    </div>
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
