import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (Phase 3, Step 2). They run against testnet with throwaway
 * accounts and start their own `next dev`; see e2e/lib/.
 *
 *   npx playwright install chromium firefox   (once; on Linux also
 *   `sudo npx playwright install-deps chromium firefox`)
 *   npm run e2e:browser
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
