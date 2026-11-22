import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

/**
 * The network setting is read once, when the module loads, so each case runs
 * in a fresh process with its own environment. No real key is used: the
 * "secrets" here are fixed throwaway strings that are never valid keys.
 */
function configUnder(env: Record<string, string>, expr: string): { ok: boolean; out: string } {
  const code = `import("./src/lib/config.ts").then(async (c) => { const kv = await import("./src/lib/kv.ts"); const sp = await import("./src/lib/sponsor.ts"); process.stdout.write(JSON.stringify(await (async () => (${expr}))())); }).catch((e) => { process.stdout.write("ERR " + e.message); process.exit(3); });`;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("NEXT_PUBLIC_QUIETSTAY_") && !k.startsWith("QUIETSTAY_")) clean[k] = v;
  }
  const r = spawnSync("node_modules/.bin/tsx", ["-e", code], { env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.status === 0 ? "" : r.stderr ?? "") };
}

describe("the network setting", () => {
  it("defaults to the testnet demo: testnet, server signing, attestations, testnet ids", () => {
    const r = configUnder({}, `({ n: c.NETWORK, s: c.SIGNING, a: c.ATTESTATIONS, p: c.NETWORK_PASSPHRASE, u: c.USDC_CONTRACT_ID, x: c.explorer.tx("h"), f: c.FRIENDBOT_URL, m: c.missingConfiguration() })`);
    assert.ok(r.ok, r.out);
    const v = JSON.parse(r.out);
    assert.equal(v.n, "testnet");
    assert.equal(v.s, "server");
    assert.equal(v.a, true);
    assert.equal(v.p, "Test SDF Network ; September 2015");
    assert.equal(v.u, "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    assert.equal(v.x, "https://stellar.expert/explorer/testnet/tx/h");
    assert.equal(v.f, "https://friendbot.stellar.org");
    assert.deepEqual(v.m, []);
  });

  it("mainnet: public passphrase, mainnet USDC, CLI signing, no attestations, no friendbot, and no testnet defaults", () => {
    const r = configUnder(
      { NEXT_PUBLIC_QUIETSTAY_NETWORK: "mainnet" },
      `({ s: c.SIGNING, a: c.ATTESTATIONS, p: c.NETWORK_PASSPHRASE, u: c.USDC_CONTRACT_ID, i: c.USDC_ISSUER, x: c.explorer.tx("h"), f: c.FRIENDBOT_URL, cid: c.CONTRACT_ID, m: c.missingConfiguration(), rpc: c.RPC_URL })`,
    );
    assert.ok(r.ok, r.out);
    const v = JSON.parse(r.out);
    assert.equal(v.s, "cli");
    assert.equal(v.a, false);
    assert.equal(v.p, "Public Global Stellar Network ; September 2015");
    assert.equal(v.u, "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
    assert.equal(v.i, "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    assert.equal(v.x, "https://stellar.expert/explorer/public/tx/h");
    assert.equal(v.f, null);
    assert.equal(v.cid, "");
    assert.equal(v.rpc, "https://mainnet.sorobanrpc.com");
    assert.deepEqual(v.m, [
      "NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID",
      "NEXT_PUBLIC_QUIETSTAY_WEB_AUTH_CONTRACT_ID",
      "NEXT_PUBLIC_QUIETSTAY_WEBAUTHN_VERIFIER_ID",
      "NEXT_PUBLIC_QUIETSTAY_FEE_ACCOUNT",
    ]);
  });

  it("refuses server signing on mainnet, and any unknown value", () => {
    assert.match(configUnder({ NEXT_PUBLIC_QUIETSTAY_NETWORK: "mainnet", NEXT_PUBLIC_QUIETSTAY_SIGNING: "server" }, "1").out, /not allowed on mainnet/);
    assert.match(configUnder({ NEXT_PUBLIC_QUIETSTAY_NETWORK: "Mainnet" }, "1").out, /must be "testnet" or "mainnet"/);
    assert.match(configUnder({ NEXT_PUBLIC_QUIETSTAY_SIGNING: "both" }, "1").out, /must be "server" or "cli"/);
  });

  it("CLI signing never uses an issuer or fee key, even one set by mistake", () => {
    const env = { NEXT_PUBLIC_QUIETSTAY_SIGNING: "cli", QUIETSTAY_ISSUER_SECRET: "not-a-key", QUIETSTAY_TESTNET_FEE_SECRET: "not-a-key" };
    const r = configUnder(env, `({ has: c.hasIssuerSecret(), a: c.ATTESTATIONS, n: c.NETWORK, m: c.missingConfiguration().length })`);
    assert.ok(r.ok, r.out);
    // Like mainnet, the rehearsal takes no testnet defaults: all four ids must be set.
    assert.deepEqual(JSON.parse(r.out), { has: false, a: false, n: "testnet", m: 4 });
    assert.match(configUnder(env, "c.issuerSecret()").out, /holds no issuer key/);
    assert.match(configUnder(env, "c.testnetFeeSecret()").out, /holds no fee key/);
  });

  it("the fee route refuses in a CLI deployment", () => {
    const r = configUnder(
      { NEXT_PUBLIC_QUIETSTAY_SIGNING: "cli" },
      `(() => { try { sp.checkSponsored(null, [], "G"); return "accepted"; } catch (e) { return e.message; } })()`,
    );
    assert.ok(r.ok, r.out);
    assert.match(JSON.parse(r.out), /no fee route/);
  });

  it("the store prefix defaults to quietstay, and refuses anything but lowercase, digits and dashes", () => {
    assert.equal(JSON.parse(configUnder({}, "kv.kvPrefix()").out), "quietstay");
    assert.equal(JSON.parse(configUnder({ QUIETSTAY_KV_PREFIX: "qs-rehearsal" }, "kv.kvPrefix()").out), "qs-rehearsal");
    assert.match(configUnder({ QUIETSTAY_KV_PREFIX: "Bad:Prefix" }, "kv.kvPrefix()").out, /must be lowercase/);
  });
});
