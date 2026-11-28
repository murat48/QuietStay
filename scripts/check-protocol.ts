/**
 * The pinned protocol check (docs/PHASE3_SPEC.md §14): prints both networks'
 * protocol versions and fails unless mainnet is on protocol 30, the protocol
 * the contracts were tested for. It was 29 until mainnet moved to 30; the
 * checklist's protocol, simulation and cost items were re-run then and found
 * nothing changed for this contract (2026-11-27, docs/PHASE3_PROGRESS.md),
 * and 30 was set on your go-ahead (2026-11-28).
 *
 *   npx tsx scripts/check-protocol.ts
 *
 * Read-only: two `getNetwork` and two `getVersionInfo` calls. It runs at
 * Step 5 and again immediately before every mainnet transaction in Steps 6–7.
 * If mainnet has moved, mainnet work stops and the checklist's protocol,
 * simulation and cost items are re-run first.
 */

const EXPECTED_MAINNET = 30;
const NETWORKS = [
  { name: "testnet", rpc: "https://soroban-testnet.stellar.org", passphrase: "Test SDF Network ; September 2015" },
  { name: "mainnet", rpc: "https://mainnet.sorobanrpc.com", passphrase: "Public Global Stellar Network ; September 2015" },
] as const;

async function call(url: string, method: string): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
      if (!body.result) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function main() {
  let failed = false;
  console.log(`checked at ${new Date().toISOString()}`);
  for (const n of NETWORKS) {
    const net = await call(n.rpc, "getNetwork");
    const ver = await call(n.rpc, "getVersionInfo");
    const ok = net.passphrase === n.passphrase;
    console.log(
      `${n.name.padEnd(8)} protocol ${net.protocolVersion}  passphrase ${ok ? "ok" : `UNEXPECTED (${net.passphrase})`}  rpc ${n.rpc} (${ver.version})`,
    );
    if (!ok) failed = true;
    if (n.name === "mainnet" && net.protocolVersion !== EXPECTED_MAINNET) {
      console.log(`FAIL: mainnet is on protocol ${net.protocolVersion}, not ${EXPECTED_MAINNET}. Stop mainnet work and re-run the checklist's protocol, simulation and cost items.`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`PASS: mainnet is on protocol ${EXPECTED_MAINNET}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
