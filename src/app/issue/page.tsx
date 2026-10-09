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
 * The record's digest `d` — SHA-256 over its canonical bytes — is computed here,
 * in the browser, before anything is sent, so the person issuing can see it and
 * confirm it matches `npm run commit-record` or `sha256sum`. What goes on chain is
 * the commitment `C = Poseidon(d, owner, h)` (docs/CIRCUIT.md §2), from the hash
 * `h` of a secret only the owner holds. The issuer pastes the owner's `h` here and
 * the server computes `C` when the week is issued — Poseidon runs in the circuit,
 * the command line and the server, never in a browser. The record itself never
 * goes further than the issuer's own server, and none of it reaches the ledger.
 *
 * Only the issuer can do this. The contract enforces that; SEP-10 keeps the
 * deployment's issuing key from being driven by anyone who finds the URL.
 *
 * **The screen reads the role** (`issueScreenView`). The issuer sees the form
 * and the owners' pending issuance requests; picking one fills in the first
 * holder and `h` and locks both, so the issuer only enters the record. Every
 * other account sees just the box for asking to have a week issued: it sends
 * `h` — never the secret — for the account signed in, and nothing else.
 *
 * `/issue?h=…` — the link `npm run zk:secret` prints — fills that box, checked
 * by the same rule the server applies. The issuer's form never reads it: the
 * issuer takes `h` from an owner's request, or types it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { RoleGate } from "@/components/RoleGate";
import { useWallet } from "@/components/WalletProvider";
import { canonicalText, commit } from "@/lib/canonical";
import { explorer } from "@/lib/config";
import { describeError, formatDate } from "@/lib/format";
import type { IssuanceRequest } from "@/lib/requests";
import { issueScreenView } from "@/lib/roles";
import { issuanceRequestPrefill, parseSecretHash } from "@/lib/secret-hash";
import {
  isoWeekNumber,
  onChainWindows,
  propertyFacts,
  validateRecord,
  type OwnershipRecord,
  type PropertyFacts,
} from "@/lib/record";

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
    city: "Lagos",
    country: "Portugal",
    unit: "Villa 14B",
    bedrooms: 2,
    sleeps: 4,
    features: ["sea view", "pool", "wifi"],
  },
  week: {
    check_in: "2026-10-03",
    check_out: "2026-10-10",
    use_year: 2026,
    // Derived here too, so editing the date above cannot leave a stale number
    // behind — the form derives it from that moment on.
    week_number: isoWeekNumber("2026-10-03"),
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
  /** What the issuer will sign into the attestation, and a shopper will read. */
  property: PropertyFacts;
}

interface IssueResult {
  right_id: number;
  /** The record text exactly as it was issued — what "Save record" downloads. */
  issuedText: string;
  record_digest: string;
  commitment: string;
  tx: string;
  explorer: string;
  attested_clean: boolean;
  attestation: unknown;
  note: string;
}

