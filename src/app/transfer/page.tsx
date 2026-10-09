"use client";

/**
 * Screen 4 of 4 — **Transfer**.
 *
 * One primitive, two modes: a rental carries the week's end as its term, a sale
 * carries none. Under Phase 2 either one is authorized by an **ownership proof**
 * the contract verifies on chain, and by nobody's permission:
 *
 *   1. **Prove ownership.** The holder runs the command-line prover on their own
 *      machine — their record secret never leaves it — and gets `transfer.json`:
 *      the transfer's terms, the proof, and its public signals. This screen shows
 *      the exact command for each of the holder's weeks.
 *   2. **Upload it here.** The app checks it names the signed-in holder, and on a
 *      sale attaches the consent the buyer signed when asking for the week. It
 *      simulates the call, so the contract checks the proof now and a bad one is
 *      refused before anything is signed.
 *   3. **Sign.** The holder's wallet signs the envelope; it is submitted.
 *
 * Proving is not done in the browser: in-browser proving is out of scope for
 * Phase 2, and the secret belongs on the holder's machine.
 *
 * Who can use it is read from the registry. Only a title holder can prove — the
 * record secret is theirs — so a renter is shown why not, rather than a form
 * that would fail.
 */

import { useCallback, useMemo, useState } from "react";

import { RoleGate } from "@/components/RoleGate";
import { useWallet } from "@/components/WalletProvider";
import { explorer } from "@/lib/config";
import { describeError, formatDate, shortAddress } from "@/lib/format";
import { transferableRights } from "@/lib/roles";

interface Outcome {
  kind: "confirmed" | "rejected-on-chain";
  headline: string;
  detail?: string;
  hash?: string;
  explorer?: string;
}

/** What `transfer.json` says, as far as this screen needs to show it. */
interface TransferFile {
  transfer: {
    right_id: string;
    from: string;
    to: string;
    expires_at: string | null;
    expiry_ledger: string;
    next_secret_hash: string;
  };
  proof: { a: string; b: string; c: string };
  public_signals: Record<string, string>;
}

function parseFile(text: string): TransferFile {
  const parsed = JSON.parse(text) as TransferFile;
  if (!parsed?.transfer || !parsed.proof || !parsed.public_signals) {
    throw new Error("this is not the transfer.json that `npm run zk:prove` writes");
  }
  return parsed;
}

