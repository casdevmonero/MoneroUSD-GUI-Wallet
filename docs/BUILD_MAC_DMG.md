# Building Mac DMGs on the VPS (Linux)

This documents how to build macOS `.dmg` installer images from the VPS without
a Mac. The Electron app bundles (x64 and arm64) live in `dist/mac/` and
`dist/mac-arm64/` — they were originally produced by `electron-builder` on macOS.
Only the `app.asar` inside each bundle changes between releases; the Electron
framework binaries stay the same.

## Prerequisites

```
genisoimage   # apt install genisoimage  — creates ISO9660/Rock Ridge images macOS can mount
npx asar      # ships with the project's devDependencies (electron-builder)
```

## Step-by-step

### 1. Bump the version

Edit `package.json`:

```json
"version": "1.2.XX"
```

### 2. Build a new `app.asar`

The asar must contain the app source files **and** production `node_modules`.
Do NOT rely solely on the `build.files` list in `package.json` — that list is
for `electron-builder` which handles `node_modules` automatically. When building
the asar manually you must include the dependencies yourself.

The safest way is to match the module list from the previous working asar:

```bash
# List top-level modules in the current working asar
npx asar list "dist/mac/Monero USD Wallet.app/Contents/Resources/app.asar" \
  | grep "^/node_modules/[^/]*$" | sort
```

Then build:

```bash
VERSION=1.2.XX   # set to your new version
rm -rf /tmp/asar-build && mkdir -p /tmp/asar-build/node_modules

# App source files
cp main.js preload.js package.json /tmp/asar-build/
cp -r rpc renderer assets /tmp/asar-build/

# Production node_modules — copy each module listed above
for mod in argparse asn1js cross-fetch debug electron-updater graceful-fs \
  @hexagon js-yaml lazy-val @levischuck lodash.escaperegexp lodash.isequal \
  ms node-fetch @peculiar pvtsutils pvutils sax @simplewebauthn \
  tiny-typed-emitter tr46 tslib universalify webidl-conversions whatwg-url; do
  [ -d "node_modules/$mod" ] && {
    mkdir -p "/tmp/asar-build/node_modules/$(dirname $mod)"
    cp -r "node_modules/$mod" "/tmp/asar-build/node_modules/$mod"
  }
done

npx asar pack /tmp/asar-build /tmp/app-${VERSION}.asar
```

**Verify** the asar size is close to the previous one (~4-5 MB). If it's
hundreds of MB you accidentally included devDependencies. If it's < 1 MB you
forgot `node_modules`.

### 3. Replace the asar in both app bundles

```bash
/usr/bin/cp /tmp/app-${VERSION}.asar \
  "dist/mac/Monero USD Wallet.app/Contents/Resources/app.asar"
/usr/bin/cp /tmp/app-${VERSION}.asar \
  "dist/mac-arm64/Monero USD Wallet.app/Contents/Resources/app.asar"
```

> Use `/usr/bin/cp` to bypass any `cp -i` alias that blocks non-interactive
> overwrites.

### 4. Create DMG staging directories

Each DMG needs two items at the root:
- `Monero USD Wallet.app` — the application
- `Applications` — a **symlink** to `/Applications` (enables drag-and-drop install)

```bash
rm -rf /tmp/dmg-x64 /tmp/dmg-arm64
mkdir -p /tmp/dmg-x64 /tmp/dmg-arm64

cp -a "dist/mac/Monero USD Wallet.app" /tmp/dmg-x64/
ln -s /Applications /tmp/dmg-x64/Applications

cp -a "dist/mac-arm64/Monero USD Wallet.app" /tmp/dmg-arm64/
ln -s /Applications /tmp/dmg-arm64/Applications
```

### 5. Build the DMGs with `genisoimage`

```bash
genisoimage -V "Monero USD Wallet" -D -R -apple -no-pad \
  -o "dist/Monero USD Wallet-${VERSION}.dmg" \
  /tmp/dmg-x64/

genisoimage -V "Monero USD Wallet" -D -R -apple -no-pad \
  -o "dist/Monero USD Wallet-${VERSION}-arm64.dmg" \
  /tmp/dmg-arm64/
```

**Flags explained:**
- `-V "Monero USD Wallet"` — volume label shown in Finder
- `-D` — allow deep directory nesting
- `-R` — Rock Ridge extensions (preserves Unix permissions and **symlinks**)
- `-apple` — Apple extensions for HFS compatibility
- `-no-pad` — don't pad the image (smaller file)

> **Do NOT use `-follow-links`** — that follows the `Applications` symlink
> instead of preserving it, which breaks drag-and-drop.

**Verify** the symlink is present:

```bash
isoinfo -R -l -i "dist/Monero USD Wallet-${VERSION}.dmg" | head -6
# Should show:  lrwxrwxrwx ... Applications -> /Applications
```

### 6. Build zip archives (for OTA auto-update)

Electron's auto-updater uses zip archives, not DMGs:

