const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let isUpdating = false; // true when quitAndInstall is about to fire

/* ── Auto-Update (OTA) ─────────────────────────────────────── */
autoUpdater.autoDownload = true;           // silently download when available
autoUpdater.autoInstallOnAppQuit = false;  // We handle install manually (unsigned macOS apps)
autoUpdater.logger = console;

let updateDownloaded = false; // Track whether download completed — prevents error events from hiding the banner
let updateFilePath = null; // Saved immediately on download-complete, before any cleanup can delete it

function initAutoUpdater() {
  autoUpdater.checkForUpdates().catch((e) => {
    console.log('[update] checkForUpdates failed:', e.message);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[update] Update available:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes || '',
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[update] No update available. Current:', app.getVersion(), 'Latest:', info?.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { status: 'up-to-date' });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log('[update] Download progress:', Math.round(progress.percent) + '%');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    console.log('[update] Download COMPLETE. Version:', info.version);
    // electron-updater provides the exact path via info.downloadedFile — use it directly.
    // Fallback: scan the known cache directory if the property is missing.
    try {
      if (info.downloadedFile && fs.existsSync(info.downloadedFile)) {
        updateFilePath = info.downloadedFile;
        console.log('[update] Saved update file path (from event):', updateFilePath);
      } else {
        const cacheDir = path.join(app.getPath('userData'), '..', app.name + '-updater');
        if (fs.existsSync(cacheDir)) {
          const zips = fs.readdirSync(cacheDir).filter(f => f.endsWith('.zip'));
          if (zips.length > 0) {
            zips.sort((a, b) => fs.statSync(path.join(cacheDir, b)).mtimeMs - fs.statSync(path.join(cacheDir, a)).mtimeMs);
            updateFilePath = path.join(cacheDir, zips[0]);
            console.log('[update] Saved update file path (from scan):', updateFilePath);
          }
        }
      }
    } catch (e) {
      console.log('[update] Could not save update file path:', e.message);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', { version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[update] Error:', err.message);
    // CRITICAL: Do NOT send error to renderer if the update has already been downloaded.
    // electron-updater fires spurious errors after download on unsigned macOS apps
    // (e.g., code signing verification failures). These errors hide the restart banner,
    // preventing the user from ever installing the update.
    if (updateDownloaded) {
      console.log('[update] Ignoring post-download error — update is ready to install');
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { status: 'error', message: err.message });
    }
  });
}

// IPC handlers for update actions
ipcMain.handle('update-check', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, version: result?.updateInfo?.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update-download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update-install', async () => {
  console.log('[update] Manual update-install triggered');
  isUpdating = true;
  if (localWalletRpc && !localWalletRpc.killed) { try { localWalletRpc.kill('SIGKILL'); } catch(_){} }
  if (localDaemon && !localDaemon.killed) { try { localDaemon.kill('SIGKILL'); } catch(_){} }
  localWalletRpc = null;
  localDaemon = null;
  // Hard-exit safety net: quit the app within 15 seconds no matter what.
  // This guarantees the button always does something visible even if the
  // update script or quitAndInstall path hits an unexpected error.
  const exitTimer = setTimeout(() => {
    try { app.exit(0); } catch (_) {}
    // Nuclear fallback — if app.exit didn't work, kill the process directly
    setTimeout(() => { process.exit(0); }, 1000);
  }, 15000);
  exitTimer.unref(); // Don't prevent Node from exiting naturally

  if (process.platform === 'darwin') {
    // macOS: Squirrel quitAndInstall is unreliable for unsigned apps.
    // Manual approach: find the cached update zip, extract, replace app, relaunch.
    try {
      const appPath = app.getAppPath();
      const appBundle = path.resolve(appPath, '..', '..', '..');
      const appDir = path.dirname(appBundle);
      const appName = path.basename(appBundle);

      // Find the downloaded update zip — check saved path first, then scan cache dir
      const cacheDir = path.join(app.getPath('userData'), '..', app.name + '-updater');
      console.log('[update] Looking for cached update in:', cacheDir);

      let zipPath = updateFilePath; // Saved when update-downloaded fired
      if (!zipPath || !fs.existsSync(zipPath)) {
        zipPath = null;
        if (fs.existsSync(cacheDir)) {
          const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.zip'));
          if (files.length > 0) {
            files.sort((a, b) => fs.statSync(path.join(cacheDir, b)).mtimeMs - fs.statSync(path.join(cacheDir, a)).mtimeMs);
            zipPath = path.join(cacheDir, files[0]);
          }
        }
      }

      if (!zipPath || !fs.existsSync(zipPath)) {
        console.error('[update] No cached update zip found, using quitAndInstall + relaunch');
        // Even though Squirrel may fail to verify, quitAndInstall still calls app.quit().
        // Set autoInstallOnAppQuit so the update applies if possible.
        autoUpdater.autoInstallOnAppQuit = true;
        try { autoUpdater.quitAndInstall(false, true); } catch (_) {}
        // Guarantee exit — relaunch so user isn't left with nothing
        app.relaunch();
        app.exit(0);
        return;
      }

      console.log('[update] Found update zip:', zipPath);
      console.log('[update] App bundle:', appBundle);
      console.log('[update] App dir:', appDir);

      // Extract zip to temp dir
      const tmpDir = path.join(os.tmpdir(), 'monerousd-update-' + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });

      await new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        exec(`unzip -o -q "${zipPath}" -d "${tmpDir}"`, { timeout: 60000 }, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      // Find the .app inside the extracted zip
      const extracted = fs.readdirSync(tmpDir);
      const newApp = extracted.find(f => f.endsWith('.app'));
      if (!newApp) {
        throw new Error('No .app found in update zip. Contents: ' + extracted.join(', '));
      }

      const newAppPath = path.join(tmpDir, newApp);
      const backupPath = appBundle + '.backup';

      // Shell script: wait for app to quit, replace, remove quarantine, relaunch
      const script = `#!/bin/bash
# Wait for the app process to fully exit
for i in $(seq 1 10); do
  pgrep -f "${appName}" >/dev/null 2>&1 || break
  sleep 1
done
# Remove old backup if exists
rm -rf "${backupPath}"
# Move current app to backup
mv "${appBundle}" "${backupPath}" 2>/dev/null
# Move new app into place
if mv "${newAppPath}" "${path.join(appDir, appName)}"; then
  chmod -R 755 "${path.join(appDir, appName)}"
  xattr -dr com.apple.quarantine "${path.join(appDir, appName)}" 2>/dev/null
  open "${path.join(appDir, appName)}"
  rm -rf "${backupPath}"
else
  # Restore backup if move failed (e.g. permission denied)
  mv "${backupPath}" "${appBundle}" 2>/dev/null
  open "${appBundle}"
fi
rm -rf "${tmpDir}"
`;
      const scriptPath = path.join(tmpDir, 'update.sh');
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });

      console.log('[update] Running update script and quitting...');
      spawn('/bin/bash', [scriptPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();

      // Quit the app — the script will replace it and relaunch
      setTimeout(() => app.exit(0), 500);

    } catch (e) {
      console.error('[update] Manual update failed:', e);
      // Always guarantee the app exits and relaunches
      app.relaunch();
      app.exit(0);
    }
  } else {
    // Windows/Linux
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      console.error('[update] quitAndInstall failed:', e);
    }
    // quitAndInstall should exit, but guarantee it with fallbacks
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
      setTimeout(() => { process.exit(0); }, 1000);
    }, 3000);
  }
});

