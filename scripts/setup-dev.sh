#!/usr/bin/env bash
# DEVELOPMENT trusted setup for the ownership proof — NON-PRODUCTION.
#
#   npm run zk:setup
#
# Groth16 needs a setup per circuit. This one is run by the builder alone, on one
# machine, with one contribution to each phase. Whoever runs it could keep the
# randomness and forge proofs; nothing in this script keeps it, but nothing can
# prove that either. That is what "development setup" means, and it is why a
# forged proof would still need the holder's wallet signature to move a week.
# A production multi-party ceremony is Phase 3.
#
# Writes circuits/keys/: the proving key (transfer.zkey), the verification key
# (verification_key.json, the one fixed in the contract's constructor), the
# witness generator (transfer.wasm), and SHA256SUMS. The powers-of-tau files and
# the intermediate zkey are built in a temporary directory and deleted.
#
# Rerunning produces DIFFERENT keys — the contributions are random — and every
# proof made with the old keys stops verifying against the new ones.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
snarkjs="$root/node_modules/.bin/snarkjs"
build="$root/circuits/build"
keys="$root/circuits/keys"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 3,052 constraints for this circuit; 2^12 = 4,096 leaves room.
POWER=12
entropy() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

npm run -s zk:compile
mkdir -p "$keys"

echo "== phase 1: powers of tau on bls12-381, 2^$POWER (development, single contribution)"
"$snarkjs" powersoftau new bls12-381 "$POWER" "$work/pot_0000.ptau"
"$snarkjs" powersoftau contribute "$work/pot_0000.ptau" "$work/pot_0001.ptau" \
  --name="QuietStay development setup - NON-PRODUCTION" -e="$(entropy)"
"$snarkjs" powersoftau prepare phase2 "$work/pot_0001.ptau" "$work/pot_final.ptau"

echo "== phase 2: circuit-specific (development, single contribution)"
"$snarkjs" groth16 setup "$build/transfer.r1cs" "$work/pot_final.ptau" "$work/transfer_0000.zkey"
"$snarkjs" zkey contribute "$work/transfer_0000.zkey" "$keys/transfer.zkey" \
  --name="QuietStay development setup - NON-PRODUCTION" -e="$(entropy)"

echo "== checking the proving key against the circuit and the powers of tau"
"$snarkjs" zkey verify "$build/transfer.r1cs" "$work/pot_final.ptau" "$keys/transfer.zkey"

"$snarkjs" zkey export verificationkey "$keys/transfer.zkey" "$keys/verification_key.json"
cp "$build/transfer_js/transfer.wasm" "$keys/transfer.wasm"

( cd "$keys" && sha256sum transfer.zkey verification_key.json transfer.wasm \
    && cd "$build" && sha256sum transfer.r1cs ) > "$work/SHA256SUMS"
mv "$work/SHA256SUMS" "$keys/SHA256SUMS"
cat "$keys/SHA256SUMS"
echo "== done. Development keys in circuits/keys/ — NON-PRODUCTION."
