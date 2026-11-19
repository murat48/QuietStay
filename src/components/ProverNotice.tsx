import { PROVER_LICENSE_NOTICE, PROVER_LICENSE_URL, PROVER_SOURCE_URL } from "@/lib/prover-client";

/**
 * The in-app license notice for the GPL-3.0 prover worker (decision D2). Shown
 * in the footer and on every screen that proves. `npm run zk:check-bundle`
 * checks the text is in the build.
 */
export function ProverNotice({ compact = false }: { compact?: boolean }) {
  return (
    <p className={compact ? "muted prover-notice" : "footer-disclosure prover-notice"} data-testid="prover-notice">
      {PROVER_LICENSE_NOTICE}{" "}
      <a href={PROVER_LICENSE_URL} target="_blank" rel="noreferrer">
        License
      </a>{" "}
      ·{" "}
      <a href={PROVER_SOURCE_URL} target="_blank" rel="noreferrer">
        Source ↗
      </a>
    </p>
  );
}
