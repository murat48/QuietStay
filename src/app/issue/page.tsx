"use client";

/**
 * Screen 1 of 4 — **Issue**.
 *
 * The issuer's screen. It takes an off-chain ownership record, shows exactly what
 * will be committed and what will be published, and creates the usage right.
 *
 * The record can be edited two ways, and they are the same document either way:
 * a **form** for filling one in from scratch, and the **JSON** it serialises to,
 * for pasting a record that already exists. The JSON text is the single source of
 * truth — the form reads its fields out of it and patches them back in — so the
 * two views can never drift apart, and switching tabs never loses an edit.
 *
 * `record_id` and `salt` are generated here rather than typed. Both exist purely
 * to make the commitment safe (see `src/lib/record.ts`), neither carries meaning a
 * person could supply, and a hand-typed salt is the one field that reliably comes
 * out malformed.
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

import { useCallback, useEffect, useMemo, useState } from "react";

import { RoleGate } from "@/components/RoleGate";
import { useWallet } from "@/components/WalletProvider";
import { canonicalText, commit } from "@/lib/canonical";
import { explorer } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { onChainWindows, validateRecord, type OwnershipRecord } from "@/lib/record";

/**
 * The starting document.
 *
 * `record_id` and `salt` are left empty and filled in after mount — this
 * component is rendered on the server too, and random values chosen there would
 * not match the ones the browser picks.
 *
 * The owner block is empty because it is the one part of a record that is
 * genuinely per-issuance and has no sensible placeholder: a fake `"G..."` looks
 * filled in but is not. The rest carries the sample resort's values so the
 * preview has something to compute, and every field of it is editable.
 */
const TEMPLATE = {
  schema: "quietstay.ownership-record.v1",
  record_id: "",
  salt: "",
  owner: {
    name: "",
    email: "",
    stellar_account: "",
  },
  resort: {
    name: "Cliffside Bay Club",
    country: "Portugal",
    unit: "Villa 14B",
    bedrooms: 2,
  },
  week: {
    check_in: "2026-10-03",
    check_out: "2026-10-10",
    use_year: 2026,
    week_number: 40,
  },
  title: {
    deed_reference: "CBC-2019-04471",
    registry: "Cliffside Bay Club Members Registry",
    recorded_on: "2019-03-22",
  },
  maintenance_fees: {
    annual_amount: "820.00",
    currency: "EUR",
    paid_through: "2026-12-31",
    outstanding: "0.00",
  },
};

/** Unique per record, so one document cannot be committed for two rights. */
function freshRecordId(): string {
  return crypto.randomUUID();
}

/**
 * 32 random bytes as 64 lowercase hex characters — the same value
 * `randomBytes(32).toString("hex")` produces for the scripts, and exactly what
 * `validateRecord` requires. The randomness comes from WebCrypto; only the hex
 * formatting is ours.
 */
function freshSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Tab = "form" | "json";

type Doc = Record<string, unknown>;

/** Read one dotted path out of the parsed record, as text an input can hold. */
function readPath(doc: Doc | null, path: string): string {
  if (!doc) return "";
  const found = path.split(".").reduce<unknown>((node, key) => {
    if (typeof node !== "object" || node === null) return undefined;
    return (node as Doc)[key];
  }, doc);
  return found === null || found === undefined ? "" : String(found);
}

/**
 * Set one dotted path, returning the re-serialised document.
 *
 * Only the addressed field changes: keys keep their positions, and anything the
 * form does not know about survives a round trip through it.
 */
