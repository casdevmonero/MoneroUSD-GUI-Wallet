#!/bin/bash
# deploy-release.sh — Copy build artifacts to update server
# Usage: ./deploy-release.sh
#
# Run this after `npx electron-builder` completes.
# The website at monerousd.org automatically picks up new versions
# by fetching latest.yml, latest-mac.yml, latest-linux.yml, and SHA256SUMS
# from update.monerousd.org at page load time.

set -euo pipefail

DIST_DIR="$(cd "$(dirname "$0")" && pwd)/dist"
UPDATE_DIR="/var/www/monerousd-updates"
RELAY_KEY="${RELAY_SSH_KEY:-~/.ssh/relay_key}"
RELAY_HOST="${RELAY_SSH_HOST:-user@your-relay-server}"

# ─── macOS DMG build on Linux (geniso method) ────────────────────────────────
#
# electron-builder --mac produces .zip archives on Linux (no DMG).
# To generate a proper .dmg for the download page, use genisoimage + dmg2img:
#
#   Step 1 — Unzip the mac app bundle produced by electron-builder:
#     unzip -q "dist/Monero USD Wallet-$VERSION-mac-x64.zip" -d /tmp/mac-x64/
#     unzip -q "dist/Monero USD Wallet-$VERSION-mac-arm64.zip" -d /tmp/mac-arm64/
#
#   Step 2 — Create a HFS-compatible ISO from the .app using genisoimage:
#     genisoimage -V "Monero USD Wallet" -D -R -apple -no-pad \
#       -o "/tmp/MoneroUSD-$VERSION-mac-x64.iso" /tmp/mac-x64/
#     genisoimage -V "Monero USD Wallet" -D -R -apple -no-pad \
#       -o "/tmp/MoneroUSD-$VERSION-mac-arm64.iso" /tmp/mac-arm64/
#
#   Step 3 — Convert ISO to DMG (Linux: use dmg2img in reverse / Python dmgbuild):
#     # Option A — rename (works for basic distribution, not HFS+):
#     cp "/tmp/MoneroUSD-$VERSION-mac-x64.iso" "$DIST_DIR/Monero USD Wallet-$VERSION-x64.dmg"
#
#     # Option B — proper HFS+ DMG via dd + mkfs.hfsplus + hdiutil (macOS only):
#     hdiutil create -volname "Monero USD Wallet" -srcfolder /tmp/mac-x64/ \
#       -ov -format UDZO -o "$DIST_DIR/Monero USD Wallet-$VERSION-x64.dmg"
#
#     # Option C — dmgbuild (pip install dmgbuild, macOS or Linux with hfsprogs):
#     dmgbuild -s dmgbuild-settings.py "Monero USD Wallet" \
#       "$DIST_DIR/Monero USD Wallet-$VERSION-x64.dmg"
#
# OTA updates on macOS use the .zip file (not .dmg) — the .dmg is for first install only.
# Required tools: genisoimage (apt install genisoimage), unzip
# ─────────────────────────────────────────────────────────────────────────────

# Read version from latest.yml
VERSION=$(grep '^version:' "$DIST_DIR/latest.yml" | awk '{print $2}')
if [ -z "$VERSION" ]; then
  echo "ERROR: Could not determine version from $DIST_DIR/latest.yml"
  exit 1
fi

echo "=== Deploying MoneroUSD Desktop v$VERSION ==="

# Clear old files
echo "Clearing old release files..."
rm -f "$UPDATE_DIR"/*.exe "$UPDATE_DIR"/*.exe.blockmap
rm -f "$UPDATE_DIR"/*.AppImage
rm -f "$UPDATE_DIR"/*.deb
rm -f "$UPDATE_DIR"/*.dmg
rm -f "$UPDATE_DIR"/*.zip "$UPDATE_DIR"/*.zip.blockmap
rm -f "$UPDATE_DIR"/latest.yml "$UPDATE_DIR"/latest-linux.yml "$UPDATE_DIR"/latest-mac.yml
rm -f "$UPDATE_DIR"/SHA256SUMS

# Copy new files
echo "Copying v$VERSION artifacts..."

# Auto-update metadata (required for OTA)
cp "$DIST_DIR/latest.yml" "$UPDATE_DIR/"
cp "$DIST_DIR/latest-linux.yml" "$UPDATE_DIR/"
cp "$DIST_DIR/latest-mac.yml" "$UPDATE_DIR/"

# Windows
for f in "$DIST_DIR"/Monero\ USD\ Wallet\ Setup\ "$VERSION"*; do
  [ -f "$f" ] && cp "$f" "$UPDATE_DIR/"
done

# macOS
for f in "$DIST_DIR"/Monero\ USD\ Wallet-"$VERSION"*mac*.zip* "$DIST_DIR"/Monero\ USD\ Wallet-"$VERSION"*.dmg; do
  [ -f "$f" ] && cp "$f" "$UPDATE_DIR/"
done

# Linux
for f in "$DIST_DIR"/Monero\ USD\ Wallet-"$VERSION"*.AppImage "$DIST_DIR"/monerousd-desktop_"$VERSION"_amd64.deb; do
  [ -f "$f" ] && cp "$f" "$UPDATE_DIR/"
done

# Generate SHA256SUMS
echo "Generating SHA256SUMS..."
cd "$UPDATE_DIR"
sha256sum *.exe *.AppImage *.deb *.dmg *.zip 2>/dev/null > SHA256SUMS || true

echo ""
echo "Files deployed to $UPDATE_DIR:"
ls -lh "$UPDATE_DIR/"
echo ""
echo "=== v$VERSION deployed successfully ==="
echo "Website at monerousd.org will automatically show the new version on next page load."
echo "OTA updates will be detected by existing desktop wallets within 4 hours."