// Check for updates every 4 hours
setInterval(() => {
  autoUpdater.checkForUpdates().catch(() => {});
}, 4 * 60 * 60 * 1000);

/* ── Local Node Management ─────────────────────────────────── */
let localDaemon = null;   // child_process for USDmd
let localWalletRpc = null; // child_process for USDm-wallet-rpc (local node mode)
let daemonLog = [];        // last 200 lines of daemon output
const MAX_LOG_LINES = 200;
let buildInProgress = false; // prevent concurrent build-from-source attempts

function platformBinaryName(name) {
  return process.platform === 'win32' ? name + '.exe' : name;
}

function findBinary(name) {
  const bin = platformBinaryName(name);
  // Search order: bundled with app, local bin, dev builds, system-wide
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', bin),
    path.join(__dirname, 'bin', bin),
    path.join(os.homedir(), '.monerousd', 'bin', bin),
  ];
  // Dev / source builds (Linux/Mac only)
  if (process.platform !== 'win32') {
    candidates.push(
      path.join(__dirname, '..', 'MoneroUSD-main', 'build-linux', 'bin', name),
      path.join(__dirname, '..', 'MoneroUSD-main', 'build', 'bin', name),
      '/usr/local/bin/' + name,
      '/usr/bin/' + name,
    );
  }
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {}
  }
  return null;
}

// Download daemon binaries from update server
const BINARY_BASE_URL = 'https://update.monerousd.org/bin';
async function downloadBinary(name, destDir) {
  const bin = platformBinaryName(name);
  const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const url = `${BINARY_BASE_URL}/${plat}-${arch}/${bin}`;
  const dest = path.join(destDir, bin);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const get2 = (res.headers.location || '').startsWith('https') ? https.get : http.get;
        get2(res.headers.location, (res2) => {
          if (res2.statusCode !== 200) {
            file.close();
            fs.unlinkSync(dest);
            return reject(new Error(`Download failed: HTTP ${res2.statusCode}`));
          }
          res2.pipe(file);
          file.on('finish', () => {
            file.close();
            if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
            resolve(dest);
          });
        }).on('error', (e) => { file.close(); try { fs.unlinkSync(dest); } catch(_){} reject(e); });
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch(_){}
        return reject(new Error(`Download failed: HTTP ${res.statusCode}. Binaries for your platform may not be available yet.`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
        resolve(dest);
      });
    }).on('error', (e) => { file.close(); try { fs.unlinkSync(dest); } catch(_){} reject(e); });
  });
}

// Build daemon from source (macOS / Linux)
const SOURCE_REPO = 'https://github.com/haven-protocol-org/haven-main.git';

