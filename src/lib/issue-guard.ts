/**
 * Who a week may never be issued to (Step 5, found on the rehearsal app on
 * 2026-11-24).
 *
 * Right #3 on `CC7W4OGP…` was issued to the fee account, `GCGDZWCL…`, typed
 * into the form's Owner field by hand. From then on, the fee route refused to
 * run on that contract ("the fee account holds a right"), so no passkey
 * wallet could act. That refusal is correct, but the issuance should never
 * have happened. Nothing could undo it: a right cannot be taken back.
 *
 * Three accounts have one job each and must never hold a right:
 * - the fee account: it pays passkey fees, and must not be able to authorize
 *   anything else;
 * - the issuer: it issues, and its rights would be indistinguishable from
 *   the registry's own;
 * - the sign-in key: it signs SEP-10/SEP-45 challenges.
 */

export interface ReservedAccounts {
  feeAccount?: string | null;
  issuer?: string | null;
  signIn?: string | null;
}

/** Why `owner` may not hold a week, or `null` if it may. */
export function reservedOwnerReason(owner: string, reserved: ReservedAccounts): string | null {
  const o = owner.trim();
  if (!o) return null;
  if (reserved.feeAccount && o === reserved.feeAccount) {
    return `${o} is the fee account, which pays passkey fees and must never hold a week. Enter the owner's own account, or pick their request from the list.`;
  }
  if (reserved.issuer && o === reserved.issuer) {
    return `${o} is the issuer. The issuer issues weeks and must not hold one. Enter the owner's own account.`;
  }
  if (reserved.signIn && o === reserved.signIn) {
    return `${o} is this deployment's sign-in key, which must not hold a week. Enter the owner's own account.`;
  }
  return null;
}

/**
 * Why `asker` may not ask for a week, or `null` if it may: the same three
 * accounts, told to the person asking, at the moment they ask (found on the
 * testnet demo, 2026-11-26: the fee account, imported into Freighter, asked,
 * and only the issuer was told, at issue time).
 */
export function reservedAskerReason(asker: string, reserved: ReservedAccounts): string | null {
  const which = reservedOwnerReason(asker, reserved);
  if (!which) return null;
  const role =
    reserved.feeAccount && asker.trim() === reserved.feeAccount
      ? "QuietStay's fee account, which pays passkey fees"
      : reserved.issuer && asker.trim() === reserved.issuer
        ? "the issuer"
        : "this deployment's sign-in key";
  return (
    `The account you are signed in with is ${role}, and it can never hold a week. ` +
    "Nothing was asked. In your wallet, switch to (or create) an account of your own, sign in with it, and ask again."
  );
}
