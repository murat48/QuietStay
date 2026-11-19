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
 *   2. the issuer issues it and seals the record to the owner's request link
 *      (/receive); the owner opens the reply and checks it against the chain;
 *   3. the owner offers it for sale; the buyer asks to buy (s' made in the
 *      buyer's browser, consent signed), and the owner seals the record to the
 *      buyer's request link; the buyer opens and checks it;
 *   4. the owner proves the sale **in the browser** and submits it;
 *   5. the buyer offers it for rent; a renter asks; the buyer proves the
 *      rental **in the browser** with s', and submits it.
 *
 * Every request the owner's, buyer's and renter's browsers make is recorded:
 * pages and the prover worker, with URL, headers and body. The issuer's
 * browser is recorded while it seals. Its issuance request is not recorded,
 * because the issuer writes the record and sends it to /api/issue by design.
 *
 * Afterwards the secrets and records are read back out of each browser's
 * vault, and the test fails if any recorded request contains:
 *
 *   - s or s', in decimal or hex;
 *   - the record, as canonical JSON or as sent, or its salt, id, owner name,
 *     owner email or deed reference;
 *   - d, d_hi or d_lo, in decimal or hex;
 *   - any part of a link fragment (a request key or a sealed reply).
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
import { deployRights, fund } from "./lib/testnet";
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
const links: string[] = [];

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
  await page.goto(path);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(page.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0, { timeout: 60_000 });
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
  contract = await deployRights(issuer);
  console.log(`e2e contract ${contract}`);
  app = await startApp({ contract, issuer, sep10, port: PORT });
});

test.afterAll(async () => {
  await app?.stop();
});

test("a sale and a rental proved in the browser send no secret, record or d", async ({ browser }) => {
  const ctx = async (who: string, kp: Keypair, recorded = true) => {
    const c = await browser.newContext({ baseURL: app.url });
    await attachWallet(c, kp);
    if (recorded) record(who, c);
    return { c, page: await c.newPage() };
  };
  const O = await ctx("owner", owner);
  const B = await ctx("buyer", buyer);
  const R = await ctx("renter", renter);
  const I = await ctx("issuer", issuer, false);

  // --- 1. the owner asks for a week -------------------------------------------
  await signIn(O.page, "/issue");
  await O.page.getByRole("button", { name: "Request issuance", exact: true }).click();
  const ownerLink = await O.page.getByTestId("issue-request-link").inputValue({ timeout: 60_000 });
  links.push(ownerLink);

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

  const stopIssuer = record("issuer (sealing)", I.c);
  // A navigation across root layouts is a full page load, so sign in again there.
  await I.page.goto(ownerLink.replace(/^https?:\/\/[^/]+/, ""));
  await I.page.getByRole("button", { name: "Sign in", exact: true }).click();
  await I.page.getByRole("button", { name: "Seal the record" }).click({ timeout: 60_000 });
  const issuerReply = await I.page.getByTestId("reply-link").inputValue();
  links.push(issuerReply);
  stopIssuer();

  await O.page.goto(issuerReply.replace(/^https?:\/\/[^/]+/, ""));
  await expect(O.page.getByTestId("record-received")).toBeVisible({ timeout: 60_000 });
  expect(O.page.url()).not.toContain("#");

  // --- 3. offer for sale; the buyer asks; the record goes to the buyer ---------
  await signIn(O.page, "/list");
  await O.page.getByRole("button", { name: "Offer for sale" }).click();
  await expect(O.page.getByRole("button", { name: "Withdraw offer" })).toBeVisible({ timeout: 120_000 });

  await signIn(B.page, "/list");
  await B.page.getByRole("button", { name: "Sign my consent and ask to buy" }).click();
  const buyerLink = await B.page.getByTestId("buy-request-link").inputValue({ timeout: 60_000 });
  links.push(buyerLink);

  await O.page.goto(buyerLink.replace(/^https?:\/\/[^/]+/, ""));
  await O.page.getByRole("button", { name: "Sign in", exact: true }).click();
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
