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
# electron-builder --mac on Linux produces .zip archives + unpacked app dirs:
#   dist/mac/Monero USD Wallet.app          ← x64 app bundle (already extracted)
#   dist/mac-arm64/Monero USD Wallet.app    ← arm64 app bundle (already extracted)
#
# NOTE: OTA updates use the .zip files — no DMG needed for auto-update.
#       DMG is for the first-install download page only.
#
# To generate a .dmg for the download page from the unpacked app bundles:
#
#   Step 1 — Create a HFS-compatible ISO from dist/mac/ using genisoimage:
#     genisoimage -V "Monero USD Wallet" -D -R -apple -no-pad \
#       -o "dist/Monero USD Wallet-$VERSION-x64.iso" \
#       "dist/mac/"
#     genisoimage -V "Monero USD Wallet" -D -R -apple -no-pad \
#       -o "dist/Monero USD Wallet-$VERSION-arm64.iso" \
#       "dist/mac-arm64/"
#
#   Step 2 — Convert ISO to DMG:
#     # Option A — direct rename (mounts as read-only disk image on macOS):
#     mv "dist/Monero USD Wallet-$VERSION-x64.iso" \
#        "dist/Monero USD Wallet-$VERSION-x64.dmg"
#     mv "dist/Monero USD Wallet-$VERSION-arm64.iso" \
#        "dist/Monero USD Wallet-$VERSION-arm64.dmg"
#
#     # Option B — compressed UDZO DMG (requires hdiutil, macOS only):
#     hdiutil create -volname "Monero USD Wallet" -srcfolder "dist/mac/" \
#       -ov -format UDZO -o "dist/Monero USD Wallet-$VERSION-x64.dmg"
#     hdiutil create -volname "Monero USD Wallet" -srcfolder "dist/mac-arm64/" \
#       -ov -format UDZO -o "dist/Monero USD Wallet-$VERSION-arm64.dmg"
#
#     # Option C — dmgbuild (pip install dmgbuild, works on Linux with hfsprogs):
#     dmgbuild -s dmgbuild-settings.py "Monero USD Wallet" \
#       "dist/Monero USD Wallet-$VERSION-x64.dmg"
#
# Required tools: genisoimage (apt install genisoimage)
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
