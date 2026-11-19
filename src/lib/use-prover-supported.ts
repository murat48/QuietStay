"use client";

import { useSyncExternalStore } from "react";

import { proverSupported } from "./prover-client";

/**
 * `proverSupported()` for render code: `null` until mounted, so the server's
 * HTML (where there is no Worker) and the browser's first render agree.
 * Kept apart from prover-client.ts, which server components also import.
 */
export function useProverSupported(): boolean | null {
  return useSyncExternalStore(
    () => () => {},
    () => proverSupported(),
    () => null,
  );
}
