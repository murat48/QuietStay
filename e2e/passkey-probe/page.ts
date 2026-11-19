/**
 * Browser half of the passkey probe (docs/PHASE3_PROMPT.md Step 2: "confirm the
 * pinned versions with one real passkey-authorized testnet transaction").
 *
 * Bundled by e2e/passkey-probe/probe.ts with esbuild and served from localhost.
 * It only drives smart-account-kit: create a passkey and its wallet, connect,
 * and sign one authorization entry. Building, paying for and submitting
 * transactions happens in Node, from a fee account the CLI signs for.
 *
 * No indexer and no relayer: `indexerUrl: false` and no `relayerUrl`, so the
 * kit talks only to Stellar RPC and Horizon (spec §12).
 */

import { IndexedDBStorage, SmartAccountKit } from "smart-account-kit";

declare global {
  interface Window {
    probe: {
      create(): Promise<{ contractId: string; credentialId: string; func: string; auth: string[] }>;
      recordDeployment(credentialId: string, hash: string, ledger: number): Promise<void>;
      connect(contractId: string, credentialId: string): Promise<string | null>;
      sign(entry: string, expiration: number): Promise<string>;
    };
    probeConfig: { rpcUrl: string; networkPassphrase: string; accountWasmHash: string; webauthnVerifierAddress: string };
  }
}

const cfg = window.probeConfig;
const storage = new IndexedDBStorage();
const kit = new SmartAccountKit({
  rpcUrl: cfg.rpcUrl,
  networkPassphrase: cfg.networkPassphrase,
  accountWasmHash: cfg.accountWasmHash,
  webauthnVerifierAddress: cfg.webauthnVerifierAddress,
  indexerUrl: false,
  storage,
  rpName: "QuietStay (passkey probe)",
});

window.probe = {
  async create() {
    const r = await kit.createWallet("QuietStay", "passkey-probe", { autoSubmit: false });
    if (!r.relayerPayload) throw new Error("expected the shared-deployer {func, auth} payload");
    return { contractId: r.contractId, credentialId: r.credentialId, ...r.relayerPayload };
  },
  // With no indexer, the kit connects from the stored credential's birth claim:
  // the creation transaction we submitted ourselves. connectWallet still checks
  // that transaction on chain (code hash, deployer, salt, constructor args)
  // before it trusts the claim.
  async recordDeployment(credentialId, hash, ledger) {
    await storage.update(credentialId, {
      birthWasmHash: cfg.accountWasmHash,
      creationTransactionHash: hash,
      deploymentTransactionHash: hash,
      creationLedger: ledger,
    });
  },
  async connect(contractId, credentialId) {
    const r = await kit.connectWallet({ contractId, credentialId });
    return r?.contractId ?? null;
  },
  // Rule 0 is the wallet's default rule, whose only signer is this passkey.
  sign(entry, expiration) {
    return kit.signAuthEntry(entry, { contextRuleIds: [0], expiration });
  },
};
