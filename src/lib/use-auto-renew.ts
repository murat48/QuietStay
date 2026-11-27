"use client";

/**
 * Automatic renewals carry on by themselves (2026-11-27).
 *
 * When a week issued from an automatic renewal is in this browser (its record
 * picked up and checked), the next year's renewal is filed for it, so the
 * chain continues each year with only the issuer's approval. It runs where
 * the owner's browser picks records up and shows their weeks (/stays, /list);
 * the new ask waits, hidden from the issuer, until the new week has ended.
 */

import { useEffect } from "react";

import { useWallet } from "@/components/WalletProvider";
import { fileRenewal } from "./issuance-ask";
import { renewalDetails } from "./issuer-key";
import { getRecord } from "./vault";

interface OwnAsk {
  status: string;
  right_id?: number;
  renew_of?: number;
  auto_renew?: boolean;
}

export function useAutoRenewals(): void {
  const { address, authenticated, kind, authFetch } = useWallet();
  useEffect(() => {
    if (!authenticated || !address || kind === "cli") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/requests/issuance");
        if (!res.ok) return;
        const { requests = [] } = (await res.json()) as { requests?: OwnAsk[] };
        for (const r of requests) {
          if (cancelled) return;
          if (r.status !== "issued" || !r.auto_renew || r.right_id === undefined) continue;
          const next = r.right_id;
          // Filed once per week, whatever became of it (a declined renewal is not refiled).
          if (requests.some((x) => x.renew_of === next)) continue;
          const rec = await getRecord(next);
          if (!rec) continue;
          await fileRenewal({ address, rightId: next, details: renewalDetails(rec.record), auto: true, authFetch }).catch(() => undefined);
        }
      } catch {
        // Tried again on the next visit.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, authenticated, kind, authFetch]);
}
