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
autoUpdater.autoInstallOnAppQuit = true;
// Always enable logging for update debugging
autoUpdater.logger = console;
autoUpdater.logger.transports = { file: { level: 'info' } };

function initAutoUpdater() {
  autoUpdater.checkForUpdates().catch(() => {});

  autoUpdater.on('update-available', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes || '',
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { status: 'up-to-date' });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', { version: info.version });
    }
    // Auto-restart after a short delay to let the user see the notification
    setTimeout(() => {
      isUpdating = true;
      // Kill child processes immediately so before-quit doesn't block
      if (localWalletRpc && !localWalletRpc.killed) { try { localWalletRpc.kill('SIGKILL'); } catch(_){} }
      if (localDaemon && !localDaemon.killed) { try { localDaemon.kill('SIGKILL'); } catch(_){} }
      localWalletRpc = null;
      localDaemon = null;
      console.log('[update] Calling quitAndInstall...');
      try {
        // isSilent=true (no installer UI on Windows), isForceRunAfter=true (restart app after install)
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        console.error('[update] quitAndInstall failed:', e);
        // Fallback: force quit and let autoInstallOnAppQuit handle it on next launch
        app.quit();
      }
    }, 8000);
  });

  autoUpdater.on('error', (err) => {
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

ipcMain.handle('update-install', () => {
  isUpdating = true;
  if (localWalletRpc && !localWalletRpc.killed) { try { localWalletRpc.kill('SIGKILL'); } catch(_){} }
  if (localDaemon && !localDaemon.killed) { try { localDaemon.kill('SIGKILL'); } catch(_){} }
  localWalletRpc = null;
  localDaemon = null;
  console.log('[update] Manual quitAndInstall triggered');
  try {
    autoUpdater.quitAndInstall(true, true);
  } catch (e) {
    console.error('[update] quitAndInstall failed:', e);
    app.quit();
  }
});

// Check for updates every 4 hours
setInterval(() => {
  autoUpdater.checkForUpdates().catch(() => {});
}, 4 * 60 * 60 * 1000);

/* ── Local Node Management ─────────────────────────────────── */
let localDaemon = null;   // child_process for USDmd
let localWalletRpc = null; // child_process for USDm-wallet-rpc
let daemonLog = [];        // last 200 lines of daemon output
const MAX_LOG_LINES = 200;

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

function getDataDir() {
  const base = process.env.MONEROUSD_DATA_DIR || path.join(os.homedir(), '.monerousd');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

function daemonRpcLocal(port, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params: params || {} });
    const opts = {
      hostname: '127.0.0.1', port, path: '/json_rpc', method: 'POST',
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
      hostname: '127.0.0.1', port, path: urlPath,
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
    '--rpc-bind-ip', '127.0.0.1',
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
      return {
        ok: false,
        error: 'Could not download USDmd: ' + dlErr.message + '. You can manually place the binary in ~/.monerousd/bin/',
        steps,
      };
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
        '--rpc-bind-ip', '127.0.0.1',
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
    '--daemon-address', '127.0.0.1:' + daemonPort,
    '--rpc-bind-port', String(walletRpcPort),
    '--rpc-bind-ip', '127.0.0.1',
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

// Proxy wallet RPC from main process so renderer (file://) can reach http://127.0.0.1 without CORS.
// Retry on ECONNRESET / connection errors (local nodes only; wallet RPC can drop under load).
const RPC_MAX_ATTEMPTS = 3;
const RPC_RETRY_DELAY_MS = 2000;

// Cookie jar for remote relay sessions (per-host)
const remoteCookies = new Map(); // hostname -> cookie string

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

    // Send session cookie for remote relay connections
    if (isRemote) {
      const cookie = remoteCookies.get(u.hostname);
      if (cookie) headers['Cookie'] = cookie;
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
        try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); }
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
        // Poll for ready
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