function runShell(cmd, opts = {}) {
  const { cwd, timeout = 600000 } = opts;
  // Ensure Homebrew/MacPorts paths are in PATH even if installed after app launch
  const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin'];
  const currentPath = process.env.PATH || '';
  const fullPath = extraPaths.filter(p => !currentPath.includes(p)).concat(currentPath).join(':');
  return new Promise((resolve, reject) => {
    const proc = spawn('/bin/bash', ['-c', cmd], {
      cwd: cwd || os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: fullPath,
        MAKEFLAGS: `-j${os.cpus().length}`,
        NONINTERACTIVE: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_INSTALL_CLEANUP: '1',
        CI: '1',
        // Prevent sudo from hanging — fail immediately instead of waiting for password
        SUDO_ASKPASS: '/bin/false',
      },
    });
    proc.stdin.end();
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Build timed out')); }, timeout);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Exit ${code}: ${stderr.slice(-500)}`));
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function sendBuildProgress(step, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('build-progress', { step, message });
  }
}

async function buildFromSource(binDir) {
  const dataDir = getDataDir();
  const srcDir = path.join(dataDir, 'haven-main');
  const cpus = os.cpus().length;

  // Step 1: Check for build tools
  sendBuildProgress('tools', 'Checking build tools...');

  if (process.platform === 'darwin') {
    // Check for Xcode command line tools
    try {
      await runShell('xcode-select -p', { timeout: 10000 });
      sendBuildProgress('tools', 'Xcode command line tools found');
    } catch (_) {
      // Try to trigger the system install dialog (doesn't need sudo)
      try {
        await runShell('xcode-select --install', { timeout: 10000 });
      } catch (_) {}
      throw new Error(
        'Xcode command line tools are required. A system dialog should appear to install them. ' +
        'After installation completes, click "Create Node" again.\n\n' +
        'If no dialog appeared, open Terminal and run:  xcode-select --install'
      );
    }
    // Check if Xcode license needs acceptance (prevents brew from blocking on license prompt)
    try {
      await runShell('xcodebuild -version 2>&1 | head -1', { timeout: 10000 });
    } catch (licErr) {
      const msg = (licErr.message || '');
      if (/license|agree/i.test(msg)) {
        throw new Error(
          'Xcode license needs to be accepted before building.\n\n' +
          'Please open Terminal and run:\n' +
          'sudo xcodebuild -license accept\n\n' +
          'Then click "Create Node Again".'
        );
      }
    }

    // Check for build dependencies (cmake, boost, openssl, pkg-config)
    // These can come from Homebrew, MacPorts, Nix, or manual installs.
    sendBuildProgress('deps', 'Checking build dependencies...');

    async function findMissing() {
      const missing = [];
      for (const tool of ['cmake', 'pkg-config']) {
        try {
          await runShell(`which ${tool} 2>/dev/null || ([ -x /opt/homebrew/bin/${tool} ] && echo ok) || ([ -x /usr/local/bin/${tool} ] && echo ok)`, { timeout: 5000 });
        } catch (_) { missing.push(tool); }
      }
      // Check for boost headers
      try {
        await runShell('ls /opt/homebrew/include/boost/version.hpp 2>/dev/null || ls /usr/local/include/boost/version.hpp 2>/dev/null || ls /opt/local/include/boost/version.hpp 2>/dev/null', { timeout: 5000 });
      } catch (_) { missing.push('boost'); }
      // Check for openssl
      try {
        await runShell('ls /opt/homebrew/opt/openssl/lib/libssl.dylib 2>/dev/null || ls /usr/local/opt/openssl/lib/libssl.dylib 2>/dev/null || ls /opt/local/lib/libssl.dylib 2>/dev/null || ls /usr/lib/libssl.dylib 2>/dev/null', { timeout: 5000 });
      } catch (_) { missing.push('openssl'); }
      return missing;
    }

    let missing = await findMissing();

    if (missing.length > 0) {
      // Try to find Homebrew, install it if missing, then install deps
      let brewPath = '';
      try {
        brewPath = (await runShell('which brew 2>/dev/null || ([ -x /opt/homebrew/bin/brew ] && echo /opt/homebrew/bin/brew) || ([ -x /usr/local/bin/brew ] && echo /usr/local/bin/brew)', { timeout: 10000 })).trim();
      } catch (_) {}

      // Auto-install Homebrew if not found
      if (!brewPath) {
        sendBuildProgress('deps', 'Installing Homebrew (this may take a few minutes)...');
        try {
          await runShell('NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', { timeout: 300000 });
          brewPath = (await runShell('([ -x /opt/homebrew/bin/brew ] && echo /opt/homebrew/bin/brew) || ([ -x /usr/local/bin/brew ] && echo /usr/local/bin/brew)', { timeout: 5000 })).trim();
        } catch (e) {
          throw new Error(
            'Homebrew installation failed: ' + (e.message || '').slice(-200) + '\n\n' +
            'Please open Terminal and run these commands:\n' +
            'sudo xcodebuild -license accept\n' +
            '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n' +
            'Then click "Create Node Again".'
          );
        }
      }

      if (!brewPath) {
        throw new Error(
          'Missing build dependencies: ' + missing.join(', ') + '\n\n' +
          'Could not find or install Homebrew automatically.\n\n' +
          'Please open Terminal and run:\n' +
          '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n' +
          'Then click "Create Node Again".'
        );
      }

      const brewDir = path.dirname(brewPath);
      sendBuildProgress('deps', 'Installing missing dependencies (' + missing.join(', ') + ')...');
      try {
        await runShell(`export PATH="${brewDir}:$PATH" && brew install cmake boost openssl pkg-config`, { timeout: 600000 });
      } catch (e) {
        const em = e.message || '';
        if (/already installed/i.test(em) || /nothing to install/i.test(em)) {
          // Fine — deps are already there
        } else if (/sudo|password|Permission denied|admin/i.test(em)) {
          throw new Error(
            'Homebrew needs admin access to install build dependencies.\n\n' +
            'Please open Terminal and run:\n' +
            'brew install cmake boost openssl pkg-config\n\n' +
            'Then click "Create Node Again".'
          );
        } else {
          throw new Error('Failed to install dependencies via Homebrew: ' + em);
        }
      }

      // Re-check — verify the deps actually landed
      missing = await findMissing();
      if (missing.length > 0) {
        throw new Error(
          'Still missing after install: ' + missing.join(', ') + '\n\n' +
          'Please open Terminal and run:\n' +
          'brew install ' + missing.join(' ') + '\n\n' +
          'Then click "Create Node Again".'
        );
      }
    }
    sendBuildProgress('deps', 'All dependencies found');
  } else {
    // Linux: check what's actually missing before trying to install
    sendBuildProgress('deps', 'Checking build dependencies...');
    let linuxMissing = false;
    try {
      await runShell('which cmake && which make && which g++', { timeout: 10000 });
    } catch (_) {
      linuxMissing = true;
    }
    if (linuxMissing) {
      sendBuildProgress('deps', 'Installing build dependencies...');
      try {
        await runShell('sudo apt-get update && sudo apt-get install -y build-essential cmake pkg-config libboost-all-dev libssl-dev libunbound-dev libsodium-dev', { timeout: 600000 });
      } catch (e) {
        // Re-check — maybe the user installed them manually between retries
        try {
          await runShell('which cmake && which make && which g++', { timeout: 10000 });
        } catch (_) {
          throw new Error(
            'Build tools not found and automatic install failed.\n\n' +
            'Please open Terminal and run:\n' +
            'sudo apt-get install -y build-essential cmake pkg-config libboost-all-dev libssl-dev libunbound-dev libsodium-dev\n\n' +
            'Then click "Create Node Again".'
          );
        }
      }
    }
  }
  sendBuildProgress('deps', 'Build dependencies ready');

  // Step 2: Clone or update source
  if (fs.existsSync(path.join(srcDir, 'Makefile'))) {
    sendBuildProgress('source', 'Source code found, updating...');
    try {
      await runShell('git pull --rebase', { cwd: srcDir, timeout: 120000 });
    } catch (_) {
      // If pull fails, that's OK — we'll build what we have
    }
  } else {
    sendBuildProgress('source', 'Downloading MoneroUSD source code...');
    // Remove partial clone if exists
    if (fs.existsSync(srcDir)) {
      await runShell(`rm -rf "${srcDir}"`, { timeout: 30000 });
    }
    await runShell(`git clone --recursive --depth 1 ${SOURCE_REPO} "${srcDir}"`, { timeout: 600000 });
  }
  sendBuildProgress('source', 'Source code ready');

  // Step 3: Build
  sendBuildProgress('build', `Compiling MoneroUSD (using ${cpus} cores)... This may take 10-30 minutes.`);
  const buildDir = path.join(srcDir, 'build', 'release');
  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });

  // cmake — on macOS, help cmake find OpenSSL from Homebrew, MacPorts, or system
  sendBuildProgress('build', 'Running cmake...');
  const cmakeExtra = process.platform === 'darwin'
    ? '-D OPENSSL_ROOT_DIR=$(' +
      'brew --prefix openssl 2>/dev/null || ' +
      '([ -d /opt/homebrew/opt/openssl ] && echo /opt/homebrew/opt/openssl) || ' +
      '([ -d /usr/local/opt/openssl ] && echo /usr/local/opt/openssl) || ' +
      '([ -d /opt/local ] && echo /opt/local) || ' +
      'echo /usr) '
    : '';
  try {
    await runShell(`cd "${buildDir}" && cmake ${cmakeExtra}-D CMAKE_BUILD_TYPE=Release -D CMAKE_POLICY_VERSION_MINIMUM=3.5 ../..`, { cwd: srcDir, timeout: 120000 });
  } catch (e) {
    const em = e.message || '';
    if (/sudo|password|Permission denied|admin|Need sudo/i.test(em)) {
      throw new Error(
        'Build requires admin access on macOS.\n\n' +
        'Please open Terminal and run:\n' +
        'sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer\n\n' +
        'Or install Xcode Command Line Tools:\n' +
        'xcode-select --install\n\n' +
        'Then click "Create Node Again".'
      );
    }
    if (/CMAKE_POLICY|cmake_minimum_required|CMP0|policy/i.test(em)) {
      // CMake version incompatibility — try to update cmake
      if (process.platform === 'darwin') {
        let brewPath = '';
        try {
          brewPath = (await runShell('which brew 2>/dev/null || ([ -x /opt/homebrew/bin/brew ] && echo /opt/homebrew/bin/brew) || ([ -x /usr/local/bin/brew ] && echo /usr/local/bin/brew)', { timeout: 5000 })).trim();
        } catch (_) {}
        if (brewPath) {
          sendBuildProgress('build', 'Updating cmake to fix compatibility issue...');
          try {
            await runShell(`${brewPath} upgrade cmake 2>&1 || true`, { timeout: 300000 });
            // Retry cmake after upgrade
            await runShell(`cd "${buildDir}" && cmake ${cmakeExtra}-D CMAKE_BUILD_TYPE=Release -D CMAKE_POLICY_VERSION_MINIMUM=3.5 ../..`, { cwd: srcDir, timeout: 120000 });
          } catch (retryErr) {
            throw new Error(
              'CMake version too old for this build.\n\n' +
              'Please open Terminal and run:\n' +
              'brew upgrade cmake && brew upgrade\n\n' +
              'Then click "Create Node Again".'
            );
          }
        } else {
          throw new Error(
            'CMake version too old for this build.\n\n' +
            'Please open Terminal and run:\n' +
            'brew upgrade cmake\n\n' +
            'Then click "Create Node Again".'
          );
        }
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  // make
  sendBuildProgress('build', `Building (${cpus} parallel jobs)... This takes a while.`);
  try {
    await runShell(`cd "${buildDir}" && make -j${cpus}`, { cwd: srcDir, timeout: 3600000 }); // 1 hour max
  } catch (e) {
    const em = e.message || '';
    if (/sudo|password|Permission denied|admin|Need sudo/i.test(em)) {
      throw new Error(
        'Build requires admin (sudo) access on macOS.\n\n' +
        'Please open Terminal and run the following, then click "Create Node" again:\n' +
        'sudo xcode-select --install'
      );
    }
    throw e;
  }

  sendBuildProgress('build', 'Build complete!');

  // Step 4: Copy binaries to bin dir
  sendBuildProgress('install', 'Installing binaries...');
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  const builtBinDir = path.join(buildDir, 'bin');
  const binaries = ['USDmd', 'USDm-wallet-rpc'];
  // Also check for haven-named binaries as fallback
  const fallbackNames = { 'USDmd': 'havend', 'USDm-wallet-rpc': 'haven-wallet-rpc' };
  const installed = {};

  for (const name of binaries) {
    let src = path.join(builtBinDir, name);
    if (!fs.existsSync(src)) {
      src = path.join(builtBinDir, fallbackNames[name] || name);
    }
    if (fs.existsSync(src)) {
      const dest = path.join(binDir, name);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
      installed[name] = dest;
      sendBuildProgress('install', `Installed ${name}`);
    }
  }

  if (!installed['USDmd']) {
    // List what was actually built
    let builtFiles = [];
    try { builtFiles = fs.readdirSync(builtBinDir); } catch (_) {}
    throw new Error('Build completed but USDmd binary not found. Built files: ' + builtFiles.join(', '));
  }

  sendBuildProgress('install', 'All binaries installed!');
  return installed['USDmd'];
}

function getDataDir() {
  const base = process.env.MONEROUSD_DATA_DIR || path.join(os.homedir(), '.monerousd');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

function daemonRpcLocal(port, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params: params || {} });
    const opts = {
      hostname: 'localhost', port, path: '/json_rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function daemonRestLocal(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'localhost', port, path: urlPath,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Start local USDmd daemon
ipcMain.handle('local-node-start', async (event, { rpcPort = 17750, p2pPort = 17749, seedNodes = [] } = {}) => {
  if (localDaemon && !localDaemon.killed) {
    return { ok: true, message: 'Daemon already running', pid: localDaemon.pid };
  }

  let binary = findBinary('USDmd');
  if (!binary) {
    // Try auto-download
    const binDir = path.join(getDataDir(), 'bin');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    try {
      binary = await downloadBinary('USDmd', binDir);
    } catch (dlErr) {
      return { ok: false, error: 'USDmd binary not found and download failed: ' + dlErr.message + '. Place it in ~/.monerousd/bin/' };
    }
  }

  const dataDir = getDataDir();
  const args = [
    '--data-dir', path.join(dataDir, 'blockchain'),
    '--rpc-bind-ip', 'localhost',
    '--rpc-bind-port', String(rpcPort),
    '--p2p-bind-port', String(p2pPort),
    '--confirm-external-bind',
    '--non-interactive',
    '--log-level', '1',
    '--db-sync-mode', 'safe',
    '--disable-dns-checkpoints',
  ];

  // Add seed nodes if provided
  for (const seed of seedNodes) {
    args.push('--add-peer', seed);
  }

  // Default seed node
  if (seedNodes.length === 0) {
    args.push('--add-peer', 'seed.monerousd.org:17749');
  }

  daemonLog = [];
  try {
    localDaemon = spawn(binary, args, {
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    localDaemon.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      daemonLog.push(...lines);
      if (daemonLog.length > MAX_LOG_LINES) daemonLog = daemonLog.slice(-MAX_LOG_LINES);
    });
    localDaemon.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      daemonLog.push(...lines);
      if (daemonLog.length > MAX_LOG_LINES) daemonLog = daemonLog.slice(-MAX_LOG_LINES);
    });

    localDaemon.on('exit', (code) => {
      daemonLog.push('[USDmd exited with code ' + code + ']');
      localDaemon = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('local-node-stopped', { code });
      }
    });

    return { ok: true, pid: localDaemon.pid, binary, dataDir };
  } catch (e) {
    return { ok: false, error: 'Failed to start daemon: ' + e.message };
  }
});

