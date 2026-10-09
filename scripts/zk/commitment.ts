/**
 * Compute the commitment the issuer stores at issuance.
 *
 *   npm run zk:commitment -- --record <record.json> --owner <G…> --secret-hash <h>
 *
 * C = Poseidon_5(d_hi, d_lo, a_hi, a_lo, h)  (docs/CIRCUIT.md §2), printed as the
 * 32-byte hex the contract's `issue` takes. The issuer runs this with the `h` the
 * owner sent (`npm run zk:secret`); it never needs, or sees, the owner's secret.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { JsonValue } from "../../src/lib/canonical";
import { fatal, log } from "../lib/cli";
import { commitment, splitRecordDigest } from "../lib/zk";
import { fr } from "../lib/zk-encode";

async function main() {
  const { values: a } = parseArgs({
    options: { record: { type: "string" }, owner: { type: "string" }, "secret-hash": { type: "string" } },
  });
  if (!a.record || !a.owner || !a["secret-hash"]) {
    throw new Error("usage: npm run zk:commitment -- --record <file> --owner <G…> --secret-hash <h>");
  }
  const d = await splitRecordDigest(JSON.parse(readFileSync(a.record, "utf8")) as JsonValue);
  const c = await commitment(d, a.owner, BigInt(a["secret-hash"]));
  log.info(`record digest d   ${d.hex}`);
  log.info(`commitment C      ${fr(c)}`);
  console.log(fr(c));
  process.exit(0);
}

main().catch(fatal);
