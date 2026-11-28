/**
 * Sign a regular-wallet browser in, the way the app works since 2026-11-26
 * (the same steps as e2e/no-leak.spec.ts): a browser that has not signed in
 * shows Connect wallet, which signs in at once; a session is kept across
 * loads and tabs, so Sign in is pressed only if it is shown.
 *
 * The dev server compiles a page on its first visit and may reload it once
 * that is done, which loses a sign-in in progress: so it waits for the page to
 * settle, checks the sign-in held, and tries once more.
 */

import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page, path: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("session-resuming")).toHaveCount(0, { timeout: 60_000 });
    const connectButton = page.locator(".wallet").getByRole("button", { name: "Connect wallet" });
    if (await connectButton.isVisible()) await connectButton.click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible({ timeout: 60_000 });
    const signInButton = page.locator(".wallet").getByRole("button", { name: "Sign in", exact: true });
    await page
      .waitForFunction(() => {
        const w = document.querySelector(".wallet");
        return !!w && (w.textContent?.includes("Sign in") || !w.textContent?.includes("not verified"));
      }, undefined, { timeout: 30_000 })
      .catch(() => undefined);
    if (await signInButton.isVisible()) await signInButton.click();
    try {
      await signedIn(page);
      return;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
}

/**
 * A positive state, in one snapshot: an address shown, with neither "not
 * verified" nor a Sign in button, and still so a second later.
 */
export async function signedIn(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = document.querySelector(".wallet");
      if (!w || !w.querySelector(".addr")) return false;
      const text = w.textContent ?? "";
      return !text.includes("not verified") && ![...w.querySelectorAll("button")].some((b) => b.textContent === "Sign in" || b.textContent === "signing…");
    },
    undefined,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(1_000);
  await expect(page.locator(".wallet .tag.warn", { hasText: "not verified" })).toHaveCount(0);
}

/** Go to a page with the saved session, waiting until it is taken up. */
export async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("session-resuming")).toHaveCount(0, { timeout: 60_000 });
  await signedIn(page);
}
