"use client";

/**
 * Screen 3 of 4 — **Verify**.
 *
 * A counterparty checks a week before taking it on. Everything runs in this
 * browser: a server that told you "verified" would be one more party to trust,
 * which is the thing this project exists to reduce.
 *
 * ## Two ways in, same checks
 *
 * **By id** — type a right id and press Verify. The right is read from the
 * contract and the issuer's attestation is fetched from the issuer. Nothing is
 * pasted, and nothing is weakened by fetching: the attestation's signature is
 * still checked here, against the issuer address read from the *contract*, and
 * against the right it claims to be about. A server with no issuer key cannot
 * forge one and cannot edit one without breaking it. This is the path for someone
 * auditing the registry who was never sent a file.
 *
 * **By JSON** — paste the files a seller sent you and have them checked strictly.
 * The attestation box is prefilled from the issuer when it is empty, so the two
 * paths differ in convenience rather than in what they prove.
 *
 * ## Two levels, and the first one needs no documents
 *
 * **Required — the attestation and the contract.** The issuer's signature must be
 * bound to this right, this contract, and this network, and be in date. The
 * contract independently says who holds the week. Together those establish that
 * the week is real, that it owes no maintenance fees, and that the seller is the
 * holder — **without a single document changing hands.** That is the whole point:
 * verification instead of document exchange.
 *
 * **Optional — the record.** A seller may additionally disclose the underlying
 * document: which resort, which unit, the deed. When supplied it is canonicalized
 * (RFC 8785), hashed with SHA-256 via WebCrypto, and matched against the ledger's
 * commitment, which proves it is the exact document committed at issuance and
 * unedited since. When it is not supplied, nothing is claimed about it and the
 * verification still stands on its own.
 *
 * Making the record mandatory would have quietly reinstated document exchange —
 * the practice this design removes — so it is not. It is also why the record has
 * no endpoint: only its holder may disclose it, so it arrives by paste or not at
 * all.
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

type Tab = "id" | "json";

/** The right as the contract reports it. Throws with the server's message. */
async function fetchRight(id: string): Promise<OnChainRight> {
  const response = await fetch(`/api/right/${id}`, { cache: "no-store" });
  const body = (await response.json()) as OnChainRight & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "could not read that right");
  return body;
}

/**
 * The issuer's attestation, as text ready to be checked, or `null` if the issuer
 * signed none. A missing attestation is an answer, not an error — it means
 * nothing vouches for the week — so this resolves rather than throwing.
 */
async function fetchAttestation(id: string): Promise<string | null> {
  const response = await fetch(`/api/attestation/${id}`, { cache: "no-store" });
  if (!response.ok) return null;
  return JSON.stringify(await response.json(), null, 2);
}

