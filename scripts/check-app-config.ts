/**
 * Read-only check of a deployed app's configuration (Step 5, Stop 1: the
 * second Vercel project). It reads the app's public `/api/network` and
 * `/.well-known/stellar.toml`, and runs scripts/check-deployment.ts on the
 * contracts it names. Nothing is signed or sent.
 *
 *   npx tsx scripts/check-app-config.ts --url https://<host> --network testnet --signing cli \
 *     --rights C… --web-auth C… --verifier C… --fee-account G… --issuer G… --arbiter G… [--max-payment 10000000]
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

let failed = 0;
const check = (ok: boolean, line: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${line}`);
  if (!ok) failed++;
};

async function main() {
  const { values: a } = parseArgs({
    options: {
      url: { type: "string" },
      network: { type: "string" },
      signing: { type: "string" },
      rights: { type: "string" },
      "web-auth": { type: "string" },
      verifier: { type: "string" },
      "fee-account": { type: "string" },
      issuer: { type: "string" },
      arbiter: { type: "string" },
      "max-payment": { type: "string", default: "10000000" },
    },
  });
  for (const k of ["url", "network", "signing", "rights", "web-auth", "verifier", "fee-account", "issuer", "arbiter"] as const) {
    if (!a[k]) throw new Error(`--${k} is required`);
  }
  const base = a.url!.replace(/\/+$/, "");
  console.log(`check-app-config ${base}, ${new Date().toISOString()} (read only)`);

  const res = await fetch(`${base}/api/network`, { cache: "no-store" });
  check(res.ok, `GET /api/network: HTTP ${res.status}`);
  if (!res.ok) process.exit(1);
  const n = (await res.json()) as {
    network: string;
    signing: string;
    attestations: boolean;
    passphrase: string;
    usdc: string;
    ids: { rights: string; web_auth: string; webauthn_verifier: string; fee_account: string };
    missing: string[];
    fee_route: boolean;
    issuer_key_on_server: boolean;
  };
  check(n.network === a.network, `network = ${n.network} (expected ${a.network})`);
  check(n.signing === a.signing, `signing = ${n.signing} (expected ${a.signing})`);
  if (a.signing === "cli") {
    check(n.attestations === false, `attestations off (${n.attestations})`);
    check(n.fee_route === false, `no fee route on the server (${n.fee_route})`);
    check(n.issuer_key_on_server === false, `no issuer key on the server (${n.issuer_key_on_server})`);
  }
  check(n.ids.rights === a.rights, `rights contract ${n.ids.rights}`);
  check(n.ids.web_auth === a["web-auth"], `web-auth contract ${n.ids.web_auth}`);
  check(n.ids.webauthn_verifier === a.verifier, `WebAuthn verifier ${n.ids.webauthn_verifier}`);
  check(n.ids.fee_account === a["fee-account"], `fee account ${n.ids.fee_account}`);
  check(n.missing.length === 0, `nothing missing${n.missing.length ? `: ${n.missing.join(", ")}` : ""}`);

  const toml = await (await fetch(`${base}/.well-known/stellar.toml`, { cache: "no-store" })).text();
  check(toml.includes(`NETWORK_PASSPHRASE = "${n.passphrase}"`), "stellar.toml names the same network passphrase");
  check(toml.includes(`WEB_AUTH_CONTRACT_ID = "${a["web-auth"]}"`), "stellar.toml names the same web-auth contract");
  check(/SIGNING_KEY = "G[A-Z2-7]{55}"/.test(toml), "stellar.toml has a SIGNING_KEY (the sign-in key is set)");
  check(toml.includes(`WEB_AUTH_ENDPOINT = "${base}/api/auth"`) || toml.includes(`/api/auth"`), "stellar.toml's sign-in endpoint");
  const host = new URL(base).host;
  check(toml.includes(`://${host}/api/auth`), `stellar.toml's home domain is this host (${host}); otherwise set QUIETSTAY_HOME_DOMAIN`);

  console.log("\nOn chain:");
  try {
    execFileSync(
      "npx",
      ["tsx", "scripts/check-deployment.ts", "--network", n.network, "--rights", a.rights!, "--web-auth", a["web-auth"]!, "--verifier", a.verifier!, "--issuer", a.issuer!, "--arbiter", a.arbiter!, "--max-payment", a["max-payment"]!],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    check(true, "check-deployment");
  } catch {
    check(false, "check-deployment");
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
