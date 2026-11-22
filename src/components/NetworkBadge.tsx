import { CLI_SIGNING, IS_MAINNET, NETWORK_LABEL } from "@/lib/config";

/**
 * The deployment's network, shown in every header (Step 6: "show the active
 * network clearly on every screen"). Mainnet gets its own colour, and stays
 * visible on narrow screens.
 *
 * A testnet deployment in `cli` mode (the mainnet-like rehearsal) says so, so
 * it is never mistaken for the testnet demo.
 */
export function NetworkBadge() {
  const rehearsal = !IS_MAINNET && CLI_SIGNING;
  return (
    <span
      className={`network-label${IS_MAINNET ? " network-mainnet" : ""}`}
      title={IS_MAINNET ? "Stellar mainnet: real USDC" : rehearsal ? "Stellar testnet, configured like mainnet (CLI signing)" : "Stellar testnet"}
    >
      {NETWORK_LABEL}
      {rehearsal ? " · CLI signing" : ""}
    </span>
  );
}

/** One line for footers: which network, and what moves on it. */
export function networkDisclosure(): string {
  if (IS_MAINNET) return "Stellar mainnet pilot · Real USDC, at most 1 USDC per payment · Usage rights only, no legal title transfer.";
  if (CLI_SIGNING) return "Stellar testnet, configured like mainnet (CLI signing) · Testnet USDC · Usage rights only, no legal title transfer.";
  return "Stellar testnet demo · Testnet USDC · Usage rights only, no legal title transfer.";
}
