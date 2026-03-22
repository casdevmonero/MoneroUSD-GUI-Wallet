#!/bin/bash
# sync-to-github.sh — Sync sanitized codebase to public GitHub repo
# Usage: ./sync-to-github.sh
#
# This script copies the codebase to a clean directory, strips sensitive data
# (IPs, keys, wallet files, build artifacts), and pushes to GitHub.
# Safe to run repeatedly — it only pushes if there are actual changes.

set -euo pipefail

REPO_DIR="/root/MoneroUSD/monerousd-desktop"
CLEAN_DIR="/tmp/monerousd-clean"
GITHUB_REPO="casdevmonero/MoneroUSD"

echo "=== Syncing MoneroUSD to GitHub ==="

# 1. Sync files to clean directory (exclude sensitive data)
rsync -a --delete \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='daemon-data/' \
  --exclude='wallet-data/' \
  --exclude='.git/' \
  --exclude='.claude/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.keys' \
  --exclude='*.wallet' \
  --exclude='*.log' \
  --exclude='test-results/' \
  --exclude='*.pem' \
  --exclude='*.p12' \
  --exclude='rpc_ssl.*' \
  --exclude='sync-to-github.sh' \
  --exclude='genesis/' \
  --exclude='.shared-ringdb/' \
  --exclude='*.mdb' \
  "$REPO_DIR/" "$CLEAN_DIR/"

cd "$CLEAN_DIR"

# 2. Sanitize: replace hardcoded IPs and secrets
# Server deploy script — strip real relay host/key
sed -i 's|RELAY_KEY="[^"]*"|RELAY_KEY="${RELAY_SSH_KEY:-~/.ssh/relay_key}"|' deploy-release.sh 2>/dev/null || true
sed -i 's|RELAY_HOST="[^"]*"|RELAY_HOST="${RELAY_SSH_HOST:-user@your-relay-server}"|' deploy-release.sh 2>/dev/null || true

# Server.js — strip hardcoded miner address and binary path
sed -i "s|const MINER_ADDRESS = process.env.MINER_ADDRESS || '[^']*';|const MINER_ADDRESS = process.env.MINER_ADDRESS || '';|" server.js 2>/dev/null || true
sed -i "s||| '/root/[^']*'||| 'USDm-wallet-rpc'|" server.js 2>/dev/null || true

# 3. Verify no real IPs leaked (fail-safe)
if grep -rn --include='*.js' --include='*.html' --include='*.sh' --include='*.json' \
   -E '148\.163\.|72\.61\.' "$CLEAN_DIR/" 2>/dev/null; then
  echo "ERROR: Real server IPs found in sanitized copy! Aborting."
  exit 1
fi

# 4. Commit and push if changes exist
if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  git add -A
  SUMMARY=$(git diff --cached --stat | tail -1)
  git commit -m "Update: $SUMMARY"
  git push origin main
  echo "=== Pushed to github.com/$GITHUB_REPO ==="
else
  echo "=== No changes to push ==="
fi
