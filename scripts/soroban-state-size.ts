/**
 * Read-only: each network's live Soroban state size, which scales the rent
 * rate (the `soroban-state-size-<date>.json` the mainnet fee estimate reads,
 * `cargo test -p quietstay-rights mainnet_fees -- --ignored`).
 *
 *   npx tsx scripts/soroban-state-size.ts > evidence/checklist/soroban-state-size-<date>.json
 *
 * It reads the `LiveSorobanStateSizeWindow` config setting with
 * `getLedgerEntries`: the state size over the last ledgers sampled. Nothing is
 * signed or sent, and no key is used.
 */

import { rpc, xdr } from "@stellar/stellar-sdk";

const NETS = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
} as const;

async function read(url: string) {
  const server = new rpc.Server(url);
  const key = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingLiveSorobanStateSizeWindow() }),
  );
  const res = await server.getLedgerEntries(key);
  const entry = res.entries[0];
  if (!entry) throw new Error(`${url}: no LiveSorobanStateSizeWindow entry`);
  const window = entry.val.configSetting().liveSorobanStateSizeWindow().map((n) => BigInt(n.toString()));
  const sum = window.reduce((a, b) => a + b, 0n);
  return {
    ledger: res.latestLedger,
    window_len: window.length,
    average_bytes: (sum / BigInt(window.length)).toString(),
    latest_bytes: window[window.length - 1]!.toString(),
  };
}

async function main() {
  const out: Record<string, unknown> = {};
  for (const [name, url] of Object.entries(NETS)) out[name] = await read(url);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
