"use client";

/**
 * Screen 3 of 4 — **Verify**.
 *
 * A counterparty checks a week before taking it on. Everything runs in this
 * browser: a server that told you "verified" would be one more party to trust,
 * which is the thing this project exists to reduce.
 *
 * ## Two levels, and the first one needs no documents
 *
 * **Required — the attestation and the contract.** The issuer's signature is
 * verified with Ed25519 against the issuer address read from the *contract*, not
 * from the attestation, and must be bound to this right, this contract, and this
 * network, and be in date. The contract independently says who holds the week.
 * Together those establish that the week is real, that it owes no maintenance
 * fees, and that the seller is the holder — **without a single document changing
 * hands.** That is the whole point: verification instead of document exchange.
 *
 * **Optional — the record.** A seller may additionally disclose the underlying
 * document: which resort, which unit, the deed. When supplied it is canonicalized
 * (RFC 8785), hashed with SHA-256 via WebCrypto, and matched against the ledger's
 * commitment, which proves it is the exact document committed at issuance and
 * unedited since. When it is not supplied, nothing is claimed about it and the
 * verification still stands on its own.
 *
 * Making the record mandatory would have quietly reinstated document exchange —
 * the practice this design removes — so it is not.
 */

import { useCallback, useEffect, useState } from "react";

import { useWallet } from "@/components/WalletProvider";
import { verifyAttestation, type Check } from "@/lib/attestation";
import { commit, digestsMatch } from "@/lib/canonical";
import { CONTRACT_ID, NETWORK_PASSPHRASE, explorer } from "@/lib/config";
import { formatDate, shortAddress } from "@/lib/format";
import { validateRecord, type OwnershipRecord } from "@/lib/record";

interface OnChainRight {
  id: number;
  issuer: string;
  week: { start: number; end: number };
  validity: { from: number; until: number };
  commitment: string;
  active: boolean;
  title_holder: string | null;
  effective_holder: string | null;
  term_ends: number | null;
  listing: { by: string; term_secs: number | null } | null;
}

