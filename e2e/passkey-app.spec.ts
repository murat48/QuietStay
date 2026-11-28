/**
 * The passkey screens, through the app itself (Phase 3; rewritten 2026-11-28
 * for the app as it is now: USDC offers and escrow on /stays, the record
 * delivered to the owner's browser, the Wallet screen, D18's fee route).
 *
 *   npx playwright test e2e/passkey-app.spec.ts
 *
 * Testnet, throwaway accounts and contract, the app on `next dev` with a
 * throwaway fee key. The owner and the renter each use a passkey smart wallet
 * (Chromium's CDP virtual authenticator, one per browser context); the issuer
 * and the renter's funding wallet are regular wallets (the test wallet
 * bridge). Every passkey transaction goes through /api/tx/sponsor, which pays
 * its fee; neither passkey wallet ever holds XLM.
 *
 *   1. the issuer opens the owners' details intake; the owner creates a
 *      passkey wallet from the header (SEP-45 signs it in), asks for a week
 *      with its details, and the issuer issues; the record reaches the owner's
 *      browser with no link opened;
 *   2. the owner lists the week for rent at an asking price, approved with
 *      the passkey;
 *   3. the renter creates a passkey wallet and funds it on the Wallet screen
 *      from a regular wallet (the bridge standing in for Freighter);
 *   4. the renter makes a USDC rental offer, approved with the passkey: the
 *      offer and its USDC allowance in one passkey-signed call;
 *   5. at the owner's acceptance a cancelled passkey prompt moves nothing and
 *      says so; then the owner proves in the browser and accepts: the week is
 *      rented, the USDC is in escrow;
 *   6. a browser without WebAuthn is told to use a regular wallet.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

import { startApp, type App } from "./lib/app";
import { captureFailures, reportFailures, type FailedResponse } from "./lib/failures";
import { checkPendingPrivacy, evidenceLanded, hashOf } from "./lib/privacy";
import { signIn, visit } from "./lib/sign-in";
import { addUsdcTrustline, deployRightsStep4, fund, sendTestnetUsdc } from "./lib/testnet";
import { attachWallet } from "./lib/wallet";

const PORT = 4323;
/** 0.1 USDC: the rental's price. The renter's wallet is funded with 0.2. */
const PRICE = "0.1";

let app: App;
let contract: string;
const issuer = Keypair.random();
const sep10 = Keypair.random();
const fee = Keypair.random();
/** The renter's regular wallet, which funds the renter's passkey wallet. */
const funder = Keypair.random();
const failures: FailedResponse[] = [];

test.describe.configure({ mode: "serial" });
test.setTimeout(25 * 60_000);
test.use({ actionTimeout: 180_000 });

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  await Promise.all([issuer, sep10, fee, funder].map(fund));
  await addUsdcTrustline(funder);
  sendTestnetUsdc(funder.publicKey(), 2_000_000n);
  contract = await deployRightsStep4(issuer, Keypair.random()); // the final WASM (76d69e79…), as on the final testnet deployment
  console.log(`e2e contract ${contract}`);
  app = await startApp({ contract, issuer, sep10, fee, port: PORT });
});

// The privacy check runs here too, so it runs even when the test fails after
// the rental landed, before the run's throwaway secrets are gone.
test.afterEach(async ({}, info) => {
  try {
    await reportFailures("passkey-app", failures, info);
  } finally {
    checkPendingPrivacy();
  }
});

test.afterAll(async () => {
  await app?.stop();
});

/** A virtual platform passkey for one browser context. */
async function addPasskey(c: BrowserContext, page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await c.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

/** Create a passkey wallet from the header; SEP-45 signs it in. Returns its C… address. */
async function createPasskeyWallet(page: Page, path: string): Promise<string> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.locator(".wallet").getByRole("button", { name: "Use a passkey" }).click();
  await page.getByRole("button", { name: "Create a passkey wallet" }).click();
  await expect(page.locator(".wallet .addr")).toContainText("🔑", { timeout: 180_000 });
  await expect(page.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0, { timeout: 120_000 });
  const wallet = (await page.locator(".wallet .addr").getAttribute("title"))!;
  expect(wallet).toMatch(/^C[A-Z2-7]{55}$/);
  return wallet;
}

