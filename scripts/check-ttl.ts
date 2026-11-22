/**
 * Read-only: how long the entries a deployment needs stay live
 * (`getLedgerEntries`; nothing signed or sent, no key used).
 *
 *   npx tsx scripts/check-ttl.ts --network testnet [--until 2027-03-31]
 *   npx tsx scripts/check-ttl.ts --network mainnet --rights C… --web-auth C… --verifier C… [--until …]
 *
 * It checks the four code entries (the rights, web-auth, OZ account and OZ
 * WebAuthn verifier WASMs) and the three contract instances (rights, web-auth
 * and QuietStay's own verifier). On testnet the instances default to the demo
 * deployment. For each it prints the live-until ledger, the ledgers left and
 * the date that is, at 5 s per ledger, an estimate. With `--until` it fails
 * if any entry ends before that date (UTC midnight).
 *
 * Re-extend with, for each entry (anyone may; up to max_entry_ttl − 1 =
 * 3,110,399 ledgers on both networks):
 *   stellar contract extend --wasm-hash <hash> --durability persistent --ledgers-to-extend 3110399 --source <identity> --network <net>
 *   stellar contract extend --id <C…>          --durability persistent --ledgers-to-extend 3110399 --source <identity> --network <net>
 */

import { parseArgs } from "node:util";

import { Address, rpc, xdr } from "@stellar/stellar-sdk";

const NETS = {
  mainnet: { url: "https://mainnet.sorobanrpc.com", passphrase: "Public Global Stellar Network ; September 2015" },
  testnet: { url: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
} as const;

const CODE: Record<string, string> = {
  "rights WASM": "76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde",
  "web-auth WASM": "708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1",
  "OZ account WASM": "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1",
  "OZ verifier WASM": "e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76",
};

/** The testnet demo (docs/PHASE3_PROGRESS.md, Addresses). */
const TESTNET_DEMO = {
  rights: "CATUBRZZG47HJDHFK3R7Y3TS3RM2LQ5ROCBY4ISDWSW4PR62DZGXFVLM",
  "web-auth": "CBCDSOZPADHMM742JKTM7RBEYJQ7ZPDP6AZ4TU4LFHJ5WHMGCMWF5KGM",
  verifier: "CBK3H55VKCKZ4LRIZSETP3ZYP4OI4IIBN3SCCCFNYI5WDFC45PSWWEEL",
};

async function main() {
  const { values: a } = parseArgs({
    options: {
      network: { type: "string" },
      rights: { type: "string" },
      "web-auth": { type: "string" },
      verifier: { type: "string" },
      until: { type: "string" },
    },
  });
  const name = a.network as keyof typeof NETS;
  const net = NETS[name];
  if (!net) throw new Error("--network mainnet|testnet is required");
  const inst = {
    rights: a.rights ?? (name === "testnet" ? TESTNET_DEMO.rights : ""),
    "web-auth": a["web-auth"] ?? (name === "testnet" ? TESTNET_DEMO["web-auth"] : ""),
    verifier: a.verifier ?? (name === "testnet" ? TESTNET_DEMO.verifier : ""),
  };
  const server = new rpc.Server(net.url);
  const info = await server.getNetwork();
  if (info.passphrase !== net.passphrase) throw new Error(`unexpected network: ${info.passphrase}`);

  const rows: { label: string; key: xdr.LedgerKey }[] = [];
  for (const [label, h] of Object.entries(CODE)) {
    rows.push({ label: `${label} ${h.slice(0, 8)}…`, key: xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(h, "hex") })) });
  }
  for (const [label, id] of Object.entries(inst)) {
    if (!id) continue;
    rows.push({
      label: `${label} instance ${id.slice(0, 8)}…`,
      key: xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(id).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      ),
    });
  }
  const res = await server.getLedgerEntries(...rows.map((r) => r.key));
  const latest = res.latestLedger;
  const now = Date.now();
  const byKey = new Map(res.entries.map((e) => [e.key.toXDR("base64"), e]));
  const deadline = a.until ? Date.parse(`${a.until}T00:00:00Z`) : null;

  console.log(`${name}, latest ledger ${latest}, read ${new Date(now).toISOString()} (read only; nothing signed or sent)`);
  let fail = 0;
  for (const r of rows) {
    const e = byKey.get(r.key.toXDR("base64"));
    if (!e) {
      console.log(`  FAIL  ${r.label.padEnd(34)} not found (archived, or never created)`);
      fail++;
      continue;
    }
    const until = e.liveUntilLedgerSeq ?? 0;
    const left = until - latest;
    const date = new Date(now + left * 5000);
    const ok = left > 0 && (deadline === null || date.getTime() >= deadline);
    if (!ok) fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${r.label.padEnd(34)} live until ${until} (${left} ledgers, ~${date.toISOString().slice(0, 10)})`);
  }
  if (deadline !== null) console.log(`required: every entry live through ${a.until}`);
  console.log(fail ? `\n${fail} entr${fail === 1 ? "y" : "ies"} FAILED` : "\nall entries live");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
