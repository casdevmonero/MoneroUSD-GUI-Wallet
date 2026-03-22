#!/usr/bin/env bash
# Start Monero USD wallet RPC (USDm-wallet-rpc, Monero-based) so the desktop app can connect.
# Configured like Monero: --daemon-address and --trusted-daemon. The app then calls set_daemon,
# enables auto_refresh (periodic blockchain sync), and runs refresh so balance updates correctly.
# If you get "Address already in use", run: USDM_WALLET_RPC_PORT=27751 ./start-wallet-rpc.sh
# Then set Settings → Wallet RPC URL to http://127.0.0.1:27751

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# RPC port (default 27750). Use 27751 if 27750 is in use.
RPC_PORT="${USDM_WALLET_RPC_PORT:-27750}"
# Where to create/store wallet files (for Import, use a directory; no --wallet-file)
WALLET_DIR="${USDM_WALLET_DIR:-$SCRIPT_DIR/wallet-data}"
# Local USDm daemon (USDmd from MoneroUSD-main). Same as Monero: wallet needs daemon for sync/balance.
DAEMON_ADDRESS="${USDM_DAEMON_ADDRESS:-http://127.0.0.1:17750}"

# Find Monero USD wallet RPC binary (USDm-wallet-rpc from MoneroUSD-main build)
MONEROUSD_WALLET_RPC="${USDM_WALLET_RPC:-}"
if [[ -z "$MONEROUSD_WALLET_RPC" ]]; then
  if command -v USDm-wallet-rpc &>/dev/null; then
    MONEROUSD_WALLET_RPC="USDm-wallet-rpc"
  elif [[ -x "$SCRIPT_DIR/../MoneroUSD-main/build/Darwin/master/release/bin/USDm-wallet-rpc" ]]; then
    MONEROUSD_WALLET_RPC="$SCRIPT_DIR/../MoneroUSD-main/build/Darwin/master/release/bin/USDm-wallet-rpc"
  elif [[ -x "$SCRIPT_DIR/../MoneroUSD-main/build/bin/USDm-wallet-rpc" ]]; then
    MONEROUSD_WALLET_RPC="$SCRIPT_DIR/../MoneroUSD-main/build/bin/USDm-wallet-rpc"
  elif [[ -x "../MoneroUSD-main/build/Darwin/release/USDm-wallet-rpc" ]]; then
    MONEROUSD_WALLET_RPC="../MoneroUSD-main/build/Darwin/release/USDm-wallet-rpc"
  elif [[ -x "../MoneroUSD-main/build/Linux/release/USDm-wallet-rpc" ]]; then
    MONEROUSD_WALLET_RPC="../MoneroUSD-main/build/Linux/release/USDm-wallet-rpc"
  else
    echo "Monero USD wallet RPC (USDm-wallet-rpc) not found. Set USDM_WALLET_RPC or build MoneroUSD-main:"
    echo "  cd ../MoneroUSD-main && make release"
    exit 1
  fi
fi

mkdir -p "$WALLET_DIR"
echo "Monero USD wallet RPC"
echo "Wallet dir: $WALLET_DIR"
echo "Daemon:     $DAEMON_ADDRESS"
echo "RPC:        http://127.0.0.1:$RPC_PORT"
echo ""
exec "$MONEROUSD_WALLET_RPC" \
  --rpc-bind-port="$RPC_PORT" \
  --wallet-dir="$WALLET_DIR" \
  --daemon-address="$DAEMON_ADDRESS" \
  --trusted-daemon \
  --disable-rpc-login \
  "$@"
