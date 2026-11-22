#!/usr/bin/env bash
#
# Sign and submit one passkey-authorized transaction with a CLI identity
# (docs/PHASE3_SPEC.md §13, the mainnet signing flow; decision D6).
#
#   scripts/mainnet-sign-submit.sh <xdr-file> <identity> --network mainnet
#   scripts/mainnet-sign-submit.sh <xdr-file> <identity> --network testnet            # the rehearsal
#   scripts/mainnet-sign-submit.sh <xdr-file> <identity> --network mainnet --resume   # after a failed submission
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
#   5. signs with `stellar tx sign --sign-with-key <identity>`. The CLI keystore
#      signs; this script never reads a key. The signed envelope and its hash
#      are saved in <xdr-file>.submission/ before anything is sent;
#   6. submits it, then confirms it by hash (the recovery rule below);
#   7. prints the hash and the Stellar Expert link.
#
# **Submission recovery (pre-launch checklist item, Step 5).** If a
# submission fails on the network, the transaction is looked up by its hash
# first. Only if the network confirms it is not on chain is the *same signed
# envelope* sent again. A new transaction is never built or signed for the
# same action:
#
#   - this script signs an envelope once: if <xdr-file>.submission/ exists, it
#     refuses to sign again and points to --resume;
#   - on chain, SUCCESS or FAILED: it stops and reports; nothing is resent;
#   - confirmed not found (after waiting for it): the same envelope, same
#     hash, is sent again, at most 3 sends in all;
#   - unknown (the lookup itself failed): it is never resent on that basis;
#     the script keeps looking, then stops with the --resume command;
#   - if the network answers that the envelope can no longer be included (its
#     sequence number was used, or its time bound passed), the script stops.
#     Whether to build a new transaction is then your decision, after checking
#     on chain that the action did not happen.
#
# --resume continues from the saved signed envelope: it looks the hash up
# first, and asks you to type RESEND before sending the same envelope again.
#
# Testnet only, for the rehearsal: QS_TEST_FAIL_FIRST_SEND=1 sends the first
# attempt to an unreachable RPC, so the recovery path can be shown.

set -euo pipefail

usage() {
  echo "usage: $0 <xdr-file> <identity> --network mainnet|testnet [--resume]" >&2
  exit 64
}

[ $# -eq 4 ] || [ $# -eq 5 ] || usage
XDR_FILE="$1"
IDENTITY="$2"
[ "$3" = "--network" ] || usage
NETWORK="$4"
RESUME=0
if [ $# -eq 5 ]; then
  [ "$5" = "--resume" ] || usage
  RESUME=1
fi
case "$NETWORK" in
  mainnet) EXPERT="https://stellar.expert/explorer/public/tx" ;;
  testnet) EXPERT="https://stellar.expert/explorer/testnet/tx" ;;
  *) echo "the network must be given explicitly: mainnet or testnet" >&2; exit 64 ;;
esac
[ -f "$XDR_FILE" ] || { echo "no such file: $XDR_FILE" >&2; exit 66; }
# Absolute, because the script changes to the repo below (which may be a
# read-only snapshot, run as another user: MAINNET_SETUP.md Part 0).
XDR_FILE="$(realpath "$XDR_FILE")"
if [ "${QS_TEST_FAIL_FIRST_SEND:-}" = "1" ] && [ "$NETWORK" != "testnet" ]; then
  echo "QS_TEST_FAIL_FIRST_SEND is for the testnet rehearsal only" >&2
  exit 64
fi

STATE="${XDR_FILE}.submission"
SIGNED_FILE="$STATE/signed.xdr"
HASH_FILE="$STATE/hash"
MAX_SENDS=3

cd "$(dirname "$0")/.."

SOURCE="$(stellar keys address "$IDENTITY")"
echo "Identity     $IDENTITY ($SOURCE)"
echo

# The transaction's status by hash: SUCCESS, FAILED, NOT_FOUND or UNKNOWN.
lookup() {
  local out
  if out="$(stellar tx fetch result --hash "$1" --network "$NETWORK" 2>&1)"; then
    if printf '%s' "$out" | grep -q '"tx_success"'; then echo SUCCESS; else echo FAILED; fi
  elif printf '%s' "$out" | grep -q "not found on"; then
    echo NOT_FOUND
  else
    echo UNKNOWN
  fi
}

# Wait up to ~60 s for the hash to appear; print the last status seen.
await_status() {
  local status=NOT_FOUND
  for _ in $(seq 1 12); do
    status="$(lookup "$1")"
    case "$status" in SUCCESS | FAILED) echo "$status"; return ;; esac
    sleep 5
  done
  echo "$status"
}

# The first line of the CLI's output that names an error, or its first line.
first_error() {
  printf '%s\n' "$1" | grep -m1 -i "error" || printf '%s\n' "$1" | head -1
}

# One submission of the saved signed envelope. Prints "sent", "refused: <why>"
# (the network will never include it), or "error: <why>" (it may not have
# arrived). Never signs anything.
send_once() {
  local args=(--network "$NETWORK") out
  if [ "${QS_TEST_FAIL_FIRST_SEND:-}" = "1" ] && [ "${SENDS:-0}" -eq 0 ]; then
    args=(--rpc-url "http://127.0.0.1:9" --network-passphrase "Test SDF Network ; September 2015")
  fi
  if out="$(stellar tx send "${args[@]}" < "$SIGNED_FILE" 2>&1)"; then
    echo "sent"
  elif printf '%s' "$out" | grep -Eqi "txBadSeq|txTooLate|txTooEarly|tx_bad_seq|tx_too_late|bad.?seq|too.?late"; then
    echo "refused: $(first_error "$out")"
  else
    echo "error: $(first_error "$out")"
  fi
}

