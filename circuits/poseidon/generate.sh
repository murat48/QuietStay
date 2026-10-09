#!/usr/bin/env bash
# Regenerate circuits/poseidon/raw/ with the Poseidon authors' reference tooling,
# then rebuild the derived files. Needs git, python3, docker and node.
#
#   bash circuits/poseidon/generate.sh
#
# The reference repository and the SageMath image are pinned, and the Grain LFSR
# the tool uses is deterministic, so a rerun reproduces raw/ byte for byte —
# `git diff circuits/poseidon` after running this should be empty.
#
# You do not need to run this to check the constants: `npm run zk:check-poseidon`
# works offline from the committed raw/ output.

set -euo pipefail

HADES_REPO=https://extgit.iaik.tugraz.at/krypto/hadeshash.git
HADES_COMMIT=208b5a164c6a252b137997694d90931b2bb851c5
SAGE_IMAGE=sagemath/sagemath@sha256:8d657a42f33a407b8dbc9a3cb5818cb6b4df8aacc7b291ba675132ee55d4db73   # 10.4

BLS12_381_R=0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
BN254_R=0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet "$HADES_REPO" "$work/hadeshash"
git -C "$work/hadeshash" checkout --quiet "$HADES_COMMIT"
code="$work/hadeshash/code"

# 1. Round numbers, from the authors' calc_round_numbers.py: x^5 S-box, 128-bit
#    security, with security margin. Its module-level demo output needs
#    pycryptodome for getPrime(); only the function definitions above it are run.
#    R_P is then rounded up to a multiple of t, the rule that gives circomlib's
#    BN254 table (56, 57, 56, 60, 60, 63, …) exactly.
python3 - "$code/calc_round_numbers.py" "$BLS12_381_R" "$BN254_R" <<'PY'
import sys, types
for name in ("Crypto", "Crypto.Util", "Crypto.Util.number"):
    sys.modules[name] = types.ModuleType(name)
src = open(sys.argv[1]).read().split("\n")
exec("\n".join(src[:97]))
for label, p in (("BLS12-381", int(sys.argv[2], 16)), ("BN254", int(sys.argv[3], 16))):
    for t in (2, 3, 5, 6, 7):
        R_F, R_P = calc_final_numbers_fixed(p, t, 5, 128, True)[:2]
        print(f"{label:9} t={t}  R_F={R_F}  R_P={R_P}  rounded to multiple of t: {-(-R_P // t) * t}")
PY

# 2. Round constants and MDS matrices. Arguments: field=1 (GF(p)), s_box=0
#    (x^alpha, alpha=5), field size in bits, t, R_F, R_P, prime.
sage() { docker run --rm -v "$code:/w" -w /w "$SAGE_IMAGE" sage generate_parameters_grain.sage "$@" 2>/dev/null; }

for t_rp in "2 56" "3 57" "5 60" "6 60" "7 63"; do
  set -- $t_rp
  sage 1 0 255 "$1" 8 "$2" "$BLS12_381_R" > "$here/raw/bls12381_t$1.txt"
done
# BN254 at the circuit's widths — only to show the procedure reproduces circomlib.
for t_rp in "2 56" "6 60" "7 63"; do
  set -- $t_rp
  sage 1 0 254 "$1" 8 "$2" "$BN254_R" > "$here/raw/bn254_t$1.txt"
done
cp "$code/test_vectors.txt" "$here/raw/hadeshash_test_vectors.txt"

# 3. Derived files: bls12381.json, bls12381_opt.json, ../gpl/poseidon_constants_bls12381.circom.
node "$here/build.mjs"
