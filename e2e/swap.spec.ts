/**
 * The swap screen, and the trustline notice on /stays (docs/PHASE3_PROMPT.md
 * Step 4; Step 3 trustline item).
 *
 *   npx playwright test e2e/swap.spec.ts
 *
 * On testnet, with throwaway accounts and a fresh Step 4 rights contract,
 * through the app's own screens. Two owners, the maker and the taker, each
 * get a week through the issue flow, then:
 *
 *   1. the maker asks on chain for the taker's week's record; the taker seals
 *      it at /receive; the maker opens and checks it, and offers the swap;
 *   2. the taker asks on chain for the maker's week's record; the maker seals
 *      it; the taker opens and checks it, and proves and accepts;
 *   3. error handling: the taker withdraws, and the maker's page, still
 *      showing the acceptance, tries to complete. The contract's refusal is
 *      shown as a readable message, and nothing moves;
 *   4. the taker asks again and accepts again; the maker proves and completes;
 *      both weeks have changed hands on chain.
 *
 * Then on /stays: a rental offer for the maker's new week, made by a third
 * throwaway account. The maker's account has no USDC trustline: the screen
 * says so and the accept button is disabled. Once the maker adds one, the
 * notice is gone and the button is enabled.
 *
 * Then the collect notice: the third account gets 1 testnet USDC from the
 * builder's qs-renter (signed by the Stellar CLI from its keystore; this
 * process never sees the key), the maker accepts its rental offer in the
 * browser, which funds an escrow, and the maker's empty trustline is removed.
 * The escrow card says to add a trustline before collecting and keeps
 * collect disabled; with the trustline back, the notice is gone. (Collect
 * itself stays disabled by its 24-hour window: the week is in December.)
 *
 * Every swap transaction gets a privacy record: each owner's issued secret
 * is forbidden as s and h; each side's new secret, whose h' a swap publishes
 * by design, as s'.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { startApp, type App } from "./lib/app";
import { addUsdcTrustline, deployRightsStep4, fund, invokeAs, removeUsdcTrustline, server, USDC_SAC } from "./lib/testnet";
import { captureFailures, reportFailures, type FailedResponse } from "./lib/failures";
import { checkPendingPrivacy, evidenceLanded, hashOf } from "./lib/privacy";
import { attachWallet } from "./lib/wallet";

const PORT = 4323;

const failures: FailedResponse[] = [];
let app: App;
let contract: string;
const issuer = Keypair.random();
const arbiter = Keypair.random();
const sep10 = Keypair.random();
const maker = Keypair.random();
const taker = Keypair.random();
const renter = Keypair.random();

test.describe.configure({ mode: "serial" });
test.setTimeout(30 * 60_000);
// A step that cannot proceed fails in minutes, not at the test's end.
test.use({ actionTimeout: 180_000 });

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  await Promise.all([issuer, maker, taker, renter].map(fund));
  contract = await deployRightsStep4(issuer, arbiter);
  console.log(`e2e contract ${contract}`);
  app = await startApp({ contract, issuer, sep10, port: PORT });
  // next dev compiles a route on its first visit and may reload the page then,
  // which would drop a sign-in in progress. Compile them all now.
  for (const path of ["/issue", "/swap", "/stays", "/receive", "/list", "/api/swaps", "/api/payments", "/api/me", "/api/right/1"]) {
    await fetch(`${app.url}${path}`);
  }
  // The POST routes answer 401 without a session, after compiling.
  for (const path of ["/api/tx/swap", "/api/tx/build", "/api/tx/submit", "/api/tx/accept-offer", "/api/auth"]) {
    await fetch(`${app.url}${path}`, { method: "POST", body: "{}" });
  }
});

test.afterEach(async ({}, info) => {
  try {
    await reportFailures("swap", failures, info);
  } finally {
    checkPendingPrivacy();
  }
});

test.afterAll(async () => {
  await app?.stop();
});

/**
 * Sign in, and wait for a sign of being signed in (the nav's "Offers & stays"
 * link, shown only then), not merely for the warning to vanish: during a page
 * reload it vanishes too. Tried twice.
 */