// Stop local daemon
ipcMain.handle('local-node-stop', async () => {
  if (!localDaemon || localDaemon.killed) {
    localDaemon = null;
    return { ok: true, message: 'Not running' };
  }
  try {
    localDaemon.kill('SIGTERM');
    // Wait up to 10s for graceful shutdown
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (localDaemon && !localDaemon.killed) localDaemon.kill('SIGKILL');
        resolve();
      }, 10000);
      if (localDaemon) {
        localDaemon.on('exit', () => { clearTimeout(timeout); resolve(); });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });
    localDaemon = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Get local node status (sync height, peers, etc.)
ipcMain.handle('local-node-status', async (event, { rpcPort = 17750 } = {}) => {
  const running = localDaemon && !localDaemon.killed;

  // Also check if there's already a daemon running on the port (even if we didn't start it)
  try {
    const info = await daemonRpcLocal(rpcPort, 'get_info');
    if (info && info.result) {
      const r = info.result;
      return {
        running: true,
        managedByApp: !!running,
        height: r.height || 0,
        targetHeight: r.target_height || 0,
        peers: (r.white_peerlist_size || 0) + (r.grey_peerlist_size || 0),
        outgoingConnections: r.outgoing_connections_count || 0,
        incomingConnections: r.incoming_connections_count || 0,
        synced: r.height >= (r.target_height || r.height),
        difficulty: r.difficulty || 0,
        networkHashrate: r.difficulty ? Math.floor(r.difficulty / 120) : 0,
        version: r.version || '',
        status: r.status || '',
        txPoolSize: r.tx_pool_size || 0,
        databaseSize: r.database_size || 0,
        freeSpace: r.free_space || 0,
        topBlockHash: r.top_block_hash || '',
        lastLog: daemonLog.slice(-20),
      };
    }
  } catch (_) {}

  return {
    running: !!running,
    managedByApp: !!running,
    height: 0,
    targetHeight: 0,
    peers: 0,
    synced: false,
    lastLog: daemonLog.slice(-20),
  };
});

