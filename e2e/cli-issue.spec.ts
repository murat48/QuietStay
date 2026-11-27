/**
 * Issuing with the CLI, in `cli` mode as on mainnet (Step 5 plan, item 3,
 * 2026-11-27). The server holds no issuer key. In the browser:
 *
 *   1. the issuer signs in with a SEP-10 challenge signed "with the CLI";
 *   2. publishes the intake key, its message signed "with the CLI" (SEP-53);
 *   3. the owner asks for a week, with details sealed to that key;
 *   4. the issuer picks the ask (the form fills in), builds the envelope,
 *      which is signed and sent "with the CLI", pastes the hash and confirms;
 *   5. the owner's browser picks the sealed record up.
 *
 * "With the CLI" is this process signing with the test's throwaway issuer
 * key, exactly what `stellar tx sign` / `stellar message sign` /
 * `mainnet-sign-submit.sh` do: the page is given the same text to sign and
 * gets back the same kind of signature. No key is ever given to the page.
 */

import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { Keypair, Networks, TransactionBuilder, hash, rpc } from "@stellar/stellar-sdk";

import { startApp, type App } from "./lib/app";
import { deployRightsStep4, fund, server } from "./lib/testnet";
import { attachWallet } from "./lib/wallet";

const PORT = 4324;

let app: App;
let contract: string;
const issuer = Keypair.random();
const sep10 = Keypair.random();
const owner = Keypair.random();

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  await Promise.all([issuer, owner].map(fund));
  contract = await deployRightsStep4(issuer, Keypair.random());
  console.log(`e2e contract ${contract}`);
  app = await startApp({ contract, issuer, sep10, port: PORT, cli: true });
});

test.afterAll(async () => {
  await app?.stop();
});

/** What `stellar tx sign --sign-with-key <issuer>` does to an envelope. */
function cliSignTx(xdr: string): string {
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(issuer);
  return tx.toXDR();
}

/** What `stellar message sign --base64 --sign-with-key <issuer> <b64>` prints. */
function cliSignMessage(b64: string): string {
  const message = Buffer.from(b64, "base64");
  return issuer.sign(hash(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), message]))).toString("base64");
}

/** What `mainnet-sign-submit.sh` does: sign the envelope as it is, send it, wait. */
async function cliSignAndSend(xdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(cliSignTx(xdr), Networks.TESTNET);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`refused: ${sent.status}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${sent.hash} ended ${done.status}`);
  return sent.hash;
}

async function settle(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("session-resuming")).toHaveCount(0, { timeout: 60_000 });
}

