/**
 * The passkey probe: one real passkey-authorized contract call on testnet,
 * before any screen is built on the kit (docs/PHASE3_PROMPT.md Step 2).
 *
 *   npx tsx e2e/passkey-probe/probe.ts --contract <C…>
 *
 * Chromium runs headless with a CDP virtual authenticator: a genuine WebAuthn
 * P-256 credential, created and used through `navigator.credentials` exactly
 * as a platform passkey is. Its signature is checked on chain by the
 * OpenZeppelin WebAuthn verifier. What it does not exercise is a person
 * pressing a fingerprint reader.
 *
 * 1. Create the passkey and its smart wallet (stellar-accounts v0.8.0,
 *    c514d35e…), deployed through the shared deployer's {func, auth} and paid
 *    for by `qs-fee-testnet`.
 * 2. Issue a week to the wallet (`npm run zk:issue`, signed by the issuer).
 * 3. Prove a rental from the wallet to `qs-renter` (the Phase 2 prover; the
 *    tagged address encoding of D1 makes the wallet nameable).
 * 4. Build `transfer` from the fee account, let simulation ask for the
 *    wallet's authorization, have the passkey sign that entry in the browser,
 *    re-simulate with the signature in place, and submit.
 *
 * The record and the wallet's record secret go to .secrets/ (gitignored), as
 * `npm run zk:issue` always does. Nothing secret is printed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

import type { JsonValue } from "../../src/lib/canonical";
import { NETWORK_PASSPHRASE, RPC_URL } from "../../src/lib/config";
import { proveTransfer } from "../../scripts/lib/zk-prove";
import { buildCall, transferArgs } from "../../scripts/lib/zk-tx";
import { feeAccount, payAndSubmit, server } from "../../scripts/lib/fee-payer";

const ACCOUNT_WASM = "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
const WEBAUTHN_VERIFIER = "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";
const FEE = "qs-fee-testnet";
const CHECK_IN = "2026-12-05";
const CHECK_OUT = "2026-12-12";
const PORT = 4317;

const here = resolve("e2e/passkey-probe");
const say = (s: string) => console.log(s);

async function main() {
  const { values: a } = parseArgs({ options: { contract: { type: "string" } } });
  const contract = a.contract;
  if (!contract) throw new Error("--contract <C…> is required");
  const fee = feeAccount(FEE);
  const renter = execFileSync("stellar", ["keys", "address", "qs-renter"], { encoding: "utf8" }).trim();
  const out: Record<string, unknown> = { date: new Date().toISOString(), contract, fee_account: fee, renter };

  // --- the page -------------------------------------------------------------
  const bundle = await build({
    entryPoints: [join(here, "page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    define: { global: "globalThis" },
  });
  const js = bundle.outputFiles[0]!.text;
  const html = `<!doctype html><meta charset="utf-8"><title>passkey probe</title>
<script>window.probeConfig=${JSON.stringify({
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    accountWasmHash: ACCOUNT_WASM,
    webauthnVerifierAddress: WEBAUTHN_VERIFIER,
  })}</script><script type="module" src="/page.js"></script>`;
  const http = createServer((req, res) => {
    if (req.url === "/page.js") res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    else res.writeHead(200, { "content-type": "text/html" }).end(html);
  }).listen(PORT);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on("console", (m) => m.type() === "error" && say(`  [page] ${m.text()}`));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => !!window.probe);
    out.browser = `Chromium ${browser.version()} (headless, CDP virtual authenticator ctap2/internal)`;

    // --- 1. passkey + wallet ------------------------------------------------
    const created = await page.evaluate(() => window.probe.create());
    say(`passkey created, wallet ${created.contractId}`);
    const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    if (creds.credentials.length !== 1) throw new Error("expected exactly one passkey on the authenticator");
    const account = await server.getAccount(fee);
    const deployTx = new TransactionBuilder(account, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.fromXDR(created.func, "base64"),
          auth: created.auth.map((e) => xdr.SorobanAuthorizationEntry.fromXDR(e, "base64")),
        }),
      )
      .setTimeout(180)
      .build();
    const deployed = await payAndSubmit(deployTx, FEE);
    say(`wallet deployed: ${deployed.hash}`);
    out.wallet = created.contractId;
    out.wallet_deploy_tx = deployed.hash;

    await page.evaluate(
      ([k, h, l]) => window.probe.recordDeployment(k, h, l),
      [created.credentialId, deployed.hash, deployed.ledger] as const,
    );
    const connected = await page.evaluate(
      ([c, k]) => window.probe.connect(c, k),
      [created.contractId, created.credentialId] as const,
    );
    if (connected !== created.contractId) throw new Error(`connectWallet returned ${connected}`);
    say("kit connected to the wallet (birth and code hash verified by the kit)");

    // --- 2. issue a week to the wallet -------------------------------------
    const dir = resolve(".secrets", `probe-${created.contractId.slice(0, 8)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync(
      "npx",
      ["tsx", "scripts/zk/issue-week.ts", "--contract", contract, "--owner", created.contractId,
        "--check-in", CHECK_IN, "--check-out", CHECK_OUT, "--dir", dir],
      { stdio: "inherit" },
    );
    const issued = JSON.parse(
      readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(".issued.json"))!), "utf8"),
    ) as { right_id: number; transaction?: string; record_file: string; owner_secret_file: string };
    out.right_id = issued.right_id;

    // --- 3. prove a rental from the wallet ---------------------------------
    const record = JSON.parse(readFileSync(issued.record_file, "utf8")) as JsonValue;
    const secret = BigInt((JSON.parse(readFileSync(issued.owner_secret_file, "utf8")) as { secret: string }).secret);
    const latest = (await server.getLatestLedger()).sequence;
    const until = BigInt(Date.parse(`${CHECK_OUT}T00:00:00Z`) / 1000);
    const { file, seconds } = await proveTransfer(record, secret, {
      rightId: BigInt(issued.right_id),
      from: created.contractId,
      to: renter,
      expiresAt: until,
      expiryLedger: BigInt(latest + 360),
      nextSecretHash: 0n,
    });
    say(`rental proof made in ${seconds.toFixed(1)} s (Node prover) and verified off chain`);

    // --- 4. the passkey signs the wallet's authorization -------------------
    const call = await buildCall(fee, contract, "transfer", transferArgs({
      from: created.contractId,
      to: renter,
      rightId: BigInt(issued.right_id),
      expiresAt: until,
      proof: file.proof,
      signals: file.public_signals_hex.map((h) => "0x" + h),
    }));
    const sim = await server.simulateTransaction(call);
    if (!("result" in sim) || !sim.result) throw new Error(`simulation failed: ${JSON.stringify(sim).slice(0, 400)}`);
    const entries = sim.result.auth;
    if (entries.length !== 1) throw new Error(`expected one authorization entry (the wallet's), got ${entries.length}`);
    const expiration = (await server.getLatestLedger()).sequence + 600;
    const signedB64 = await page.evaluate(
      ([e, x]) => window.probe.sign(e, x),
      [entries[0]!.toXDR("base64"), expiration] as const,
    );
    const signedEntry = xdr.SorobanAuthorizationEntry.fromXDR(signedB64, "base64");

    const withAuth = await buildCall(fee, contract, "transfer", transferArgs({
      from: created.contractId,
      to: renter,
      rightId: BigInt(issued.right_id),
      expiresAt: until,
      proof: file.proof,
      signals: file.public_signals_hex.map((h) => "0x" + h),
    }), [signedEntry]);
    const sent = await payAndSubmit(withAuth, FEE);
    say(`passkey-authorized transfer: ${sent.hash} (ledger ${sent.ledger})`);
    out.transfer_tx = sent.hash;
    out.transfer_ledger = sent.ledger;
    out.transfer_min_resource_fee = sent.minResourceFee;

    // --- the result, read back from chain -----------------------------------
    const holder = execFileSync(
      "stellar",
      ["contract", "invoke", "--id", contract, "--network", "testnet", "--source", FEE, "--send=no", "--",
        "holding", "--right_id", String(issued.right_id)],
      { encoding: "utf8" },
    ).trim();
    say(`holding now: ${holder}`);
    out.holding_after = JSON.parse(holder);

    mkdirSync(join(here, "results"), { recursive: true });
    const resultFile = join(here, "results", `probe-${out.date!.toString().slice(0, 10)}.json`);
    writeFileSync(resultFile, JSON.stringify(out, null, 2) + "\n");
    say(`wrote ${resultFile}`);
  } finally {
    await browser.close();
    http.closeAllConnections();
    http.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
