#!/usr/bin/env bash
# Does this Polygon RPC endpoint really implement `finalized`?
#
# Run this against every candidate BEFORE it goes in POLYGON_RPC_PRIMARY_URL or
# POLYGON_RPC_SECONDARY_URL. It needs nothing but curl and the URL.
#
#   ./probe-rpc.sh https://polygon-mainnet.example.com/v2/KEY
#
# Why this exists: a provider that has not implemented Heimdall v2 milestone
# finality can serve `latest` when asked for `finalized`. The call succeeds,
# the JSON shape is right, nothing errors — and the application then settles
# payments on probabilistic confirmations while believing it has finality.
# Polygon's docs put milestone finality at 2–5 seconds against 1–2 second
# blocks, so a correct node is always at least one block behind its own head.
#
# The URL is a secret. Pass it as an argument; this script never prints it.
set -uo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 <rpc-url>" >&2
  exit 2
fi

rpc() {
  curl -sS --max-time 15 -X POST "$URL" \
    -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
}

fail() { printf '  %-28s %s\n' "$1" "FAIL — $2"; FAILED=1; }
ok()   { printf '  %-28s %s\n' "$1" "ok${2:+ — $2}"; }

FAILED=0
echo "Probing a Polygon RPC endpoint (the URL is not printed)."
echo

# --- 1. chain id --------------------------------------------------------------
RAW_CHAIN=$(rpc eth_chainId '[]')
CHAIN_HEX=$(printf '%s' "$RAW_CHAIN" | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')
if [[ -z "$CHAIN_HEX" ]]; then
  fail "chain id" "no result (endpoint unreachable, wrong URL, or an error response)"
  echo; echo "Nothing else can be checked without a working endpoint."; exit 1
fi
CHAIN=$((CHAIN_HEX))
if [[ "$CHAIN" -ne 137 ]]; then
  fail "chain id" "this is chain $CHAIN, not Polygon PoS mainnet (137)"
else
  ok "chain id" "137, Polygon PoS mainnet"
fi

# --- 2. latest ----------------------------------------------------------------
LATEST_HEX=$(rpc eth_blockNumber '[]' | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')
if [[ -z "$LATEST_HEX" ]]; then
  fail "latest block" "eth_blockNumber returned no result"
  echo; exit 1
fi
LATEST=$((LATEST_HEX))
ok "latest block" "$LATEST"

# --- 3. finalized -------------------------------------------------------------
FIN_RAW=$(rpc eth_getBlockByNumber '["finalized",false]')
if printf '%s' "$FIN_RAW" | grep -q '"error"'; then
  MSG=$(printf '%s' "$FIN_RAW" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
  fail "finalized tag" "the endpoint returned an error: ${MSG:-unknown}"
elif printf '%s' "$FIN_RAW" | grep -q '"result":null'; then
  fail "finalized tag" "the endpoint answered null"
else
  FIN_HEX=$(printf '%s' "$FIN_RAW" | sed -n 's/.*"result":{[^}]*"number":"\(0x[0-9a-fA-F]*\)".*/\1/p')
  if [[ -z "$FIN_HEX" ]]; then
    FIN_HEX=$(printf '%s' "$FIN_RAW" | tr ',' '\n' | sed -n 's/.*"number":"\(0x[0-9a-fA-F]*\)".*/\1/p' | head -1)
  fi
  if [[ -z "$FIN_HEX" ]]; then
    fail "finalized tag" "a block came back but its number could not be read"
  else
    FIN=$((FIN_HEX))
    LAG=$((LATEST - FIN))
    if [[ "$FIN" -gt "$LATEST" ]]; then
      fail "finalized tag" "finalized ($FIN) is ABOVE latest ($LATEST) — whatever that is, it is not finality"
    elif [[ "$FIN" -eq "$LATEST" ]]; then
      # The failure that actually happens in the field.
      fail "finalized tag" "finalized == latest ($FIN) — this endpoint is serving latest for finalized"
    elif [[ "$LAG" -gt 200 ]]; then
      fail "finalized tag" "finalized is $LAG blocks behind latest, which is stale rather than final"
    elif [[ "$LAG" -le 2 ]]; then
      # Not a failure: on Polygon a correct node trails its head by about this
      # much. But a node reporting "one confirmation" looks identical, and no
      # automated check can tell them apart — so this is said out loud rather
      # than passed silently.
      ok "finalized tag" "$FIN, only $LAG block(s) behind — plausible for milestone finality, and also what a node reporting one confirmation looks like. Confirm with the provider that Heimdall v2 milestones are implemented."
    else
      ok "finalized tag" "$FIN, $LAG block(s) behind latest"
    fi
  fi
fi

# --- 4. the calls the scanner makes ------------------------------------------
# One block of Transfer logs for the real JPYC contract. A provider that caps
# eth_getLogs harder than it advertises fails here rather than in production.
JPYC=0xe7c3d8c9a439fede00d2600032d5db0be71c3c29
TOPIC=0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
FROM=$(printf '0x%x' $((LATEST - 20)))
TO=$(printf '0x%x' $((LATEST - 10)))
LOGS=$(rpc eth_getLogs "[{\"fromBlock\":\"$FROM\",\"toBlock\":\"$TO\",\"address\":\"$JPYC\",\"topics\":[\"$TOPIC\"]}]")
if printf '%s' "$LOGS" | grep -q '"error"'; then
  MSG=$(printf '%s' "$LOGS" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')
  fail "eth_getLogs (11 blocks)" "${MSG:-unknown error}"
else
  N=$(printf '%s' "$LOGS" | grep -o '"logIndex"' | wc -l | tr -d ' ')
  ok "eth_getLogs (11 blocks)" "$N JPYC transfer log(s) in that range"
fi

# --- 5. decimals(), which the whitelist is checked against -------------------
DEC=$(rpc eth_call "[{\"to\":\"$JPYC\",\"data\":\"0x313ce567\"},\"latest\"]" \
  | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')
if [[ -z "$DEC" ]]; then
  fail "JPYC decimals()" "eth_call returned no result"
else
  D=$((DEC))
  if [[ "$D" -eq 18 ]]; then
    ok "JPYC decimals()" "18, as configured"
  else
    fail "JPYC decimals()" "the contract reports $D, not the 18 this build is configured for"
  fi
fi

echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "PASS — this endpoint is usable."
  echo "Remember: the primary and the secondary must be DIFFERENT COMPANIES."
  echo "Two endpoints from one provider usually share a cluster and a view of"
  echo "the chain, so a disagreement check between them detects nothing."
else
  echo "DO NOT USE this endpoint for payment settlement."
  echo "A failing finalized tag is not a tuning problem — it means settlement"
  echo "decisions would be made on confirmations that can still be reorganised."
fi
exit "$FAILED"