// Get daemon log
ipcMain.handle('local-node-log', async () => {
  return { lines: daemonLog.slice(-100) };
});

// Check if binary exists
ipcMain.handle('local-node-check-binary', async () => {
  const daemon = findBinary('USDmd');
  const walletRpc = findBinary('USDm-wallet-rpc');
  return {
    daemonFound: !!daemon,
    daemonPath: daemon,
    walletRpcFound: !!walletRpc,
    walletRpcPath: walletRpc,
    dataDir: getDataDir(),
  };
});

// One-click node setup: copy binaries, create dirs, start daemon + wallet-rpc
ipcMain.handle('local-node-setup', async (event, { seedNodes = [] } = {}) => {
  if (buildInProgress) {
    return { ok: false, error: 'A build is already in progress. Please wait for it to complete.' };
  }
  const steps = [];
  const dataDir = getDataDir();
  const binDir = path.join(dataDir, 'bin');
  const blockchainDir = path.join(dataDir, 'blockchain');
  const walletDir = path.join(dataDir, 'wallets');

  // Step 1: Create directory structure
  for (const dir of [binDir, blockchainDir, walletDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      steps.push('Created ' + dir);
    }
  }

  // Step 2: Find or download daemon binary
  let daemonPath = findBinary('USDmd');
  if (!daemonPath) {
    steps.push('USDmd not found locally, downloading…');
    try {
      daemonPath = await downloadBinary('USDmd', binDir);
      steps.push('Downloaded USDmd to ' + daemonPath);
    } catch (dlErr) {
      // Pre-built binary not available — build from source
      steps.push('Pre-built binary not available, building from source...');
      sendBuildProgress('binaries', 'Pre-built binary not available, will build from source...');
      buildInProgress = true;
      try {
        daemonPath = await buildFromSource(binDir);
        steps.push('Built USDmd from source: ' + daemonPath);
      } catch (buildErr) {
        return { ok: false, error: 'Could not set up USDmd: ' + (buildErr.message || ''), steps };
      } finally {
        buildInProgress = false;
      }
    }
  } else {
    steps.push('Found USDmd at ' + daemonPath);
  }

  // Step 3: Find or download wallet-rpc binary
  let walletRpcPath = findBinary('USDm-wallet-rpc');
  if (!walletRpcPath) {
    steps.push('USDm-wallet-rpc not found locally, downloading…');
    try {
      walletRpcPath = await downloadBinary('USDm-wallet-rpc', binDir);
      steps.push('Downloaded USDm-wallet-rpc to ' + walletRpcPath);
    } catch (dlErr) {
      // wallet-rpc is optional for node-only setup
      steps.push('USDm-wallet-rpc download failed (optional): ' + dlErr.message);
    }
  } else {
    steps.push('Found USDm-wallet-rpc at ' + walletRpcPath);
  }

  // Step 4: Check if daemon is already running on port
  let daemonAlreadyRunning = false;
  try {
    const info = await daemonRpcLocal(17750, 'get_info');
    if (info && info.result && info.result.status === 'OK') {
      daemonAlreadyRunning = true;
      steps.push('Daemon already running at height ' + (info.result.height || 0));
    }
  } catch (_) {}

  // Step 5: Start daemon if not running
  if (!daemonAlreadyRunning) {
    if (localDaemon && !localDaemon.killed) {
      steps.push('Daemon process already managed by app');
    } else {
      const args = [
        '--data-dir', blockchainDir,
        '--rpc-bind-ip', 'localhost',
        '--rpc-bind-port', '17750',
        '--p2p-bind-port', '17749',
        '--confirm-external-bind',
        '--non-interactive',
        '--log-level', '1',
        '--db-sync-mode', 'safe',
        '--disable-dns-checkpoints',
      ];

      const seeds = seedNodes.length > 0 ? seedNodes : ['seed.monerousd.org:17749'];
      for (const seed of seeds) {
        args.push('--add-peer', seed);
      }

      daemonLog = [];
      try {
        localDaemon = spawn(daemonPath, args, {
          cwd: dataDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });

        localDaemon.stdout.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          daemonLog.push(...lines);
          if (daemonLog.length > MAX_LOG_LINES) daemonLog = daemonLog.slice(-MAX_LOG_LINES);
        });
        localDaemon.stderr.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          daemonLog.push(...lines);
          if (daemonLog.length > MAX_LOG_LINES) daemonLog = daemonLog.slice(-MAX_LOG_LINES);
        });

        localDaemon.on('exit', (code) => {
          daemonLog.push('[USDmd exited with code ' + code + ']');
          localDaemon = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('local-node-stopped', { code });
          }
        });

        steps.push('Started USDmd (PID ' + localDaemon.pid + ')');
      } catch (e) {
        return { ok: false, error: 'Failed to start daemon: ' + e.message, steps };
      }
    }
  }

  return {
    ok: true,
    steps,
    daemonPath,
    walletRpcPath,
    dataDir,
    daemonAlreadyRunning,
  };
});

