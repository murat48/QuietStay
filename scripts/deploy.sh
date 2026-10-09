#!/usr/bin/env bash
#
# Build and deploy the QuietStay rights registry to Stellar testnet.
#
#   ./scripts/deploy.sh
#
# Prints the contract address. Put it in .env.local as both
# QUIETSTAY_CONTRACT_ID and NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID, then run
# `npm run zk:reissue -- <contract>` to issue the sample inventory.
#
# The verification key in circuits/keys/ is fixed in the constructor and can
# never be changed on this deployment. It comes from the development trusted
# setup (npm run zk:setup) — non-production.
#
# Requires: stellar-cli 27+, and an identity named qs-issuer funded on testnet:
#   stellar keys generate qs-issuer --fund --network testnet

set -euo pipefail

ISSUER_ALIAS="${ISSUER_ALIAS:-qs-issuer}"
TOKEN_NAME="${TOKEN_NAME:-QuietStay Usage Rights}"
TOKEN_SYMBOL="${TOKEN_SYMBOL:-QSTAY}"

cd "$(dirname "$0")/.."

echo "==> Running contract tests"
(cd contracts && cargo test --quiet)

echo "==> Building WASM"
(cd contracts && stellar contract build)

WASM="contracts/target/wasm32v1-none/release/quietstay_rights.wasm"
echo "==> WASM size: $(stat -c %s "$WASM") bytes (limit 65536)"

VK="$(node -e 'process.stdout.write(JSON.stringify(require("./circuits/keys/verification_key.soroban.json")))')"

echo "==> Deploying to testnet as ${ISSUER_ALIAS}, verification key from circuits/keys/"
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ISSUER_ALIAS" \
  --network testnet \
  -- \
  --issuer "$ISSUER_ALIAS" \
  --name "$TOKEN_NAME" \
  --symbol "$TOKEN_SYMBOL" \
  --verification_key "$VK" 2>/dev/null | tail -1)

echo
echo "Contract:  ${CONTRACT_ID}"
echo "Explorer:  https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"
echo
echo "Add to .env.local:"
echo "  QUIETSTAY_CONTRACT_ID=${CONTRACT_ID}"
echo "  NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=${CONTRACT_ID}"