export default function IssueScreen() {
  const { standing, readOnly, authFetch, authenticated } = useWallet();

  const [tab, setTab] = useState<Tab>("form");
  const [recordText, setRecordText] = useState(() => JSON.stringify(TEMPLATE, null, 2));
  const [seeded, setSeeded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  // The owner's h, from `npm run zk:secret` on their machine. The server computes C.
  const [secretHash, setSecretHash] = useState("");
  // The owners' open issuance requests, and the one being issued from, if any.
  const [asks, setAsks] = useState<IssuanceRequest[]>([]);
  const [asksError, setAsksError] = useState<string | null>(null);
  const [selected, setSelected] = useState<IssuanceRequest | null>(null);
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

  // Which of the public description's optional parts the record leaves unsaid.
  const thin = useMemo(() => {
    if (!preview) return [];
    const missing: string[] = [];
    if (!preview.property.region.includes(",")) missing.push("a town");
    if (preview.property.sleeps === undefined) missing.push("how many it sleeps");
    if (!preview.property.features?.length) missing.push("any features");
    return missing;
  }, [preview]);

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

  // Features are a list in the record but a single box on the form, because
  // typing "sea view, pool" is how anyone would write it. An emptied box drops
  // the key rather than committing an empty array to the record forever.
  const setListField = useCallback(
    (path: string, raw: string) => {
      const items = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      setField(path, items.length > 0 ? items : undefined);
    },
    [setField],
  );

  /**
   * Check-in also fixes the week number, so the two can never disagree.
   *
   * The number is the one field of the week block nobody can check by eye, and a
   * record whose number contradicts its dates is committed to that contradiction
   * forever. Written in a single update so the document is never briefly
   * inconsistent.
   */
  const setCheckIn = useCallback((value: string) => {
    setRecordText((current) => {
      const withDate = writePath(current, "week.check_in", value);
      try {
        return writePath(withDate, "week.week_number", isoWeekNumber(value));
      } catch {
        // A half-typed date. Keep what was entered and leave the number alone.
        return withDate;
      }
    });
  }, []);

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
          property: propertyFacts(record),
        });
        setPreviewError(null);
      } catch (caught) {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(describeError(caught));
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
      const record: unknown = JSON.parse(recordText);
      const response = await authFetch("/api/issue", {
        method: "POST",
        body: JSON.stringify(
          selected ? { record, request_id: selected.id } : { record, secret_hash: secretHash.trim() },
        ),
      });
      const body = (await response.json()) as Omit<IssueResult, "issuedText"> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "issuance failed");
      // Kept as sent: an edit made after issuing must not change what is saved.
      setResult({ ...body, issuedText: recordText });
      // An issued request drops off the list.
      if (selected) {
        setAsks((current) => current.filter((ask) => ask.id !== selected.id));
        setSelected(null);
        setSecretHash("");
      }
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [authFetch, recordText, secretHash, selected]);

  // Taken from the registry rather than compared against configuration, so the
  // button agrees with what the contract would actually accept.
  const isIssuer = standing?.isIssuer === true;

  // The issuer's queue: open requests from owners, read when the issuer signs in.
  useEffect(() => {
    if (!isIssuer || !authenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await authFetch("/api/requests/issuance");
        const body = (await response.json()) as { requests?: IssuanceRequest[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "could not read the requests");
        if (!cancelled) setAsks(body.requests ?? []);
      } catch (caught) {
        if (!cancelled) setAsksError(describeError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isIssuer, authenticated, authFetch]);

  const pick = useCallback(
    (ask: IssuanceRequest | null) => {
      setSelected(ask);
      setSecretHash(ask ? ask.secret_hash : "");
      if (ask) setField("owner.stellar_account", ask.by);
    },
    [setField],
  );
  const feesOutstanding =
    preview !== null && Number.parseFloat(preview.feesOutstanding) !== 0;

  const text = (path: string) => readPath(parsed, path);
  const ownerMatchesAsk = selected === null || text("owner.stellar_account") === selected.by;

  if (issueScreenView(standing) === "request") {
    return (
      <>
        <h1>Ask for a week to be issued</h1>
        <p className="lede">
          The issuer issues usage rights. To have a week issued to you, send the issuer the hash of
          a secret only you hold. The issuer enters the record; the week arrives in this account.
        </p>
        <IssuanceAsk />
      </>
    );
  }

  return (
    <>
      <h1>Issue a usage right</h1>
      <p className="lede">
        The ownership record stays off chain. What goes on chain is a commitment that wraps its
        SHA-256 with the owner&apos;s account and the hash of a secret only the owner holds, the
        week&apos;s dates, the use year, and the first holder — nothing else.
      </p>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Requests from owners</h3>
        {asksError ? <div className="note bad">{asksError}</div> : null}
        {asks.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No pending requests. An owner asks on this screen, signed in with their own wallet.
          </p>
        ) : (
          <ul>
            {asks.map((ask) => (
              <li key={ask.id}>
                <code>{ask.by}</code>{" "}
                <span className="muted">· asked {formatDate(Date.parse(ask.requested_at) / 1000)}</span>{" "}
                {selected?.id === ask.id ? (
                  <button type="button" onClick={() => pick(null)}>
                    Deselect
                  </button>
                ) : (
                  <button type="button" onClick={() => pick(ask)}>
                    Issue to this account
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

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
                      readOnly={selected !== null}
                      onChange={(event) =>
                        setField("owner.stellar_account", event.target.value.trim())
                      }
                    />
                    {selected ? (
                      <p className="muted">From the owner&apos;s request — it cannot be edited.</p>
                    ) : null}
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
                      <label htmlFor="resort_city">Town or city</label>
                      <input
                        id="resort_city"
                        value={text("resort.city")}
                        onChange={(event) => setField("resort.city", event.target.value)}
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
                    <div className="field">
                      <label htmlFor="resort_sleeps">Sleeps</label>
                      <input
                        id="resort_sleeps"
                        type="number"
                        min={1}
                        step={1}
                        value={text("resort.sleeps")}
                        // Optional, so an emptied box drops the key rather than
                        // writing null and failing validation on a field the
                        // schema does not require.
                        onChange={(event) =>
                          setField(
                            "resort.sleeps",
                            event.target.value.trim() === ""
                              ? undefined
                              : Number(event.target.value),
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="resort_features">Features — comma separated</label>
                    <input
                      id="resort_features"
                      value={text("resort.features").split(",").join(", ")}
                      onChange={(event) => setListField("resort.features", event.target.value)}
                    />
                  </div>
                  <p className="muted">
                    The town, the size and the features are published on the listing, signed by you,
                    because nobody takes a week without knowing where it is, how many it sleeps and
                    what it offers. The resort name and the unit are not — those name one apartment,
                    and through the registry one person. They stay in the record and go to a buyer
                    once, on request. Keep the features to what the place offers: no address, no
                    building name.
                  </p>
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
                        onChange={(event) => setCheckIn(event.target.value)}
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
                    {/*
                      Shown because it is committed and a reader should be able
                      to see everything that is; read-only because it is derived,
                      and a number a person could edit away from its own date is
                      a contradiction waiting to be committed.
                    */}
                    <div className="field">
                      <label htmlFor="week_number">Week number — from the date</label>
                      <input id="week_number" value={text("week.week_number")} readOnly />
                    </div>
                  </div>
                  <p className="muted">
                    The week must fall inside its use year — the contract requires the validity
                    window to enclose the occupancy period, and rejects a record where it does not.
                    The resort week number is the ISO 8601 week of the check-in date, set for you so
                    it cannot disagree with it.
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
              <dt>Record digest d</dt>
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
              <dt>Where</dt>
              <dd>{preview.property.region}</dd>
              <dt>Sleeps</dt>
              <dd>
                {preview.property.sleeps === undefined ? (
                  <span className="muted">not stated</span>
                ) : (
                  `${preview.property.sleeps} people`
                )}
                <span className="muted">
                  {" "}
                  · {preview.property.bedrooms}{" "}
                  {preview.property.bedrooms === 1 ? "bedroom" : "bedrooms"}
                </span>
              </dd>
              <dt>Features</dt>
              <dd>
                {preview.property.features?.length ? (
                  preview.property.features.join(" · ")
                ) : (
                  <span className="muted">not stated</span>
                )}
              </dd>
            </dl>

            {/*
              A record is only valid once, and this is the last moment anything in
              it can change. The three optional fields validate when absent, so
              without this the record commits silently and the week is listed with
              nothing said about the place — recoverable afterwards only by the
              issuer asserting it unbacked, through `npm run describe`. Pasting an
              older record into the JSON tab is the way this happens.
            */}
            {thin.length > 0 ? (
              <div className="note warn">
                <strong>This week will be listed without {thin.join(", ")}.</strong> Those are
                published from the record, and the record cannot be edited once it is committed —
                only asserted again by the issuer, with nothing behind it. Fill them in above before
                issuing.
              </div>
            ) : null}

            <div className="note">
              Staying off chain: the owner&apos;s name and email, the resort, the unit, the deed
              reference and registry, the fee amounts, the record id, and the salt. The town and
              country are published, as is what the place offers — a listing has to say where it is
              and what it is.
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
        <div className="card">
          <div className="field">
            <label htmlFor="secret-hash">The owner&apos;s h</label>
            <input
              id="secret-hash"
              value={secretHash}
              readOnly={selected !== null}
              onChange={(event) => setSecretHash(event.target.value)}
              placeholder="the number npm run zk:secret printed — decimal or hex"
              spellCheck={false}
            />
          </div>
          {selected ? (
            <p className="muted">From the owner&apos;s request — it cannot be edited.</p>
          ) : null}
          {!ownerMatchesAsk ? (
            <div className="note warn">
              The record&apos;s first holder is no longer the account that asked,{" "}
              <code>{selected?.by}</code>. Put it back, or deselect the request.
            </div>
          ) : null}
          <p className="muted" style={{ marginBottom: 0 }}>
            The owner makes a secret on their own machine with <code>npm run zk:secret</code> and
            sends you only its hash <code>h</code> — by asking on this screen, or directly. When you issue, the server computes the
            commitment <code>C = Poseidon(d, owner, h)</code> from this record and that{" "}
            <code>h</code>. The secret itself never reaches you or this server, so you can never
            prove a transfer of the week.
          </p>
        </div>
        {readOnly ? (
          <div className="note warn">
            <strong>This deployment cannot issue.</strong> It does not hold the issuer key, on
            purpose: the key signs every attestation, and the contract fixed its issuer at
            construction, so a key that leaked could never be replaced. Everything above still
            works — the record digest is computed in your browser and needs no key at all. Issuing is done from wherever the key already lives.
          </div>
        ) : (
          <button
            className="primary"
            onClick={() => void issue()}
            disabled={busy || !preview || !isIssuer || secretHash.trim() === "" || !ownerMatchesAsk}
          >
            {busy ? "issuing…" : "Issue on testnet"}
          </button>
        )}
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
              <dt>Record digest d</dt>
              <dd className="hash">0x{result.record_digest}</dd>
              <dt>Commitment C</dt>
              <dd className="hash">0x{result.commitment}</dd>
              <dt>Transaction</dt>
              <dd>
                <a href={result.explorer ?? explorer.tx(result.tx)} target="_blank" rel="noreferrer">
                  <code>{result.tx}</code>
                </a>
              </dd>
            </dl>

            {/*
              The record is offered back before the attestation, and said to be
              the thing to keep, because nothing else stores it. It exists in this
              browser and nowhere else: no endpoint serves it, by design. An
              issuer who closes this tab without it can never re-attest the week,
              never restate its fee position from the document, and never show a
              buyer what the commitment above was taken over.
            */}
            <h3>Keep the record</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              This is the only copy. It is not stored anywhere and no endpoint serves it — that is
              what keeps it off the public ledger, and it means losing it is permanent.
            </p>
            <p>
              <a
                className="btn primary"
                download={`right-${result.right_id}.record.json`}
                href={`data:application/json,${encodeURIComponent(result.issuedText)}`}
              >
                Save record for right #{result.right_id}
              </a>
            </p>
            <p className="muted">
              Send it to the owner. With it and their secret file they can prove a transfer of the
              week:
            </p>
            <pre>{`npm run zk:prove -- --record right-${result.right_id}.record.json --secret <their secret>.json \\
  --right ${result.right_id} --from ${readPath(JSON.parse(result.issuedText) as Doc, "owner.stellar_account") || "<owner G…>"} --to <G…> \\
  ( --rental-until <unix seconds> | --sale --next-secret-hash <buyer's h'> )`}</pre>

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

/**
 * The owner's side: ask the issuer to issue a week to the account signed in.
 *
 * The account is the session's — shown, never typed — and the only other thing
 * sent is `h`. The secret it hashes stays in the owner's file.
 */
function IssuanceAsk() {
  const { address, authenticated, standing, busy: connecting, connect, authFetch } = useWallet();
  const [hashText, setHashText] = useState("");
  // Filled from the link `npm run zk:secret` prints, once in the browser.
  useEffect(() => {
    const { value } = issuanceRequestPrefill(window.location.search);
    if (value) setHashText(value);
  }, []);
  // The same check the server makes, shown before anything is sent.
  const hashError = useMemo(() => {
    if (hashText.trim() === "") return null;
    try {
      parseSecretHash(hashText);
      return null;
    } catch (caught) {
      return describeError(caught);
    }
  }, [hashText]);
  const [mine, setMine] = useState<IssuanceRequest[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await authFetch("/api/requests/issuance");
    const body = (await response.json()) as { requests?: IssuanceRequest[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "could not read your requests");
    setMine(body.requests ?? []);
  }, [authFetch]);

  useEffect(() => {
    if (!authenticated) return;
    load().catch((caught: unknown) => setError(describeError(caught)));
  }, [authenticated, load]);

  const ask = useCallback(async () => {
    setSending(true);
    setError(null);
    setNote(null);
    try {
      const response = await authFetch("/api/requests/issuance", {
        method: "POST",
        body: JSON.stringify({ secret_hash: hashText.trim() }),
      });
      const body = (await response.json()) as { note?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "the request was not recorded");
      setNote(body.note ?? "Asked.");
      setHashText("");
      await load();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSending(false);
    }
  }, [authFetch, hashText, load]);

  if (!address || !authenticated) {
    return (
      <div className="note">
        <strong>Asking for a week needs a verified account</strong> — the one the week will be
        issued to.
        <p style={{ margin: "0.5rem 0 0.75rem" }}>
          Connect a wallet and complete the SEP-10 handshake.
        </p>
        <button className="primary" onClick={() => void connect()} disabled={connecting}>
          {connecting ? "connecting…" : "Connect wallet"}
        </button>
      </div>
    );
  }
  if (!standing) return <p className="muted">Reading your standing from the registry…</p>;

  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Request issuance</h3>
        <dl className="facts">
          <dt>Issued to</dt>
          <dd>
            <code>{standing.account}</code> <span className="muted">· the account signed in</span>
          </dd>
        </dl>
        <p className="muted">
          First, on your own machine, make the week&apos;s secret. Keep the file: with it you can
          rent the week out or sell it, and nobody else can — the issuer included.
        </p>
        <pre>npm run zk:secret -- .secrets/my-week.json</pre>
        <div className="field">
          <label htmlFor="ask-secret-hash">Your h</label>
          <input
            id="ask-secret-hash"
            className="mono"
            value={hashText}
            onChange={(event) => setHashText(event.target.value)}
            placeholder="the number npm run zk:secret printed — decimal or hex"
            spellCheck={false}
          />
          {hashError ? <div className="note bad">{hashError}</div> : null}
          <p className="muted">
            Only this hash is sent. The secret in the file never leaves your machine. The link{" "}
            <code>npm run zk:secret</code> prints fills it in.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => void ask()}
          disabled={sending || hashText.trim() === "" || hashError !== null}
        >
          {sending ? "sending…" : "Request issuance"}
        </button>
        {error ? <div className="note bad" style={{ marginTop: "1rem" }}>{error}</div> : null}
        {note ? <div className="note accent" style={{ marginTop: "1rem" }}>{note}</div> : null}
      </div>

      {mine.length > 0 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Your requests</h3>
          <ul>
            {mine.map((r) => (
              <li key={r.id}>
                asked {formatDate(Date.parse(r.requested_at) / 1000)} ·{" "}
                {r.status === "issued" && r.right_id !== undefined ? (
                  <>
                    <strong>issued as right #{r.right_id}</strong>
                    {r.tx ? (
                      <>
                        {" "}
                        ·{" "}
                        <a href={explorer.tx(r.tx)} target="_blank" rel="noreferrer">
                          transaction
                        </a>
                      </>
                    ) : null}
                    <span className="muted"> — ask the issuer for the record file</span>
                  </>
                ) : (
                  <span className="muted">waiting for the issuer</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