report_done() {
  local status="$1" hash="$2"
  echo
  if [ "$status" = "SUCCESS" ]; then
    echo "On chain, successful: $hash"
  else
    echo "On chain, FAILED (the contract or the network refused it; it is final): $hash"
  fi
  echo "      $EXPERT/$hash"
  [ "$status" = "SUCCESS" ]
}

if [ "$RESUME" -eq 0 ]; then
  if [ -e "$STATE" ]; then
    echo "Refused: $XDR_FILE was already signed ($STATE exists, hash $(cat "$HASH_FILE" 2>/dev/null || echo '?'))." >&2
    echo "Never sign a second transaction for the same action. Continue with:" >&2
    echo "  $0 $XDR_FILE $IDENTITY --network $NETWORK --resume" >&2
    exit 1
  fi

  # QS_RIGHTS_CONTRACT (the rights contract id) lets the review refuse a USDC
  # transfer straight to the contract; on mainnet the review refuses without it.
  if ! npx tsx scripts/tx-review.ts --xdr-file "$XDR_FILE" --network "$NETWORK" --source "$SOURCE"; then
    echo "Refused. Nothing was signed." >&2
    exit 1
  fi

  # Before every mainnet transaction (spec §14, D7): mainnet is still on the
  # protocol the contracts were tested for, and the pilot's accounts hold at
  # most 5 USDC in all, each G account with a USDC trustline.
  # QS_PILOT_ACCOUNTS is the comma-separated list of every pilot account
  # that holds USDC; QS_RIGHTS_CONTRACT is the rights contract, or, before it
  # is deployed, the id its deploy will create (`stellar contract id wasm`).
  # Since the Step 5 review the same checks run on testnet too, so the
  # testnet rehearsal (docs/MAINNET_REHEARSAL.md) goes through them.
  if ! npx tsx scripts/check-protocol.ts; then
    echo "Refused: the protocol check failed. Nothing was signed." >&2
    exit 1
  fi
  if [ -z "${QS_PILOT_ACCOUNTS:-}" ] || [ -z "${QS_RIGHTS_CONTRACT:-}" ]; then
    echo "Refused: set QS_PILOT_ACCOUNTS (every pilot account holding USDC, comma-separated) and QS_RIGHTS_CONTRACT. Nothing was signed." >&2
    exit 1
  fi
  if ! npx tsx scripts/check-pilot-accounts.ts --network "$NETWORK" --accounts "$QS_PILOT_ACCOUNTS" --contract "$QS_RIGHTS_CONTRACT"; then
    echo "Refused: the pilot account check failed (trustline or the 5 USDC total). Nothing was signed." >&2
    exit 1
  fi

  echo
  read -r -p "Type SEND to sign as $IDENTITY and submit to $NETWORK: " ANSWER
  if [ "$ANSWER" != "SEND" ]; then
    echo "Not sent." >&2
    exit 1
  fi

  # Signed once, and kept before anything is sent.
  mkdir -m 700 "$STATE"
  (umask 077 && stellar tx sign --sign-with-key "$IDENTITY" --network "$NETWORK" < "$XDR_FILE" > "$SIGNED_FILE")
  stellar tx hash --network "$NETWORK" < "$SIGNED_FILE" > "$HASH_FILE"
  HASH="$(cat "$HASH_FILE")"
  echo
  echo "Signed: $HASH (kept in $STATE)"
else
  [ -f "$SIGNED_FILE" ] && [ -f "$HASH_FILE" ] || { echo "nothing to resume: $SIGNED_FILE is missing" >&2; exit 66; }
  HASH="$(cat "$HASH_FILE")"
  echo "Resuming $HASH from $STATE"
  STATUS="$(lookup "$HASH")"
  echo "Looked up by hash first: $STATUS"
  case "$STATUS" in
    SUCCESS | FAILED) report_done "$STATUS" "$HASH"; exit $? ;;
    UNKNOWN) echo "The lookup failed, so nothing is resent. Try --resume again." >&2; exit 1 ;;
  esac
  read -r -p "Not on chain. Type RESEND to send the same signed envelope ($HASH) again: " ANSWER
  if [ "$ANSWER" != "RESEND" ]; then
    echo "Not sent." >&2
    exit 1
  fi
fi

SENDS=0
while :; do
  RESULT="$(send_once)"
  SENDS=$((SENDS + 1))
  echo "Send $SENDS of at most $MAX_SENDS: $RESULT"
  case "$RESULT" in
    refused:*)
      STATUS="$(lookup "$HASH")"
      case "$STATUS" in SUCCESS | FAILED) report_done "$STATUS" "$HASH"; exit $? ;; esac
      echo "The network will not include this envelope, and it is not on chain ($STATUS)." >&2
      echo "Nothing was re-signed. Check on chain that the action did not happen before building anything new." >&2
      exit 1
      ;;
  esac
  echo "Looking it up by hash…"
  STATUS="$(await_status "$HASH")"
  echo "Status: $STATUS"
  case "$STATUS" in
    SUCCESS | FAILED) report_done "$STATUS" "$HASH"; exit $? ;;
    UNKNOWN)
      echo "The lookup failed, so it is not resent on that basis. Continue with:" >&2
      echo "  $0 $XDR_FILE $IDENTITY --network $NETWORK --resume" >&2
      exit 1
      ;;
  esac
  # Confirmed not on chain: the same signed envelope again.
  if [ "$SENDS" -ge "$MAX_SENDS" ]; then
    echo "Not on chain after $SENDS sends of the same envelope. Stopping; continue later with:" >&2
    echo "  $0 $XDR_FILE $IDENTITY --network $NETWORK --resume" >&2
    exit 1
  fi
  echo "Confirmed not on chain: sending the same signed envelope again (same hash)."
done
