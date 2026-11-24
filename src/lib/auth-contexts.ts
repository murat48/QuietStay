import { xdr } from "@stellar/stellar-sdk";

/**
 * How many authorization contexts an entry gives: its root call and every
 * sub-invocation under it, depth first.
 *
 * The OZ smart account wants one context rule id per context, in that order,
 * or it refuses with #3014 (ContextRuleIdsLengthMismatch). A SEP-45 sign-in
 * has one context; an offer has two (the QuietStay call and the USDC
 * `approve` beneath it). Found on the testnet app, 2026-11-24: "Offer for
 * rent" from a passkey wallet was refused because the app always sent `[0]`.
 */
export function countAuthContexts(entry: xdr.SorobanAuthorizationEntry): number {
  const walk = (inv: xdr.SorobanAuthorizedInvocation): number =>
    1 + inv.subInvocations().reduce((n, sub) => n + walk(sub), 0);
  return walk(entry.rootInvocation());
}

/** One `ruleId` per context of `entry`. */
export function contextRuleIdsFor(entry: xdr.SorobanAuthorizationEntry, ruleId: number): number[] {
  return Array<number>(countAuthContexts(entry)).fill(ruleId);
}