export default function VerifyScreen() {
  const { address } = useWallet();
  const [rightId, setRightId] = useState("3");
  const [right, setRight] = useState<OnChainRight | null>(null);
  const [recordText, setRecordText] = useState("");
  const [attestationText, setAttestationText] = useState("");
  const [claimedHolder, setClaimedHolder] = useState("");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRight = useCallback(async (id: string) => {
    setError(null);
    setRight(null);
    setChecks(null);
    if (!/^\d+$/.test(id)) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/right/${id}`, { cache: "no-store" });
      const body = (await response.json()) as OnChainRight & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "could not read that right");
      setRight(body);
      setClaimedHolder(body.effective_holder ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRight(rightId);
    // Only on mount: afterwards the user drives it with the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runVerification = useCallback(async () => {
    setError(null);
    if (!right) {
      setError("load a usage right first");
      return;
    }

    const collected: Check[] = [];

    // --- leg 1: the record, if one was disclosed at all -------------------
    //
    // Optional on purpose. The point of an issuer-signed attestation is that a
    // counterparty can establish "this week is real, it owes nothing, and that
    // account holds it" *without* being handed anyone's deed — verification
    // instead of document exchange. Requiring a document here would have quietly
    // reinstated the thing the design exists to remove.
    //
    // Disclosing the record is a second, deeper step for a buyer who wants to know
    // which resort and which unit they are getting. When one is supplied it is
    // checked strictly; when it is not, nothing is claimed about it.
    let recomputed: string | undefined;
    let record: OwnershipRecord | null = null;

    if (recordText.trim() !== "") {
      try {
        record = validateRecord(JSON.parse(recordText));
        recomputed = await commit(record as never);
        const matches = digestsMatch(recomputed, right.commitment);
        collected.push({
          id: "record",
          label: "Record is well formed and hashes to the on-chain commitment",
          ok: matches,
          detail: matches
            ? `SHA-256 over the canonical record = 0x${recomputed}`
            : `record hashes to 0x${recomputed}, ledger holds 0x${right.commitment}`,
        });
      } catch (caught) {
        collected.push({
          id: "record",
          label: "Record is well formed",
          ok: false,
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }

    // --- leg 2: the attestation ------------------------------------------
    if (attestationText.trim() === "") {
      collected.push({
        id: "attestation-absent",
        label: "Issuer attestation supplied",
        ok: false,
        detail: "no attestation supplied — nothing vouches that this week is free of unpaid fees",
      });
    } else {
      try {
        const parsed: unknown = JSON.parse(attestationText);
        const verification = verifyAttestation(parsed, {
          contract: CONTRACT_ID,
          network: NETWORK_PASSPHRASE,
          rightId: right.id,
          // From the contract, never from the attestation itself.
          contractIssuer: right.issuer,
          onChainCommitment: right.commitment,
          recomputedCommitment: recomputed,
        });
        collected.push(...verification.checks);
      } catch (caught) {
        collected.push({
          id: "attestation",
          label: "Attestation parses",
          ok: false,
          detail: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }

    // --- leg 3: the holder ------------------------------------------------
    const claimed = claimedHolder.trim();
    if (claimed !== "") {
      const isHolder = claimed === right.effective_holder;
      collected.push({
        id: "holder",
        label: "The account offering the week is the account the contract says holds it",
        ok: isHolder,
        detail: isHolder
          ? `${claimed} is the effective holder`
          : `the contract names ${right.effective_holder} as the holder, not ${claimed}`,
      });
    }

    collected.push({
      id: "active",
      label: "The right is inside its validity window",
      ok: right.active,
      detail: right.active
        ? `use year ${formatDate(right.validity.from)} → ${formatDate(right.validity.until)}`
        : "the use year has closed, so this right can no longer be transferred",
    });

    if (right.term_ends !== null) {
      collected.push({
        id: "encumbered",
        label: "The week is not already rented out",
        ok: false,
        detail: `held on a term that ends ${formatDate(right.term_ends)} — until then it cannot be sold`,
      });
    }

    setChecks(collected);
  }, [right, recordText, attestationText, claimedHolder]);

  const allOk = checks !== null && checks.every((check) => check.ok);
  // Whether the deeper, optional step was taken — the message says which of the
  // two levels of assurance the reader actually has.
  const checkedARecord = checks?.some((check) => check.id === "record") ?? false;

  return (
    <>
      {/*
        "before you take it on" rather than "before you commit": this project uses
        "commitment" throughout for the on-chain hash, and reusing the word for
        "agree to a deal" a paragraph later reads as the same thing twice.
      */}
      <h1>Check a week before you take it on</h1>
      <p className="lede">
        You are the buyer or the renter here. The seller has privately sent you two files — the
        ownership record and the issuer&apos;s attestation — and this screen tells you whether they
        hold up. Everything below runs in your browser: the record is hashed here, and the
        issuer&apos;s signature is verified here, against the issuer address read from the contract
        rather than from the file.
      </p>
      <p className="lede" style={{ marginTop: "-1rem" }}>
        Three questions get answered. <strong>Is this really the document behind that week?</strong>{" "}
        <strong>Does the issuer vouch that it carries no unpaid fees?</strong>{" "}
        <strong>And is the person offering it actually the one holding it?</strong> No account
        needed — anyone can audit any week.
      </p>

      <div className="card">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ maxWidth: "10rem" }}>
            <label htmlFor="right-id">Usage right</label>
            <input
              id="right-id"
              value={rightId}
              onChange={(event) => setRightId(event.target.value)}
              inputMode="numeric"
            />
          </div>
          <button onClick={() => void loadRight(rightId)} disabled={loading}>
            {loading ? "reading…" : "Read from contract"}
          </button>
        </div>

        {right ? (
          <dl className="facts" style={{ marginTop: "1rem" }}>
            <dt>Week</dt>
            <dd>
              {formatDate(right.week.start)} → {formatDate(right.week.end)}
            </dd>
            <dt>Issuer</dt>
            <dd className="hash">{right.issuer}</dd>
            <dt>Holder</dt>
            <dd>
              <code>{shortAddress(right.effective_holder)}</code>
              {right.term_ends === null ? " (outright)" : ` until ${formatDate(right.term_ends)}`}
            </dd>
            <dt>Commitment</dt>
            <dd className="hash">0x{right.commitment}</dd>
            <dt>On chain</dt>
            <dd>
              <a href={explorer.contract()} target="_blank" rel="noreferrer">
                open the contract in stellar.expert
              </a>
            </dd>
          </dl>
        ) : null}
      </div>

      {error ? <div className="note bad">{error}</div> : null}

      <div className="card">
        <div className="field">
          <label htmlFor="attestation">
            Issuer attestation (JSON) — <span style={{ color: "var(--accent)" }}>required</span>
          </label>
          <textarea
            id="attestation"
            style={{ minHeight: "11rem" }}
            value={attestationText}
            onChange={(event) => setAttestationText(event.target.value)}
            placeholder="Paste the contents of, for example, inventory/attestations/right-3.attestation.json"
            spellCheck={false}
          />
          <p className="muted" style={{ margin: "0.3rem 0 0" }}>
            This alone — with the contract — answers whether the week is real, whether it owes
            maintenance fees, and who holds it. No document changes hands.
          </p>
        </div>

        <div className="field">
          <label htmlFor="record">
            Ownership record (JSON) — <span style={{ color: "var(--text-faint)" }}>optional</span>
          </label>
          <textarea
            id="record"
            value={recordText}
            onChange={(event) => setRecordText(event.target.value)}
            placeholder="Leave empty to verify without any document. Paste, for example, inventory/records/week-03.json to also check the underlying deed."
            spellCheck={false}
          />
          <p className="muted" style={{ margin: "0.3rem 0 0" }}>
            Only if the seller has chosen to show you the detail behind the week — the resort, the
            unit, the deed. Supply it and this screen proves it is the exact document committed on
            chain and unaltered since. Leave it empty and nothing is claimed about it.
          </p>
        </div>

        <div className="field">
          <label htmlFor="claimed">The account offering you this week</label>
          <input
            id="claimed"
            value={claimedHolder}
            onChange={(event) => setClaimedHolder(event.target.value)}
            placeholder="G…"
            spellCheck={false}
          />
          {address ? (
            <p className="muted" style={{ margin: "0.3rem 0 0" }}>
              Prefilled from the contract. Replace it with whatever the seller told you, and see
              whether the contract agrees.
            </p>
          ) : null}
        </div>

        <button className="primary" onClick={() => void runVerification()} disabled={!right}>
          Verify
        </button>
      </div>

      {checks ? (
        <>
          <h2>Result</h2>
          <div className={`note ${allOk ? "accent" : "bad"}`}>
            {allOk ? (
              <>
                <strong>Every check passed.</strong> The issuer attests this week is valid and free
                of unpaid maintenance fees, and the account offering it is the holder the contract
                names.{" "}
                {checkedARecord ? (
                  <>
                    The record you were shown is the exact document committed on chain, unaltered
                    since issuance.
                  </>
                ) : (
                  <>
                    <strong>And you did this without being shown a single document</strong> — no
                    deed, no name, no resort. That is the point: verification instead of document
                    exchange.
                  </>
                )}
              </>
            ) : (
              <>
                <strong>Do not proceed.</strong> At least one check failed. Each line below says
                exactly what was compared and what did not match.
              </>
            )}
          </div>

          <div className="card">
            <ul className="checks">
              {checks.map((check) => (
                <li key={check.id}>
                  <span className={`mark ${check.ok ? "ok" : "bad"}`}>{check.ok ? "✓" : "✗"}</span>
                  <span>
                    <span className="check-label">{check.label}</span>
                    <br />
                    <span className="check-detail">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="note">
            What was never needed to do any of this: the seller's identity in any registry, a
            document held by a third party, or a call to the resort. What the ledger gave up in
            exchange: a hash, two account addresses, and the dates of the week itself.
          </div>
        </>
      ) : null}
    </>
  );
}
