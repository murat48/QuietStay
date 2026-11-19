/**
 * Deploy the vendored SEP-45 web-auth contract (contracts/vendor/anchor-web-auth/).
 *
 *   npx tsx scripts/deploy-web-auth.ts --network testnet --source <identity>
 *   npx tsx scripts/deploy-web-auth.ts --print-admin
 *
 * The contract's constructor takes an `admin`, which gates its `upgrade`.
 * QuietStay passes an address nobody can authorize (PINNED.md): the contract
 * address whose id is SHA-256("QuietStay SEP-45 web-auth: no admin"). This
 * script computes that address, refuses any WASM other than the one built
 * from the pinned source, and deploys with the CLI. The identity signs
 * through the CLI keystore; no key is read here.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StrKey } from "@stellar/stellar-sdk";

export const NO_ADMIN_LABEL = "QuietStay SEP-45 web-auth: no admin";
export const WEB_AUTH_WASM = "contracts/vendor/anchor-web-auth/target/wasm32v1-none/release/web_auth.wasm";
export const WEB_AUTH_WASM_SHA256 = "708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1";

export function noAdminAddress(): string {
  return StrKey.encodeContract(createHash("sha256").update(NO_ADMIN_LABEL).digest());
}

function main() {
  const { values: a } = parseArgs({
    options: { network: { type: "string" }, source: { type: "string" }, "print-admin": { type: "boolean" } },
  });
  const admin = noAdminAddress();
  if (a["print-admin"]) {
    console.log(admin);
    return;
  }
  if (a.network !== "testnet" && a.network !== "mainnet") throw new Error("--network testnet|mainnet is required");
  if (!a.source) throw new Error("--source <identity> is required");
  const hash = createHash("sha256").update(readFileSync(WEB_AUTH_WASM)).digest("hex");
  if (hash !== WEB_AUTH_WASM_SHA256) throw new Error(`the WASM is ${hash}, not the pinned build ${WEB_AUTH_WASM_SHA256}`);
  console.log(`admin (unauthorizable): ${admin}`);
  const out = execFileSync(
    "stellar",
    ["contract", "deploy", "--wasm", WEB_AUTH_WASM, "--source", a.source, "--network", a.network, "--", "--admin", admin],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  console.log(`web-auth contract: ${out.trim().split("\n").pop()}`);
}

if (process.argv[1]?.endsWith("deploy-web-auth.ts")) main();
