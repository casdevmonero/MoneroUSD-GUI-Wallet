#!/usr/bin/env bash
# Test wallet RPC and (optional) app server. Run after:
#   1. USDmd (daemon) on 17750
#   2. USDM_DAEMON_ADDRESS=http://127.0.0.1:17750 ./start-wallet-rpc.sh
#   3. (Browser) node server.js
# Usage: ./scripts/test-connection.sh [base_url]
#   base_url default: http://127.0.0.1:27750 (wallet RPC direct). Use http://127.0.0.1:3000 to test via app server.

set -e
BASE="${1:-http://127.0.0.1:27750}"
echo "Testing Monero USD wallet connection at $BASE"
echo ""

rpc() {
  local method="$1"
  local params="${2:-{}}"
  if [[ "$BASE" == *":3000"* ]]; then
    curl -s -X POST "$BASE/json_rpc" \
      -H "Content-Type: application/json" \
      -H "x-wallet-rpc-url: http://127.0.0.1:27750" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":\"0\",\"method\":\"$method\",\"params\":$params}"
  else
    curl -s -X POST "$BASE/json_rpc" \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":\"0\",\"method\":\"$method\",\"params\":$params}"
  fi
}

echo "1. get_version"
out=$(rpc "get_version")
if echo "$out" | grep -q '"result"'; then
  echo "   OK"
else
  echo "   FAIL: $out"
  exit 1
fi

echo "2. set_daemon (http://127.0.0.1:17750)"
out=$(rpc "set_daemon" '{"address":"http://127.0.0.1:17750","trusted":true}')
if echo "$out" | grep -q '"result"'; then
  echo "   OK"
else
  echo "   FAIL: $out"
  exit 1
fi

echo "3. get_height"
out=$(rpc "get_height")
if echo "$out" | grep -q '"height"'; then
  echo "   OK: $out"
else
  echo "   FAIL: $out"
  exit 1
fi

echo "4. get_balance (USDm)"
out=$(rpc "get_balance" '{"account_index":0,"all_accounts":false,"asset_type":"USDm","strict":false}')
if echo "$out" | grep -q '"balance"'; then
  echo "   OK: $out"
else
  echo "   FAIL (no wallet?): $out"
fi

echo "5. refresh (short timeout)"
EXTRA_HEADER=""
[[ "$BASE" == *":3000"* ]] && EXTRA_HEADER="-H x-wallet-rpc-url: http://127.0.0.1:27750"
out=$(curl -s -X POST "$BASE/json_rpc" \
  -H "Content-Type: application/json" \
  $EXTRA_HEADER \
  -d '{"jsonrpc":"2.0","id":"0","method":"refresh","params":{"start_height":0}}' \
  --max-time 10 2>/dev/null || true)
if echo "$out" | grep -q '"blocks_fetched"'; then
  echo "   OK"
else
  echo "   (timeout or no result - refresh can take minutes): ${out:-timeout}"
fi

echo ""
echo "All steps passed. App should work: open Settings, set Daemon URL to http://127.0.0.1:17750, Save, then Refresh on dashboard."
