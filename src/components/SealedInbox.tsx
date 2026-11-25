"use client";

/**
 * The issuance inbox, the owner's side (D3 as amended 2026-11-25,
 * docs/PHASE3_SPEC.md §2).
 *
 * When an account is signed in (on sign-in, on each page and when the tab
 * comes back into view), this reads its own issuance asks. For each one
 * whose week was issued and whose record the issuer's browser left sealed
 * with it, and whose sealing key this browser holds, it opens the record,
 * checks it against the chain (src/lib/sealed-import.ts), keeps it, and asks
 * the server to drop the sealed copy. From then on this browser can prove
 * for the week: the owner never handles a link.
 *
 * An ask whose key is in another browser is left alone, for that browser.
 * Nothing is sent but the ask id: the record, the secret and `d` stay here.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { useWallet } from "@/components/WalletProvider";
import { describeError, formatDate } from "@/lib/format";
import type { IssuanceRequest } from "@/lib/requests";
import { NotForThisBrowser, importSealed } from "@/lib/sealed-import";
import { sealKey } from "@/lib/vault";

interface Arrived {
  rightId: number;
  week: { start: number; end: number };
}

export function SealedInbox() {
  const { address, authenticated, authFetch } = useWallet();
  const [arrived, setArrived] = useState<Arrived[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const pathname = usePathname();
  // One pass at a time, even if React mounts this twice.
  const running = useRef(false);

  const check = useCallback(async () => {
    if (!authenticated || !address || running.current) return;
    running.current = true;
    try {
      const res = await authFetch("/api/requests/issuance");
      if (!res.ok) return;
      const body = (await res.json()) as { requests?: IssuanceRequest[] };
      const waiting = (body.requests ?? []).filter((r) => r.by === address && r.sealed_record && r.key_hash);
      const got: Arrived[] = [];
      for (const r of waiting) {
        if (!(await sealKey(r.key_hash!))) continue; // sealed to another browser of this account
        try {
          const imported = await importSealed(r.sealed_record!.blob);
          got.push({ rightId: imported.rightId, week: imported.week });
          await authFetch(`/api/requests/issuance/delivery?id=${encodeURIComponent(r.id)}`, { method: "DELETE" });
        } catch (e) {
          if (!(e instanceof NotForThisBrowser)) setProblem(`A week's record arrived but could not be kept: ${describeError(e)}`);
        }
      }
      if (got.length) setArrived((current) => [...current, ...got.filter((g) => !current.some((c) => c.rightId === g.rightId))]);
    } catch {
      // The inbox is a convenience; the page works without it.
    } finally {
      running.current = false;
    }
  }, [address, authenticated, authFetch]);

  // On sign-in, on every page, and whenever the tab comes back into view: the
  // issuer may issue while the owner is already signed in.
  useEffect(() => {
    void Promise.resolve().then(check);
  }, [check, pathname]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [check]);

  if (!arrived.length && !problem) return null;
  return (
    <div style={{ marginBottom: "1rem" }}>
      {arrived.map((a) => (
        <div className="note accent" key={a.rightId} data-testid="inbox-received">
          <strong>Week #{a.rightId} is ready in this browser</strong> ({formatDate(a.week.start)} →{" "}
          {formatDate(a.week.end)}). Its record arrived sealed from the issuer and matches the chain,
          so you can now <Link href="/list">rent it out or sell it</Link>.
        </div>
      ))}
      {problem ? <div className="note bad">{problem}</div> : null}
    </div>
  );
}