/** The secrets in a browser's vault. */
async function vaultSecrets(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((ok) => {
        const req = indexedDB.open("quietstay-vault");
        req.onsuccess = () => {
          const all = req.result.transaction("entries").objectStore("entries").getAll();
          all.onsuccess = () => ok((all.result as { value: { s?: string } }[]).flatMap((e) => (e.value?.s ? [e.value.s] : [])));
        };
      }),
  );
}

async function right(rightId: number): Promise<{ title_holder: string | null; effective_holder: string }> {
  return (await fetch(`${app.url}/api/right/${rightId}`)).json();
}

test("two passkey users rent a week through the app, each fee paid by the fee route", async ({ browser }) => {
  const oc = await browser.newContext({ baseURL: app.url });
  await oc.addInitScript({ content: "globalThis.__name = (f) => f;" });
  captureFailures("owner (passkey)", oc, failures);
  const O = await oc.newPage();
  const ownerKey = await addPasskey(oc, O);

  const ic = await browser.newContext({ baseURL: app.url });
  await attachWallet(ic, issuer);
  captureFailures("issuer", ic, failures);
  const I = await ic.newPage();

  // The renter's context has a passkey and, for the one funding transfer, the
  // regular wallet the bridge stands in for.
  const rc = await browser.newContext({ baseURL: app.url });
  await attachWallet(rc, funder);
  captureFailures("renter (passkey)", rc, failures);
  const R = await rc.newPage();
  await addPasskey(rc, R);

  // --- 1. intake open; the owner's passkey wallet asks; issued and delivered ---
  await signIn(I, "/issue");
  await I.getByTestId("intake-publish").click({ timeout: 60_000 });
  await expect(I.getByTestId("intake-ready")).toBeVisible({ timeout: 60_000 });

  const ownerWallet = await createPasskeyWallet(O, "/issue");
  console.log(`owner's passkey wallet ${ownerWallet}`);
  const ownerName = "Passkey Owner";
  await expect(O.getByTestId("detail-owner_name")).toBeEnabled({ timeout: 60_000 });
  await O.getByTestId("detail-owner_name").fill(ownerName);
  await O.getByTestId("detail-week_check_in").fill("2026-12-19");
  await O.getByRole("button", { name: "Request issuance", exact: true }).click();
  await expect(O.getByTestId("issue-reply-wait")).toBeVisible({ timeout: 60_000 });

  await signIn(I, "/issue");
  await I.getByRole("button", { name: "Issue to this account" }).first().click();
  await expect(I.locator("#owner_name")).toHaveValue(ownerName, { timeout: 60_000 });
  await I.locator("#tab-json").click();
  const sample = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  const theRecord = {
    ...sample,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { name: ownerName, email: "passkey.e2e@example.invalid", stellar_account: ownerWallet },
    week: { check_in: "2026-12-19", check_out: "2026-12-26", use_year: 2026, week_number: 51 },
    title: { ...sample.title, deed_reference: `E2E-PK-${randomBytes(4).toString("hex")}` },
  };
  await I.locator("textarea#record").fill(JSON.stringify(theRecord, null, 2));
  await I.getByRole("button", { name: "Issue on testnet" }).click();
  const issued = I.getByText(/Right #\d+/).first();
  await expect(issued).toBeVisible({ timeout: 120_000 });
  // Read at once: a dev-server reload later in the test clears this result.
  const rightId = Number(/Right #(\d+)/.exec((await issued.textContent()) ?? "")![1]);
  await expect(I.getByTestId("issue-delivered")).toBeVisible({ timeout: 60_000 });

  // No link: signed in, the owner's browser picks the record up.
  await visit(O, "/stays");
  await expect(O.getByTestId("inbox-received")).toBeVisible({ timeout: 60_000 });

  // --- 2. listed for rent at an asking price, approved with the passkey --------
  await visit(O, "/list");
  await O.getByTestId(`asking-price-${rightId}`).fill(PRICE, { timeout: 60_000 });
  await O.getByRole("button", { name: /^Offer for rent/ }).click();
  await expect(O.getByRole("button", { name: "Withdraw offer" })).toBeVisible({ timeout: 180_000 });

  // --- 3. the renter's passkey wallet, funded on the Wallet screen ------------
  const renterWallet = await createPasskeyWallet(R, "/wallet");
  console.log(`renter's passkey wallet ${renterWallet}`);
  await expect(R.getByTestId("wallet-address")).toHaveText(renterWallet, { timeout: 60_000 });
  await expect(R.getByTestId("wallet-usdc")).toContainText("0 USDC", { timeout: 60_000 });
  await R.getByTestId("fund-amount").fill("0.2");
  await R.getByTestId("fund-send").click();
  await expect(R.getByTestId("fund-done")).toContainText("Sent 0.2 USDC", { timeout: 180_000 });
  await expect(R.getByTestId("wallet-usdc")).toContainText("0.2 USDC", { timeout: 60_000 });
  // The session is still the passkey's.
  await expect(R.locator(".wallet .addr")).toContainText("🔑");

  // --- 4. a USDC rental offer, approved with the passkey -----------------------
  await visit(R, `/stays?right=${rightId}&kind=rent`);
  await expect(R.getByTestId("offer-price")).toHaveValue(PRICE, { timeout: 60_000 });
  await R.getByTestId("offer-rent").click({ timeout: 60_000 });
  await expect(R.getByTestId("stays-outcome")).toContainText("Offer made", { timeout: 180_000 });

  // --- 5. a cancelled prompt moves nothing; then proved and accepted -----------
  await visit(O, "/stays");
  const accept = O.locator('[data-testid^="accept-offer-"]').first();
  await expect(accept).toBeEnabled({ timeout: 60_000 });
  await ownerKey.cdp.send("WebAuthn.setUserVerified", { authenticatorId: ownerKey.authenticatorId, isUserVerified: false });
  await accept.click();
  await expect(O.locator(".note.bad", { hasText: "cancelled or failed" }).first()).toBeVisible({ timeout: 180_000 });
  await ownerKey.cdp.send("WebAuthn.setUserVerified", { authenticatorId: ownerKey.authenticatorId, isUserVerified: true });
  expect((await right(rightId)).effective_holder).toBe(ownerWallet);

  await visit(O, "/stays");
  await O.locator('[data-testid^="accept-offer-"]').first().click({ timeout: 60_000 });
  await expect(O.getByTestId("stays-outcome")).toContainText("Rented out", { timeout: 180_000 });
  const rentalTx = await O.getByTestId("stays-outcome").locator("a").getAttribute("href");

  // Registered the moment it lands: the ledger holds neither the record nor
  // the owner's secret, read back from the owner's browser vault.
  const secrets = await vaultSecrets(O);
  expect(secrets.length).toBeGreaterThan(0);
  evidenceLanded({
    txs: { "passkey-app-rental": hashOf(rentalTx) },
    records: [theRecord],
    secrets,
    out: `evidence/privacy/${new Date().toISOString().slice(0, 10)}-passkey-app-${hashOf(rentalTx).slice(0, 8)}.txt`,
  });

  const after = await right(rightId);
  expect(after.title_holder).toBe(ownerWallet);
  expect(after.effective_holder).toBe(renterWallet);
  // The rent is in escrow: 0.1 of the renter's 0.2 left their wallet.
  await visit(R, "/wallet");
  await expect(R.getByTestId("wallet-usdc")).toContainText("0.1 USDC", { timeout: 60_000 });
  console.log(`passkey-approved rental ${rentalTx}`);
  checkPendingPrivacy();

  mkdirSync("e2e/results", { recursive: true });
  writeFileSync(
    `e2e/results/passkey-app-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        command: "npx playwright test e2e/passkey-app.spec.ts",
        contract,
        owner_wallet: ownerWallet,
        renter_wallet: renterWallet,
        rental_tx: rentalTx,
        fee_account: "throwaway (Keypair.random)",
      },
      null,
      2,
    ) + "\n",
  );
  for (const c of [oc, ic, rc]) await c.close();
});

test("a browser without WebAuthn is told to use a regular wallet", async ({ browser }) => {
  const c = await browser.newContext({ baseURL: app.url });
  await c.addInitScript({ content: "delete window.PublicKeyCredential;" });
  const p = await c.newPage();
  await p.goto("/list");
  await p.locator(".wallet").getByRole("button", { name: "Use a passkey" }).click();
  await expect(p.getByTestId("passkey-unsupported")).toContainText("Use a regular Stellar wallet instead");
  await expect(p.getByRole("button", { name: "Create a passkey wallet" })).toHaveCount(0);
  await c.close();
});
