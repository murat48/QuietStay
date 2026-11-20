#!/usr/bin/env bash
#
# The pilot arbiter resolves one Disputed rental escrow (docs/PHASE3_SPEC.md §5).
# There is no arbiter screen: this script is the arbiter's only tool.
#
#   scripts/arbiter-resolve.sh --network testnet --contract <C…> --escrow <id> \
#       --outcome pay-owner|refund-renter --decision <file> --arbiter <identity>
#
# The default network is none: it must be given, and mainnet needs the exact
# word `mainnet` (it then uses MAINNET_RPC_URL, default
# https://mainnet.sorobanrpc.com). The script:
#
#   1. checks that <identity>'s address is the contract's `arbiter()`;
#   2. reads the escrow and refuses unless it is Disputed;
#   3. hashes <decision> (the written decision) with SHA-256; only the hash
#      goes on chain, and the file is what anyone can re-hash to check it;
#   4. prints the escrow, its evidence hashes, and exactly who would be paid
#      how much;
#   5. simulates the call (`--send=no`) and stops if the contract refuses;
#   6. asks you to type RESOLVE, then sends it signed by <identity> from the
#      Stellar CLI keystore. This script never reads a secret key.
#
# `resolve` takes only an escrow id, an outcome and a hash. It can pay only the
# escrow's own owner or renter, only the escrow's own amount, and touches no
# right.

set -euo pipefail

usage() {
  echo "usage: $0 --network testnet|mainnet --contract <C…> --escrow <id> --outcome pay-owner|refund-renter --decision <file> --arbiter <identity>" >&2
  exit 64
}

NETWORK="" CONTRACT="" ESCROW="" OUTCOME="" DECISION="" ARBITER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="${2:-}"; shift 2 ;;
    --contract) CONTRACT="${2:-}"; shift 2 ;;
    --escrow) ESCROW="${2:-}"; shift 2 ;;
    --outcome) OUTCOME="${2:-}"; shift 2 ;;
    --decision) DECISION="${2:-}"; shift 2 ;;
    --arbiter) ARBITER="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$NETWORK" ] && [ -n "$CONTRACT" ] && [ -n "$ESCROW" ] && [ -n "$OUTCOME" ] && [ -n "$DECISION" ] && [ -n "$ARBITER" ] || usage

case "$NETWORK" in
  testnet)
    NET=(--network testnet)
    EXPERT="https://stellar.expert/explorer/testnet/tx"
    ;;
  mainnet)
    NET=(--rpc-url "${MAINNET_RPC_URL:-https://mainnet.sorobanrpc.com}" --network-passphrase "Public Global Stellar Network ; September 2015")
    EXPERT="https://stellar.expert/explorer/public/tx"
    ;;
  *) echo "the network must be given explicitly: testnet or mainnet" >&2; exit 64 ;;
esac
case "$OUTCOME" in
  pay-owner) VARIANT="PayOwner" ;;
  refund-renter) VARIANT="RefundRenter" ;;
  *) echo "the outcome is pay-owner or refund-renter" >&2; exit 64 ;;
esac
[[ "$CONTRACT" =~ ^C[A-Z2-7]{55}$ ]] || { echo "not a contract address: $CONTRACT" >&2; exit 64; }
[[ "$ESCROW" =~ ^[0-9]+$ ]] || { echo "the escrow id is a number" >&2; exit 64; }
[ -f "$DECISION" ] || { echo "no such decision file: $DECISION" >&2; exit 66; }

ADDRESS="$(stellar keys address "$ARBITER")"
read_call() {
  stellar contract invoke --id "$CONTRACT" --source-account "$ARBITER" "${NET[@]}" --send=no -- "$@"
}

echo "Network      $NETWORK"
echo "Contract     $CONTRACT"
echo "Arbiter      $ARBITER ($ADDRESS)"

ON_CHAIN_ARBITER="$(read_call arbiter | tr -d '"')"
if [ "$ON_CHAIN_ARBITER" != "$ADDRESS" ]; then
  echo "Refused: this contract's arbiter is $ON_CHAIN_ARBITER, not $ARBITER. Nothing was sent." >&2
  exit 1
fi

ESCROW_JSON="$(read_call get_escrow --escrow_id "$ESCROW")"
DECISION_HASH="$(sha256sum "$DECISION" | cut -d' ' -f1)"

# Print the escrow in plain words, and refuse unless it is Disputed.
if ! node -e '
  const e = JSON.parse(process.argv[1]);
  const outcome = process.argv[2];
  const units = BigInt(e.amount);
  const usdc = (u) => `${u / 10_000_000n}.${(u % 10_000_000n).toString().padStart(7, "0")}`.replace(/\.?0+$/, "");
  const state = Array.isArray(e.state) ? e.state[0] : e.state;
  const at = (s) => new Date(Number(s) * 1000).toISOString();
  console.log(`Escrow       #${e.id}, week #${e.right_id}, from offer #${e.offer_id}`);
  console.log(`State        ${state}`);
  console.log(`Amount       ${usdc(units)} USDC (${units} units)`);
  console.log(`Owner        ${e.owner}`);
  console.log(`Renter       ${e.renter}`);
  console.log(`Check-in     ${at(e.check_in)}; collectable from ${at(BigInt(e.check_in) + 86400n)}`);
  console.log(`Report       ${e.report_hash ?? "none"}`);
  for (const h of e.owner_evidence ?? []) console.log(`Evidence     owner  ${h}`);
  for (const h of e.renter_evidence ?? []) console.log(`Evidence     renter ${h}`);
  if (state !== "Disputed") {
    console.error(`Refused: the arbiter can act only on a Disputed escrow; this one is ${state}.`);
    process.exit(1);
  }
  const to = outcome === "PayOwner" ? `the owner, ${e.owner}` : `the renter, ${e.renter}`;
  console.log("");
  console.log(`Decision     ${outcome}: pay ${usdc(units)} USDC to ${to}`);
' "$ESCROW_JSON" "$VARIANT"; then
  echo "Nothing was sent." >&2
  exit 1
fi
echo "Decision file $DECISION"
echo "Decision hash $DECISION_HASH (SHA-256; goes on chain)"
echo

ARGS=(resolve --arbiter "$ADDRESS" --escrow_id "$ESCROW" --outcome "\"$VARIANT\"" --decision_hash "$DECISION_HASH")

echo "Simulating…"
if ! stellar contract invoke --id "$CONTRACT" --source-account "$ARBITER" "${NET[@]}" --send=no -- "${ARGS[@]}" > /dev/null; then
  echo "Refused by the contract in simulation. Nothing was sent." >&2
  exit 1
fi
echo "The simulation passed."
echo
echo "Command:"
echo "  stellar contract invoke --id $CONTRACT --source-account $ARBITER ${NET[*]} -- ${ARGS[*]}"
echo
read -r -p "Type RESOLVE to sign as $ARBITER and send to $NETWORK: " ANSWER
if [ "$ANSWER" != "RESOLVE" ]; then
  echo "Not sent." >&2
  exit 1
fi

OUT="$(stellar contract invoke --id "$CONTRACT" --source-account "$ARBITER" "${NET[@]}" -- "${ARGS[@]}" 2>&1)"
echo "$OUT"
# The CLI prints the explorer link of what it sent; the decision hash also
# appears in the output, so the hash is taken from that link only.
HASH="$(printf '%s\n' "$OUT" | grep -oE 'tx/[0-9a-f]{64}' | head -1 | cut -c4- || true)"
if [ -n "$HASH" ]; then
  echo
  echo "Sent: $EXPERT/$HASH"
fi
