/**
 * Write the verification key in the contract's byte layout.
 *
 *   npm run zk:encode-vk
 *
 * circuits/keys/verification_key.json (snarkjs) → circuits/keys/verification_key.soroban.json,
 * the exact value passed to the contract's constructor at deployment.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fatal, log } from "../lib/cli";
import { encodeVerificationKey } from "../lib/zk-encode";

const IN = "circuits/keys/verification_key.json";
const OUT = "circuits/keys/verification_key.soroban.json";

try {
  const vk = encodeVerificationKey(JSON.parse(readFileSync(IN, "utf8")));
  writeFileSync(OUT, JSON.stringify(vk, null, 2) + "\n");
  log.ok(`wrote ${OUT} (${vk.ic.length} ic points)`);
} catch (e) {
  fatal(e);
}
