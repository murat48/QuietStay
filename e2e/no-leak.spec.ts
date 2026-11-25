/**
 * The no-leak test (docs/PHASE3_PROMPT.md Step 2; docs/PHASE3_SPEC.md §2).
 *
 *   npx playwright test e2e/no-leak.spec.ts
 *
 * One week, start to finish, through the app's own screens and on testnet,
 * with four browsers (one context each, so each has its own IndexedDB):
 *
 *   1. the owner asks for a week: the secret s and a sealed-link key are made
 *      in the owner's browser;
 *   2. the issuer issues it from the owner's ask, and the issuer's browser
 *      seals the record at once to the owner's key carried by the ask and
 *      leaves it with the ask; signed in, the owner's browser picks it up and
 *      checks it against the chain, with no link opened;
 *   3. the owner offers it for sale; the buyer asks to buy (s' made in the
 *      buyer's browser, consent signed), and the owner seals the record to the
 *      buyer's request link; the buyer opens and checks it;
 *   4. the owner proves the sale **in the browser** and submits it;
 *   5. the buyer offers it for rent; a renter asks; the buyer proves the
 *      rental **in the browser** with s', and submits it.
 *
 * Every request the owner's, buyer's and renter's browsers make is recorded:
 * pages and the prover worker, with URL, headers and body. The issuer's
 * browser is not recorded: its issuance request carries the record to
 * /api/issue by design, and its delivery carries only the sealed form.
 *
 * Afterwards the secrets and records are read back out of each browser's
 * vault, and the test fails if any recorded request contains:
 *
 *   - s or s', in decimal or hex;
 *   - the record, as canonical JSON or as sent, or its salt, id, owner name,
 *     owner email or deed reference;
 *   - d, d_hi or d_lo, in decimal or hex;
 *   - any part of a link fragment (a request key or a sealed reply), except
 *     that an owner's issuance ask carries its own public key since
 *     2026-11-25, in that one request and no other.
 *
 * It also fails if /receive makes any request to an analytics endpoint, or
 * if its HTML references one. As controls, it checks that the worker's fetch
 * of transfer.wasm was recorded, so worker traffic is visible to the
 * recorder, and that a site page did load analytics, so the analytics check
 * can see them.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

import canonicalize from "canonicalize";
import { startApp, type App } from "./lib/app";
import { deployRightsStep4, fund } from "./lib/testnet";
import { captureFailures, reportFailures, type FailedResponse } from "./lib/failures";
import { checkPendingPrivacy, evidenceLanded, hashOf } from "./lib/privacy";
import { attachWallet } from "./lib/wallet";

const PORT = 4321;
const ANALYTICS = ["/_vercel/insights", "/_vercel/speed-insights", "va.vercel-scripts.com"];

interface Logged {
  who: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  frameUrl: string;
}

const log: Logged[] = [];
const failures: FailedResponse[] = [];
const links: string[] = [];
/** Owners' sealed-link public keys: allowed only in the body of their own ask. */
const askKeys: string[] = [];

function record(who: string, context: BrowserContext) {
  const take = (req: Request) => {
    let frameUrl = "";
    try {
      frameUrl = req.frame().url();
    } catch {
      frameUrl = "(worker)";
    }
    log.push({
      who,
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      body: req.postDataBuffer()?.toString("latin1") ?? "",
      frameUrl,
    });
  };
  context.on("request", take);
  return () => context.off("request", take);
}

