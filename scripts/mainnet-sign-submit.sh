#!/usr/bin/env bash
#
# Sign and submit one passkey-authorized transaction with a CLI identity
# (docs/PHASE3_SPEC.md §13, the mainnet signing flow; decision D6).
#
#   scripts/mainnet-sign-submit.sh <xdr-file> <identity> --network mainnet
#   scripts/mainnet-sign-submit.sh <xdr-file> <identity> --network testnet   # the rehearsal
#
# <xdr-file> holds the unsigned envelope the app showed: its source is the fee
# identity, and the smart wallet's authorization entry is already signed by
# the passkey. This script:
#
#   1. refuses unless the network and the identity are given explicitly;
#   2. prints, in plain words, what the envelope does (scripts/tx-review.ts):
#      every operation, contract, function, argument and authorization;
#   3. re-simulates and prints the fee and resources, and refuses if any amount
#      exceeds the D7 cap, if an authorization expires within 60 ledgers, or if
#      the source is not <identity>;
#   4. asks you to type SEND;
#   5. signs with `stellar tx sign --sign-with-key <identity>` and sends with
#      `stellar tx send`. The CLI keystore signs; this script never reads a key;
#   6. prints the hash and the Stellar Expert link.
#
# If the identity's sequence number moved since the app built the envelope
# (another transaction from it in between), sending fails: rebuild in the app.

set -euo pipefail

usage() {
  echo "usage: $0 <xdr-file> <identity> --network mainnet|testnet" >&2
  exit 64
}

[ $# -eq 4 ] || usage
XDR_FILE="$1"
IDENTITY="$2"
[ "$3" = "--network" ] || usage
NETWORK="$4"
case "$NETWORK" in
  mainnet) EXPERT="https://stellar.expert/explorer/public/tx" ;;
  testnet) EXPERT="https://stellar.expert/explorer/testnet/tx" ;;
  *) echo "the network must be given explicitly: mainnet or testnet" >&2; exit 64 ;;
esac
[ -f "$XDR_FILE" ] || { echo "no such file: $XDR_FILE" >&2; exit 66; }

cd "$(dirname "$0")/.."

SOURCE="$(stellar keys address "$IDENTITY")"
echo "Identity     $IDENTITY ($SOURCE)"
echo

if ! npx tsx scripts/tx-review.ts --xdr-file "$XDR_FILE" --network "$NETWORK" --source "$SOURCE"; then
  echo "Refused. Nothing was signed." >&2
  exit 1
fi

echo
read -r -p "Type SEND to sign as $IDENTITY and submit to $NETWORK: " ANSWER
if [ "$ANSWER" != "SEND" ]; then
  echo "Not sent." >&2
  exit 1
fi

SIGNED="$(stellar tx sign --sign-with-key "$IDENTITY" --network "$NETWORK" < "$XDR_FILE")"
HASH="$(printf '%s' "$SIGNED" | stellar tx hash --network "$NETWORK")"
printf '%s' "$SIGNED" | stellar tx send --network "$NETWORK" > /dev/null
echo
echo "Sent: $HASH"
echo "      $EXPERT/$HASH"
