/**
 * The passkey screens, through the app itself (Phase 3, Step 2 review).
 *
 *   npx playwright test e2e/passkey-app.spec.ts
 *
 * Testnet, throwaway accounts and contract, the app on `next dev`. The owner
 * uses a passkey smart wallet (Chromium's CDP virtual authenticator); the
 * issuer and the renter use regular wallets (the test wallet bridge).
 *
 *   1. the owner creates a passkey wallet from the header (/api/tx/sponsor pays)
 *      and is signed in by SEP-45;
 *   2. the owner asks for a week; the issuer issues and seals; the owner imports;
 *   3. the owner offers it for rent (passkey-signed, sponsored);
 *   4. a renter asks; the owner proves in the browser and approves with the
 *      passkey (sponsored);
 *   5. a cancelled passkey prompt at approval moves nothing and says so;
 *   6. a browser without WebAuthn is told to use a regular wallet.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

import { startApp, type App } from "./lib/app";
import { captureFailures, reportFailures, type FailedResponse } from "./lib/failures";
import { checkPendingPrivacy, evidenceLanded, hashOf } from "./lib/privacy";
import { deployRightsStep4, fund } from "./lib/testnet";
import { attachWallet } from "./lib/wallet";

let app: App;
let contract: string;
const issuer = Keypair.random();
const sep10 = Keypair.random();
const fee = Keypair.random();
const renter = Keypair.random();
const renter2 = Keypair.random();
const failures: FailedResponse[] = [];

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  await Promise.all([issuer, sep10, fee, renter, renter2].map(fund));
  contract = await deployRightsStep4(issuer, Keypair.random()); // the final WASM (76d69e79…), as on the final testnet deployment
  console.log(`e2e contract ${contract}`);
  app = await startApp({ contract, issuer, sep10, fee, port: 4323 });
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

async function signIn(page: Page, path: string) {
  await page.goto(path);
  await page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await expect(page.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0, { timeout: 90_000 });
  } catch (e) {
    const why = await page.getByTestId("wallet-error").getAttribute("title").catch(() => null);
    throw new Error(`sign-in did not complete: ${why ?? "no error shown"}`, { cause: e });
  }
}

/** A browser context with a virtual platform passkey. */
async function passkeyContext(c: BrowserContext, page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await c.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

test("a passkey owner gets a week, offers it, and rents it out, approving with the passkey", async ({ browser }) => {
  const oc = await browser.newContext({ baseURL: app.url });
  await oc.addInitScript({ content: "globalThis.__name = (f) => f;" });
  captureFailures("owner (passkey)", oc, failures);
  const O = await oc.newPage();
  const { cdp, authenticatorId } = await passkeyContext(oc, O);

  const ic = await browser.newContext({ baseURL: app.url });
  await attachWallet(ic, issuer);
  captureFailures("issuer", ic, failures);
  const I = await ic.newPage();
  const rc = await browser.newContext({ baseURL: app.url });
  await attachWallet(rc, renter);
  captureFailures("renter", rc, failures);
  const R = await rc.newPage();

  // 1. create the passkey wallet; SEP-45 signs it in
  await O.goto("/issue");
  await O.locator(".wallet").getByRole("button", { name: "Use a passkey" }).click();
  await O.getByRole("button", { name: "Create a passkey wallet" }).click();
  await expect(O.locator(".wallet .addr")).toContainText("🔑", { timeout: 120_000 });
  await expect(O.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0, { timeout: 120_000 });
  const wallet = (await O.locator(".wallet .addr").getAttribute("title"))!;
  expect(wallet).toMatch(/^C[A-Z2-7]{55}$/);

  // 2. ask, issue, seal, import
  await O.getByRole("button", { name: "Request issuance", exact: true }).click();
  const ownerLink = await O.getByTestId("issue-request-link").inputValue({ timeout: 60_000 });
  await signIn(I, "/issue");
  await I.getByRole("button", { name: "Issue to this account" }).first().click();
  await I.locator("#tab-json").click();
  const sample = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  const theRecord = {
    ...sample,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { name: "Passkey Owner", email: "passkey.e2e@example.invalid", stellar_account: wallet },
    week: { check_in: "2026-12-05", check_out: "2026-12-12", use_year: 2026, week_number: 49 },
  };
  await I.locator("textarea#record").fill(JSON.stringify(theRecord, null, 2));
  await I.getByRole("button", { name: "Issue on testnet" }).click();
  await expect(I.getByText(/Right #\d+/).first()).toBeVisible({ timeout: 120_000 });
  await I.goto(ownerLink.replace(/^https?:\/\/[^/]+/, ""));
  await I.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
  await I.getByRole("button", { name: "Seal the record" }).click({ timeout: 60_000 });
  const reply = await I.getByTestId("reply-link").inputValue();
  await O.goto(reply.replace(/^https?:\/\/[^/]+/, ""));
  await expect(O.getByTestId("record-received")).toBeVisible({ timeout: 60_000 });

  // Back on the site layout (a full load): sign in again with the passkey.
  const passkeySignIn = async (path: string) => {
    await O.goto(path);
    await O.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(O.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0, { timeout: 90_000 });
  };

  // 3. offer for rent, approved with the passkey, paid by the fee route
  await passkeySignIn("/list");
  await O.getByRole("button", { name: /^Offer for rent/ }).click();
  await expect(O.getByRole("button", { name: "Withdraw offer" })).toBeVisible({ timeout: 120_000 });

  // 4. a renter asks
  await signIn(R, "/list");
  await R.getByRole("button", { name: /^Ask to rent it for/ }).click();
  await expect(R.getByText("you asked for this")).toBeVisible({ timeout: 60_000 });

  // 5. first, a cancelled passkey prompt at approval: nothing moves
  await passkeySignIn("/transfer");
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await O.getByRole("button", { name: "Prove and rent out" }).click({ timeout: 60_000 });
  await expect(O.locator(".note.bad", { hasText: "cancelled or failed" })).toBeVisible({ timeout: 120_000 });
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
  const holderAfterCancel = await (await fetch(`${app.url}/api/right/1`)).json();
  expect(holderAfterCancel.effective_holder).toBe(wallet);

  // 4, continued: the real approval
  await O.getByRole("button", { name: "Prove and rent out" }).click();
  await expect(O.getByTestId("transfer-outcome")).toContainText("Rented out", { timeout: 180_000 });
  const rentalTx = await O.getByTestId("transfer-outcome").locator("a").getAttribute("href");

  // Registered the moment it lands, before anything below can fail: the
  // ledger must hold neither the record nor the owner's secret, which is read
  // back from the owner's browser vault.
  const secrets = await O.evaluate(
    () =>
      new Promise<string[]>((ok) => {
        const req = indexedDB.open("quietstay-vault");
        req.onsuccess = () => {
          const all = req.result.transaction("entries").objectStore("entries").getAll();
          all.onsuccess = () => ok((all.result as { value: { s?: string } }[]).flatMap((e) => (e.value?.s ? [e.value.s] : [])));
        };
      }),
  );
  evidenceLanded({
    txs: { "passkey-app-rental": hashOf(rentalTx) },
    records: [theRecord],
    secrets,
    out: `evidence/privacy/${new Date().toISOString().slice(0, 10)}-passkey-app-${hashOf(rentalTx).slice(0, 8)}.txt`,
  });

  const after = await (await fetch(`${app.url}/api/right/1`)).json();
  expect(after.effective_holder).toBe(renter.publicKey());
  expect(after.title_holder).toBe(wallet);
  console.log(`passkey wallet ${wallet}\npasskey-approved rental ${rentalTx}`);

  expect(secrets.length).toBeGreaterThan(0);
  checkPendingPrivacy();

  mkdirSync("e2e/results", { recursive: true });
  writeFileSync(
    `e2e/results/passkey-app-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ date: new Date().toISOString(), command: "npx playwright test e2e/passkey-app.spec.ts", contract, wallet, rental_tx: rentalTx, fee_account: "throwaway (Keypair.random)" }, null, 2) + "\n",
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
