/**
 * Whether this browser can approve with a passkey through a smart wallet
 * (docs/PHASE3_SPEC.md §12, supported browser target).
 *
 * Phase 3 supports one target: a current desktop browser with a platform
 * passkey (Chrome with Google Password Manager, or Windows Hello). The check
 * is the one the spec names: `PublicKeyCredential` exists and
 * `isUserVerifyingPlatformAuthenticatorAvailable()` says yes. Anything else
 * gets a plain message pointing to the regular wallet, which works
 * everywhere the app does.
 */

export const PASSKEY_FALLBACK =
  "Passkeys are not available in this browser. Use a regular Stellar wallet instead — Freighter, xBull, " +
  "Albedo, Rabet or Hana — from the Connect wallet button. Passkeys work in current desktop Chrome with a " +
  "platform passkey (Google Password Manager, or Windows Hello on Windows).";

export async function passkeySupport(): Promise<{ supported: true } | { supported: false; reason: string }> {
  if (typeof window === "undefined") return { supported: false, reason: "not in a browser" };
  const pkc = (window as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } })
    .PublicKeyCredential;
  if (!pkc) return { supported: false, reason: "this browser has no WebAuthn (PublicKeyCredential)" };
  if (typeof pkc.isUserVerifyingPlatformAuthenticatorAvailable !== "function") {
    return { supported: false, reason: "this browser cannot report a platform authenticator" };
  }
  try {
    if (!(await pkc.isUserVerifyingPlatformAuthenticatorAvailable())) {
      return { supported: false, reason: "this device has no platform passkey (fingerprint, face or device PIN)" };
    }
  } catch {
    return { supported: false, reason: "this browser refused to report a platform authenticator" };
  }
  return { supported: true };
}
