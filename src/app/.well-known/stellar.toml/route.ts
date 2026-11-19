/**
 * SEP-1 stellar.toml: what a wallet needs to sign in (SEP-10 for G… accounts,
 * SEP-45 for C… smart wallets) and the contracts this deployment uses.
 */

import { CONTRACT_ID, HOME_DOMAIN, NETWORK_PASSPHRASE, WEB_AUTH_CONTRACT_ID } from "@/lib/config";
import { serverAccount } from "@/lib/sep10";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const scheme = HOME_DOMAIN.startsWith("localhost") ? "http" : "https";
  let signingKey = "";
  try {
    signingKey = serverAccount();
  } catch {
    // Not configured: the file still says what it can.
  }
  const lines = [
    `NETWORK_PASSPHRASE = "${NETWORK_PASSPHRASE}"`,
    `WEB_AUTH_ENDPOINT = "${scheme}://${HOME_DOMAIN}/api/auth"`,
    `WEB_AUTH_FOR_CONTRACTS_ENDPOINT = "${scheme}://${HOME_DOMAIN}/api/auth/contract"`,
    `WEB_AUTH_CONTRACT_ID = "${WEB_AUTH_CONTRACT_ID}"`,
    ...(signingKey ? [`SIGNING_KEY = "${signingKey}"`] : []),
    "",
    "[[CURRENCIES]]",
    `code = "QSTAY"`,
    `issuer = "${CONTRACT_ID}"`,
    `desc = "QuietStay usage rights (testnet pilot; non-fungible, decimals 0)"`,
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
}
