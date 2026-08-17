"use client";

/**
 * Screen 4 of 4 — **Transfer**.
 *
 * One form for both modes, because there is one primitive. Choosing "rent out"
 * sends a timestamp; choosing "sell" sends `expires_at = None`. Nothing else
 * differs.
 *
 * What *does* differ is who is using it, and the form is built from the account's
 * standing on the registry rather than from a role the user picks:
 *
 * - **Owner (kiraya veren)** — holds title. May rent the week out for a term, or
 *   sell it outright. The term may run to the end of the use year.
 * - **Renter (kiracı)** — holds the week on a term. May sublet within that term,
 *   and may not sell at all, because an open-ended grant would outlast the term
 *   they hold.
 *
 * Both limits are enforced by the contract (`ExpiryBeyondSenderTerm`). Reflecting
 * them here only stops the form offering something that would be refused after a
 * signature and a fee.
 *
 * The sequence is the SEP-8 approval model in Soroban's native authorization:
 * the holder states terms, `/api/approve-transfer` applies the issuer's policy and
 * attaches an authorization entry bound to exactly those terms, the holder's
 * wallet signs the envelope, and the contract checks both. The second button skips
 * the approval on purpose — the transfer is submitted without it and refused on
 * chain, with a hash you can open.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { RoleGate } from "@/components/RoleGate";
import { useWallet } from "@/components/WalletProvider";
import { explorer } from "@/lib/config";
import { formatDate, shortAddress } from "@/lib/format";
import { transferableRights } from "@/lib/roles";

interface Outcome {
  kind: "approved" | "declined" | "rejected-on-chain" | "confirmed";
  headline: string;
  detail?: string;
  hash?: string;
  explorer?: string;
}

export default function TransferScreen() {
  return (
    <>
      <h1>Rent out or sell a week</h1>
      <p className="lede">
        One form, one contract call. Renting sends a term; selling sends none. The issuer
        approves the transfer you initiate — it cannot start one, and cannot take a week
        back.
      </p>
      <RoleGate requires="holder" action="Transferring a week">
        <TransferForm />
      </RoleGate>
    </>
  );
}

function TransferForm() {
  const { address, standing, sign, authFetch, refreshStanding } = useWallet();

  const options = useMemo(() => transferableRights(standing), [standing]);

  const [rightId, setRightId] = useState<string>("");
  const [recipient, setRecipient] = useState("");
  const [mode, setMode] = useState<"rent" | "sell">("rent");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = options.find((option) => String(option.right.id) === rightId) ?? null;

  // Default to the first transferable week, and to a term that fits it.
  useEffect(() => {
    if (rightId !== "" || options.length === 0) return;
    const first = options[0]!;
    setRightId(String(first.right.id));
    setUntil(formatDate(Math.min(first.right.week.end, first.maxTermEnds)));
    if (!first.maySell) setMode("rent");
  }, [options, rightId]);

  // A renter cannot sell. If the selection changes to a week they only rent, move
  // the mode with it rather than leaving an impossible choice selected.
  useEffect(() => {
    if (selected && !selected.maySell && mode === "sell") setMode("rent");
  }, [selected, mode]);

  const terms = useCallback(() => {
    if (!selected || !address) return null;
    if (mode === "sell") {
      return { from: address, to: recipient.trim(), rightId: selected.right.id, expiresAt: null };
    }
    const expiresAt = Math.floor(Date.parse(`${until}T00:00:00Z`) / 1000);
    if (!Number.isFinite(expiresAt)) return null;
    return { from: address, to: recipient.trim(), rightId: selected.right.id, expiresAt };
  }, [selected, address, mode, until, recipient]);

  const validate = useCallback((): string | null => {
    const requested = terms();
    if (!requested) return "choose a week, a recipient, and — for a rental — a date the term ends";
    if (!/^G[A-Z2-7]{55}$/.test(requested.to)) return "the recipient must be a Stellar account (G…)";
    if (requested.to === requested.from) return "sender and recipient are the same account";
    if (requested.expiresAt !== null && selected) {
      if (requested.expiresAt <= Math.floor(Date.now() / 1000)) return "the term must end in the future";
      if (requested.expiresAt > selected.maxTermEnds) {
        return selected.maySell
          ? `the term cannot run past the end of the use year (${formatDate(selected.maxTermEnds)})`
          : `you hold this week only until ${formatDate(selected.maxTermEnds)}, and cannot sublet past that`;
      }
    }
    return null;
  }, [terms, selected]);

  /** Steps 2–4: ask for approval, sign, submit. */
  const transfer = useCallback(async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const requested = terms()!;

    setBusy(true);
    setError(null);
    setOutcome(null);

    try {
      const approval = await authFetch("/api/approve-transfer", {
        method: "POST",
        body: JSON.stringify(requested),
      });
      const approvalBody = (await approval.json()) as {
        xdr?: string;
        error?: string;
        detail?: unknown;
        approved_by?: string;
        valid_until_ledger?: number;
      };

      if (!approval.ok || !approvalBody.xdr) {
        // A decline is a legitimate answer, and it is not a seizure: the holder
        // keeps the week and may try again.
        setOutcome({
          kind: "declined",
          headline: "The issuer declined to approve this transfer",
          detail: approvalBody.error ?? "no reason given",
        });
        return;
      }

      setOutcome({
        kind: "approved",
        headline: `Approved by ${shortAddress(approvalBody.approved_by)} — waiting for your signature`,
        detail: `The approval is bound to these exact terms and expires at ledger ${approvalBody.valid_until_ledger}.`,
      });

      const signed = await sign(approvalBody.xdr);
      const sent = await authFetch("/api/tx/submit", {
        method: "POST",
        body: JSON.stringify({ xdr: signed }),
      });
      const result = (await sent.json()) as {
        hash?: string;
        successful?: boolean;
        failure?: string;
        explorer?: string;
        error?: string;
      };
      if (!sent.ok) throw new Error(result.error ?? "submission failed");

      setOutcome(
        result.successful
          ? {
              kind: "confirmed",
              headline:
                requested.expiresAt === null
                  ? `Sold. Right #${requested.rightId} now belongs to ${shortAddress(requested.to)}.`
                  : `Rented out until ${formatDate(requested.expiresAt)}. Title stays with you and the week comes back on its own.`,
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

      // The account's standing has changed — a sold week leaves, a rented one moves.
      await refreshStanding();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [validate, terms, authFetch, sign, refreshStanding]);

  /** The same transfer with the issuer's approval left off. Expected to fail. */
  const transferWithoutApproval = useCallback(async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    const requested = terms()!;

    setBusy(true);
    setError(null);
    setOutcome(null);

    try {
      const built = await authFetch("/api/tx/unapproved-transfer", {
        method: "POST",
        body: JSON.stringify(requested),
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
        explorer?: string;
      };

      setOutcome(
        result.successful
          ? {
              kind: "confirmed",
              headline:
                "This should not have happened: a transfer without issuer approval was accepted.",
              hash: result.hash,
              explorer: result.explorer,
            }
          : {
              kind: "rejected-on-chain",
              headline: "Rejected by the contract, as it should be",
              detail:
                `${result.failure ?? "authorization missing"}\n\n` +
                "You signed this transfer and paid for it. The week did not move, because the " +
                "contract — not the interface — requires the issuer's approval.",
              hash: result.hash,
              explorer: result.explorer,
            },
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [validate, terms, authFetch, sign]);

  return (
    <>
      {standing && standing.rentedOut.length > 0 ? (
        <div className="note">
          {standing.rentedOut.length} week{standing.rentedOut.length === 1 ? "" : "s"} you own{" "}
          {standing.rentedOut.length === 1 ? "is" : "are"} out on rental and therefore not listed
          below. Until the term lapses the renter is the holder — the week returns to you with no
          transaction to send.
        </div>
      ) : null}

      <div className="card">
        <div className="field">
          <label htmlFor="right">Week</label>
          <select
            id="right"
            value={rightId}
            onChange={(event) => {
              setRightId(event.target.value);
              const next = options.find((o) => String(o.right.id) === event.target.value);
              if (next) {
                setUntil(formatDate(Math.min(next.right.week.end, next.maxTermEnds)));
                if (!next.maySell) setMode("rent");
              }
            }}
          >
            {options.map((option) => (
              <option key={option.right.id} value={option.right.id}>
                #{option.right.id} — {formatDate(option.right.week.start)} →{" "}
                {formatDate(option.right.week.end)}
                {option.as === "lessor" ? " · you own it" : " · you are renting it"}
              </option>
            ))}
          </select>
        </div>

        {selected ? (
          <div className={`note ${selected.maySell ? "accent" : "warn"}`} style={{ marginTop: 0 }}>
            {selected.maySell ? (
              <>
                You hold <strong>title</strong> to this week. You can rent it out for a term, or
                sell it outright. A rental may run to {formatDate(selected.maxTermEnds)}, the end of
                the use year.
              </>
            ) : (
              <>
                You are <strong>renting</strong> this week until{" "}
                {formatDate(selected.maxTermEnds)}. You can sublet it up to that date, but you
                cannot sell it — an open-ended transfer would outlast the term you hold, and the
                contract rejects it.
              </>
            )}
          </div>
        ) : null}

        <fieldset>
          <legend>What you are granting</legend>
          <div className="row">
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", margin: 0 }}>
              <input
                type="radio"
                name="mode"
                checked={mode === "rent"}
                onChange={() => setMode("rent")}
                style={{ width: "auto" }}
              />
              {selected?.maySell ? "Rent out" : "Sublet"} — a term that lapses
            </label>
            <label
              style={{
                display: "flex",
                gap: "0.4rem",
                alignItems: "center",
                margin: 0,
                opacity: selected?.maySell ? 1 : 0.45,
              }}
              title={selected?.maySell ? undefined : "a rented week is not yours to sell"}
            >
              <input
                type="radio"
                name="mode"
                checked={mode === "sell"}
                onChange={() => setMode("sell")}
                style={{ width: "auto" }}
                disabled={!selected?.maySell}
              />
              Sell — open-ended
            </label>
          </div>

          {mode === "rent" ? (
            <div className="field" style={{ marginTop: "0.75rem", maxWidth: "14rem" }}>
              <label htmlFor="until">Term ends</label>
              <input
                id="until"
                type="date"
                value={until}
                max={selected ? formatDate(selected.maxTermEnds) : undefined}
                onChange={(event) => setUntil(event.target.value)}
              />
              <p className="muted" style={{ margin: "0.3rem 0 0" }}>
                Must be in the future and no later than{" "}
                {selected ? formatDate(selected.maxTermEnds) : "your own term"}.
              </p>
            </div>
          ) : null}
        </fieldset>

        <div className="field">
          <label htmlFor="recipient">Recipient account</label>
          <input
            id="recipient"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            placeholder="G…"
            spellCheck={false}
          />
        </div>

        <div className="row">
          <button className="primary" onClick={() => void transfer()} disabled={busy || !selected}>
            {busy
              ? "working…"
              : mode === "sell"
                ? "Sell this week"
                : selected?.maySell
                  ? "Rent this week out"
                  : "Sublet this week"}
          </button>
          <button
            className="danger"
            onClick={() => void transferWithoutApproval()}
            disabled={busy || !selected}
          >
            Try it without issuer approval
          </button>
        </div>
        <p className="muted" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
          The second button submits the same transfer with the issuer&apos;s authorization removed.
          It costs a testnet fee and it will fail — that is the point.
        </p>
      </div>

      {error ? <div className="note bad">{error}</div> : null}

      {outcome ? (
        <>
          <h2>Outcome</h2>
          <div
            className={`note ${
              outcome.kind === "confirmed"
                ? "accent"
                : outcome.kind === "approved"
                  ? ""
                  : outcome.kind === "declined"
                    ? "warn"
                    : "bad"
            }`}
          >
            <strong>{outcome.headline}</strong>
            {outcome.detail ? (
              <pre style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{outcome.detail}</pre>
            ) : null}
            {outcome.hash ? (
              <p style={{ marginBottom: 0, marginTop: "0.6rem" }}>
                <a
                  href={outcome.explorer ?? explorer.tx(outcome.hash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open {outcome.hash.slice(0, 12)}… in stellar.expert
                </a>
              </p>
            ) : null}
          </div>

          {outcome.kind === "rejected-on-chain" ? (
            <div className="note">
              Open that transaction and look at what it shows: two account addresses, a right id, a
              term, and a hash. No name, no document, no resort. That is true of the transfers that
              succeed as well.
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
