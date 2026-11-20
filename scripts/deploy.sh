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
# Phase 3 (D7): the arbiter, the USDC contract and the payment cap are fixed in
# the constructor too, so one WASM serves both networks. This script deploys
# to testnet only: USDC is Circle's testnet SAC and the cap is 100 USDC
# (1,000,000,000 units). Mainnet is Step 6, with its own approved commands.
#
# Requires: stellar-cli 30.0.1, and two identities you created:
#   qs-issuer   (issuer, funded on testnet)
#   qs-arbiter  (the pilot arbiter; a separate address, never the issuer)

set -euo pipefail

ISSUER_ALIAS="${ISSUER_ALIAS:-qs-issuer}"
ARBITER_ALIAS="${ARBITER_ALIAS:-qs-arbiter}"
# Circle's testnet USDC SAC (docs/PHASE3_SPEC.md §4).
USDC_TESTNET="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
MAX_PAYMENT_TESTNET="1000000000"
TOKEN_NAME="${TOKEN_NAME:-QuietStay Usage Rights}"
TOKEN_SYMBOL="${TOKEN_SYMBOL:-QSTAY}"

cd "$(dirname "$0")/.."

echo "==> Running contract tests"
(cd contracts && cargo test --quiet)

echo "==> Building WASM"
(cd contracts && stellar contract build)

WASM="contracts/target/wasm32v1-none/release/quietstay_rights.wasm"
echo "==> WASM size: $(stat -c %s "$WASM") bytes (limit 131072)"
echo "==> WASM sha256: $(sha256sum "$WASM" | cut -d' ' -f1)"

VK="$(node -e 'process.stdout.write(JSON.stringify(require("./circuits/keys/verification_key.soroban.json")))')"

echo "==> Deploying to testnet as ${ISSUER_ALIAS}, verification key from circuits/keys/"
CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ISSUER_ALIAS" \
  --network testnet \
  -- \
  --issuer "$ISSUER_ALIAS" \
  --arbiter "$ARBITER_ALIAS" \
  --usdc "$USDC_TESTNET" \
  --name "$TOKEN_NAME" \
  --symbol "$TOKEN_SYMBOL" \
  --verification_key "$VK" \
  --max_payment "$MAX_PAYMENT_TESTNET" 2>/dev/null | tail -1)

echo
echo "Contract:  ${CONTRACT_ID}"
echo "Explorer:  https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"
echo
echo "Add to .env.local:"
echo "  QUIETSTAY_CONTRACT_ID=${CONTRACT_ID}"
echo "  NEXT_PUBLIC_QUIETSTAY_CONTRACT_ID=${CONTRACT_ID}"
