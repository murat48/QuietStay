/**
 * Issue the sample inventory on a Phase 2 contract, with Poseidon commitments.
 *
 *   npm run zk:reissue -- <contract id> [--out <issued.json>]
 *
 * For each record in inventory/records/, as its owner and then as the issuer:
 *
 *   1. the owner makes a record secret s (or reuses one already made for this
 *      contract) in .secrets/<first 8 of the contract id>/week-NN-owner.json —
 *      gitignored, mode 600 — and hands over only h = Poseidon(s);
 *   2. the issuer computes C = Poseidon(d, owner, h) and calls `issue`.
 *
 * Writes inventory/phase2/issued.json — the record of the evidence deployment —
 * or, with --out, anywhere else. It refuses to overwrite that file with another
 * contract's issuance, so a rehearsal on a throwaway contract cannot clobber it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { explorer, issuerSecret } from "../../src/lib/config";
import type { JsonValue } from "../../src/lib/canonical";
import { fatal, loadEnv, log, requireArg, writeJson } from "../lib/cli";
import { commitment, randomSecret, secretHash, splitRecordDigest } from "../lib/zk";
import { fr } from "../lib/zk-encode";
import { buildCall, issueArgs, sendAndWait, simulate } from "../lib/zk-tx";
import { rpc } from "@stellar/stellar-sdk";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

interface RecordFile {
  owner: { stellar_account: string };
  week: { check_in: string; check_out: string; use_year: number };
}

async function main() {
  loadEnv();
  const contractId = requireArg(0, "npm run zk:reissue -- <contract id> [--out <issued.json>]");
  const outAt = process.argv.indexOf("--out");
  const outFile = outAt === -1 ? "inventory/phase2/issued.json" : process.argv[outAt + 1]!;
  if (outFile === "inventory/phase2/issued.json" && existsSync(outFile)) {
    const current = (JSON.parse(readFileSync(outFile, "utf8")) as { contract: string }).contract;
    if (current !== contractId) {
      throw new Error(
        `${outFile} records ${current}; issuing on ${contractId} would overwrite it — pass --out <file>`,
      );
    }
  }
  const issuer = Keypair.fromSecret(issuerSecret());
  const secretsDir = join(".secrets", contractId.slice(0, 8));
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const rights = [];
  for (const file of readdirSync("inventory/records").filter((f) => /^week-\d+\.json$/.test(f)).sort()) {
    const path = join("inventory/records", file);
    const record = JSON.parse(readFileSync(path, "utf8")) as RecordFile;
    const label = file.replace(/\.json$/, "");
    const owner = record.owner.stellar_account;
    log.step(`${label} → ${owner}`);

    // The owner's side: a secret that never leaves their machine, and its hash.
    const secretFile = join(secretsDir, `${label}-owner.json`);
    if (!existsSync(secretFile)) {
      writeFileSync(secretFile, JSON.stringify({ secret: randomSecret().toString() }, null, 2) + "\n", { mode: 0o600 });
      log.info(`made a secret in ${secretFile}`);
    }
    const s = BigInt((JSON.parse(readFileSync(secretFile, "utf8")) as { secret: string }).secret);
    const h = await secretHash(s);

    // The issuer's side: only h crosses over.
    const d = await splitRecordDigest(record as unknown as JsonValue);
    const c = fr(await commitment(d, owner, h));
    const period = { start: day(record.week.check_in), end: day(record.week.check_out) };
    const validity = { from: day(`${record.week.use_year}-01-01`), until: day(`${record.week.use_year + 1}-01-01`) };

    const tx = await buildCall(issuer.publicKey(), contractId, "issue", issueArgs(owner, period, validity, c));
    const sim = await simulate(tx);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(issuer);
    const out = await sendAndWait(prepared);
    if (!out.successful) throw new Error(`issue failed: ${out.opResult} ${out.errors.join(" ")}`);
    const rightId = Number(scValToNative(out.returnValue as never));
    log.ok(`right #${rightId}, commitment ${c.slice(0, 16)}…`);
    log.link("issued", explorer.tx(out.hash));

    rights.push({
      right_id: rightId,
      record_file: path,
      week: { check_in: record.week.check_in, check_out: record.week.check_out },
      period,
      validity,
      owner,
      record_digest: d.hex,
      commitment: c,
      issue_tx: out.hash,
      owner_secret_file: secretFile,
    });
  }

  writeJson(outFile, {
    contract: contractId,
    network: "testnet",
    issued_on: new Date().toISOString().slice(0, 10),
    note:
      "Phase 2 sample inventory: each commitment is C = Poseidon(d, owner, h) per docs/CIRCUIT.md §2, " +
      "where d is the record's SHA-256 digest. Owner secrets are local files and are not in the repository.",
    rights,
  });
  log.ok(`wrote ${outFile}`);
  process.exit(0);
}

main().catch(fatal);
