"use client";

/**
 * The receive page: both ends of a sealed link (docs/PHASE3_SPEC.md §2, D3/D4).
 *
 * - A **request link** (`#req=…`) is opened by whoever holds the record: the
 *   issuer, for a week it just issued from an owner's ask, or the holder, for a
 *   buyer's ask. This browser reads the ask from the deployment, refuses unless
 *   the link's key hashes to the `key_hash` recorded with it, shows who asked,
 *   and only then seals `{record, h, holder, right, contract, ask}` to that key.
 *   For a paid sale (Phase 3, D4a, kind `offer`) the ask is the buyer's
 *   on-chain `RecordRequest`, so the key hash checked is the one bound on chain
 *   to the buyer's account.
 * - A **reply link** (`#rec=…`) is opened by the asker. This browser opens it
 *   with the private key it kept, computes `C = Poseidon(d, holder, h)` in the
 *   prover worker, and keeps the record only if `C` is the commitment on chain
 *   now.
 *
 * The fragment is read and removed from the address bar before anything else
 * runs. Browsers never send it in a request, and this page sends no part of
 * it: the only requests carry the ask id and the right id.
 */

import { useCallback, useEffect, useState } from "react";

import { useWallet } from "@/components/WalletProvider";
import type { JsonValue } from "@/lib/canonical";
import { CONTRACT_ID } from "@/lib/config";
import { describeError, formatDate, shortAddress } from "@/lib/format";
import { prover } from "@/lib/prover-client";
import { useProverSupported } from "@/lib/use-prover-supported";
import {
  open,
  parseFragment,
  replyLink,
  seal,
  sha256Hex,
  type Fragment,
  type SealedRecord,
} from "@/lib/sealed";
import { allSealKeys, getIssued, putHolding, putRecord, resolveHolding, secretFor } from "@/lib/vault";

interface ChainRight {
  id: number;
  commitment: string;
  title_holder: string | null;
  week: { start: number; end: number };
}

async function chainRight(rightId: number): Promise<ChainRight> {
  const res = await fetch(`/api/right/${rightId}`);
  const body = (await res.json()) as ChainRight & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `could not read right #${rightId}`);
  return body;
}

/**
 * The fragment as first read. Kept at module scope so that a re-mount (React
 * may discard a tree and render it again) still has it after the address bar
 * was cleared.
 */
let takenHash: string | null = null;

export default function ReceivePage() {
  const [fragment, setFragment] = useState<Fragment | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const supported = useProverSupported();

  // First thing: take the fragment and clear it from the address bar. The
  // state is set after that, outside the effect's synchronous body.
  useEffect(() => {
    if (takenHash === null || window.location.hash !== "") takenHash = window.location.hash;
    const hash = takenHash;
    history.replaceState(null, "", window.location.pathname);
    void Promise.resolve().then(() => {
      try {
        setFragment(parseFragment(hash));
      } catch (e) {
        setProblem(describeError(e));
        setFragment(null);
      }
    });
  }, []);

  return (
    <>
      <p className="eyebrow">SEALED RECORD</p>
      <h1>Pass a private record, browser to browser</h1>
      <p className="lede">
        The record behind a week never touches a server. It travels sealed to one browser&apos;s
        key, inside the part of a link that browsers never send.
      </p>
      {supported === false ? (
        <div className="note bad">
          This browser cannot run the in-browser prover (it needs Web Workers, WebCrypto and
          IndexedDB). Use a current desktop Chrome or Firefox.
        </div>
      ) : null}
      {problem ? <div className="note bad">{problem}</div> : null}
      {fragment === undefined ? <p className="muted">Reading the link…</p> : null}
      {fragment === null && !problem ? (
        <div className="note">
          Open this page from a request link or a reply link. Nothing was in the address.
        </div>
      ) : null}
      {fragment?.type === "request" ? <SealSide link={fragment} /> : null}
      {fragment?.type === "reply" ? <OpenSide blob={fragment.blob} /> : null}
    </>
  );
}

// --- the holder or issuer: seal the record to the asker ------------------------

interface Ask {
  id: string;
  by: string;
  key_hash?: string;
  status: string;
  right_id?: number;
  to_holder?: string;
  secret_hash?: string;
}

