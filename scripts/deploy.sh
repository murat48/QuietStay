#!/usr/bin/env bash
#
# Build and deploy the QuietStay rights registry to Stellar testnet.
#
#   ./scripts/deploy.sh
#
# Prints the contract address. Put it in .env.local as both
# QUIETSTAY_CONTRACT_ID and NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID, then run
# `npm run seed`.
#
# Requires: stellar-cli 27+, and an identity named qs-issuer funded on testnet:
#   stellar keys generate qs-issuer --fund --network testnet

set -euo pipefail

ISSUER_ALIAS="${ISSUER_ALIAS:-qs-issuer}"
TOKEN_NAME="${TOKEN_NAME:-QuietStay Usage Right}"
TOKEN_SYMBOL="${TOKEN_SYMBOL:-QSTAY}"

cd "$(dirname "$0")/.."

echo "==> Running contract tests"
(cd contracts && cargo test --quiet)

echo "==> Building WASM"
(cd contracts && stellar contract build)

WASM="contracts/target/wasm32v1-none/release/quietstay_rights.wasm"
echo "==> WASM size: $(stat -c %s "$WASM") bytes (limit 65536)"

echo "==> Deploying to testnet as ${ISSUER_ALIAS}"
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ISSUER_ALIAS" \
  --network testnet \
  -- \
  --issuer "$ISSUER_ALIAS" \
  --name "$TOKEN_NAME" \
  --symbol "$TOKEN_SYMBOL" 2>/dev/null | tail -1)

echo
echo "Contract:  ${CONTRACT_ID}"
echo "Explorer:  https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"
echo
echo "Add to .env.local:"
echo "  QUIETSTAY_CONTRACT_ID=${CONTRACT_ID}"
echo "  NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=${CONTRACT_ID}"