test("the issuer signs in and issues with the CLI; the owner's browser gets the record", async ({ browser }) => {
  const I = await (await browser.newContext({ baseURL: app.url })).newPage();
  const oc = await browser.newContext({ baseURL: app.url });
  await attachWallet(oc, owner);
  const O = await oc.newPage();

  // --- 1. the issuer signs in with the CLI -------------------------------------
  await settle(I, "/issue");
  await I.getByTestId("cli-sign-in-open").click();
  await I.getByTestId("cli-account").fill(issuer.publicKey());
  await I.getByTestId("cli-get-challenge").click();
  const command = await I.getByTestId("cli-command").inputValue({ timeout: 30_000 });
  expect(command).toContain("stellar tx sign --sign-with-key qs-issuer --network testnet ");
  // Pasted as the terminal shows it: the CLI's info line, then the signed challenge.
  await I.getByTestId("cli-signed").fill(`ℹ️  Signing transaction: ${"ab".repeat(32)}\n${cliSignTx(command.split(" ").pop()!)}\n`);
  await I.getByTestId("cli-sign-in-submit").click();
  await expect(I.locator(".wallet .addr")).toBeVisible({ timeout: 60_000 });
  await expect(I.locator(".wallet .tag", { hasText: "Issuer" })).toBeVisible({ timeout: 60_000 });
  // The session survives a reload, as for the other kinds.
  await I.reload();
  await expect(I.locator(".wallet .tag", { hasText: "Issuer" })).toBeVisible({ timeout: 60_000 });

  // No server key here: the only way to issue is the envelope.
  await expect(I.getByRole("button", { name: /^Issue on / })).toHaveCount(0);

  // --- 2. the intake key, signed with the CLI ----------------------------------
  await I.getByTestId("intake-publish").click({ timeout: 60_000 });
  const signCmd = (await I.getByTestId("intake-cli-command").textContent({ timeout: 30_000 })) ?? "";
  expect(signCmd).toContain("stellar message sign --base64 --sign-with-key qs-issuer ");
  await I.getByTestId("intake-cli-signature").fill(cliSignMessage(signCmd.trim().split(" ").pop()!));
  await I.getByTestId("intake-cli-publish").click();
  await expect(I.getByTestId("intake-ready")).toBeVisible({ timeout: 60_000 });

  // --- 3. the owner asks, with details -----------------------------------------
  await settle(O, "/issue");
  await O.locator(".wallet").getByRole("button", { name: "Connect wallet" }).click();
  await expect(O.getByRole("button", { name: "Disconnect" })).toBeVisible({ timeout: 60_000 });
  await expect(O.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0, { timeout: 60_000 });
  const ownerName = "CLI E2E Owner";
  await expect(O.getByTestId("details-closed")).toHaveCount(0, { timeout: 60_000 });
  await O.getByTestId("detail-owner_name").fill(ownerName);
  await O.getByRole("button", { name: "Request issuance", exact: true }).click();
  await expect(O.getByTestId("issue-reply-wait")).toBeVisible({ timeout: 60_000 });

  // --- 3b. the issuer opens the ask's details, and declines it with a reason ---
  // (2026-11-27). The owner sees the reason, and asks again.
  await settle(I, "/issue");
  await I.locator('[data-testid^="ask-details-"]').first().click({ timeout: 60_000 });
  await expect(I.locator('[data-testid^="ask-details-list-"]')).toContainText(ownerName, { timeout: 60_000 });
  const reason = "The deed reference is missing; please add it and ask again.";
  // Declined from the row's own button, which opens the panel ready to decline.
  await I.locator('[data-testid^="ask-decline-"]').first().click();
  await I.locator('[data-testid^="decline-reason-"]').fill(reason);
  await I.locator('[data-testid^="decline-yes-"]').click();
  await expect(I.getByTestId("ask-declined-note")).toBeVisible({ timeout: 60_000 });
  await expect(I.getByRole("button", { name: "Issue to this account" })).toHaveCount(0);

  await settle(O, "/issue");
  await expect(O.locator('[data-testid^="ask-declined-"]')).toContainText(reason, { timeout: 60_000 });
  await O.getByTestId("detail-owner_name").fill(ownerName);
  await O.getByRole("button", { name: "Request issuance", exact: true }).click();
  await expect(O.getByTestId("issue-reply-wait")).toBeVisible({ timeout: 60_000 });

  // --- 4. the envelope, signed and sent with the CLI, then confirmed -----------
  await settle(I, "/issue");
  await I.getByRole("button", { name: "Issue to this account" }).first().click({ timeout: 60_000 });
  await expect(I.locator("#owner_name")).toHaveValue(ownerName, { timeout: 60_000 });
  await I.locator("#tab-json").click();
  const sample = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  const record = {
    ...sample,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { name: ownerName, email: "cli.e2e@example.invalid", stellar_account: owner.publicKey() },
    week: { check_in: "2026-12-19", check_out: "2026-12-26", use_year: 2026, week_number: 51 },
  };
  await I.locator("textarea#record").fill(JSON.stringify(record, null, 2));
  await I.getByTestId("issue-build-envelope").click();
  const xdr = await I.getByTestId("issue-envelope-xdr").inputValue({ timeout: 120_000 });
  await expect(I.getByTestId("issue-envelope-command")).toContainText("scripts/mainnet-sign-submit.sh issue-ask-");
  await expect(I.getByTestId("issue-envelope-command")).toContainText(" qs-issuer --network testnet");

  // A wrong hash is refused, and nothing is closed.
  await I.getByTestId("issue-tx-hash").fill("0".repeat(64));
  await I.getByTestId("issue-confirm").click();
  await expect(I.getByText(/not on chain/)).toBeVisible({ timeout: 60_000 });

  const txHash = await cliSignAndSend(xdr);
  console.log(`issued with the envelope: ${txHash}`);
  await I.getByTestId("issue-tx-hash").fill(txHash);
  await I.getByTestId("issue-confirm").click();
  const issued = I.getByText(/Right #\d+/).first();
  await expect(issued).toBeVisible({ timeout: 120_000 });
  // Read at once: a dev-server reload later in the test clears this result.
  const rightId = Number(/Right #(\d+)/.exec((await issued.textContent()) ?? "")![1]);
  await expect(I.getByText("Issued with the CLI and confirmed on chain")).toBeVisible();
  await expect(I.getByTestId("issue-delivered")).toBeVisible({ timeout: 60_000 });

  // --- 5. the owner's browser picks the record up -------------------------------
  // Logged so a failure here says whether the session check itself failed.
  O.on("response", (r) => {
    if (r.url().includes("/api/me")) console.log(`owner /api/me ${r.status()}`);
  });
  await settle(O, "/stays");
  await expect(O.getByTestId("inbox-received")).toBeVisible({ timeout: 60_000 });

  // --- 6. renewal (2026-11-27): the contract cannot move a week's dates, so the
  // title holder asks for next year's, filled in from the record held here.
  await settle(O, "/list");
  await O.getByTestId(`renew-now-${rightId}`).click({ timeout: 60_000 });
  await expect(O.getByTestId(`renew-waiting-${rightId}`)).toContainText("waiting for the issuer", { timeout: 60_000 });

  await settle(I, "/issue");
  await expect(I.locator('[data-testid^="ask-renews-"]')).toContainText(`renews week #${rightId}`, { timeout: 60_000 });
  await I.getByRole("button", { name: "Issue to this account" }).first().click();
  // The same week, 52 weeks later, from the owner's record.
  await expect(I.locator("#week_in")).toHaveValue("2027-12-18", { timeout: 60_000 });
  await expect(I.locator("#owner_name")).toHaveValue(ownerName);

  // Declined, so the owner can file an automatic one instead: it waits,
  // hidden from the issuer, until this week ends (2026-12-26).
  await I.locator('[data-testid^="ask-decline-"]').first().click();
  await I.locator('[data-testid^="decline-yes-"]').click();
  await expect(I.getByTestId("ask-declined-note")).toBeVisible({ timeout: 60_000 });
  await settle(O, "/list");
  await O.getByTestId(`renew-auto-${rightId}`).click({ timeout: 60_000 });
  await expect(O.getByTestId(`renew-waiting-${rightId}`)).toContainText("automatic renewal filed", { timeout: 60_000 });
  await settle(I, "/issue");
  await expect(I.getByText("No pending requests.")).toBeVisible({ timeout: 60_000 });
});