async function signIn(page: Page, path: string) {
  // The dev server compiles a page on its first visit and may reload it once
  // that is done; a sign-in started before then is lost with the reload (seen
  // twice, 2026-11-24 and 2026-11-25: a challenge fetched, never posted). So
  // wait for the page to settle, and check the sign-in held; retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
    try {
      // One snapshot, and a positive state: an address shown, with neither
      // "not verified" nor a Sign in button. (Two separate "count 0" checks
      // passed vacuously while the page was blank mid-reload.)
      await page.waitForFunction(
        () => {
          const w = document.querySelector(".wallet");
          if (!w || !w.querySelector(".addr")) return false;
          const text = w.textContent ?? "";
          return !text.includes("not verified") && ![...w.querySelectorAll("button")].some((b) => b.textContent === "Sign in" || b.textContent === "signing…");
        },
        undefined,
        { timeout: 60_000 },
      );
      // Still so a moment later: not a frame caught between two renders.
      await page.waitForTimeout(1_000);
      await expect(page.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0);
      return;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
}

/** Everything a browser's vault holds, read back for the leak check. */
async function vaultContents(page: Page): Promise<{ secrets: string[]; records: unknown[] }> {
  return page.evaluate(
    () =>
      new Promise<{ secrets: string[]; records: unknown[] }>((ok, fail) => {
        const req = indexedDB.open("quietstay-vault");
        req.onerror = () => fail(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction("entries").objectStore("entries").getAll();
          all.onsuccess = () => {
            const secrets: string[] = [];
            const records: unknown[] = [];
            for (const e of all.result as { key: string; value: { s?: string; record?: unknown } }[]) {
              if (e.value?.s) secrets.push(e.value.s);
              if (e.value?.record) records.push(e.value.record);
            }
            ok({ secrets, records });
          };
        };
      }),
  );
}

let app: App;
let contract: string;
const issuer = Keypair.random();
const sep10 = Keypair.random();
const owner = Keypair.random();
const buyer = Keypair.random();
const renter = Keypair.random();

test.describe.configure({ mode: "serial" });
test.setTimeout(20 * 60_000);

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  await Promise.all([issuer, owner, buyer, renter].map(fund));
  contract = await deployRightsStep4(issuer, Keypair.random()); // the final WASM (76d69e79…), as on the final testnet deployment
  console.log(`e2e contract ${contract}`);
  app = await startApp({ contract, issuer, sep10, port: PORT });
});

// The privacy check runs here too, so it runs even when the test fails after
// a transaction landed, before the run's throwaway secrets are gone.
test.afterEach(async ({}, info) => {
  try {
    await reportFailures("no-leak", failures, info);
  } finally {
    checkPendingPrivacy();
  }
});

test.afterAll(async () => {
  await app?.stop();
});

