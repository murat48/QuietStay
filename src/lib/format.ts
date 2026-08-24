/** Display helpers shared by the screens. */

export function formatDate(unix: number | null | undefined): string {
  if (unix === null || unix === undefined) return "—";
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

export function formatDateTime(unix: number | null | undefined): string {
  if (unix === null || unix === undefined) return "—";
  return `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return "—";
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export function formatDays(seconds: number): string {
  const days = seconds / 86_400;
  if (Number.isInteger(days)) return `${days} day${days === 1 ? "" : "s"}`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

/** How a right's current holding reads to a person. */
export function describeHolding(params: {
  titleHolder: string | null;
  effectiveHolder: string | null;
  termEnds: number | null;
}): string {
  if (!params.effectiveHolder) return "unknown";
  if (params.termEnds === null) return "held outright";
  return `rented out until ${formatDate(params.termEnds)}`;
}

/**
 * A thrown value, as a sentence somebody can act on.
 *
 * `String(caught)` is the obvious thing and it is wrong: a wallet extension that
 * rejects with `{ message: "User declined" }` — or with a bare `{}` — renders as
 * `[object Object]`, which tells the reader nothing and looks like a crash. Not
 * everything thrown in a browser is an `Error`, and the things that are not tend
 * to come from exactly the code paths a user is most likely to hit: a rejected
 * signature, a locked wallet, a closed popup.
 *
 * So this looks for the message wherever it plausibly is, and when there is
 * genuinely nothing to say, says that instead of leaking a type name.
 */
export function describeError(caught: unknown): string {
  if (caught instanceof Error && caught.message) return caught.message;
  if (typeof caught === "string" && caught.trim()) return caught;

  if (typeof caught === "object" && caught !== null) {
    const bag = caught as Record<string, unknown>;
    // Wallet kits and fetch wrappers each pick a different one of these.
    for (const key of ["message", "error", "detail", "reason", "description"]) {
      const value = bag[key];
      if (typeof value === "string" && value.trim()) return value;
      // One level down: `{ error: { message } }` is common enough to unwrap.
      if (typeof value === "object" && value !== null) {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === "string" && nested.trim()) return nested;
      }
    }
    // A code with no message is still more use than "[object Object]".
    const code = bag.code ?? bag.status;
    if (typeof code === "string" || typeof code === "number") {
      return `the wallet or network refused this (${code})`;
    }
  }

  return "something went wrong, and whatever threw it gave no reason";
}
