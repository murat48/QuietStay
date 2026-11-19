/**
 * Passkey approval through the smart wallet (Phase 3, Step 2).
 *
 *   npx playwright test e2e/passkey.spec.ts
 *
 * Kit-level: the probe page (e2e/passkey-probe/page.ts) drives
 * smart-account-kit 0.10.0 in Chromium with a CDP virtual authenticator, a
 * genuine WebAuthn P-256 credential. Everything else is throwaway: the
 * contract's issuer, the fee payer, the renter and the records, all made for
 * this run and funded by Friendbot.
 *
 *   - a passkey-signed, proven rental from the wallet goes through;
 *   - a cancelled or failed passkey prompt (user verification refused) signs
 *     nothing, and the week does not move;
 *   - a signature that does not verify (tampered) is refused by the wallet's
 *     check on chain, and the week does not move;
 *   - a browser without WebAuthn is detected as unsupported.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { Address, Keypair, Operation, rpc, TransactionBuilder, xdr, scValToNative } from "@stellar/stellar-sdk";

import type { JsonValue } from "../src/lib/canonical";
import { NETWORK_PASSPHRASE, RPC_URL } from "../src/lib/config";
import { commitment, randomSecret, secretHash, splitRecordDigest } from "../scripts/lib/zk";
import { fr } from "../scripts/lib/zk-encode";
import { proveTransfer } from "../scripts/lib/zk-prove";
import { buildCall, issueArgs, transferArgs } from "../scripts/lib/zk-tx";
import { deployRights, fund, server, submit } from "./lib/testnet";

const PORT = 4320;
const ACCOUNT_WASM = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
const WEBAUTHN_VERIFIER = "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";
const CHECK_IN = "2026-12-05";
const CHECK_OUT = "2026-12-12";
const UNTIL = BigInt(Date.parse(`${CHECK_OUT}T00:00:00Z`) / 1000);

const issuer = Keypair.random();
const fee = Keypair.random();
const renter = Keypair.random();
let contract: string;
let http: Server;
let page: Page;
let cdp: CDPSession;
let authenticatorId: string;
let wallet: string;
const weeks: { rightId: number; record: JsonValue; secret: bigint }[] = [];

test.describe.configure({ mode: "serial" });
test.setTimeout(10 * 60_000);

/** Issue one week to the wallet, committed to a secret made here. */
async function issueToWallet(): Promise<void> {
  const sample = JSON.parse(readFileSync("inventory/records/week-01.json", "utf8"));
  const record = {
    ...sample,
    record_id: randomUUID(),
    salt: randomBytes(32).toString("hex"),
    owner: { ...sample.owner, stellar_account: wallet },
    week: { check_in: CHECK_IN, check_out: CHECK_OUT, use_year: 2026, week_number: 49 },
  } as JsonValue;
  const secret = randomSecret();
  const c = fr(await commitment(await splitRecordDigest(record), wallet, await secretHash(secret)));
  const period = { start: Date.parse(`${CHECK_IN}T00:00:00Z`) / 1000, end: Number(UNTIL) };
  const validity = { from: Date.parse("2026-01-01T00:00:00Z") / 1000, until: Date.parse("2027-01-01T00:00:00Z") / 1000 };
  const tx = await buildCall(issuer.publicKey(), contract, "issue", issueArgs(wallet, period, validity, c));
  const { returnValue } = await submit(tx, issuer);
  weeks.push({ rightId: Number(scValToNative(returnValue!)), record, secret });
}

async function holder(rightId: number): Promise<string> {
  const tx = await buildCall(fee.publicKey(), contract, "holder", [xdr.ScVal.scvU64(xdr.Uint64.fromString(String(rightId)))]);
  const sim = (await server.simulateTransaction(tx)) as rpc.Api.SimulateTransactionSuccessResponse;
  return Address.fromScVal(sim.result!.retval).toString();
}

