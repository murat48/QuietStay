/**
 * The prover worker refuses keys that are not the committed ones, and the app
 * says so plainly when a browser cannot prove (Phase 3, Step 2).
 *
 *   npx playwright test e2e/prover.spec.ts
 *
 * Serves public/ (after `npm run zk:build-worker`) from a local server. The
 * worker is the built one, exactly as the app ships it.
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const PORT = 4319;
const PUBLIC = resolve("public");
const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" };
let http: Server;

test.beforeAll(() => {
  if (!existsSync(join(PUBLIC, "zk/prover.worker.js"))) throw new Error("run `npm run zk:build-worker` first");
  http = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>t</title>");
    const file = join(PUBLIC, path);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  }).listen(PORT);
});

test.afterAll(() => {
  http.closeAllConnections();
  http.close();
});

async function selfCheck(page: import("@playwright/test").Page): Promise<{ ok: boolean; error?: string }> {
  await page.addInitScript({ content: "globalThis.__name = (f) => f;" });
  await page.goto(`http://localhost:${PORT}/`);
  return page.evaluate(
    () =>
      new Promise<{ ok: boolean; error?: string }>((done) => {
        const w = new Worker("/zk/prover.worker.js");
        w.onmessage = (e) => done({ ok: e.data.ok, error: e.data.error });
        w.postMessage({ id: 1, op: "selfCheck" });
      }),
  );
}

test("the genuine circuit and proving key pass the hash check", async ({ page }) => {
  expect(await selfCheck(page)).toEqual({ ok: true, error: undefined });
});

test("a tampered proving key is refused before any proof", async ({ page }) => {
  await page.route("**/zk/transfer.zkey", async (route) => {
    const bytes = readFileSync(join(PUBLIC, "zk/transfer.zkey"));
    bytes[bytes.length - 1] ^= 0x01;
    await route.fulfill({ body: bytes, contentType: "application/octet-stream" });
  });
  const r = await selfCheck(page);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("transfer.zkey does not match the committed hash");
});

test("a substituted circuit is refused before any proof", async ({ page }) => {
  await page.route("**/zk/transfer.wasm", (route) =>
    route.fulfill({ body: Buffer.from("not the circuit"), contentType: "application/wasm" }),
  );
  const r = await selfCheck(page);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("transfer.wasm does not match the committed hash");
});
