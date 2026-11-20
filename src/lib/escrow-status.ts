/**
 * What the app calls each escrow at a given moment (docs/PHASE3_SPEC.md §5).
 *
 * The contract decides with the ledger's time; this mirrors its two windows
 * for display: before `check_in + 24 h` the money is only funded (the renter
 * can still report a problem), from then on it is collectable.
 */

import type { Escrow } from "./contract";
import { formatDateTime } from "./format";

export const FIRST_NIGHT_SECS = 86_400;

export type Tone = "ok" | "warn" | "bad" | "";

export function escrowStatus(e: Pick<Escrow, "state" | "checkIn">, now: number): { label: string; tone: Tone } {
  switch (e.state) {
    case "Funded":
      return now >= e.checkIn + FIRST_NIGHT_SECS
        ? { label: "collectable", tone: "ok" }
        : { label: `funded · collectable from ${formatDateTime(e.checkIn + FIRST_NIGHT_SECS)}`, tone: "" };
    case "Disputed":
      return { label: "disputed", tone: "bad" };
    case "PaidOut":
      return { label: "paid out", tone: "ok" };
    case "Refunded":
      return { label: "refunded", tone: "warn" };
  }
}