```bash
cd /tmp/dmg-x64 && zip -r -y -q \
  "/root/MoneroUSD/monerousd-desktop/dist/Monero USD Wallet-${VERSION}-mac.zip" .
cd /tmp/dmg-arm64 && zip -r -y -q \
  "/root/MoneroUSD/monerousd-desktop/dist/Monero USD Wallet-${VERSION}-arm64-mac.zip" .
```

> `-y` preserves symlinks inside the zip.

### 7. Generate `latest-mac.yml`

This file tells the auto-updater about the new version:

```bash
cd dist

DMG_X64_SHA=$(sha512sum "Monero USD Wallet-${VERSION}.dmg" | awk '{print $1}' | xxd -r -p | base64 -w 0)
DMG_ARM_SHA=$(sha512sum "Monero USD Wallet-${VERSION}-arm64.dmg" | awk '{print $1}' | xxd -r -p | base64 -w 0)
ZIP_X64_SHA=$(sha512sum "Monero USD Wallet-${VERSION}-mac.zip" | awk '{print $1}' | xxd -r -p | base64 -w 0)
ZIP_ARM_SHA=$(sha512sum "Monero USD Wallet-${VERSION}-arm64-mac.zip" | awk '{print $1}' | xxd -r -p | base64 -w 0)
DMG_X64_SIZE=$(stat -c%s "Monero USD Wallet-${VERSION}.dmg")
DMG_ARM_SIZE=$(stat -c%s "Monero USD Wallet-${VERSION}-arm64.dmg")
ZIP_X64_SIZE=$(stat -c%s "Monero USD Wallet-${VERSION}-mac.zip")
ZIP_ARM_SIZE=$(stat -c%s "Monero USD Wallet-${VERSION}-arm64-mac.zip")

cat > latest-mac.yml << EOF
version: ${VERSION}
files:
  - url: Monero USD Wallet-${VERSION}.dmg
    sha512: ${DMG_X64_SHA}
    size: ${DMG_X64_SIZE}
  - url: Monero USD Wallet-${VERSION}-arm64.dmg
    sha512: ${DMG_ARM_SHA}
    size: ${DMG_ARM_SIZE}
  - url: Monero USD Wallet-${VERSION}-mac.zip
    sha512: ${ZIP_X64_SHA}
    size: ${ZIP_X64_SIZE}
  - url: Monero USD Wallet-${VERSION}-arm64-mac.zip
    sha512: ${ZIP_ARM_SHA}
    size: ${ZIP_ARM_SIZE}
path: Monero USD Wallet-${VERSION}-arm64-mac.zip
sha512: ${ZIP_ARM_SHA}

releaseDate: '$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'
EOF
```

### 8. Deploy

```bash
/usr/bin/cp "Monero USD Wallet-${VERSION}.dmg" /var/www/monerousd-updates/
/usr/bin/cp "Monero USD Wallet-${VERSION}-arm64.dmg" /var/www/monerousd-updates/
/usr/bin/cp "Monero USD Wallet-${VERSION}-mac.zip" /var/www/monerousd-updates/
/usr/bin/cp "Monero USD Wallet-${VERSION}-arm64-mac.zip" /var/www/monerousd-updates/
/usr/bin/cp latest-mac.yml /var/www/monerousd-updates/

cd /var/www/monerousd-updates
sha256sum *.dmg *.zip *.AppImage *.deb 2>/dev/null > SHA256SUMS || true
```

### 9. Update download links on the website

Edit `/var/www/monerousd-site/index.html` — find the `#download` section and
update the version number and URLs for the macOS download buttons.

---

## Common mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Forgot `node_modules` in asar | `Cannot find module 'electron-updater'` on launch | Include production deps (step 2) |
| Used `-follow-links` in genisoimage | No drag-and-drop to Applications | Omit that flag; `-R` preserves symlinks |
| Forgot `Applications` symlink in staging dir | DMG opens but no Applications folder to drag into | `ln -s /Applications /tmp/dmg-xxx/Applications` |
| Included devDependencies | asar is 400+ MB, DMG is huge | Only copy the modules listed in the previous working asar |
| Used `cp` instead of `/usr/bin/cp` | "overwrite?" prompt hangs in scripts | Use `/usr/bin/cp` to bypass alias |

## File locations

| What | Path |
|------|------|
| Desktop wallet source | `/root/MoneroUSD/monerousd-desktop/` |
| Unpacked x64 Mac app | `dist/mac/Monero USD Wallet.app/` |
| Unpacked arm64 Mac app | `dist/mac-arm64/Monero USD Wallet.app/` |
| Update server files | `/var/www/monerousd-updates/` |
| Website HTML | `/var/www/monerousd-site/index.html` |
| C++ wallet-rpc binary | `/root/MoneroUSD/MoneroUSD-main/build-linux/bin/USDm-wallet-rpc` |
| C++ source (daemon) | `/root/MoneroUSD/MoneroUSD-main/src/wallet/` |