async function signIn(page: Page, path: string) {
  for (let attempt = 1; ; attempt += 1) {
    await page.goto(path);
    await page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
    try {
      await expect(page.getByRole("link", { name: "Offers & stays" })).toBeVisible({ timeout: 60_000 });
      await expect(page.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0);
      return;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}

const local = (link: string) => link.replace(/^https?:\/\/[^/]+/, "");

/**
 * Open a sealed link as a fresh page load. A link to /receive from /receive
 * differs only in its fragment, and a fragment-only navigation does not reload
 * the page, so the receive page would not read the new link.
 */
async function openLink(page: Page, link: string) {
  await page.goto("about:blank");
  await page.goto(local(link));
}

/** The secrets in a browser's vault. */
async function vaultSecrets(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((ok, fail) => {
        const req = indexedDB.open("quietstay-vault");
        req.onerror = () => fail(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction("entries").objectStore("entries").getAll();
          all.onsuccess = () =>
            ok((all.result as { value: { s?: string } }[]).map((e) => e.value?.s).filter((s): s is string => Boolean(s)));
        };
      }),
  );
}

async function titleHolder(rightId: number): Promise<string | null> {
  const res = await fetch(`${app.url}/api/right/${rightId}`);
  return ((await res.json()) as { title_holder: string | null }).title_holder;
}

test("two owners swap weeks through the swap screen, with the records exchanged both ways", async ({ browser }) => {
  const ctx = async (who: string, kp: Keypair) => {
    const c = await browser.newContext({ baseURL: app.url });
    await attachWallet(c, kp);
    captureFailures(who, c, failures);
    return { c, page: await c.newPage() };
  };
  const M = await ctx("maker", maker);
  const T = await ctx("taker", taker);
  const I = await ctx("issuer", issuer);

  // --- each owner gets a week ---------------------------------------------------
  const sample = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  const records: unknown[] = [];
  const issueTo = async (owner: { page: Page }, kp: Keypair, week: { check_in: string; check_out: string; week_number: number }) => {
    await signIn(owner.page, "/issue");
    await owner.page.getByRole("button", { name: "Request issuance", exact: true }).click();
    const askLink = await owner.page.getByTestId("issue-request-link").inputValue({ timeout: 60_000 });
    await signIn(I.page, "/issue");
    await I.page.getByRole("button", { name: "Issue to this account" }).first().click();
    await I.page.locator("#tab-json").click();
    const rec = {
      ...sample,
      record_id: randomUUID(),
      salt: randomBytes(32).toString("hex"),
      owner: { name: `E2E Swap ${kp.publicKey().slice(0, 4)}`, email: `swap.${randomBytes(3).toString("hex")}@example.invalid`, stellar_account: kp.publicKey() },
      week: { ...week, use_year: 2026 },
      title: { ...sample.title, deed_reference: `E2E-SWAP-${randomBytes(4).toString("hex")}` },
    };
    records.push(rec);
    await I.page.locator("textarea#record").fill(JSON.stringify(rec, null, 2));
    await I.page.getByRole("button", { name: "Issue on testnet" }).click();
    const issued = I.page.getByText(/Right #\d+/).first();
    await expect(issued).toBeVisible({ timeout: 120_000 });
    const rightId = Number(/Right #(\d+)/.exec((await issued.textContent()) ?? "")![1]);
    await openLink(I.page, askLink);
    await I.page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
    await I.page.getByRole("button", { name: "Seal the record" }).click({ timeout: 60_000 });
    const reply = await I.page.getByTestId("reply-link").inputValue();
    await openLink(owner.page, reply);
    await expect(owner.page.getByTestId("record-received")).toBeVisible({ timeout: 60_000 });
    return rightId;
  };
  const give = await issueTo(M, maker, { check_in: "2026-12-12", check_out: "2026-12-19", week_number: 50 });
  const want = await issueTo(T, taker, { check_in: "2026-12-19", check_out: "2026-12-26", week_number: 51 });
  console.log(`maker holds #${give}, taker holds #${want}`);
  const issuedSecrets = [...(await vaultSecrets(M.page)), ...(await vaultSecrets(T.page))];
  const txs: Record<string, string> = {};
  const outcomeTx = async (page: Page, label: string, text: string | RegExp) => {
    const outcome = page.getByTestId("swap-outcome");
    await expect(outcome).toContainText(text, { timeout: 180_000 });
    txs[label] = hashOf(await outcome.locator("a").getAttribute("href"));
  };

  // --- 1. the maker asks for the taker's record, receives it, offers -----------------
  await signIn(M.page, "/swap");
  await M.page.getByTestId("swap-want").fill(String(want));
  await M.page.getByTestId("swap-want-record-ask").click();
  const makerAsk = await M.page.getByTestId("swap-want-record-link").inputValue({ timeout: 120_000 });
  await openLink(T.page, makerAsk);
  await T.page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
  await T.page.getByRole("button", { name: "Seal the record" }).click({ timeout: 60_000 });
  const takerReply = await T.page.getByTestId("reply-link").inputValue();
  await openLink(M.page, takerReply);
  await expect(M.page.getByTestId("record-received")).toBeVisible({ timeout: 60_000 });

  await signIn(M.page, "/swap");
  await M.page.getByTestId("swap-want").fill(String(want));
  await expect(M.page.getByText(`Week #${want}'s record is in this browser and matches the commitment on chain ✓`)).toBeVisible({ timeout: 60_000 });
  await M.page.getByTestId("swap-offer").click();
  await outcomeTx(M.page, "swap-offer", "Swap offered");

  // --- 2. the taker asks for the maker's record, receives it, accepts ------------------
  await signIn(T.page, "/swap");
  const incoming = T.page.locator('[data-testid^="incoming-swap-"]').first();
  await expect(incoming).toBeVisible({ timeout: 60_000 });
  const swapId = Number(((await incoming.getAttribute("data-testid")) ?? "").replace("incoming-swap-", ""));
  // Before the maker's record is here, accepting is not offered.
  await expect(T.page.getByTestId(`accept-swap-${swapId}`)).toBeDisabled();
  await T.page.getByTestId(`swap-${swapId}-record-ask`).click();
  const takerAsk = await T.page.getByTestId(`swap-${swapId}-record-link`).inputValue({ timeout: 120_000 });
  await openLink(M.page, takerAsk);
  await M.page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
  await M.page.getByRole("button", { name: "Seal the record" }).click({ timeout: 60_000 });
  const makerReply = await M.page.getByTestId("reply-link").inputValue();
  await openLink(T.page, makerReply);
  await expect(T.page.getByTestId("record-received")).toBeVisible({ timeout: 60_000 });

  await signIn(T.page, "/swap");
  await T.page.getByTestId(`accept-swap-${swapId}`).click({ timeout: 60_000 });
  await outcomeTx(T.page, "swap-accept-1", "Accepted swap");

  // --- 3. error handling: withdrawn, then a stale complete is refused -------------------
  await signIn(M.page, "/swap");
  await expect(M.page.getByTestId(`complete-swap-${swapId}`)).toBeVisible({ timeout: 60_000 });
  await signIn(T.page, "/swap");
  await T.page.getByTestId(`withdraw-swap-${swapId}`).click();
  await outcomeTx(T.page, "swap-withdraw", "withdrawn");
  await M.page.getByTestId(`complete-swap-${swapId}`).click();
  await expect(M.page.getByTestId("swap-error")).toContainText("no live acceptance", { timeout: 120_000 });
  expect(await titleHolder(give)).toBe(maker.publicKey());
  expect(await titleHolder(want)).toBe(taker.publicKey());

  // --- 4. accept again (a fresh request; the record is still here), then complete -------
  await signIn(T.page, "/swap");
  await T.page.getByTestId(`swap-${swapId}-record-ask`).click();
  await expect(T.page.getByTestId(`accept-swap-${swapId}`)).toBeEnabled({ timeout: 120_000 });
  await T.page.getByTestId(`accept-swap-${swapId}`).click();
  await outcomeTx(T.page, "swap-accept-2", "Accepted swap");

  await signIn(M.page, "/swap");
  await M.page.getByTestId(`complete-swap-${swapId}`).click({ timeout: 60_000 });
  await outcomeTx(M.page, "swap-complete", "Swapped");
  expect(await titleHolder(give)).toBe(taker.publicKey());
  expect(await titleHolder(want)).toBe(maker.publicKey());
  await expect(M.page.getByTestId(`done-swap-${swapId}`)).toBeVisible();

  // Privacy record for every swap transaction, right after they landed.
  const allSecrets = [...(await vaultSecrets(M.page)), ...(await vaultSecrets(T.page))];
  evidenceLanded({
    txs,
    records,
    secrets: issuedSecrets,
    nextSecrets: allSecrets.filter((s) => !issuedSecrets.includes(s)),
    out: `evidence/privacy/${new Date().toISOString().slice(0, 10)}-swap-e2e-${txs["swap-complete"]!.slice(0, 8)}.txt`,
  });
  console.log(`swap e2e txs: ${JSON.stringify(txs)}`);
  checkPendingPrivacy();

  // --- the trustline notice on /stays -------------------------------------------------------
  // A third account, with a trustline (but no USDC needed to make an offer),
  // offers to rent the maker's new week.
  await fund(renter).catch(() => undefined);
  await addUsdcTrustline(renter);
  const right = (await (await fetch(`${app.url}/api/right/${want}`)).json()) as { week: { start: number; end: number } };
  const latest = await server.getLatestLedger();
  const nowSecs = Math.floor(Date.now() / 1000);
  const checkIn = Math.max(right.week.start, nowSecs + 3600);
  await invokeAs(renter, contract, "create_rental_offer", [
    new Address(renter.publicKey()).toScVal(),
    nativeToScVal(BigInt(want), { type: "u64" }),
    nativeToScVal(10_000_000n, { type: "i128" }),
    nativeToScVal(BigInt(right.week.end), { type: "u64" }),
    nativeToScVal(BigInt(checkIn), { type: "u64" }),
    xdr.ScVal.scvU32(latest.sequence + 2000),
  ]);

  await signIn(M.page, "/stays");
  const card = M.page.locator('[data-testid^="incoming-offer-"]').first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  const offerId = ((await card.getAttribute("data-testid")) ?? "").replace("incoming-offer-", "");
  await expect(M.page.getByTestId(`no-trustline-${offerId}`)).toContainText("Add a USDC trustline before you accept");
  await expect(M.page.getByTestId(`accept-offer-${offerId}`)).toBeDisabled();
  await expect(M.page.getByTestId("usdc-balance")).toContainText("no USDC trustline");

  await addUsdcTrustline(maker);
  // A reload drops the in-memory session, so sign in again.
  await signIn(M.page, "/stays");
  await expect(M.page.getByTestId(`accept-offer-${offerId}`)).toBeVisible({ timeout: 60_000 });
  await expect(M.page.getByTestId(`no-trustline-${offerId}`)).toHaveCount(0);
  await expect(M.page.getByTestId(`accept-offer-${offerId}`)).toBeEnabled();

  // --- the collect notice on /stays ----------------------------------------------------
  const renterAddress = renter.publicKey();
  const qsRenter = execFileSync("stellar", ["keys", "public-key", "qs-renter"], { encoding: "utf8" }).trim();
  execFileSync(
    "stellar",
    ["contract", "invoke", "--id", USDC_SAC, "--source", "qs-renter", "--network", "testnet", "--", "transfer", "--from", qsRenter, "--to", renterAddress, "--amount", "10000000"],
    { stdio: "ignore" },
  );
  await M.page.getByTestId(`accept-offer-${offerId}`).click();
  const stays = M.page.getByTestId("stays-outcome");
  await expect(stays).toContainText("Rented out", { timeout: 180_000 });
  txs["rental-accept"] = hashOf(await stays.locator("a").getAttribute("href"));
  const escrowCard = M.page.locator('[data-testid^="escrow-"][data-testid$="-status"]').first();
  await expect(escrowCard).toBeVisible({ timeout: 60_000 });
  const escrowId = ((await escrowCard.getAttribute("data-testid")) ?? "").replace("escrow-", "").replace("-status", "");

  await removeUsdcTrustline(maker);
  await signIn(M.page, "/stays");
  await expect(M.page.getByTestId(`escrow-no-trustline-${escrowId}`)).toContainText("Add a USDC trustline before you collect", { timeout: 60_000 });
  await expect(M.page.getByTestId(`collect-${escrowId}`)).toBeDisabled();

  await addUsdcTrustline(maker);
  await signIn(M.page, "/stays");
  await expect(M.page.getByTestId(`collect-${escrowId}`)).toBeVisible({ timeout: 60_000 });
  await expect(M.page.getByTestId(`escrow-no-trustline-${escrowId}`)).toHaveCount(0);

  // The rental acceptance's privacy record, with the maker's secrets.
  evidenceLanded({
    txs: { "collect-notice-rental-accept": txs["rental-accept"]! },
    records,
    secrets: issuedSecrets,
    nextSecrets: (await vaultSecrets(M.page)).filter((x) => !issuedSecrets.includes(x)),
    out: `evidence/privacy/${new Date().toISOString().slice(0, 10)}-collect-notice-${txs["rental-accept"]!.slice(0, 8)}.txt`,
  });
  checkPendingPrivacy();

  for (const c of [M, T, I]) await c.c.close();
});
