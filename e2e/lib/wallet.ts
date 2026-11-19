/**
 * A wallet for one browser context, whose signing runs here in the test
 * process (src/lib/wallet-kit.ts, `NEXT_PUBLIC_QS_E2E_WALLET`).
 *
 * The page calls three exposed functions. No key is ever given to the page.
 * The calls are not network requests, so they do not appear in the request
 * log, and they carry only what a wallet extension would receive: an envelope
 * or a preimage to sign.
 */

import { hash, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { BrowserContext } from "@playwright/test";

export async function attachWallet(context: BrowserContext, kp: Keypair): Promise<void> {
  await context.exposeFunction("__qsw_address", () => kp.publicKey());
  await context.exposeFunction("__qsw_signTx", (xdr: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    tx.sign(kp);
    return tx.toXDR();
  });
  await context.exposeFunction("__qsw_signAuth", (preimage: string) =>
    kp.sign(hash(Buffer.from(preimage, "base64"))).toString("base64"),
  );
  await context.addInitScript({
    content: `
      globalThis.__name = (f) => f;
      window.__qsTestWallet = {
        address: () => window.__qsw_address(),
        signTransaction: (x) => window.__qsw_signTx(x),
        signAuthEntry: (p) => window.__qsw_signAuth(p),
      };`,
  });
}
