/**
 * Read-only: is a WASM already uploaded on a network, and how long does it
 * stay live? It reads the contract-code ledger entry by its hash
 * (`getLedgerEntries`). Nothing is signed or sent, and no key is used.
 *
 *   npx tsx scripts/check-mainnet-wasm.ts [--network mainnet|testnet] <sha256 hex> [...]
 *
 * With no hashes it checks the four WASMs the pilot uses: the rights
 * contract, the SEP-45 web-auth contract, the OpenZeppelin smart account and
 * the OpenZeppelin WebAuthn verifier.
 *
 * Reusing an uploaded WASM means a new instance of our own is created from
 * that code (a deploy with `--wasm-hash`). Its code is immutable and
 * addressed by its hash, so whoever uploaded it has no control over it.
 * Someone else's contract instance is never used.
 */

import { parseArgs } from "node:util";

import { rpc, xdr } from "@stellar/stellar-sdk";

const NETS = {
  mainnet: { url: "https://mainnet.sorobanrpc.com", passphrase: "Public Global Stellar Network ; September 2015" },
  testnet: { url: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
} as const;

const KNOWN: Record<string, string> = {
  "76d69e790aba28131d25188c3ea7a63ed8eb8faaa75e34d9b0038300244dddde": "QuietStay rights (final, Step 5)",
  "708cacdcb458f9790bb27da0c706aefe40f299e25cd97798e24547792ef4cbc1": "SEP-45 web-auth (Anchor Platform @ dc5817fb, our build)",
  c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1: "OpenZeppelin smart account (stellar-accounts v0.8.0)",
  e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76: "OpenZeppelin WebAuthn verifier",
};

const SECONDS_PER_LEDGER = 5;

async function main() {
  const { values: a, positionals } = parseArgs({
    allowPositionals: true,
    options: { network: { type: "string", default: "mainnet" } },
  });
  const netName = a.network as keyof typeof NETS;
  const net = NETS[netName];
  if (!net) throw new Error("--network must be mainnet or testnet");
  const hashes = positionals.length ? positionals : Object.keys(KNOWN);
  for (const h of hashes) if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`not a sha256 hex: ${h}`);

  const server = new rpc.Server(net.url);
  const info = await server.getNetwork();
  if (info.passphrase !== net.passphrase) throw new Error(`unexpected network: ${info.passphrase}`);
  const keys = hashes.map((h) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(h, "hex") })));
  const res = await server.getLedgerEntries(...keys);
  const latest = res.latestLedger;
  const found = new Map<string, rpc.Api.LedgerEntryResult>();
  for (const e of res.entries) found.set(Buffer.from(e.key.contractCode().hash()).toString("hex"), e);

  console.log(`${netName} (${net.url}), protocol ${info.protocolVersion}, latest ledger ${latest}, read ${new Date().toISOString()}`);
  console.log("read only: getLedgerEntries; nothing signed or sent");
  for (const h of hashes) {
    const e = found.get(h);
    const name = KNOWN[h] ?? "";
    if (!e) {
      console.log(`  ${h}  NOT UPLOADED (or archived)   ${name}`);
      continue;
    }
    const code = e.val.contractCode();
    const bytes = code.code().length;
    const until = e.liveUntilLedgerSeq ?? 0;
    const left = until - latest;
    const days = ((left * SECONDS_PER_LEDGER) / 86400).toFixed(1);
    const state = left >= 0 ? `live until ledger ${until} (${left} ledgers, ~${days} days)` : `ARCHIVED since ledger ${until}`;
    console.log(`  ${h}  UPLOADED, ${bytes} B, ${state}   ${name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