// Start local wallet-rpc connected to local daemon
ipcMain.handle('local-wallet-rpc-start', async (event, { daemonPort = 17750, walletRpcPort = 27750 } = {}) => {
  if (localWalletRpc && !localWalletRpc.killed) {
    return { ok: true, message: 'Wallet RPC already running', pid: localWalletRpc.pid };
  }

  const binary = findBinary('USDm-wallet-rpc');
  if (!binary) {
    return { ok: false, error: 'USDm-wallet-rpc binary not found.' };
  }

  const dataDir = getDataDir();
  const walletDir = path.join(dataDir, 'wallets');
  if (!fs.existsSync(walletDir)) fs.mkdirSync(walletDir, { recursive: true });

  const args = [
    '--daemon-address', 'localhost:' + daemonPort,
    '--rpc-bind-port', String(walletRpcPort),
    '--rpc-bind-ip', 'localhost',
    '--disable-rpc-login',
    '--wallet-dir', walletDir,
    '--log-level', '1',
    '--non-interactive',
  ];

  try {
    localWalletRpc = spawn(binary, args, {
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    localWalletRpc.on('exit', (code) => {
      localWalletRpc = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('local-wallet-rpc-stopped', { code });
      }
    });

    return { ok: true, pid: localWalletRpc.pid, binary };
  } catch (e) {
    return { ok: false, error: 'Failed to start wallet RPC: ' + e.message };
  }
});

// Stop local wallet-rpc
ipcMain.handle('local-wallet-rpc-stop', async () => {
  if (!localWalletRpc || localWalletRpc.killed) {
    localWalletRpc = null;
    return { ok: true };
  }
  try {
    localWalletRpc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (localWalletRpc && !localWalletRpc.killed) localWalletRpc.kill('SIGKILL');
        resolve();
      }, 5000);
      if (localWalletRpc) {
        localWalletRpc.on('exit', () => { clearTimeout(timeout); resolve(); });
      } else {
        clearTimeout(timeout); resolve();
      }
    });
    localWalletRpc = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Cleanup on app exit