function SealSide({ link }: { link: Extract<Fragment, { type: "request" }> }) {
  const { address, authenticated, authFetch } = useWallet();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [linkKeyHash, setLinkKeyHash] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void sha256Hex(link.publicRaw).then(setLinkKeyHash);
  }, [link]);

  useEffect(() => {
    if (!authenticated) return;
    void (async () => {
      try {
        if (link.kind === "issue") {
          const res = await authFetch(`/api/requests/issuance?id=${encodeURIComponent(link.askId)}`);
          const body = (await res.json()) as { request?: Ask; error?: string };
          if (!res.ok || !body.request) throw new Error(body.error ?? "no such issuance request");
          setAsk(body.request);
        } else if (link.kind === "offer") {
          const res = await fetch(`/api/record-request/${encodeURIComponent(link.askId)}`);
          const body = (await res.json()) as {
            id?: number;
            requester?: string;
            rightId?: number;
            keyHash?: string;
            live?: boolean;
            error?: string;
          };
          if (!res.ok || body.id === undefined) throw new Error(body.error ?? "no such record request on chain");
          setAsk({
            id: String(body.id),
            by: body.requester!,
            key_hash: body.keyHash,
            status: body.live ? "open" : "expired",
            right_id: body.rightId,
          });
        } else {
          const res = await authFetch("/api/requests");
          const body = (await res.json()) as { incoming?: Ask[] };
          const found = body.incoming?.find((r) => r.id === link.askId);
          if (!found) throw new Error("no ask with this id is addressed to the account signed in");
          setAsk(found);
        }
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [authenticated, authFetch, link]);

  const keyMatches = ask?.key_hash !== undefined && linkKeyHash === ask.key_hash;

  const doSeal = useCallback(async () => {
    if (!ask || !address) return;
    setBusy(true);
    setError(null);
    try {
      let payload: SealedRecord;
      if (link.kind === "issue") {
        if (ask.status !== "issued" || !ask.right_id) throw new Error("this ask has not been issued yet");
        const issued = await getIssued(ask.right_id);
        if (!issued) {
          throw new Error(
            `this browser has no copy of week #${ask.right_id}'s record. Seal it from the browser it was issued in.`,
          );
        }
        payload = {
          v: 1,
          record: issued.record,
          h: issued.h,
          holder: issued.owner,
          right_id: ask.right_id,
          contract: CONTRACT_ID,
          request: { kind: "issue", id: ask.id },
        };
      } else {
        if (ask.status !== "open" || !ask.right_id) throw new Error(`this ask is ${ask.status}`);
        const right = await chainRight(ask.right_id);
        if (right.title_holder !== address) throw new Error("you do not hold title to this week");
        const holding = await resolveHolding(ask.right_id, address, BigInt("0x" + right.commitment));
        if (!holding) throw new Error("this browser holds no record for this week that matches the chain");
        payload = {
          v: 1,
          record: holding.record,
          h: holding.h,
          holder: address,
          right_id: ask.right_id,
          contract: CONTRACT_ID,
          request: { kind: link.kind, id: ask.id },
        };
      }
      const blob = await seal(link.publicRaw, ask.key_hash!, payload);
      setReply(replyLink(window.location.origin, blob));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [ask, address, link]);

  if (!authenticated) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Someone asked for a record</h2>
        <p className="muted">
          Connect and sign in with the account that holds it — the issuer for a new week, or the
          week&apos;s holder for an ask to buy. The button is at the top of the page.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{link.kind === "issue" ? "Send a new week's record to its owner" : "Send your week's record to a buyer"}</h2>
      {link.kind === "offer" ? (
        <p className="muted">
          This buyer asked on chain, binding their key to their account. Sending the record obliges
          you to nothing: you can still sell to someone else, rent out, or ignore the request.
        </p>
      ) : null}
      {ask ? (
        <dl className="facts">
          <dt>Asked by</dt>
          <dd className="hash">{ask.by}</dd>
          <dt>Week</dt>
          <dd>{ask.right_id ? `#${ask.right_id}` : "not issued yet"}</dd>
          <dt>{link.kind === "offer" ? "Key check (on chain)" : "Key check"}</dt>
          <dd>
            {ask.key_hash === undefined
              ? "this ask carries no key: it was made before sealed links"
              : keyMatches
                ? "the link's key is the one recorded with the ask ✓"
                : "the link's key is NOT the one recorded with the ask"}
          </dd>
        </dl>
      ) : (
        <p className="muted">Reading the ask…</p>
      )}
      {ask && !keyMatches ? (
        <div className="note bad">Refusing to seal: this link was not made by the browser that asked.</div>
      ) : null}
      {ask && keyMatches && !reply ? (
        <>
          <p>
            Seal the record to <strong>{shortAddress(ask.by)}</strong>? Only the browser that made this
            link can open what you send.
          </p>
          <button className="primary" onClick={() => void doSeal()} disabled={busy}>
            {busy ? "sealing…" : "Seal the record"}
          </button>
        </>
      ) : null}
      {reply ? (
        <>
          <p>
            Send this link back to {shortAddress(ask?.by ?? null)} through the channel you already use.
            It is useless to anyone else.
          </p>
          <textarea readOnly value={reply} style={{ minHeight: "6rem" }} data-testid="reply-link" />
          <button onClick={() => void navigator.clipboard.writeText(reply)}>Copy</button>
        </>
      ) : null}
      {error ? <div className="note bad">{error}</div> : null}
    </div>
  );
}

// --- the asker: open and check --------------------------------------------------

function OpenSide({ blob }: { blob: string }) {
  const [state, setState] = useState<
    | { kind: "working" }
    | { kind: "ok"; rightId: number; week: { start: number; end: number }; owner: boolean; record: JsonValue }
    | { kind: "bad"; message: string }
  >({ kind: "working" });

  useEffect(() => {
    void (async () => {
      try {
        let payload: SealedRecord | null = null;
        for (const key of await allSealKeys()) {
          try {
            payload = (await open(key.privateKey, key.keyHash, blob)) as SealedRecord;
            break;
          } catch {
            // not sealed to this key; try the next
          }
        }
        if (!payload) throw new Error("this browser holds no key that opens this link. Open it in the browser that asked.");
        if (payload.v !== 1 || payload.contract !== CONTRACT_ID) {
          throw new Error("this record is for a different QuietStay deployment");
        }
        const right = await chainRight(payload.right_id);
        if (right.title_holder !== payload.holder) {
          throw new Error(`the chain says week #${payload.right_id} is held by ${shortAddress(right.title_holder)}, not by the sender`);
        }
        const { commitment } = await prover.commitment(payload.record as JsonValue, payload.holder, BigInt(payload.h));
        if (commitment !== BigInt("0x" + right.commitment)) {
          throw new Error("this record does not match the commitment on chain. It is not the record behind this week; nothing was kept.");
        }
        await putRecord({
          right_id: payload.right_id,
          record: payload.record as JsonValue,
          holder: payload.holder,
          h: payload.h,
          commitment: right.commitment,
        });
        // The first owner already holds the secret behind h: this browser can prove now.
        const own = (await secretFor(BigInt(payload.h))) !== null;
        if (own) {
          await putHolding({ right_id: payload.right_id, record: payload.record as JsonValue, holder: payload.holder, h: payload.h });
        }
        setState({ kind: "ok", rightId: payload.right_id, week: right.week, owner: own, record: payload.record as JsonValue });
      } catch (e) {
        setState({ kind: "bad", message: describeError(e) });
      }
    })();
  }, [blob]);

  if (state.kind === "working") return <p className="muted">Opening and checking against the chain…</p>;
  if (state.kind === "bad") return <div className="note bad">{state.message}</div>;
  return (
    <div className="card" data-testid="record-received">
      <h2 style={{ marginTop: 0 }}>Record received and checked</h2>
      <p>
        Week #{state.rightId}, {formatDate(state.week.start)} → {formatDate(state.week.end)}. Its record
        reproduces the commitment on chain, so this is the record behind the week.
      </p>
      <p className="muted">
        {state.owner
          ? "You hold the secret for this week in this browser: you can rent it out or sell it from the Transfer screen."
          : "Kept in this browser. Once the sale lands, this browser can prove for the week with the secret it makes for your offer."}
      </p>
      {!state.owner ? (
        <p>
          <a className="button primary" href={`/stays?right=${state.rightId}&kind=buy`} data-testid="make-offer-link">
            Make a paid offer for week #{state.rightId}
          </a>
        </p>
      ) : null}
      <details>
        <summary>The record</summary>
        <pre>{JSON.stringify(state.record, null, 2)}</pre>
      </details>
    </div>
  );
}
