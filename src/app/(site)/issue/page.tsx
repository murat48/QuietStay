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

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RoleGate } from "@/components/RoleGate";
import { SignInChoice } from "@/components/SignInChoice";
import { useWallet } from "@/components/WalletProvider";
import { canonicalText, commit, type JsonValue } from "@/lib/canonical";
import { CONTRACT_ID, FEE_ACCOUNT, NETWORK, NETWORK_LABEL, explorer } from "@/lib/config";
import { reservedOwnerReason } from "@/lib/issue-guard";
import {
  intakeSignCommand,
  intakeStatus,
  openDetails,
  prepareIntakeKey,
  publishIntakeKey,
  sealDetails,
  submitIntakeKey,
  verifiedIntakeKey,
} from "@/lib/issuer-intake";
import { DETAIL_FIELDS, cleanDetails, detailValues, type DetailKey } from "@/lib/issuer-key";
import { signMessageWithWallet } from "@/lib/wallet-kit";
import { addDays, followCheckIn, todayIso } from "@/lib/week-dates";
import { describeError, formatDate } from "@/lib/format";
import type { IssuanceRequest } from "@/lib/requests";
import { issueScreenView } from "@/lib/roles";
import { useProverSupported } from "@/lib/use-prover-supported";
import { issuanceRequestPrefill } from "@/lib/secret-hash";
import { b64u, replyLink, requestLink, seal, unb64u, type SealedRecord } from "@/lib/sealed";
import { getPendingIssue, newSealKey, newSecret, putIssued, putPendingIssue, sealKey, type PendingIssue } from "@/lib/vault";
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
  /**
   * The owner's reply link, sealed in this browser the moment the week was
   * issued, when the ask carried its public key. Null when it did not (an older
   * ask): then the owner's request link, opened here, makes it.
   */
  reply: string | null;
  /** The sealed record was left with the owner's ask, for their browser to pick up. */
  delivered: boolean;
  /** Why sealing or delivery failed, if it did; the week is issued either way. */
  replyError?: string;
  record_digest: string;
  commitment: string;
  tx: string;
  explorer: string;
  attested_clean: boolean;
  attestation: unknown;
  note: string;
}