app.on('before-quit', () => {
  // If we're updating, child processes are already killed — skip slow cleanup
  if (isUpdating) return;
  if (localWalletRpc && !localWalletRpc.killed) localWalletRpc.kill('SIGTERM');
  if (localDaemon && !localDaemon.killed) localDaemon.kill('SIGTERM');
  // Destroy remote relay sessions
  for (const [hostname] of remoteCookies) {
    destroyRemoteSession('https://' + hostname);
  }
});

function buildNativeMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'MoneroUSD Website',
          click: async () => { await shell.openExternal('https://monerousd.org'); },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const windowOpts = {
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    show: false, // show when ready to prevent flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // macOS: use default native title bar with traffic lights (no hiddenInset)
  if (isMac) {
    windowOpts.titleBarStyle = 'default';
    windowOpts.vibrancy = 'sidebar';
  }

  // Windows: standard frame with icon
  if (process.platform === 'win32') {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    if (fs.existsSync(iconPath)) windowOpts.icon = iconPath;
  }

  // Linux: set icon
  if (process.platform === 'linux') {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(iconPath)) windowOpts.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOpts);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Show window gracefully once content is ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isMac) mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // Set native application menu
  Menu.setApplicationMenu(buildNativeMenu());
  createWindow();
  // Start auto-update checks after a short delay
  setTimeout(initAutoUpdater, 5000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !isUpdating) app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

ipcMain.handle('get-app-version', () => app.getVersion());

// Proxy wallet RPC from main process so renderer (file://) can reach local RPC without CORS.
// Retry on ECONNRESET / connection errors (local nodes only; wallet RPC can drop under load).
const RPC_MAX_ATTEMPTS = 3;
const RPC_RETRY_DELAY_MS = 2000;

// Cookie jar for remote relay sessions (per-host)
const remoteCookies = new Map(); // hostname -> cookie string
const remoteCsrfTokens = new Map(); // hostname -> CSRF token string

