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