test("a sale and a rental proved in the browser send no secret, record or d", async ({ browser }) => {
  const ctx = async (who: string, kp: Keypair, recorded = true) => {
    const c = await browser.newContext({ baseURL: app.url });
    await attachWallet(c, kp);
    if (recorded) record(who, c);
    captureFailures(who, c, failures);
    return { c, page: await c.newPage() };
  };
  const O = await ctx("owner", owner);
  const B = await ctx("buyer", buyer);
  const R = await ctx("renter", renter);
  const I = await ctx("issuer", issuer, false);

  // --- 1. the owner asks for a week -------------------------------------------
  await signIn(O.page, "/issue");
  await O.page.getByRole("button", { name: "Request issuance", exact: true }).click();
  // Since 2026-11-25 the ask carries the owner's public key, so the issuer
  // seals at once and the request link is only a fallback. The key is public
  // and goes to the server in exactly one request, the ask itself; it is
  // checked below to appear in no other.
  await expect(O.page.getByTestId("issue-reply-wait")).toBeVisible({ timeout: 60_000 });
  const ownerLink = await O.page.getByTestId("issue-request-link").inputValue({ timeout: 60_000 });
  askKeys.push(ownerLink.slice(ownerLink.lastIndexOf(".") + 1));

  // --- 2. the issuer issues and seals; the owner opens -------------------------
  await signIn(I.page, "/issue");
  await I.page.getByRole("button", { name: "Issue to this account" }).first().click();
  await I.page.locator("#tab-json").click();
  const sample = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  const theRecord = {
    ...sample,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { name: "E2E Owner Zelda", email: "zelda.e2e@example.invalid", stellar_account: owner.publicKey() },
    week: { check_in: "2026-12-05", check_out: "2026-12-12", use_year: 2026, week_number: 49 },
    title: { ...sample.title, deed_reference: `E2E-${randomBytes(4).toString("hex")}` },
  };
  await I.page.locator("textarea#record").fill(JSON.stringify(theRecord, null, 2));
  await I.page.getByRole("button", { name: "Issue on testnet" }).click();
  await expect(I.page.getByText(/Right #\d+/).first()).toBeVisible({ timeout: 120_000 });

  // Sealed in the issuer's browser right after issuing, and left with the
  // owner's ask (D3 as amended 2026-11-25). The issuer's browser is not
  // recorded: its issuance request carries the record by design, and its
  // delivery request carries only the sealed form.
  await expect(I.page.getByTestId("issue-delivered")).toBeVisible({ timeout: 60_000 });
  const issuerReply = await I.page.getByTestId("issue-reply-link").inputValue({ timeout: 60_000 });
  // The sealed record's own bytes: no request of the owner's may carry them
  // (the owner's browser receives them in a response and sends back only the
  // ask id).
  links.push(issuerReply);

  // The owner opens no link: signed in, the browser picks the record up.
  await signIn(O.page, "/stays");
  await expect(O.page.getByTestId("inbox-received")).toBeVisible({ timeout: 60_000 });

  // --- 3. offer for sale; the buyer asks; the record goes to the buyer ---------
  await signIn(O.page, "/list");
  await O.page.getByRole("button", { name: "Offer for sale" }).click();
  await expect(O.page.getByRole("button", { name: "Withdraw offer" })).toBeVisible({ timeout: 120_000 });

  await signIn(B.page, "/list");
  await B.page.getByRole("button", { name: "Sign my consent and ask to buy" }).click();
  const buyerLink = await B.page.getByTestId("buy-request-link").inputValue({ timeout: 60_000 });
  links.push(buyerLink);

  await O.page.goto(buyerLink.replace(/^https?:\/\/[^/]+/, ""));
  await O.page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true }).click();
  await O.page.getByRole("button", { name: "Seal the record" }).click({ timeout: 60_000 });
  const ownerReply = await O.page.getByTestId("reply-link").inputValue();
  links.push(ownerReply);

  await B.page.goto(ownerReply.replace(/^https?:\/\/[^/]+/, ""));
  await expect(B.page.getByTestId("record-received")).toBeVisible({ timeout: 60_000 });

  // --- 4. the owner proves the sale in the browser -----------------------------
  await signIn(O.page, "/transfer");
  await O.page.getByRole("button", { name: "Prove and sell" }).click({ timeout: 60_000 });
  await expect(O.page.getByTestId("transfer-outcome")).toContainText("Sold", { timeout: 180_000 });
  const saleTx = await O.page.getByTestId("transfer-outcome").locator("a").getAttribute("href");
  // Registered the moment it lands: the owner's s, and the buyer's s' (whose
  // h' a sale publishes by design). The rental joins this same check below.
  const [ownerVault, buyerVault] = await Promise.all([O.page, B.page].map(vaultContents));
  const onChainCheck = {
    txs: { "no-leak-sale": hashOf(saleTx) } as Record<string, string>,
    records: [theRecord],
    secrets: ownerVault!.secrets,
    nextSecrets: buyerVault!.secrets,
    out: `evidence/privacy/${new Date().toISOString().slice(0, 10)}-no-leak-${hashOf(saleTx).slice(0, 8)}.txt`,
  };
  evidenceLanded(onChainCheck);

  // --- 5. the buyer rents it out, proving with s' ------------------------------
  await signIn(B.page, "/list");
  await B.page.getByRole("button", { name: /^Offer for rent/ }).click();
  await expect(B.page.getByRole("button", { name: "Withdraw offer" })).toBeVisible({ timeout: 120_000 });

  await signIn(R.page, "/list");
  await R.page.getByRole("button", { name: /^Ask to rent it for/ }).click();
  await expect(R.page.getByText("you asked for this")).toBeVisible({ timeout: 60_000 });

  await signIn(B.page, "/transfer");
  await B.page.getByRole("button", { name: "Prove and rent out" }).click({ timeout: 60_000 });
  await expect(B.page.getByTestId("transfer-outcome")).toContainText("Rented out", { timeout: 180_000 });
  const rentalTx = await B.page.getByTestId("transfer-outcome").locator("a").getAttribute("href");
  onChainCheck.txs["no-leak-rental"] = hashOf(rentalTx);
  console.log(`sale ${saleTx}\nrental ${rentalTx}`);

  // --- the leak check ----------------------------------------------------------
  const vaults = await Promise.all([O.page, B.page].map(vaultContents));
  const secrets = vaults.flatMap((v) => v.secrets);
  const records = [theRecord, ...vaults.flatMap((v) => v.records)];
  expect(secrets.length).toBeGreaterThanOrEqual(2); // s and s'

  const forbidden = new Map<string, string>();
  for (const s of secrets) {
    forbidden.set(s, "a secret (decimal)");
    forbidden.set(BigInt(s).toString(16), "a secret (hex)");
    forbidden.set(BigInt(s).toString(16).padStart(64, "0"), "a secret (hex, padded)");
  }
  for (const r of records) {
    const rec = r as typeof theRecord;
    const canon = canonicalize(rec) as string;
    forbidden.set(canon, "the record (canonical JSON)");
    forbidden.set(JSON.stringify(rec), "the record (JSON)");
    forbidden.set(rec.salt, "the record's salt");
    forbidden.set(rec.record_id, "the record's id");
    forbidden.set(rec.owner.name, "the owner's name");
    forbidden.set(rec.owner.email, "the owner's email");
    forbidden.set(rec.title.deed_reference, "the deed reference");
    const d = createHash("sha256").update(canon).digest("hex");
    const dHi = BigInt("0x" + d.slice(0, 32));
    const dLo = BigInt("0x" + d.slice(32));
    forbidden.set(d, "d (hex)");
    for (const [n, v] of [["d_hi", dHi], ["d_lo", dLo]] as const) {
      forbidden.set(v.toString(), `${n} (decimal)`);
      forbidden.set(v.toString(16), `${n} (hex)`);
    }
  }
  for (const l of links) {
    const frag = l.slice(l.indexOf("#") + 1);
    forbidden.set(frag.slice(0, 48), "part of a link fragment");
    forbidden.set(frag.slice(-48), "part of a link fragment");
  }

  const leaks: string[] = [];
  const isAsk = (e: Logged) => e.method === "POST" && new URL(e.url).pathname === "/api/requests/issuance";
  for (const key of askKeys) {
    const carriers = log.filter((e) => e.body.includes(key) || e.url.includes(key));
    const elsewhere = carriers.filter((e) => !isAsk(e));
    for (const e of elsewhere) leaks.push(`${e.who}: ${e.method} ${e.url.slice(0, 120)} contains an owner's ask key outside the ask`);
    if (!carriers.some(isAsk)) leaks.push("control: the owner's ask did not carry its public key; the check above saw nothing");
  }
  for (const entry of log) {
    const haystacks = [entry.url, decodeURIComponent(entry.url), JSON.stringify(entry.headers), entry.body];
    for (const [needle, what] of forbidden) {
      if (needle.length < 8) continue;
      if (haystacks.some((h) => h.includes(needle) || h.includes(encodeURIComponent(needle)))) {
        leaks.push(`${entry.who}: ${entry.method} ${entry.url.slice(0, 120)} contains ${what}`);
      }
    }
  }
  console.log(`recorded ${log.length} requests; checked each for ${forbidden.size} forbidden values`);
  mkdirSync("e2e/results", { recursive: true });
  writeFileSync(
    `e2e/results/no-leak-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        command: "npx playwright test e2e/no-leak.spec.ts",
        contract,
        sale_tx: saleTx,
        rental_tx: rentalTx,
        requests_recorded: log.length,
        requests_by_browser: Object.fromEntries(
          [...new Set(log.map((e) => e.who))].map((w) => [w, log.filter((e) => e.who === w).length]),
        ),
        worker_requests: log.filter((e) => e.url.includes("/zk/")).map((e) => `${e.who}: ${e.url.replace(app.url, "")}`),
        forbidden_values_checked: forbidden.size,
        secrets_found_in_vaults: secrets.length,
        leaks,
      },
      null,
      2,
    ) + "\n",
  );
  expect(leaks, leaks.join("\n")).toEqual([]);

  // The on-chain side, right after the transactions (Step 2 review): the
  // ledger holds none of the same values, events included.
  // Registered when the sale landed, the rental added when it landed.
  checkPendingPrivacy();

  // Controls: the recorder sees the worker's traffic, and the analytics check can see analytics.
  expect(log.some((e) => e.url.endsWith("/zk/transfer.wasm"))).toBe(true);
  expect(log.some((e) => e.url.endsWith("/zk/transfer.zkey"))).toBe(true);
  expect(log.some((e) => ANALYTICS.some((a) => e.url.includes(a)) && !e.frameUrl.includes("/receive"))).toBe(true);

  // /receive: no request to an analytics endpoint, and none referenced in its HTML.
  const fromReceive = log.filter((e) => e.frameUrl.includes("/receive"));
  expect(fromReceive.length).toBeGreaterThan(0);
  expect(fromReceive.filter((e) => ANALYTICS.some((a) => e.url.includes(a)))).toEqual([]);
  const html = await (await fetch(`${app.url}/receive`)).text();
  for (const a of ANALYTICS) expect(html).not.toContain(a);
  expect(html).not.toContain("fonts.googleapis.com");

  for (const c of [O, B, R, I]) await c.c.close();
});

test("a browser that cannot run the prover is told so, and offered nothing that would fail", async ({ browser }) => {
  const c = await browser.newContext({ baseURL: app.url });
  await c.addInitScript({ content: "delete window.Worker;" });
  const page = await c.newPage();
  await page.goto("/transfer");
  await expect(page.getByTestId("prover-unsupported")).toBeVisible();
  await expect(page.getByTestId("prover-unsupported")).toContainText("Chrome or Firefox");
  await page.goto("/receive#rec=AAAA");
  await expect(page.getByText("cannot run the in-browser prover")).toBeVisible();
  await c.close();
});