export default function IssueScreen() {
  const { standing, readOnly, authFetch, authenticated, kind } = useWallet();

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
  // D16: whether this browser holds the published intake key owners seal their
  // details to, and what happened when an ask's details were opened.
  const [intake, setIntake] = useState<"ready" | "missing" | null>(null);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [detailsNote, setDetailsNote] = useState<{ ok: boolean; text: string } | null>(null);

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
      // The week starts today, for a week, in this year (asked for on the
      // testnet demo, 2026-11-26: the sample's fixed dates were in the past).
      const today = todayIso();
      const year = Number(today.slice(0, 4));
      const week = { check_in: today, check_out: addDays(today, 7), use_year: year, week_number: isoWeekNumber(today) };
      const fees = { ...(doc.maintenance_fees as object), paid_through: `${year}-12-31` };
      return JSON.stringify(
        { ...doc, record_id: freshRecordId(), salt: freshSalt(), week, maintenance_fees: fees },
        null,
        2,
      );
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
      let withDate = writePath(current, "week.check_in", value);
      // Check-out keeps the stay's length and the use year follows check-in,
      // so moving the week is one edit, not three.
      let previous: { checkIn?: string; checkOut?: string } = {};
      try {
        const doc = JSON.parse(current) as { week?: { check_in?: string; check_out?: string } };
        previous = { checkIn: doc.week?.check_in, checkOut: doc.week?.check_out };
      } catch {
        // not JSON: nothing to follow
      }
      const follow = followCheckIn(value, previous);
      if (follow) {
        withDate = writePath(withDate, "week.check_out", follow.checkOut);
        withDate = writePath(withDate, "week.use_year", follow.useYear);
      }
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

  /**
   * After a week is on chain, by either path: keep this browser's copy of the
   * record, seal it to the owner and leave it with their ask (D3 as amended
   * 2026-11-25), and show the result.
   */
  const finishIssued = useCallback(
    async (body: Omit<IssueResult, "issuedText" | "reply" | "delivered">, issuedText: string, sel: IssuanceRequest) => {
      const record = JSON.parse(issuedText) as unknown;
      let reply: string | null = null;
      let replyError: string | undefined;
      let delivered = false;
      if (sel.key_hash && body.right_id !== undefined) {
        const owner = (record as { owner: { stellar_account: string } }).owner.stellar_account;
        await putIssued({ right_id: body.right_id, record: record as JsonValue, owner, h: sel.secret_hash, ask_id: sel.id });
        // Seal at once when the ask carries the owner's public key: no request
        // link has to travel. `seal` refuses a key that does not hash to the
        // ask's key_hash.
        if (sel.public_key) {
          try {
            const payload: SealedRecord = {
              v: 1,
              record,
              h: sel.secret_hash,
              holder: owner,
              right_id: body.right_id,
              contract: CONTRACT_ID,
              request: { kind: "issue", id: sel.id },
            };
            const blob = await seal(unb64u(sel.public_key), sel.key_hash, payload);
            reply = replyLink(window.location.origin, blob);
            const sent = await authFetch("/api/requests/issuance/delivery", {
              method: "POST",
              body: JSON.stringify({ id: sel.id, blob }),
            });
            const sentBody = (await sent.json()) as { delivered?: boolean; error?: string };
            if (!sent.ok || !sentBody.delivered) throw new Error(sentBody.error ?? "the sealed record could not be left for the owner");
            delivered = true;
          } catch (caught) {
            replyError = describeError(caught);
          }
        }
      }
      // Kept as sent: an edit made after issuing must not change what is saved.
      setResult({ ...body, issuedText, reply, delivered, ...(replyError ? { replyError } : {}) });
      // An issued request drops off the list.
      setAsks((current) => current.filter((ask) => ask.id !== sel.id));
      setSelected(null);
      setSecretHash("");
    },
    [authFetch],
  );

  const issue = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Only from an owner's request (Step 5, 2026-11-25): a week issued with
      // an h typed in has its secret nowhere this app can reach.
      if (!selected) throw new Error("pick the owner's request from the list first; a week is issued here only from a request");
      const record: unknown = JSON.parse(recordText);
      const response = await authFetch("/api/issue", {
        method: "POST",
        body: JSON.stringify({ record, request_id: selected.id }),
      });
      const body = (await response.json()) as Omit<IssueResult, "issuedText" | "reply" | "delivered"> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "issuance failed");
      await finishIssued(body, recordText, selected);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [authFetch, recordText, selected, finishIssued]);

  /*
   * The CLI path (Step 5 plan, item 3, 2026-11-27): the server builds the
   * unsigned `issue` envelope; the issuer reviews, signs and sends it with
   * scripts/mainnet-sign-submit.sh, then pastes the hash; the server reads it
   * back from the chain before closing the ask. The only path where the
   * deployment holds no issuer key (`cli` mode, mainnet). The record and the
   * ask wait in this browser's vault meanwhile, so a reload loses nothing.
   */
  const [envelope, setEnvelope] = useState<PendingIssue | null>(null);
  const [txHash, setTxHash] = useState("");
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void getPendingIssue(selected.id).then((p) => {
      if (!cancelled && p) setEnvelope(p);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const buildEnvelope = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (!selected) throw new Error("pick the owner's request from the list first");
      const record: unknown = JSON.parse(recordText);
      const response = await authFetch("/api/issue", {
        method: "POST",
        body: JSON.stringify({ record, request_id: selected.id, envelope: true }),
      });
      const body = (await response.json()) as { xdr?: string; valid_until?: string; expected_right_id?: number; error?: string };
      if (!response.ok || !body.xdr) throw new Error(body.error ?? "the envelope could not be built");
      const pending: PendingIssue = {
        ask: selected,
        recordText,
        xdr: body.xdr,
        validUntil: body.valid_until ?? "",
        expectedRightId: body.expected_right_id ?? null,
      };
      await putPendingIssue(pending);
      setEnvelope(pending);
      setTxHash("");
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [authFetch, recordText, selected]);

  const confirmEnvelope = useCallback(async () => {
    if (!envelope) return;
    setBusy(true);
    setError(null);
    try {
      const response = await authFetch("/api/issue/confirm", {
        method: "POST",
        body: JSON.stringify({ tx_hash: txHash.trim(), record: JSON.parse(envelope.recordText), request_id: envelope.ask.id }),
      });
      const body = (await response.json()) as Omit<IssueResult, "issuedText" | "reply" | "delivered"> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "the issuance could not be confirmed");
      await finishIssued(
        { ...body, attested_clean: body.attested_clean ?? false, attestation: body.attestation ?? null },
        envelope.recordText,
        envelope.ask,
      );
      await putPendingIssue(null, envelope.ask.id);
      setEnvelope(null);
      setTxHash("");
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [authFetch, envelope, txHash, finishIssued]);

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

  // Which ask's details are open, and declining one (2026-11-27).
  const [viewing, setViewing] = useState<string | null>(null);
  // Opened from the row's Decline button: the panel goes straight to declining.
  const [declineFirst, setDeclineFirst] = useState<string | null>(null);
  const [declinedNote, setDeclinedNote] = useState<string | null>(null);
  const declineAsk = useCallback(
    async (ask: IssuanceRequest, reason: string) => {
      const res = await authFetch("/api/requests/issuance/decline", {
        method: "POST",
        body: JSON.stringify({ id: ask.id, reason }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "the request could not be declined");
      setAsks((current) => current.filter((a) => a.id !== ask.id));
      setViewing(null);
      if (selected?.id === ask.id) {
        setSelected(null);
        setSecretHash("");
        setDetailsNote(null);
      }
      setDeclinedNote(`Declined the request from ${ask.by.slice(0, 6)}…${ask.by.slice(-4)}. They see it on their screen${reason ? ", with your reason" : ""}.`);
    },
    [authFetch, selected],
  );

  // D16: does this browser hold the intake key owners seal their details to?
  useEffect(() => {
    if (!isIssuer || !authenticated || !standing) return;
    let cancelled = false;
    void intakeStatus(standing.account)
      .then((status) => {
        if (!cancelled) setIntake(status);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setIntakeError(describeError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [isIssuer, authenticated, standing]);

  // A CLI session signs the key's message with `stellar message sign`: the
  // key is made here first, then the signature pasted back.
  const [intakeCli, setIntakeCli] = useState<{ publicKey: string; message: string } | null>(null);
  const [intakeSig, setIntakeSig] = useState("");
  const publishIntake = useCallback(async () => {
    if (!standing) return;
    setIntakeBusy(true);
    setIntakeError(null);
    try {
      if (kind === "cli") {
        if (!intakeCli) {
          const key = await prepareIntakeKey();
          setIntakeCli({ publicKey: key.publicKey, message: key.message });
          return;
        }
        await submitIntakeKey(intakeCli.publicKey, intakeSig, authFetch);
        setIntakeCli(null);
        setIntakeSig("");
      } else {
        await publishIntakeKey((message) => signMessageWithWallet(message, standing.account), authFetch);
      }
      setIntake(await intakeStatus(standing.account));
    } catch (caught) {
      setIntakeError(describeError(caught));
    } finally {
      setIntakeBusy(false);
    }
  }, [standing, authFetch, kind, intakeCli, intakeSig]);

  const pick = useCallback(
    (ask: IssuanceRequest | null) => {
      setSelected(ask);
      setSecretHash(ask ? ask.secret_hash : "");
      setDetailsNote(null);
      if (!ask) return;
      setField("owner.stellar_account", ask.by);
      if (!ask.sealed_details) return;
      // The owner's details, opened here with the intake key: they fill in the
      // form, and the issuer checks each against the deed before issuing.
      void openDetails(ask)
        .then((details) => {
          for (const { path, value } of detailValues(details)) {
            if (path === "week.check_in") setCheckIn(String(value));
            else setField(path, value);
          }
          setDetailsNote({
            ok: true,
            text: "Filled in from the details the owner entered. Check every field against the deed and the resort's books before issuing: the owner's word is not proof.",
          });
        })
        .catch((caught: unknown) => setDetailsNote({ ok: false, text: `The owner's details could not be opened: ${describeError(caught)}` }));
    },
    [setField, setCheckIn],
  );
  const feesOutstanding =
    preview !== null && Number.parseFloat(preview.feesOutstanding) !== 0;

  const text = (path: string) => readPath(parsed, path);
  const ownerMatchesAsk = selected === null || text("owner.stellar_account") === selected.by;
  // The fee account and the issuer never hold a week (src/lib/issue-guard.ts);
  // /api/issue refuses them too, and also the sign-in key.
  const reservedReason = reservedOwnerReason(text("owner.stellar_account"), { feeAccount: FEE_ACCOUNT, issuer: standing?.account ?? null });

  if (issueScreenView(standing) === "request") {
    return (
      <>
        <p className="eyebrow">START WITH YOUR RIGHTS</p>
        <h1>Add your week to QuietStay</h1>
        <p className="lede">
          The issuer issues usage rights. To have a week issued to you, send the issuer the hash of
          a secret only you hold. The issuer enters the record; the week arrives in this account.
        </p>
        <div className="note accent phase-note" data-testid="issue-browser-note">
          Everything happens in this browser, with any wallet or a passkey: it makes your secret
          and keeps it, the week&apos;s record arrives here sealed, and the proof is made here when
          you rent the week out or sell it. Nothing to install and no command line. Your wallet
          or passkey is asked only to approve.
        </div>
        <IssuanceAsk />
      </>
    );
  }

  return (
    <>
      <p className="eyebrow">ISSUER WORKSPACE</p>
      <h1>Issue a usage right</h1>
      <p className="lede">
        The ownership record stays off chain. What goes on chain is a commitment that wraps its
        SHA-256 with the owner&apos;s account and the hash of a secret only the owner holds, the
        week&apos;s dates, the use year, and the first holder — nothing else.
      </p>

      <div className="card" data-testid="intake-card">
        <h3 style={{ marginTop: 0 }}>Owners&apos; details</h3>
        {intake === "ready" ? (
          <p className="muted" style={{ marginBottom: 0 }} data-testid="intake-ready">
            Owners can send you their week&apos;s details with their ask, sealed to this browser. Picking
            an ask fills the form in. Only this browser can open them.
          </p>
        ) : intake === "missing" ? (
          <>
            <p className="muted">
              Let owners send their week&apos;s details (name, resort, unit, dates, deed, fees) with their
              ask, so the form starts filled in. This browser makes a key; your wallet signs it once, so
              an owner&apos;s browser can check the key is yours before sealing anything to it. Details
              sealed to a key made in another browser cannot be opened here.
            </p>
            {intakeCli ? (
              <>
                <p className="muted">
                  Sign the key with the CLI (SEP-53). It signs only this message and sends nothing; paste the
                  signature it prints.
                </p>
                <pre className="mono" style={{ whiteSpace: "pre-wrap" }} data-testid="intake-cli-command">
                  {intakeSignCommand(intakeCli.message, NETWORK === "mainnet" ? "qs-main-issuer" : "qs-issuer")}
                </pre>
                <div className="field">
                  <label htmlFor="intake-sig">The signature</label>
                  <input
                    id="intake-sig"
                    className="mono"
                    value={intakeSig}
                    onChange={(e) => setIntakeSig(e.target.value.trim())}
                    spellCheck={false}
                    data-testid="intake-cli-signature"
                  />
                </div>
                <button className="primary" onClick={() => void publishIntake()} disabled={intakeBusy || intakeSig === ""} data-testid="intake-cli-publish">
                  {intakeBusy ? "publishing…" : "Publish the key"}
                </button>
              </>
            ) : (
              <button className="primary" onClick={() => void publishIntake()} disabled={intakeBusy} data-testid="intake-publish">
                {intakeBusy ? (kind === "cli" ? "making the key…" : "waiting for your wallet…") : "Let owners send their details"}
              </button>
            )}
          </>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>Checking…</p>
        )}
        {intakeError ? <div className="note bad" style={{ marginTop: "0.6rem" }}>{intakeError}</div> : null}
      </div>

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
              <li key={ask.id} data-testid={`ask-${ask.id}`}>
                <code>{ask.by}</code>{" "}
                <span className="muted">· asked {formatDate(Date.parse(ask.requested_at) / 1000)}</span>{" "}
                {ask.sealed_details ? <span className="tag accent">details sent</span> : null}{" "}
                {ask.renew_of ? (
                  <span className="tag" data-testid={`ask-renews-${ask.id}`}>
                    renews week #{ask.renew_of}
                    {ask.auto_renew ? " · each year" : ""}
                  </span>
                ) : null}{" "}
                <button type="button" onClick={() => {
                    setViewing(viewing === ask.id ? null : ask.id);
                    setDeclineFirst(null);
                  }}
                  data-testid={`ask-details-${ask.id}`}>
                  {viewing === ask.id ? "Hide details" : "Details"}
                </button>{" "}
                {selected?.id === ask.id ? (
                  <button type="button" onClick={() => pick(null)}>
                    Deselect
                  </button>
                ) : (
                  <button type="button" onClick={() => pick(ask)}>
                    Issue to this account
                  </button>
                )}{" "}
                {/* In the row itself, not only inside Details (found on the demo, 2026-11-27). */}
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setViewing(ask.id);
                    setDeclineFirst(ask.id);
                  }}
                  data-testid={`ask-decline-${ask.id}`}
                >
                  Decline
                </button>
                {viewing === ask.id ? (
                  <AskDetails
                    key={`${ask.id}-${declineFirst === ask.id ? "decline" : "view"}`}
                    ask={ask}
                    declineFirst={declineFirst === ask.id}
                    onDecline={(reason) => declineAsk(ask, reason)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {declinedNote ? (
          <div className="note" data-testid="ask-declined-note">
            {declinedNote}
          </div>
        ) : null}
        {detailsNote ? (
          <div className={`note ${detailsNote.ok ? "warn" : "bad"}`} data-testid="issue-details-note">
            {detailsNote.text}
          </div>
        ) : null}
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
                    {reservedReason ? (
                      <p className="note bad" data-testid="reserved-owner">{reservedReason}</p>
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
              readOnly
              placeholder="filled in from the owner's request"
              spellCheck={false}
            />
          </div>
          {selected ? (
            <p className="muted">From the owner&apos;s request — it cannot be edited.</p>
          ) : (
            <div className="note warn" data-testid="issue-needs-request">
              <strong>Pick the owner&apos;s request first.</strong> A week is issued here only from
              a request in the list above: that is how the owner&apos;s browser comes to hold the
              week&apos;s secret, and how this screen can hand you their reply link. A week issued
              to an account typed in by hand could never be rented out or sold from a browser.
            </div>
          )}
          {!ownerMatchesAsk ? (
            <div className="note warn">
              The record&apos;s first holder is no longer the account that asked,{" "}
              <code>{selected?.by}</code>. Put it back, or deselect the request.
            </div>
          ) : null}
          <p className="muted" style={{ marginBottom: 0 }}>
            The owner&apos;s browser made a secret when they asked, and sent you only its hash{" "}
            <code>h</code>. When you issue, the server computes the commitment{" "}
            <code>C = Poseidon(d, owner, h)</code> from this record and that <code>h</code>. The
            secret itself never reaches you or this server, so you can never prove a transfer of
            the week.
          </p>
        </div>
        {/*
          Two ways to issue (2026-11-27). Signed here where the deployment holds
          the issuer key; and always the envelope, signed with the CLI, which
          is the only way where it holds none (`cli` mode, mainnet).
        */}
        {readOnly ? null : (
          <button
            className="primary"
            onClick={() => void issue()}
            disabled={busy || !preview || !isIssuer || selected === null || !ownerMatchesAsk || reservedReason !== null}
          >
            {busy ? "issuing…" : `Issue on ${NETWORK_LABEL}`}
          </button>
        )}
        <div className="card" style={{ marginTop: "1rem" }} data-testid="issue-envelope-card">
          <h3 style={{ marginTop: 0 }}>{readOnly ? "Issue with the CLI" : "Or issue with the CLI"}</h3>
          <p className="muted">
            {readOnly
              ? "This deployment holds no issuer key, on purpose. "
              : ""}
            The server builds the unsigned <code>issue</code> transaction from this record and the
            owner&apos;s request. You review, sign and send it in your own terminal with{" "}
            <code>scripts/mainnet-sign-submit.sh</code>, then paste its hash here: the server reads it back
            from the chain before closing the request, and this browser seals the record to the owner.
          </p>
          <button
            onClick={() => void buildEnvelope()}
            disabled={busy || !preview || !isIssuer || selected === null || !ownerMatchesAsk || reservedReason !== null}
            data-testid="issue-build-envelope"
          >
            {busy && !envelope ? "building…" : envelope ? "Build it again" : "Build the envelope"}
          </button>
          {envelope && selected?.id === envelope.ask.id ? (
            <>
              <p className="muted" style={{ marginBottom: "0.3rem" }}>
                Valid until {envelope.validUntil ? new Date(envelope.validUntil).toLocaleString() : "…"}
                {envelope.expectedRightId !== null ? <> · it will be right #{envelope.expectedRightId} if nothing is issued first</> : null}.
                Save it as a file, then run:
              </p>
              <textarea readOnly className="mono" value={envelope.xdr} style={{ minHeight: "5rem" }} data-testid="issue-envelope-xdr" />
              <p>
                <a
                  className="btn"
                  download={`issue-ask-${envelope.ask.id.slice(0, 8)}.xdr`}
                  href={`data:text/plain,${encodeURIComponent(envelope.xdr + "\n")}`}
                >
                  Save the envelope (.xdr)
                </a>
              </p>
              <pre className="mono" style={{ whiteSpace: "pre-wrap" }} data-testid="issue-envelope-command">
                {`scripts/mainnet-sign-submit.sh issue-ask-${envelope.ask.id.slice(0, 8)}.xdr ${NETWORK === "mainnet" ? "qs-main-issuer" : "qs-issuer"} --network ${NETWORK}`}
              </pre>
              <div className="field">
                <label htmlFor="issue-tx-hash">The transaction hash it printed</label>
                <input
                  id="issue-tx-hash"
                  className="mono"
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value.trim())}
                  spellCheck={false}
                  data-testid="issue-tx-hash"
                />
              </div>
              <button
                className="primary"
                onClick={() => void confirmEnvelope()}
                disabled={busy || !/^[0-9a-fA-F]{64}$/.test(txHash)}
                data-testid="issue-confirm"
              >
                {busy ? "reading it from the chain…" : "Confirm the issuance"}
              </button>
            </>
          ) : null}
        </div>
      </RoleGate>

      {error ? <div className="note bad" style={{ marginTop: "1rem" }}>{error}</div> : null}

      {result ? (
        <>
          <h2>Issued</h2>
          <div className={`note ${result.attested_clean ? "accent" : "warn"}`}>
            <strong>Right #{result.right_id}</strong> — {result.note}
          </div>
          <div className="card">
            {result.reply && result.delivered ? (
              <>
                <h3 style={{ marginTop: 0 }}>Delivered to the owner</h3>
                <p className="note accent" style={{ marginTop: 0 }} data-testid="issue-delivered">
                  The week&apos;s record was sealed in this browser to the owner&apos;s browser, and left
                  with their request. Their browser picks it up the next time they sign in, checks
                  it against the chain, and can then rent the week out or sell it. Nothing to send.
                  The server holds only the sealed form, which it cannot open, until then.
                </p>
                <details>
                  <summary className="muted">The owner did not get it? Send them the reply link instead</summary>
                  <textarea readOnly value={result.reply} style={{ minHeight: "6rem" }} data-testid="issue-reply-link" />
                </details>
              </>
            ) : result.reply ? (
              <>
                <h3 style={{ marginTop: 0 }}>Send the owner their reply link</h3>
                <p className="note warn" style={{ marginTop: 0 }}>
                  It could not be left with their request{result.replyError ? <> ({result.replyError})</> : null}.
                  Send them this link through the channel you already use; they open it in the
                  browser they asked from. It is useless to anyone else.
                </p>
                <textarea readOnly value={result.reply} style={{ minHeight: "6rem" }} data-testid="issue-reply-link" />
              </>
            ) : (
              <>
              <h3 style={{ marginTop: 0 }}>Send the owner their record</h3>
              <p className="muted" style={{ marginTop: 0 }} data-testid="issue-reply-later">
                {result.replyError ? <>Sealing here failed ({result.replyError}). </> : null}
                This request was made before requests carried the owner&apos;s key. Ask the owner for
                the request link on their /issue screen, and open it here, in this browser: it makes
                the reply link.
              </p>
              </>
            )}
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
              This browser keeps a copy, to seal it to the owner again if the reply link is lost.
              No server stores it and no endpoint serves it — that is what keeps it off the public
              ledger. Save a copy for your own files too.
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

            {/* None on the CLI path in `cli` mode: that deployment signs no attestations. */}
            {result.attestation ? (
              <>
                <h3>Issuer attestation</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  Give this to a counterparty along with the record. They can check both on the{" "}
                  <Link href="/verify">verify screen</Link> without asking anyone&apos;s permission.
                </p>
                <pre>{JSON.stringify(result.attestation, null, 2)}</pre>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * One owner's ask, opened on the issuer's screen (2026-11-27): who asked and
 * when, the details they sent (opened here with the intake key), and a way to
 * decline it with a reason the owner will see.
 */
function AskDetails({
  ask,
  declineFirst = false,
  onDecline,
}: {
  ask: IssuanceRequest;
  declineFirst?: boolean;
  onDecline: (reason: string) => Promise<void>;
}) {
  const [details, setDetails] = useState<Partial<Record<DetailKey, string>> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(declineFirst);
  const [busy, setBusy] = useState(false);
  const declineBox = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (declineFirst) declineBox.current?.focus();
  }, [declineFirst]);
  useEffect(() => {
    if (!ask.sealed_details) return;
    let cancelled = false;
    void openDetails(ask).then(
      (d) => {
        if (!cancelled) setDetails(d);
      },
      (e: unknown) => {
        if (!cancelled) setProblem(describeError(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ask]);

  const filled = details ? DETAIL_FIELDS.filter((f) => details[f.key]) : [];
  return (
    <div className="card" style={{ margin: "0.6rem 0" }} data-testid={`ask-panel-${ask.id}`}>
      <dl className="facts">
        <dt>Account (the first holder)</dt>
        <dd>
          <code>{ask.by}</code>
        </dd>
        <dt>Asked</dt>
        <dd>{new Date(ask.requested_at).toLocaleString()}</dd>
        <dt>Secret hash h</dt>
        <dd className="hash">{ask.secret_hash.slice(0, 16)}…</dd>
        <dt>Record delivery</dt>
        <dd>{ask.public_key ? "sealed to the owner's browser as soon as you issue" : "by request link (an older ask)"}</dd>
      </dl>
      <h4 style={{ marginBottom: "0.3rem" }}>The owner&apos;s details</h4>
      {!ask.sealed_details ? (
        <p className="muted">None sent with this ask: get them from the owner another way.</p>
      ) : problem ? (
        <p className="note bad">{problem}</p>
      ) : details === null ? (
        <p className="muted">Opening them in this browser…</p>
      ) : filled.length === 0 ? (
        <p className="muted">The owner left every field empty.</p>
      ) : (
        <dl className="facts" data-testid={`ask-details-list-${ask.id}`}>
          {filled.map((f) => (
            <Fragment key={f.key}>
              <dt>{f.label}</dt>
              <dd>{details[f.key]}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      <p className="muted" style={{ marginTop: "0.4rem" }}>
        Check them against the deed and the resort&apos;s books. They are the owner&apos;s word, not proof.
      </p>

      <h4 style={{ marginBottom: "0.3rem" }}>Decline</h4>
      <div className="field">
        <label htmlFor={`decline-${ask.id}`}>Reason, shown to the owner (optional)</label>
        <textarea
          id={`decline-${ask.id}`}
          ref={declineBox}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. the deed reference does not match the resort's registry; please check it and ask again"
          style={{ minHeight: "3.5rem" }}
          data-testid={`decline-reason-${ask.id}`}
        />
      </div>
      {confirming ? (
        <span className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setProblem(null);
              onDecline(reason.trim()).catch((e: unknown) => {
                setProblem(describeError(e));
                setBusy(false);
              });
            }}
            data-testid={`decline-yes-${ask.id}`}
          >
            {busy ? "declining…" : "Yes, decline it"}
          </button>
          <button onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </span>
      ) : (
        <button onClick={() => setConfirming(true)} data-testid={`decline-${ask.id}`}>
          Decline this request
        </button>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>
        Nothing is on chain yet, so declining changes nothing else. The owner can correct and ask again.
      </p>
    </div>
  );
}

/**
 * The owner's side: ask the issuer to issue a week to the account signed in.
 *
 * The account is the session's — shown, never typed — and the only other thing
 * sent is `h`. The secret it hashes is made and kept in this browser.
 */
function IssuanceAsk() {
  const { address, authenticated, standing, readOnly, authFetch } = useWallet();
  // A link from `npm run zk:secret` carries an h made on the command line.
  // Asking with one is no longer offered here (2026-11-26, D15): this browser
  // would not hold its secret, so it could never rent the week out or sell
  // it. The link is only answered with a note.
  const [cliLink, setCliLink] = useState(false);
  useEffect(() => {
    if (issuanceRequestPrefill(window.location.search).value) void Promise.resolve().then(() => setCliLink(true));
  }, []);
  const [mine, setMine] = useState<IssuanceRequest[]>([]);
  const supported = useProverSupported();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // D16: the week's details, typed here and sealed in this browser to the
  // issuer's intake key, which is checked against the issuer on chain first.
  const [details, setDetails] = useState<Partial<Record<DetailKey, string>>>({});
  // The week starts today, for a week, in this year; set after mount so the
  // server's HTML and the browser's agree.
  useEffect(() => {
    const today = todayIso();
    void Promise.resolve().then(() =>
      setDetails((d) => ({
        week_check_in: today,
        week_check_out: addDays(today, 7) ?? "",
        week_use_year: today.slice(0, 4),
        ...d,
      })),
    );
  }, []);
  const setDetail = (key: DetailKey, value: string) => {
    if (key !== "week_check_in") return setDetails({ ...details, [key]: value });
    const follow = followCheckIn(value, { checkIn: details.week_check_in, checkOut: details.week_check_out });
    setDetails({
      ...details,
      week_check_in: value,
      ...(follow ? { week_check_out: follow.checkOut, week_use_year: String(follow.useYear) } : {}),
    });
  };
  const [intakeOpen, setIntakeOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void verifiedIntakeKey()
      .then((k) => {
        if (!cancelled) setIntakeOpen(k !== null);
      })
      .catch(() => {
        if (!cancelled) setIntakeOpen(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  /**
   * Phase 3 (D3): make the secret and a sealed-link key in this browser, keep
   * both in its vault, and send only `h` and the key's hash.
   */
  const ask = useCallback(
    async () => {
      setSending(true);
      setError(null);
      setNote(null);
      try {
        if (!address) throw new Error("sign in first");
        // Sealed before anything else is made, so a refused key stops the ask
        // with nothing sent. The details never leave this browser in the clear.
        // With the intake closed the fields are disabled, and the ask goes
        // without them (the dates are filled in by default, so they are never
        // empty).
        // The issuer may have turned it on since this page loaded: look again
        // before asking without the details, and stop so they can be checked.
        if (intakeOpen !== true && (await verifiedIntakeKey().catch(() => null))) {
          setIntakeOpen(true);
          setNote("The issuer can receive details now. Check what you entered, then press Request issuance.");
          return;
        }
        const cleaned = intakeOpen === true ? cleanDetails(details) : {};
        let sealedDetails: { blob: string; key_hash: string } | undefined;
        if (Object.keys(cleaned).length > 0) {
          const intakeKey = await verifiedIntakeKey();
          if (!intakeKey) throw new Error("the issuer cannot receive details yet; nothing was sent");
          sealedDetails = await sealDetails(intakeKey, address, cleaned);
        }
        const h = await newSecret("issuance ask");
        const key = await newSealKey("issuance ask");
        // The public half goes with the ask, so the issuer seals the moment
        // they issue; the private half never leaves this browser.
        const payload = {
          secret_hash: h.toString(),
          key_hash: key.keyHash,
          public_key: b64u(key.publicRaw),
          ...(sealedDetails ? { sealed_details: sealedDetails } : {}),
        };
        const response = await authFetch("/api/requests/issuance", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const body = (await response.json()) as { note?: string; error?: string };
        if (!response.ok) throw new Error(body.error ?? "the request was not recorded");
        setNote(
          "Asked. Your week's secret was made and kept in this browser; only its hash was sent. " +
            "When the issuer issues the week, its record arrives here the next time you sign in, in this browser.",
        );
        const today = todayIso();
        setDetails({ week_check_in: today, week_check_out: addDays(today, 7) ?? "", week_use_year: today.slice(0, 4) });
        await load();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setSending(false);
      }
    },
    [address, authFetch, details, intakeOpen, load],
  );

  // A request link for each ask this browser holds the key for.
  const [links, setLinks] = useState<Record<string, string>>({});
  useEffect(() => {
    void (async () => {
      const out: Record<string, string> = {};
      for (const r of mine) {
        if (!r.key_hash) continue;
        const key = await sealKey(r.key_hash);
        if (key) out[r.id] = requestLink(window.location.origin, "issue", r.id, key.publicRaw);
      }
      setLinks(out);
    })();
  }, [mine]);

  if (!address || !authenticated) {
    return (
      <div className="note">
        <strong>Asking for a week needs a verified account</strong> — the one the week will be
        issued to.
        <SignInChoice />
      </div>
    );
  }
  if (!standing) return <p className="muted">Reading your standing from the registry…</p>;

  return (
    <>
      {/*
        Said up front on a deployment without the issuer key: the ask is kept
        here, but the issuer issues from their own machine, so the week does
        not arrive the moment the ask is sent.
      */}
      {readOnly ? (
        <div className="note accent">
          <strong>Requests here are handled by hand.</strong> This site does not hold the
          issuer&apos;s key, so the issuer reviews your request and issues the week from their own
          machine. It appears in your account once they have; nothing more is needed from you.
        </div>
      ) : null}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Request issuance</h3>
        <dl className="facts">
          <dt>Issued to</dt>
          <dd>
            <code>{standing.account}</code> <span className="muted">· the account signed in</span>
          </dd>
        </dl>
        <p className="muted">
          Your browser makes the week&apos;s secret and keeps it. Only its hash is sent. With the
          secret, this browser can rent the week out or sell it, and nobody else can — the issuer
          included. If this browser&apos;s storage is cleared, that ability is lost for good.
        </p>
        {/*
          Always editable (found on the testnet demo, 2026-11-26: a form
          locked until the issuer acted looked broken). Until the issuer has
          published an intake key, nothing typed here is sent, and the screen
          says so and what the issuer has to do.
        */}
        <fieldset style={{ border: 0, padding: 0, margin: "0 0 1rem" }} disabled={sending}>
          <legend style={{ fontWeight: 600 }}>Your week, for the issuer</legend>
          {intakeOpen === false ? (
            <div className="note warn" data-testid="details-closed">
              <strong>The issuer has not turned on receiving details yet,</strong> so what you type here
              cannot be sent: there is no key yet that only the issuer&apos;s browser can open. The
              issuer does it once, on this screen signed in with the issuer account, with{" "}
              <em>Let owners send their details</em>. Until then you can ask without details, and the
              issuer gets them from you another way.
            </div>
          ) : (
            <p className="muted">
              What you know of your week, so the issuer&apos;s form starts filled in. Sealed in this
              browser so that only the issuer&apos;s browser can open it — this site&apos;s server cannot
              read it. The issuer checks each field against the deed and the resort&apos;s books. Leave out
              what you do not know.
            </p>
          )}
          <div className="field-row">
            {DETAIL_FIELDS.map((f) => (
              <div className="field" key={f.key}>
                <label htmlFor={`detail-${f.key}`}>{f.label}</label>
                <input
                  id={`detail-${f.key}`}
                  type={"type" in f && f.type === "date" ? "date" : "text"}
                  inputMode={"type" in f && f.type === "number" ? "numeric" : undefined}
                  value={details[f.key] ?? ""}
                  onChange={(event) => setDetail(f.key, event.target.value)}
                  data-testid={`detail-${f.key}`}
                />
              </div>
            ))}
          </div>
        </fieldset>
        <button className="primary" onClick={() => void ask()} disabled={sending || supported !== true}>
          {sending ? "making your secret…" : intakeOpen === false ? "Ask without details" : "Request issuance"}
        </button>
        {supported === false ? (
          <div className="note bad" data-testid="prover-unsupported">This browser cannot keep a secret for you: it lacks Web Workers, WebCrypto or IndexedDB.</div>
        ) : null}
        {cliLink ? (
          <div className="note warn" style={{ marginTop: "1rem" }} data-testid="issue-cli-link">
            This link carries a secret hash made on the command line. Asking with one is no longer
            offered: this browser would not hold its secret, so it could never rent the week out or
            sell it. Use <strong>Request issuance</strong> above; the browser makes and keeps the
            secret for you.
          </div>
        ) : null}
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
                    {links[r.id] ? null : <span className="muted"> — ask the issuer for the record file</span>}
                  </>
                ) : r.status === "declined" ? (
                  <span data-testid={`ask-declined-${r.id}`}>
                    <span className="tag bad">declined by the issuer</span>
                    {r.reason ? <> — &ldquo;{r.reason}&rdquo;</> : <span className="muted"> — no reason given</span>}
                    <span className="muted"> Correct what is needed and ask again; nothing was put on chain.</span>
                  </span>
                ) : r.status === "cancelled" ? (
                  <span className="tag">renewal cancelled by you</span>
                ) : (
                  <span className="muted">waiting for the issuer</span>
                )}
                {r.status === "declined" || r.status === "cancelled" ? null : links[r.id] && r.public_key ? (
                  <>
                    <p className="muted" style={{ margin: "0.4rem 0" }} data-testid="issue-reply-wait">
                      Nothing to do: when the issuer issues this week, its record arrives sealed to
                      this browser and is checked against the chain the next time you sign in here.
                    </p>
                    {/* Kept for the case where the sealed record could not be left with the ask. */}
                    <details>
                      <summary className="muted">The record did not arrive?</summary>
                      <p className="muted" style={{ margin: "0.4rem 0" }}>
                        Send them this request link. They open it in the browser they issued from,
                        and it makes the reply link again.
                      </p>
                      <textarea readOnly value={links[r.id]} style={{ minHeight: "4rem" }} data-testid="issue-request-link" />
                    </details>
                  </>
                ) : links[r.id] ? (
                  <>
                    <p className="muted" style={{ margin: "0.4rem 0" }}>
                      Send the issuer this request link. Once the week is issued they open it and
                      send back a reply link; open that here, in this browser.
                    </p>
                    <textarea readOnly value={links[r.id]} style={{ minHeight: "4rem" }} data-testid="issue-request-link" />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