function writePath(text: string, path: string, value: unknown): string {
  let doc: Doc;
  try {
    doc = JSON.parse(text) as Doc;
  } catch {
    return text; // Unparseable JSON is the JSON tab's problem to fix.
  }
  const [group, key] = path.split(".");
  if (group === undefined) return text;

  if (key === undefined) {
    doc[group] = value;
  } else {
    const branch = doc[group];
    doc[group] = { ...(typeof branch === "object" && branch !== null ? branch : {}), [key]: value };
  }
  return JSON.stringify(doc, null, 2);
}

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

  const [tab, setTab] = useState<Tab>("form");
  const [recordText, setRecordText] = useState(() => JSON.stringify(TEMPLATE, null, 2));
  const [seeded, setSeeded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generate the two commitment fields once the component is in the browser.
  // Doing it during render would make the server's HTML disagree with the
  // client's, and an existing record pasted before this runs is left alone.
  useEffect(() => {
    setRecordText((current) => {
      let doc: Doc;
      try {
        doc = JSON.parse(current) as Doc;
      } catch {
        return current;
      }
      if (doc.record_id || doc.salt) return current;
      return JSON.stringify({ ...doc, record_id: freshRecordId(), salt: freshSalt() }, null, 2);
    });
    setSeeded(true);
  }, []);

  const parsed = useMemo<Doc | null>(() => {
    try {
      const doc: unknown = JSON.parse(recordText);
      return typeof doc === "object" && doc !== null ? (doc as Doc) : null;
    } catch {
      return null;
    }
  }, [recordText]);

  const setField = useCallback((path: string, value: unknown) => {
    setRecordText((current) => writePath(current, path, value));
  }, []);

  // Number fields are stored as numbers, not strings: the schema types them that
  // way and `validateRecord` checks `use_year` is an integer. An emptied box
  // becomes null so that the check fails loudly instead of silently reading 0.
  const setNumberField = useCallback(
    (path: string, raw: string) => {
      setField(path, raw.trim() === "" ? null : Number(raw));
    },
    [setField],
  );

  // Recompute the commitment as the record is edited, so the hash is never a
  // surprise produced by a server.
  useEffect(() => {
    if (!seeded) return;
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
  }, [recordText, seeded]);

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

  const text = (path: string) => readPath(parsed, path);

  return (
    <>
      <h1>Issue a usage right</h1>
      <p className="lede">
        The ownership record stays off chain. What goes on chain is a SHA-256 commitment to it, the
        week&apos;s dates, the use year, and the first holder — nothing else.
      </p>

      <div className="card">
        <div className="tabs" role="tablist" aria-label="Record editor">
          <button
            type="button"
            role="tab"
            id="tab-form"
            aria-selected={tab === "form"}
            aria-controls="panel-form"
            onClick={() => setTab("form")}
          >
            Form
          </button>
          <button
            type="button"
            role="tab"
            id="tab-json"
            aria-selected={tab === "json"}
            aria-controls="panel-json"
            onClick={() => setTab("json")}
          >
            JSON
          </button>
        </div>

        {tab === "form" ? (
          <div role="tabpanel" id="panel-form" aria-labelledby="tab-form">
            {parsed === null ? (
              <div className="note bad">
                This record is not valid JSON, so the form cannot show it. Fix it on the JSON tab.
              </div>
            ) : (
              <>
                <fieldset>
                  <legend>Commitment fields</legend>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Generated, not typed. Both exist to make the commitment safe: the salt blinds a
                    record whose contents are otherwise low entropy, and the id keeps one document
                    from being committed for two rights.
                  </p>
                  <div className="field">
                    <label htmlFor="record_id">record_id</label>
                    <div className="generated">
                      <input id="record_id" value={text("record_id")} readOnly spellCheck={false} />
                      <button type="button" onClick={() => setField("record_id", freshRecordId())}>
                        Regenerate
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="salt">salt — 32 bytes</label>
                    <div className="generated">
                      <input id="salt" value={text("salt")} readOnly spellCheck={false} />
                      <button type="button" onClick={() => setField("salt", freshSalt())}>
                        Regenerate
                      </button>
                    </div>
                  </div>
                </fieldset>

                <fieldset>
                  <legend>Owner</legend>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="owner_name">Name on the deed</label>
                      <input
                        id="owner_name"
                        value={text("owner.name")}
                        onChange={(event) => setField("owner.name", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="owner_email">Email</label>
                      <input
                        id="owner_email"
                        type="email"
                        value={text("owner.email")}
                        onChange={(event) => setField("owner.email", event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="owner_account">Stellar account — the first holder</label>
                    <input
                      id="owner_account"
                      className="mono"
                      placeholder="G…"
                      spellCheck={false}
                      value={text("owner.stellar_account")}
                      onChange={(event) =>
                        setField("owner.stellar_account", event.target.value.trim())
                      }
                    />
                    <p className="muted">
                      The only part of this block that reaches the ledger. The name and email stay in
                      the record.
                    </p>
                  </div>
                </fieldset>

                <fieldset>
                  <legend>Resort</legend>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="resort_name">Resort</label>
                      <input
                        id="resort_name"
                        value={text("resort.name")}
                        onChange={(event) => setField("resort.name", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="resort_country">Country</label>
                      <input
                        id="resort_country"
                        value={text("resort.country")}
                        onChange={(event) => setField("resort.country", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="resort_unit">Unit</label>
                      <input
                        id="resort_unit"
                        value={text("resort.unit")}
                        onChange={(event) => setField("resort.unit", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="resort_bedrooms">Bedrooms</label>
                      <input
                        id="resort_bedrooms"
                        type="number"
                        min={0}
                        step={1}
                        value={text("resort.bedrooms")}
                        onChange={(event) => setNumberField("resort.bedrooms", event.target.value)}
                      />
                    </div>
                  </div>
                </fieldset>

                <fieldset>
                  <legend>Week</legend>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="week_in">Check in — first night</label>
                      <input
                        id="week_in"
                        type="date"
                        value={text("week.check_in")}
                        onChange={(event) => setField("week.check_in", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="week_out">Check out — departure</label>
                      <input
                        id="week_out"
                        type="date"
                        value={text("week.check_out")}
                        onChange={(event) => setField("week.check_out", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="week_year">Use year</label>
                      <input
                        id="week_year"
                        type="number"
                        step={1}
                        value={text("week.use_year")}
                        onChange={(event) => setNumberField("week.use_year", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="week_number">Week number</label>
                      <input
                        id="week_number"
                        type="number"
                        min={1}
                        max={53}
                        step={1}
                        value={text("week.week_number")}
                        onChange={(event) => setNumberField("week.week_number", event.target.value)}
                      />
                    </div>
                  </div>
                  <p className="muted">
                    The week must fall inside its use year — the contract requires the validity
                    window to enclose the occupancy period, and rejects a record where it does not.
                  </p>
                </fieldset>

                <fieldset>
                  <legend>Title</legend>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="title_deed">Deed reference</label>
                      <input
                        id="title_deed"
                        value={text("title.deed_reference")}
                        onChange={(event) => setField("title.deed_reference", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="title_registry">Registry</label>
                      <input
                        id="title_registry"
                        value={text("title.registry")}
                        onChange={(event) => setField("title.registry", event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="title_recorded">Recorded on</label>
                      <input
                        id="title_recorded"
                        type="date"
                        value={text("title.recorded_on")}
                        onChange={(event) => setField("title.recorded_on", event.target.value)}
                      />
                    </div>
                  </div>
                </fieldset>

                <fieldset>
                  <legend>Maintenance fees</legend>
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="fees_annual">Annual amount</label>
                      <input
                        id="fees_annual"
                        inputMode="decimal"
                        value={text("maintenance_fees.annual_amount")}
                        onChange={(event) =>
                          setField("maintenance_fees.annual_amount", event.target.value)
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="fees_currency">Currency</label>
                      <input
                        id="fees_currency"
                        value={text("maintenance_fees.currency")}
                        onChange={(event) =>
                          setField("maintenance_fees.currency", event.target.value)
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="fees_through">Paid through</label>
                      <input
                        id="fees_through"
                        type="date"
                        value={text("maintenance_fees.paid_through")}
                        onChange={(event) =>
                          setField("maintenance_fees.paid_through", event.target.value)
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="fees_outstanding">Outstanding</label>
                      <input
                        id="fees_outstanding"
                        inputMode="decimal"
                        value={text("maintenance_fees.outstanding")}
                        onChange={(event) =>
                          setField("maintenance_fees.outstanding", event.target.value)
                        }
                      />
                    </div>
                  </div>
                  <p className="muted">
                    Amounts are strings, so a figure is committed exactly as it was written.
                    &quot;0.00&quot; means the week is clean.
                  </p>
                </fieldset>
              </>
            )}
          </div>
        ) : (
          <div role="tabpanel" id="panel-json" aria-labelledby="tab-json">
            <div className="field">
              <label htmlFor="record">Ownership record (JSON)</label>
              <textarea
                id="record"
                value={recordText}
                onChange={(event) => setRecordText(event.target.value)}
                spellCheck={false}
              />
              <p className="muted">
                The same document the form edits. Paste a record you already have, and the form will
                show it.
              </p>
            </div>
          </div>
        )}

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
              Staying off chain: the owner&apos;s name and email, the resort, the country, the unit,
              the deed reference and registry, the fee amounts, the record id, and the salt.
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