/** Prove a rental of `week` from the wallet, and the call with the wallet's unsigned entry. */
async function provenRental(week: (typeof weeks)[number]) {
  const latest = (await server.getLatestLedger()).sequence;
  const { file } = await proveTransfer(week.record, week.secret, {
    rightId: BigInt(week.rightId),
    from: wallet,
    to: renter.publicKey(),
    expiresAt: UNTIL,
    expiryLedger: BigInt(latest + 360),
    nextSecretHash: 0n,
  });
  const t = {
    from: wallet,
    to: renter.publicKey(),
    rightId: BigInt(week.rightId),
    expiresAt: UNTIL,
    proof: file.proof,
    signals: file.public_signals_hex.map((h) => "0x" + h),
  };
  const call = await buildCall(fee.publicKey(), contract, "transfer", transferArgs(t));
  const sim = (await server.simulateTransaction(call)) as rpc.Api.SimulateTransactionSuccessResponse;
  expect(sim.result?.auth.length).toBe(1);
  return { t, entry: sim.result!.auth[0]!, expiration: latest + 600 };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  await Promise.all([issuer, fee, renter].map(fund));
  contract = await deployRights(issuer);

  const js = (
    await build({
      entryPoints: [resolve("e2e/passkey-probe/page.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      define: { global: "globalThis" },
    })
  ).outputFiles[0]!.text;
  const html = `<!doctype html><meta charset="utf-8"><script>window.probeConfig=${JSON.stringify({
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    accountWasmHash: ACCOUNT_WASM,
    webauthnVerifierAddress: WEBAUTHN_VERIFIER,
  })}</script><script type="module" src="/page.js"></script>`;
  http = createServer((req, res) =>
    req.url === "/page.js"
      ? res.writeHead(200, { "content-type": "text/javascript" }).end(js)
      : res.writeHead(200, { "content-type": "text/html" }).end(html),
  ).listen(PORT);

  page = await (await browser.newContext()).newPage();
  await page.addInitScript({ content: "globalThis.__name = (f) => f;" });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  }));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!window.probe);

  const created = await page.evaluate(() => window.probe.create());
  wallet = created.contractId;
  const account = await server.getAccount(fee.publicKey());
  const deploy = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.fromXDR(created.func, "base64"),
        auth: created.auth.map((e) => xdr.SorobanAuthorizationEntry.fromXDR(e, "base64")),
      }),
    )
    .setTimeout(120)
    .build();
  const deployed = await submit(deploy, fee);
  const ledger = (await server.getTransaction(deployed.hash)) as rpc.Api.GetSuccessfulTransactionResponse;
  await page.evaluate(([k, h, l]) => window.probe.recordDeployment(k, h, l), [created.credentialId, deployed.hash, ledger.ledger] as const);
  expect(await page.evaluate(([c, k]) => window.probe.connect(c, k), [wallet, created.credentialId] as const)).toBe(wallet);

  for (let i = 0; i < 3; i++) await issueToWallet();
});

test.afterAll(() => {
  http?.closeAllConnections();
  http?.close();
  // snarkjs leaves its curve threads running; release them.
  void (globalThis as { curve_bls12381?: { terminate(): Promise<void> } }).curve_bls12381?.terminate();
});

test("a passkey-signed, proven rental from the smart wallet goes through", async () => {
  const week = weeks[0]!;
  const { t, entry, expiration } = await provenRental(week);
  const signed = await page.evaluate(([e, x]) => window.probe.sign(e, x), [entry.toXDR("base64"), expiration] as const);
  const call = await buildCall(fee.publicKey(), contract, "transfer", transferArgs(t), [
    xdr.SorobanAuthorizationEntry.fromXDR(signed, "base64"),
  ]);
  const { hash } = await submit(call, fee);
  console.log(`passkey rental ${hash}`);
  expect(await holder(week.rightId)).toBe(renter.publicKey());
});

test("a signature that does not verify is refused on chain, and nothing moves", async () => {
  const week = weeks[1]!;
  const { t, entry, expiration } = await provenRental(week);
  const signedB64 = await page.evaluate(([e, x]) => window.probe.sign(e, x), [entry.toXDR("base64"), expiration] as const);
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(signedB64, "base64");
  // Flip one byte of the WebAuthn signature inside the wallet's signature map.
  const creds = signed.credentials().address();
  const sigBytes = creds.signature().toXDR();
  const i = sigBytes.length - 40;
  sigBytes[i] = sigBytes[i]! ^ 0xff;
  creds.signature(xdr.ScVal.fromXDR(sigBytes));
  const call = await buildCall(fee.publicKey(), contract, "transfer", transferArgs(t), [signed]);
  const sim = await server.simulateTransaction(call);
  expect(rpc.Api.isSimulationError(sim)).toBe(true);
  console.log(`tampered signature refused: ${(sim as rpc.Api.SimulateTransactionErrorResponse).error.slice(0, 160)}`);
  expect(await holder(week.rightId)).toBe(wallet);
});

test("a cancelled or failed passkey prompt signs nothing, and nothing moves", async () => {
  const week = weeks[2]!;
  const { entry, expiration } = await provenRental(week);
  // The kit asks for user verification ("required"). An authenticator that
  // does not verify the user is what a cancelled prompt or a failed
  // fingerprint gives the page: the browser rejects with NotAllowedError.
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  const result = await page.evaluate(
    ([e, x]) => window.probe.sign(e, x).then(() => "signed", (err: Error) => `${err.name}: ${err.message}`),
    [entry.toXDR("base64"), expiration] as const,
  );
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
  console.log(`cancelled prompt: ${result.slice(0, 200)}`);
  expect(result).not.toBe("signed");
  expect(await holder(week.rightId)).toBe(wallet);
});

test("the app's check: supported with a platform passkey, unsupported without WebAuthn, and it names the fallback", async ({ browser }) => {
  // This page has the virtual platform authenticator.
  expect(await page.evaluate(() => window.probe.support())).toMatchObject({ supported: true });

  const p = await (await browser.newContext()).newPage();
  await p.addInitScript({ content: "globalThis.__name = (f) => f; delete window.PublicKeyCredential;" });
  await p.goto(`http://localhost:${PORT}/`);
  await p.waitForFunction(() => !!window.probe);
  const r = await p.evaluate(() => window.probe.support());
  expect(r.supported).toBe(false);
  expect(r.reason).toContain("no WebAuthn");
  expect(r.fallback).toContain("Freighter");
});