function attemptWalletRpc(url, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const baseUrl = (url || '').trim().replace(/\/$/, '');
    if (!baseUrl || (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://'))) {
      reject(new Error('Invalid wallet RPC URL. Use e.g. https://monerousd.org or http://192.0.2.1:27750'));
      return;
    }
    const reqUrl = baseUrl + '/json_rpc';
    const u = new URL(reqUrl);
    const isHttps = u.protocol === 'https:';
    const isRemote = u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '::1';
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };

    // Send session cookie and CSRF token for remote relay connections
    if (isRemote) {
      const cookie = remoteCookies.get(u.hostname);
      if (cookie) headers['Cookie'] = cookie;
      const csrf = remoteCsrfTokens.get(u.hostname);
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers,
    };
    const req = (isHttps ? https : http).request(opts, (res) => {
      // Capture Set-Cookie for remote relay sessions
      if (isRemote && res.headers['set-cookie']) {
        for (const sc of res.headers['set-cookie']) {
          const match = sc.match(/musd_session=([^;]+)/);
          if (match && match[1]) {
            remoteCookies.set(u.hostname, 'musd_session=' + match[1]);
          }
        }
      }

      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try {
          // Preserve uint64 precision: JS Number loses precision above 2^53-1. 18M USDm = 1.8e19 atomic units.
          const raw = (buf || '')
            .replace(/"balance"\s*:\s*(\d+)/g, '"balance":"$1"')
            .replace(/"unlocked_balance"\s*:\s*(\d+)/g, '"unlocked_balance":"$1"')
            .replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"');
          const data = JSON.parse(raw || '{}');
          if (data.error) reject(new Error(data.error.message || 'RPC error'));
          else resolve(data.result);
        } catch (e) {
          reject(new Error('Invalid RPC response: ' + (e.message || 'parse error')));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}

// Initialize a remote relay session (call /api/session to spawn a per-user wallet-rpc)
async function initRemoteSession(baseUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const isHttps = u.protocol === 'https:';
    const headers = { 'Content-Type': 'application/json' };
    const cookie = remoteCookies.get(u.hostname);
    if (cookie) headers['Cookie'] = cookie;
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: '/api/session',
      method: 'POST',
      headers,
    };
    const req = (isHttps ? https : http).request(opts, (res) => {
      // Capture Set-Cookie
      if (res.headers['set-cookie']) {
        for (const sc of res.headers['set-cookie']) {
          const match = sc.match(/musd_session=([^;]+)/);
          if (match && match[1]) {
            remoteCookies.set(u.hostname, 'musd_session=' + match[1]);
          }
        }
      }
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(buf);
          // Capture CSRF token from session response for use in RPC requests
          if (data && data.csrfToken) {
            remoteCsrfTokens.set(u.hostname, data.csrfToken);
          }
          resolve(data);
        } catch (_) { resolve(null); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Session init timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Destroy a remote relay session on app quit
function destroyRemoteSession(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const isHttps = u.protocol === 'https:';
    const headers = {};
    const cookie = remoteCookies.get(u.hostname);
    if (cookie) headers['Cookie'] = cookie;
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: '/api/session/close',
      method: 'POST',
      headers,
    };
    const req = (isHttps ? https : http).request(opts, () => {});
    req.on('error', () => {});
    req.setTimeout(3000, () => req.destroy());
    req.end();
    remoteCookies.delete(u.hostname);
    remoteCsrfTokens.delete(u.hostname);
  } catch (_) {}
}

ipcMain.handle('wallet-rpc', async (event, { url, method, params = {}, timeoutMs = 30000 }) => {
  const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
  const isRemote = u && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '::1';
  const hint = isRemote
    ? ' Check your internet connection or try refreshing.'
    : ' Run USDmd (17750) and ./start-wallet-rpc.sh (27750) locally.';

  // For remote connections, ensure session exists first
  if (isRemote && !remoteCookies.has(u.hostname)) {
    try {
      const sess = await initRemoteSession(url);
      if (!sess || sess.status !== 'ready') {
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const s = await initRemoteSession(url).catch(() => null);
          if (s && s.status === 'ready') break;
        }
      }
    } catch (e) {
      throw new Error('Failed to connect to MoneroUSD relay: ' + (e.message || '') + hint);
    }
  }

  let lastErr;
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptWalletRpc(url, method, params, timeoutMs);
    } catch (e) {
      lastErr = e;
      const code = e.code || '';
      const msg = (e && e.message) || '';
      const retryable = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'socket hang up'].some(c => code === c || msg.includes(c));
      if (attempt < RPC_MAX_ATTEMPTS && retryable) {
        await new Promise(r => setTimeout(r, RPC_RETRY_DELAY_MS));
        continue;
      }
      const friendly = msg.includes('timed out') ? 'Request timed out.' + hint
        : /ECONNRESET|socket hang up/i.test(msg || code) ? 'Wallet RPC connection reset.' + hint
        : msg + hint;
      throw new Error(friendly);
    }
  }
  throw lastErr;
});

// IPC: Initialize remote session explicitly from renderer
ipcMain.handle('init-remote-session', async (event, { url }) => {
  try {
    const result = await initRemoteSession(url);
    return result || { status: 'error' };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
});

// IPC: Check if any wallet files exist on disk (for fresh-install detection)
ipcMain.handle('check-wallet-exists', async () => {
  const walletDir = path.join(getDataDir(), 'wallets');
  try {
    if (!fs.existsSync(walletDir)) return false;
    const files = fs.readdirSync(walletDir);
    // Look for .keys files which indicate a created wallet
    return files.some(f => f.endsWith('.keys'));
  } catch (_) {
    return false;
  }
});

// IPC: Generic relay API fetch — routes non-RPC calls (like /delete_wallet_cache)
// through the same session (remoteCookies) that wallet-rpc uses.
ipcMain.handle('relay-fetch', async (event, { baseUrl, path, method, body }) => {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const isHttps = u.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const cookie = remoteCookies.get(u.hostname);
    if (cookie) headers['Cookie'] = cookie;
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: path,
      method: method || 'POST',
      headers,
    };
    const req = (isHttps ? https : http).request(opts, (res) => {
      if (res.headers['set-cookie']) {
        for (const sc of res.headers['set-cookie']) {
          const match = sc.match(/musd_session=([^;]+)/);
          if (match && match[1]) remoteCookies.set(u.hostname, 'musd_session=' + match[1]);
        }
      }
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')); } catch (_) { resolve({ raw: buf }); }
      });
    });
    req.on('error', e => reject(e));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Relay fetch timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
});
