/**
 * What this deployment is configured as, for checking a deployment from
 * outside (Step 5, Stop 1: the second Vercel project).
 *
 *   GET /api/network → { network, signing, attestations, passphrase, rpc, horizon, usdc, ids, missing, fee_route, issuer_key_on_server }
 *
 * Every value here is public: the network, contract ids, the fee account's
 * address. No secret and nothing derived from one is returned. The two
 * booleans only say whether the deployment's mode lets the server use an
 * issuer or fee key.
 */

import {
  ATTESTATIONS,
  CONTRACT_ID,
  FEE_ACCOUNT,
  HORIZON_URL,
  NETWORK,
  NETWORK_PASSPHRASE,
  RPC_URL,
  SIGNING,
  USDC_CONTRACT_ID,
  WEB_AUTH_CONTRACT_ID,
  WEBAUTHN_VERIFIER_ID,
  hasFeeKey,
  hasIssuerSecret,
  missingConfiguration,
} from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({
    network: NETWORK,
    signing: SIGNING,
    attestations: ATTESTATIONS,
    passphrase: NETWORK_PASSPHRASE,
    rpc: RPC_URL,
    horizon: HORIZON_URL,
    usdc: USDC_CONTRACT_ID,
    ids: {
      rights: CONTRACT_ID,
      web_auth: WEB_AUTH_CONTRACT_ID,
      webauthn_verifier: WEBAUTHN_VERIFIER_ID,
      fee_account: FEE_ACCOUNT,
    },
    missing: missingConfiguration(),
    // The fee route runs wherever a fee key is set, mainnet too (D18).
    fee_route: hasFeeKey(),
    issuer_key_on_server: hasIssuerSecret(),
  });
}
