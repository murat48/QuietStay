"use client";

/**
 * Screen 1 of 4 — **Issue**.
 *
 * The issuer's screen. It takes an off-chain ownership record, shows exactly what
 * will be committed and what will be published, and creates the usage right.
 *
 * The commitment is computed here, in the browser, before anything is sent — so
 * the person issuing can see the hash and the canonical byte count and confirm
 * they match what they would get from `npm run commit-record` or `sha256sum`. The
 * record itself never goes further than the issuer's own server, and none of it
 * reaches the ledger.
 *
 * Only the issuer can do this. The contract enforces that; SEP-10 keeps the
 * deployment's issuing key from being driven by anyone who finds the URL.
 */

import { useCallback, useEffect, useState } from "react";

import { RoleGate } from "@/components/RoleGate";
import { useWallet } from "@/components/WalletProvider";
import { canonicalText, commit } from "@/lib/canonical";
import { explorer } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { onChainWindows, validateRecord, type OwnershipRecord } from "@/lib/record";

const EXAMPLE = `{
  "schema": "quietstay.ownership-record.v1",
  "record_id": "paste-a-fresh-uuid-here",
  "salt": "replace-with-64-hex-characters-of-randomness-0000000000000000",
  "owner": {
    "name": "Ayla Demir",
    "email": "ayla.demir@example.invalid",
    "stellar_account": "G..."
  },
  "resort": {
    "name": "Cliffside Bay Club",
    "country": "Portugal",
    "unit": "Villa 14B",
    "bedrooms": 2
  },
  "week": {
    "check_in": "2026-10-03",
    "check_out": "2026-10-10",
    "use_year": 2026,
    "week_number": 40
  },
  "title": {
    "deed_reference": "CBC-2019-04471",
    "registry": "Cliffside Bay Club Members Registry",
    "recorded_on": "2019-03-22"
  },
  "maintenance_fees": {
    "annual_amount": "820.00",
    "currency": "EUR",
    "paid_through": "2026-12-31",
    "outstanding": "0.00"
  }
}`;

interface Preview {
  commitment: string;
  canonicalBytes: number;
  windows: ReturnType<typeof onChainWindows>;
  feesOutstanding: string;
}

interface IssueResult {
  right_id: number;
  commitment: string;
  tx: string;
  explorer: string;
  attested_clean: boolean;
  attestation: unknown;
  note: string;
}

export default function IssueScreen() {
  const { standing, authFetch } = useWallet();

  const [recordText, setRecordText] = useState(EXAMPLE);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Recompute the commitment as the record is edited, so the hash is never a
  // surprise produced by a server.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const record: OwnershipRecord = validateRecord(JSON.parse(recordText));
        const [digest, canonical] = await Promise.all([
          commit(record as never),
          Promise.resolve(canonicalText(record as never)),
        ]);
        if (cancelled) return;
        setPreview({
          commitment: digest,
          canonicalBytes: new TextEncoder().encode(canonical).length,
          windows: onChainWindows(record),
          feesOutstanding: record.maintenance_fees.outstanding,
        });
        setPreviewError(null);
      } catch (caught) {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recordText]);

  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await authFetch("/api/issue", {
        method: "POST",
        body: JSON.stringify({ record: JSON.parse(recordText) }),
      });
      const body = (await response.json()) as IssueResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "issuance failed");
      setResult(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [authFetch, recordText]);

  // Taken from the registry rather than compared against configuration, so the
  // button agrees with what the contract would actually accept.
  const isIssuer = standing?.isIssuer === true;
  const feesOutstanding =
    preview !== null && Number.parseFloat(preview.feesOutstanding) !== 0;

  return (
    <>
      <h1>Issue a usage right</h1>
      <p className="lede">
        The ownership record stays off chain. What goes on chain is a SHA-256 commitment to it, the
        week's dates, the use year, and the first holder — nothing else.
      </p>

      <div className="card">
        <div className="field">
          <label htmlFor="record">Ownership record (JSON)</label>
          <textarea
            id="record"
            value={recordText}
            onChange={(event) => setRecordText(event.target.value)}
            spellCheck={false}
          />
        </div>

        {previewError ? <div className="note bad">{previewError}</div> : null}

        {preview ? (
          <>
            <h3>What will be committed</h3>
            <dl className="facts">
              <dt>Commitment</dt>
              <dd className="hash">0x{preview.commitment}</dd>
              <dt>Canonical form</dt>
              <dd>
                {preview.canonicalBytes} bytes, RFC 8785 · computed in this browser
              </dd>
            </dl>

            <h3>What will be public</h3>
            <dl className="facts">
              <dt>Week</dt>
              <dd>
                {formatDate(preview.windows.period.start)} →{" "}
                {formatDate(preview.windows.period.end)}
              </dd>
              <dt>Use year</dt>
              <dd>
                {formatDate(preview.windows.validity.from)} →{" "}
                {formatDate(preview.windows.validity.until)}
              </dd>
            </dl>

            <div className="note">
              Staying off chain: the owner's name and email, the resort, the country, the unit, the
              deed reference and registry, the fee amounts, the record id, and the salt.
            </div>

            {feesOutstanding ? (
              <div className="note warn">
                This record shows <strong>{preview.feesOutstanding}</strong> in maintenance fees
                outstanding. The right can still be issued, but the issuer will not attest the week
                as clean, and anyone who verifies it will see that check fail.
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {/*
        Everything above is a pure computation on a document the visitor already
        has, so it stays open to anyone — a reviewer should be able to reproduce a
        commitment here without an account. Only the act of writing to the ledger
        is gated.
      */}
      <RoleGate requires="issuer" action="Issuing a usage right">
        <button
          className="primary"
          onClick={() => void issue()}
          disabled={busy || !preview || !isIssuer}
        >
          {busy ? "issuing…" : "Issue on testnet"}
        </button>
      </RoleGate>

      {error ? <div className="note bad" style={{ marginTop: "1rem" }}>{error}</div> : null}

      {result ? (
        <>
          <h2>Issued</h2>
          <div className={`note ${result.attested_clean ? "accent" : "warn"}`}>
            <strong>Right #{result.right_id}</strong> — {result.note}
          </div>
          <div className="card">
            <dl className="facts">
              <dt>Commitment</dt>
              <dd className="hash">0x{result.commitment}</dd>
              <dt>Transaction</dt>
              <dd>
                <a href={result.explorer ?? explorer.tx(result.tx)} target="_blank" rel="noreferrer">
                  <code>{result.tx}</code>
                </a>
              </dd>
            </dl>

            <h3>Issuer attestation</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Give this to a counterparty along with the record. They can check both on the{" "}
              <a href="/verify">verify screen</a> without asking anyone&apos;s permission.
            </p>
            <pre>{JSON.stringify(result.attestation, null, 2)}</pre>
          </div>
        </>
      ) : null}
    </>
  );
}