export default function TransferScreen() {
  return (
    <>
      <h1>Rent out or sell a week</h1>
      <p className="lede">
        You prove you own the week, and the contract checks that proof on chain. Nobody approves
        it — not the issuer, not this site — and nothing about you or the week&apos;s record is
        revealed by the proof.
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
  const owned = options.filter((o) => o.maySell);
  const rented = options.filter((o) => !o.maySell);

  const [fileText, setFileText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    if (fileText.trim() === "") return null;
    try {
      return { file: parseFile(fileText), problem: null as string | null };
    } catch (caught) {
      return { file: null, problem: describeError(caught) };
    }
  }, [fileText]);

  const file = parsed?.file ?? null;
  const isSale = file ? file.transfer.expires_at === null : false;
  const notYours = file !== null && address !== null && file.transfer.from !== address;

  const readUpload = useCallback(async (input: HTMLInputElement) => {
    const chosen = input.files?.[0];
    if (!chosen) return;
    setOutcome(null);
    setError(null);
    setFileText(await chosen.text());
  }, []);

  /** Build with the proof (and the buyer's consent on a sale), sign, submit. */
  const submit = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const built = await authFetch("/api/tx/proven-transfer", {
        method: "POST",
        body: JSON.stringify({ transfer: file }),
      });
      const builtBody = (await built.json()) as {
        xdr?: string;
        error?: string;
        request_id?: string;
      };
      if (!built.ok || !builtBody.xdr) throw new Error(builtBody.error ?? "could not build the transfer");

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
        error?: string;
      };
      if (!sent.ok) throw new Error(result.error ?? "submission failed");

      if (result.successful && builtBody.request_id) {
        // The buyer's or renter's ask is now answered; record it against the chain.
        await authFetch(`/api/requests/${builtBody.request_id}`, {
          method: "POST",
          body: JSON.stringify({ right_id: Number(file.transfer.right_id), action: "accepted", tx: result.hash }),
        });
      }

      const expiresAt = file.transfer.expires_at === null ? null : Number(file.transfer.expires_at);
      setOutcome(
        result.successful
          ? {
              kind: "confirmed",
              headline:
                expiresAt === null
                  ? `Sold. Right #${file.transfer.right_id} now belongs to ${shortAddress(file.transfer.to)}, and only they can prove it next.`
                  : `Rented out until ${formatDate(expiresAt)}. Title stays with you and the week comes back on its own.`,
              detail: "The contract verified your ownership proof on chain before accepting this.",
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
      await refreshStanding();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [file, authFetch, sign, refreshStanding]);

  return (
    <>
      {standing && standing.rentedOut.length > 0 ? (
        <div className="note">
          {standing.rentedOut.length} week{standing.rentedOut.length === 1 ? "" : "s"} you own{" "}
          {standing.rentedOut.length === 1 ? "is" : "are"} out on rental. Until the term lapses the
          renter is the holder — the week returns to you with no transaction to send.
        </div>
      ) : null}

      {rented.length > 0 ? (
        <div className="note warn">
          You are renting{" "}
          {rented.map((o) => `#${o.right.id}`).join(", ")} until{" "}
          {formatDate(rented[0]!.maxTermEnds)}. It is yours to use, not to pass on: transferring a
          week takes the record secret, which only the owner holds.
        </div>
      ) : null}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>1 · Prove ownership</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          On your own machine, with your week&apos;s record and the secret file you made when it
          was issued. The secret never leaves that machine; what comes out is{" "}
          <code>proofs/…/transfer.json</code>. A proof is good for one transfer, for about an hour.
        </p>
        {owned.length === 0 ? (
          <p className="muted">You hold title to no week at the moment, so there is nothing to prove.</p>
        ) : (
          owned.map((o) => (
            <div key={o.right.id} style={{ marginBottom: "0.9rem" }}>
              <strong>
                #{o.right.id} — {formatDate(o.right.week.start)} → {formatDate(o.right.week.end)}
              </strong>
              <pre>{`# rent it out for the week:
npm run zk:prove -- --record <your record>.json --secret <your secret>.json \\
  --right ${o.right.id} --from ${address} --to <renter G…> \\
  --rental-until ${Math.min(o.right.week.end, o.maxTermEnds)} --out proofs/right-${o.right.id}

# or sell it — with the h' the buyer gave when asking:
npm run zk:prove -- --record <your record>.json --secret <your secret>.json \\
  --right ${o.right.id} --from ${address} --to <buyer G…> \\
  --sale --next-secret-hash <buyer's h'> --out proofs/right-${o.right.id}`}</pre>
            </div>
          ))
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          A buyer&apos;s or renter&apos;s ask on the List screen shows the command with their account
          and h&apos; already filled in.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>2 · Upload the proof</h2>
        <div className="field">
          <label htmlFor="proof-file">transfer.json</label>
          <input id="proof-file" type="file" accept="application/json,.json" onChange={(e) => void readUpload(e.currentTarget)} />
        </div>
        <div className="field">
          <label htmlFor="proof-text">…or paste it</label>
          <textarea
            id="proof-text"
            style={{ minHeight: "6rem" }}
            value={fileText}
            onChange={(e) => {
              setOutcome(null);
              setError(null);
              setFileText(e.target.value);
            }}
            spellCheck={false}
            placeholder='{ "transfer": { … }, "proof": { … }, "public_signals": { … } }'
          />
        </div>

        {parsed?.problem ? <div className="note bad">{parsed.problem}</div> : null}

        {file ? (
          <dl className="facts">
            <dt>Week</dt>
            <dd>#{file.transfer.right_id}</dd>
            <dt>What</dt>
            <dd>
              {isSale
                ? "A sale — title moves, and the buyer's new commitment replaces yours"
                : `A rental until ${formatDate(Number(file.transfer.expires_at))} — title stays with you`}
            </dd>
            <dt>To</dt>
            <dd className="hash">{file.transfer.to}</dd>
            <dt>From</dt>
            <dd className="hash">{file.transfer.from}</dd>
            <dt>Proof valid through</dt>
            <dd>ledger {file.transfer.expiry_ledger}</dd>
          </dl>
        ) : null}

        {notYours ? (
          <div className="note bad">
            This proof is for a transfer from {shortAddress(file!.transfer.from)}, and you are signed in as{" "}
            {shortAddress(address)}. Only the holder it names can submit it.
          </div>
        ) : null}
        {file && isSale && !notYours ? (
          <p className="muted">
            A sale also needs the buyer&apos;s consent, which they signed when they asked for the week.
            It is attached automatically; if the buyer has not asked, the build will say so.
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>3 · Sign and submit</h2>
        <button className="primary" onClick={() => void submit()} disabled={busy || !file || notYours}>
          {busy ? "working…" : isSale ? "Sell with my wallet" : "Rent out with my wallet"}
        </button>
        <p className="muted" style={{ marginTop: "0.6rem", marginBottom: 0 }}>
          Your wallet signs the transaction; nobody else&apos;s signature is involved except, on a sale,
          the buyer&apos;s consent. The contract verifies the proof before anything moves.
        </p>
      </div>

      {error ? <div className="note bad">{error}</div> : null}

      {outcome ? (
        <>
          <h2>Outcome</h2>
          <div className={`note ${outcome.kind === "confirmed" ? "accent" : "bad"}`}>
            <strong>{outcome.headline}</strong>
            {outcome.detail ? (
              <pre style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{outcome.detail}</pre>
            ) : null}
            {outcome.hash ? (
              <p style={{ marginBottom: 0, marginTop: "0.6rem" }}>
                <a href={outcome.explorer ?? explorer.tx(outcome.hash)} target="_blank" rel="noreferrer">
                  Open {outcome.hash.slice(0, 12)}… in stellar.expert
                </a>
              </p>
            ) : null}
          </div>
          <div className="note">
            Open that transaction and look at what it shows: two account addresses, a right id, an
            opaque commitment, and a proof with its public signals. No name, no document, no resort,
            and no secret.
          </div>
        </>
      ) : null}
    </>
  );
}
