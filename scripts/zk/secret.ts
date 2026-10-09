/**
 * Make a record secret and print the hash that may be shared.
 *
 *   npm run zk:secret -- <out-file>
 *
 * Writes { "secret": s } to <out-file> (created with mode 600, refused if it
 * exists) and prints h = Poseidon(s).
 *
 * Who runs this:
 *   - an owner, before issuance: send h to the issuer, which computes the
 *     commitment. The issuer never sees s.
 *   - a buyer, before a sale: send h — as h' — to the seller, who proves with it,
 *     and sign it when the sale is submitted.
 *
 * s never leaves the file. Lose it and the week can still be used, but never
 * rented out or sold again.
 */

import { existsSync, writeFileSync } from "node:fs";
import { fatal, log, requireArg } from "../lib/cli";
import { randomSecret, secretHash } from "../lib/zk";

async function main() {
  const out = requireArg(0, "npm run zk:secret -- <out-file>");
  if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a secret`);
  const s = randomSecret();
  writeFileSync(out, JSON.stringify({ secret: s.toString() }, null, 2) + "\n", { mode: 0o600 });
  const h = await secretHash(s);
  log.ok(`wrote ${out} — keep it private`);
  log.info(`h (shareable): ${h.toString()}`);
  process.exit(0);
}

main().catch(fatal);