export default function VerifyScreen() {
  const { address } = useWallet();
  const [tab, setTab] = useState<Tab>("id");
  const [rightId, setRightId] = useState("3");
  const [right, setRight] = useState<OnChainRight | null>(null);
  const [recordText, setRecordText] = useState("");
  const [attestationText, setAttestationText] = useState("");
  const [claimedHolder, setClaimedHolder] = useState("");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * Every check, run against explicit inputs rather than against component
   * state, so that both tabs go through exactly one implementation. What differs
   * between them is what they hand in: the id tab supplies no record and names no
   * seller, and says so in its results.
   */
  const collectChecks = useCallback(
    async (input: {
      right: OnChainRight;
      attestationText: string;
      recordText: string;
      claimedHolder: string;
      attestationAbsentDetail?: string;
    }): Promise<Check[]> => {
      const collected: Check[] = [];

      // --- leg 1: the record, if one was disclosed at all -------------------
      //
      // Optional on purpose. The point of an issuer-signed attestation is that a
      // counterparty can establish "this week is real, it owes nothing, and that
      // account holds it" *without* being handed anyone's deed — verification
      // instead of document exchange. Requiring a document here would have quietly
      // reinstated the thing the design exists to remove.
      let recomputed: string | undefined;
      let record: OwnershipRecord | null = null;

      if (input.recordText.trim() !== "") {
        try {
          record = validateRecord(JSON.parse(input.recordText));
          recomputed = await commit(record as never);
          const matches = digestsMatch(recomputed, input.right.commitment);
          collected.push({
            id: "record",
            label: "Record is well formed and hashes to the on-chain commitment",
            ok: matches,
            detail: matches
              ? `SHA-256 over the canonical record = 0x${recomputed}`
              : `record hashes to 0x${recomputed}, ledger holds 0x${input.right.commitment}`,
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
      if (input.attestationText.trim() === "") {
        collected.push({
          id: "attestation-absent",
          label: "Issuer attestation supplied",
          ok: false,
          detail:
            input.attestationAbsentDetail ??
            "no attestation supplied — nothing vouches that this week is free of unpaid fees",
        });
      } else {
        try {
          const parsed: unknown = JSON.parse(input.attestationText);
          const verification = verifyAttestation(parsed, {
            contract: CONTRACT_ID,
            network: NETWORK_PASSPHRASE,
            rightId: input.right.id,
            // From the contract, never from the attestation itself.
            contractIssuer: input.right.issuer,
            onChainCommitment: input.right.commitment,
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
      const claimed = input.claimedHolder.trim();
      if (claimed !== "") {
        const isHolder = claimed === input.right.effective_holder;
        collected.push({
          id: "holder",
          label: "The account offering the week is the account the contract says holds it",
          ok: isHolder,
          detail: isHolder
            ? `${claimed} is the effective holder`
            : `the contract names ${input.right.effective_holder} as the holder, not ${claimed}`,
        });
      }

      collected.push({
        id: "active",
        label: "The right is inside its validity window",
        ok: input.right.active,
        detail: input.right.active
          ? `use year ${formatDate(input.right.validity.from)} → ${formatDate(input.right.validity.until)}`
          : "the use year has closed, so this right can no longer be transferred",
      });

      if (input.right.term_ends !== null) {
        collected.push({
          id: "encumbered",
          label: "The week is not already rented out",
          ok: false,
          detail: `held on a term that ends ${formatDate(input.right.term_ends)} — until then it cannot be sold`,
        });
      }

      return collected;
    },
    [],
  );

  /** Read the right into the panel. Used by both tabs. */
  const loadRight = useCallback(async (id: string): Promise<OnChainRight | null> => {
    setError(null);
    setRight(null);
    setChecks(null);
    if (!/^\d+$/.test(id)) {
      setError("enter a usage right id — a positive whole number");
      return null;
    }
    setLoading(true);
    try {
      const body = await fetchRight(id);
      setRight(body);
      setClaimedHolder(body.effective_holder ?? "");
      return body;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRight(rightId);
    // Only on mount: afterwards the user drives it with the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The id path: read the right, fetch the attestation, check both. No paste, and
   * no claim about a seller — there is nobody to name when you are auditing the
   * registry rather than being sold something.
   */
  const verifyById = useCallback(async () => {
    setNotice(null);
    const loaded = await loadRight(rightId);
    if (!loaded) return;

    setLoading(true);
    try {
      const fetched = await fetchAttestation(rightId);
      setAttestationText(fetched ?? "");
      setChecks(
        await collectChecks({
          right: loaded,
          attestationText: fetched ?? "",
          recordText: "",
          claimedHolder: "",
          attestationAbsentDetail:
            "the issuer has signed no attestation for this right — nothing vouches that this week is free of unpaid fees",
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [collectChecks, loadRight, rightId]);

  /**
   * The JSON path: read the right, and offer the issuer's attestation if the box
   * is empty. An attestation already pasted is never overwritten — the file a
   * seller sent is the one the buyer meant to check.
   */
  const loadForPasting = useCallback(async () => {
    setNotice(null);
    const loaded = await loadRight(rightId);
    if (!loaded) return;
    if (attestationText.trim() !== "") return;

    const fetched = await fetchAttestation(rightId);
    if (fetched === null) {
      setNotice(
        "The issuer has signed no attestation for this right. If a seller sent you one, paste it below.",
      );
      return;
    }
    setAttestationText(fetched);
    setNotice(
      "Attestation loaded from the issuer and checked below in your browser, against the issuer address read from the contract. Replace it with the file a seller sent you if you would rather check that one.",
    );
  }, [attestationText, loadRight, rightId]);

  const verifyPasted = useCallback(async () => {
    setError(null);
    if (!right) {
      setError("load a usage right first");
      return;
    }
    setChecks(await collectChecks({ right, attestationText, recordText, claimedHolder }));
  }, [collectChecks, right, attestationText, recordText, claimedHolder]);

  const allOk = checks !== null && checks.every((check) => check.ok);
  // Which of the optional legs were actually taken — the summary says what the
  // reader has, rather than implying more than was checked.
  const checkedARecord = checks?.some((check) => check.id === "record") ?? false;
  const checkedAHolder = checks?.some((check) => check.id === "holder") ?? false;

  const switchTab = (next: Tab) => {
    setTab(next);
    setChecks(null);
    setNotice(null);
  };

  return (
    <>
      {/*
        "before you take it on" rather than "before you commit": this project uses
        "commitment" throughout for the on-chain hash, and reusing the word for
        "agree to a deal" a paragraph later reads as the same thing twice.
      */}
      <h1>Check a week before you take it on</h1>
      <p className="lede">
        Three questions get answered. <strong>Does the issuer vouch that this week is real and
        carries no unpaid fees?</strong> <strong>Is the person offering it actually the one holding
        it?</strong> <strong>And — if they showed you the document — is it really the one behind that
        week?</strong> No account needed: anyone can audit any week.
      </p>
      <p className="lede" style={{ marginTop: "-1rem" }}>
        Everything runs in your browser. The issuer&apos;s signature is verified here, against the
        issuer address read from the contract rather than from the file, so nothing rests on this
        site telling you the truth.
      </p>

      <div className="card">
        <div className="tabs" role="tablist" aria-label="How to verify">
          <button
            type="button"
            role="tab"
            id="tab-id"
            aria-selected={tab === "id"}
            aria-controls="panel-id"
            onClick={() => switchTab("id")}
          >
            Verify by id
          </button>
          <button
            type="button"
            role="tab"
            id="tab-json"
            aria-selected={tab === "json"}
            aria-controls="panel-json"
            onClick={() => switchTab("json")}
          >
            Verify JSON
          </button>
        </div>

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
          {tab === "id" ? (
            <button className="primary" onClick={() => void verifyById()} disabled={loading}>
              {loading ? "checking…" : "Verify"}
            </button>
          ) : (
            <button onClick={() => void loadForPasting()} disabled={loading}>
              {loading ? "reading…" : "Read from contract"}
            </button>
          )}
        </div>

        {tab === "id" ? (
          <p className="muted" style={{ margin: "0.5rem 0 0" }}>
            Reads the right from the contract and the issuer&apos;s attestation from the issuer, then
            checks them here. Use <strong>Verify JSON</strong> instead to check files a seller sent
            you, or to check the ownership record itself — that document has no endpoint, because
            only its holder may disclose it.
          </p>
        ) : null}

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
      {notice ? <div className="note">{notice}</div> : null}

      {tab === "json" ? (
        <div className="card" role="tabpanel" id="panel-json" aria-labelledby="tab-json">
          <div className="field">
            <label htmlFor="attestation">
              Issuer attestation (JSON) — <span style={{ color: "var(--accent)" }}>required</span>
            </label>
            <textarea
              id="attestation"
              style={{ minHeight: "11rem" }}
              value={attestationText}
              onChange={(event) => setAttestationText(event.target.value)}
              placeholder="Press “Read from contract” to load the issuer's, or paste the file a seller sent you."
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

          <button className="primary" onClick={() => void verifyPasted()} disabled={!right}>
            Verify
          </button>
        </div>
      ) : (
        <div role="tabpanel" id="panel-id" aria-labelledby="tab-id" hidden />
      )}

      {checks ? (
        <>
          <h2>Result</h2>
          <div className={`note ${allOk ? "accent" : "bad"}`}>
            {allOk ? (
              <>
                <strong>Every check passed.</strong> The issuer attests this week is valid and free
                of unpaid maintenance fees, and it is inside its use year.{" "}
                {checkedAHolder ? (
                  <>The account offering it is the holder the contract names. </>
                ) : (
                  <>
                    To also check that a particular seller is the holder, name their account on the{" "}
                    <strong>Verify JSON</strong> tab — the contract already says the holder is{" "}
                    <code>{shortAddress(right?.effective_holder ?? null)}</code>.{" "}
                  </>
                )}
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
            What was never needed to do any of this: the seller&apos;s identity in any registry, a
            document held by a third party, or a call to the resort. What the ledger gave up in
            exchange: a hash, two account addresses, and the dates of the week itself.
          </div>
        </>
      ) : null}
    </>
  );
}
