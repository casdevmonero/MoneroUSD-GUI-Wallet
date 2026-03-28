/**
 * Serve the wallet UI in the browser and proxy JSON-RPC to per-user USDm-wallet-rpc instances.
 * Each browser session gets its own wallet-rpc process on a unique port.
 * Uses CakeWallet-style WalletRpcManager for state management, health monitoring, and reconnection.
 * Run: node server.js
 * Then open: http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WalletRpcManager = require('./rpc');

// WebAuthn/FIDO2 biometric authentication
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DAEMON_RPC = process.env.DAEMON_RPC_URL || 'http://127.0.0.1:17750';

// Wallet-rpc binary and config
const WALLET_RPC_BIN = process.env.WALLET_RPC_BIN
  || '/root/MoneroUSD/MoneroUSD-main/build-linux/bin/USDm-wallet-rpc';
const DAEMON_ADDRESS = 'http://127.0.0.1:17750';

// ===== Dandelion++ Transaction Propagation =====
const DANDELION_STEM_PROB = parseFloat(process.env.DANDELION_STEM_PROB || '0.9');
const DANDELION_RELAY_PEERS = (process.env.DANDELION_RELAY_PEERS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const dandelionPool = new Map();

// ===== Coinbase unlock window =====
const COINBASE_UNLOCK_BLOCKS = 10;
let cachedChainHeight = 0;
let chainHeightFetchedAt = 0;

// ===== Reserve Health =====
const SWAP_BACKEND_URL = process.env.SWAP_BACKEND_URL || 'http://127.0.0.1:8787';
const RESERVE_MIN_RATIO = 1.50;

// ===== Block Reward (Dynamic) =====
// Miners earn from treasury: min(yield_pool / (720 × 30), 1 USDm) per block.
// Scales with swap volume — zero when treasury is empty (no unbacked issuance).
const BLOCKS_PER_DAY = 720;
const BLOCK_REWARD_WINDOW = BLOCKS_PER_DAY * 30;  // ~1 month of blocks
const MAX_BLOCK_REWARD_ATOMIC = 100000000n;         // 1 USDm = 1e8 atomic
const YIELD_WALLET_RPC_URL = process.env.YIELD_WALLET_RPC_URL || 'http://127.0.0.1:27751';
const YIELD_WALLET_RPC_USER = process.env.YIELD_WALLET_RPC_USER || '';
const YIELD_WALLET_RPC_PASS = process.env.YIELD_WALLET_RPC_PASS || '';

async function fetchYieldPoolBalance() {
  try {
    const r = await new Promise((resolve, reject) => {
      const u = new URL(SWAP_BACKEND_URL);
      const req = http.request({
        hostname: u.hostname, port: u.port || 80, path: '/api/reserves', method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
      });
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.end();
    });
    return r && r.yield_pool_atomic ? BigInt(r.yield_pool_atomic) : 0n;
  } catch (_) { return 0n; }
}

function computeBlockReward(yieldPool) {
  if (yieldPool <= 0n) return 0n;
  const reward = yieldPool / BigInt(BLOCK_REWARD_WINDOW);
  return reward > MAX_BLOCK_REWARD_ATOMIC ? MAX_BLOCK_REWARD_ATOMIC : reward;
}

async function yieldWalletRpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params: params || {} });
    const u = new URL(YIELD_WALLET_RPC_URL);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (YIELD_WALLET_RPC_USER || YIELD_WALLET_RPC_PASS)
      headers.Authorization = 'Basic ' + Buffer.from(YIELD_WALLET_RPC_USER + ':' + YIELD_WALLET_RPC_PASS).toString('base64');
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: '/json_rpc', method: 'POST', headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try {
          const d = JSON.parse(buf);
          if (d && d.error) return reject(new Error(d.error.message || 'yield wallet RPC error'));
          resolve(d ? d.result : null);
        } catch (_) { resolve(null); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('yield wallet RPC timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function payBlockReward(toAddress) {
  if (!toAddress) return;
  try {
    const yieldPool = await fetchYieldPoolBalance();
    const reward = computeBlockReward(yieldPool);
    if (reward <= 0n) return;
    await yieldWalletRpc('transfer', {
      destinations: [{ amount: String(reward), address: toAddress }],
      priority: 1,
      ring_size: 0,
    });
    console.log('  Block reward: sent ' + (Number(reward) / 1e8).toFixed(8) + ' USDm to ' + toAddress.slice(0, 12) + '… (treasury=' + (Number(yieldPool) / 1e8).toFixed(2) + ')');
  } catch (e) {
    console.log('  Block reward: skipped — ' + e.message);
  }
}
let cachedReserveRatio = null;
let reserveRatioFetchedAt = 0;

async function fetchReserveRatio() {
  const now = Date.now();
  if (cachedReserveRatio !== null && now - reserveRatioFetchedAt < 60000) return cachedReserveRatio;
  try {
    const body = JSON.stringify({});
    const u = new URL(SWAP_BACKEND_URL);
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname, port: u.port || 80,
        path: '/api/reserves', method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
      });
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.end();
    });
    if (r && r.total_reserve_usd != null && r.total_swap_minted_usdm != null) {
      const reserveUsd = parseFloat(r.total_reserve_usd);
      const mintedUsdm = parseFloat(r.total_swap_minted_usdm);
      cachedReserveRatio = mintedUsdm > 0 ? reserveUsd / mintedUsdm : null;
      reserveRatioFetchedAt = now;
      return cachedReserveRatio;
    }
  } catch (_) {}
  return null;
}

// ===== Security: Allowed origins (exact match, no regex bypass) =====
const ALLOWED_ORIGINS = new Set([
  'https://monerousd.org',
  'https://www.monerousd.org',
  'https://app.monerousd.org',
  'http://monerousd.org',
  'http://www.monerousd.org',
  'http://app.monerousd.org',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

// ===== Security: RPC method whitelist =====
const ALLOWED_RPC_METHODS = new Set([
  'create_wallet', 'open_wallet', 'close_wallet', 'get_balance',
  'get_address', 'create_address', 'get_height', 'refresh',
  'transfer', 'get_transfers', 'get_transfer_by_txid',
  'restore_deterministic_wallet', 'query_key', 'store',
  'get_version', 'get_accounts', 'get_languages', 'get_attribute',
  'auto_refresh', 'change_wallet_password', 'rescan_blockchain',
  'set_daemon', 'incoming_transfers',
  'freeze', 'thaw', // Staking: freeze/unfreeze outputs
  'set_attribute', // Store wallet config (e.g. ring_size for FCMP++)
]);

// ===== Security: Per-IP session limits =====
const MAX_SESSIONS_PER_IP = 10;
const sessionsByIp = new Map(); // ip -> Set<token>

// ===== Security: Rate limiting for all endpoints =====
const GLOBAL_RATE_WINDOW = 60 * 1000;
const GLOBAL_RATE_MAX = 120; // 120 req/min per IP
const RPC_RATE_MAX = 60;     // 60 req/min per IP for RPC
const globalRateMap = new Map(); // ip -> { count, resetAt }
const rpcRateMap = new Map();    // ip -> { count, resetAt }

function checkGlobalRate(ip) {
  const now = Date.now();
  let entry = globalRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + GLOBAL_RATE_WINDOW };
    globalRateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= GLOBAL_RATE_MAX;
}

function checkRpcRate(ip) {
  const now = Date.now();
  let entry = rpcRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + GLOBAL_RATE_WINDOW };
    rpcRateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RPC_RATE_MAX;
}

// ===== Security: Audit logging =====
const SECURITY_LOG_PATH = '/var/log/monerousd/security.log';
let securityLogStream = null;
try {
  fs.mkdirSync('/var/log/monerousd', { recursive: true, mode: 0o700 });
  securityLogStream = fs.createWriteStream(SECURITY_LOG_PATH, { flags: 'a' });
} catch (_) {}

function logSecurity(event, details) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...(details || {}),
  });
  if (securityLogStream) securityLogStream.write(entry + '\n');
}

// ===== WebAuthn credential storage =====
const CREDENTIALS_DIR = '/var/lib/monerousd/credentials';
try { fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}

function walletHash(address) {
  return crypto.createHash('sha256').update(String(address)).digest('hex');
}

function credentialPath(wHash) {
  // Sanitize to prevent path traversal
  const safe = wHash.replace(/[^a-f0-9]/g, '');
  return path.join(CREDENTIALS_DIR, safe + '.json');
}

function loadCredential(wHash) {
  try {
    const data = fs.readFileSync(credentialPath(wHash), 'utf8');
    return JSON.parse(data);
  } catch (_) { return null; }
}

function saveCredential(wHash, cred) {
  const tmp = credentialPath(wHash) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, credentialPath(wHash));
}

function deleteCredential(wHash) {
  try { fs.unlinkSync(credentialPath(wHash)); } catch (_) {}
}

function hasCredential(wHash) {
  try { return fs.existsSync(credentialPath(wHash)); } catch (_) { return false; }
}

// Look up credential by seed hash — scans all credential files
function findCredentialBySeedHash(seedHash) {
  try {
    const files = fs.readdirSync(CREDENTIALS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CREDENTIALS_DIR, f), 'utf8'));
        if (data.seedHash === seedHash) return data;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function seedHashFromSeed(seed) {
  return crypto.createHash('sha256').update(seed.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
}

// RP ID extraction from request Host header
function getRpId(req) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  // For localhost/127.0.0.1, use 'localhost'
  if (host === '127.0.0.1' || host === '::1' || !host) return 'localhost';
  return host;
}

function getOrigin(req) {
  // Reconstruct origin from request
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || 'localhost:3000';
  return proto + '://' + host;
}

function getClientIp(req) {
  // Only trust X-Forwarded-For from loopback (nginx)
  const remote = req.socket.remoteAddress || '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || remote;
  }
  return remote;
}

function validateOrigin(req) {
  const origin = req.headers.origin || '';
  if (!origin) return true; // Same-origin requests don't send Origin header
  // Allow Electron desktop app origins (file://, app://, null)
  if (origin === 'null' || origin === 'file://' || origin.startsWith('app://')) return true;
  return ALLOWED_ORIGINS.has(origin);
}

// Per-user session config
const SESSION_PORT_START = 28000;
const SESSION_PORT_END   = 28999;
const MAX_SESSIONS       = 200;
const SESSION_IDLE_MS    = 4 * 60 * 60 * 1000;  // 4 hr idle timeout — desktop wallets stay open for hours
const SESSION_DIR_BASE   = '/var/lib/monerousd/sessions'; // Moved from /tmp for security (restricted permissions)
const CLEANUP_INTERVAL   = 60 * 1000;       // check every 60s
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hr absolute session timeout

// Rate limiting: per-IP session creation (max 3 sessions per IP per minute)
const RATE_LIMIT_WINDOW  = 60 * 1000;
const RATE_LIMIT_MAX     = 3;
const rateLimitMap = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Periodic rate-limit map cleanup
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
  for (const [ip, entry] of globalRateMap) {
    if (now > entry.resetAt) globalRateMap.delete(ip);
  }
  for (const [ip, entry] of rpcRateMap) {
    if (now > entry.resetAt) rpcRateMap.delete(ip);
  }
}, 5 * 60 * 1000);

const MIMES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const rendererDir = path.join(__dirname, 'renderer');

// Read-only RPC methods safe to run concurrently
const CONCURRENT_RPC_METHODS = new Set([
  'get_version', 'get_address', 'get_balance', 'get_height',
  'get_accounts', 'get_transfers', 'get_transfer_by_txid',
  'query_key', 'get_languages', 'get_attribute',
  'auto_refresh', 'incoming_transfers', 'refresh',
]);

// ===== Session Manager =====

const sessions = new Map();    // token -> SessionState
const usedPorts = new Set();
const net = require('net');

// Kill stale wallet-rpc processes from previous server instances on startup
(function cleanupStaleWalletRpc() {
  try {
    const { execSync } = require('child_process');
    // Find wallet-rpc processes using session ports (not the main wallet-rpc on 27750)
    const psOutput = execSync(
      "ps aux | grep USDm-wallet-rpc | grep -v grep | grep -- '--rpc-bind-port 28' || true",
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (psOutput) {
      const pids = psOutput.split('\n').map(line => line.trim().split(/\s+/)[1]).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
          console.log('  Cleaned up stale wallet-rpc PID ' + pid);
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Also clean up stale session directories from previous server crashes
  try {
    const dirs = fs.readdirSync(SESSION_DIR_BASE);
    let cleaned = 0;
    for (const d of dirs) {
      const full = path.join(SESSION_DIR_BASE, d);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
          cleaned++;
        }
      } catch (_) {}
    }
    if (cleaned > 0) console.log('  Cleaned up ' + cleaned + ' stale session directories');
  } catch (_) {}
})();

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    srv.listen(port, '127.0.0.1');
  });
}

async function allocatePort() {
  for (let p = SESSION_PORT_START; p <= SESSION_PORT_END; p++) {
    if (!usedPorts.has(p)) {
      // Verify the port is actually free on the OS
      const free = await isPortFree(p);
      if (free) {
        usedPorts.add(p);
        return p;
      } else {
        console.log('  Port ' + p + ' in use by OS (stale process?), skipping');
      }
    }
  }
  return null;
}

function releasePort(port) {
  usedPorts.delete(port);
}

function parseCookie(req, name) {
  const hdr = req.headers.cookie || '';
  const match = hdr.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    'musd_session=' + token + '; Path=/; HttpOnly; SameSite=Strict;' + secure + ' Max-Age=43200'); // 12hr — matches SESSION_MAX_AGE_MS
}

function walletRpc(port, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params: params || {} });
    const opts = {
      hostname: '127.0.0.1', port, path: '/json_rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
    });
    req.setTimeout(timeoutMs || 5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitForWalletRpc(port, maxRetries) {
  // Fast first check after 200ms, then 300ms intervals — total ~3s for 10 retries
  for (let i = 0; i < (maxRetries || 10); i++) {
    try {
      const r = await walletRpc(port, 'get_version', {}, 1500);
      if (r && r.result) return true;
    } catch (_) {}
    await new Promise(ok => setTimeout(ok, i === 0 ? 200 : 300));
  }
  return false;
}

// Auto-restart is now handled by WalletRpcManager internally.
// The manager's health monitor detects failures, triggers reconnection,
// and restarts the process if needed — CakeWallet-style.
async function autoRestartSession(session) {
  if (session.state === 'closing') return;
  if (session.manager) {
    // WalletRpcManager handles restart internally via health monitor
    const ok = await session.manager.restart();
    if (ok) {
      session.state = 'ready';
      session.port = session.manager.port;
    } else {
      session.state = 'dead';
    }
  }
}

async function createSession() {
  if (sessions.size >= MAX_SESSIONS) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const port = await allocatePort();
  if (!port) return null;

  const walletDir = path.join(SESSION_DIR_BASE, token);
  fs.mkdirSync(walletDir, { recursive: true, mode: 0o700 });

  const env = Object.assign({}, process.env, {
    MONEROUSD_ENABLE_FCMP: '1',
    MONEROUSD_ALLOW_LOW_MIXIN: '1',
    MONEROUSD_DISABLE_TX_LIMITS: '1',
    MONEROUSD_DISABLE_UNLOCKS: '1',
  });

  // CakeWallet-style WalletRpcManager per session
  const manager = new WalletRpcManager({
    mode: 'server',
    walletDir,
    daemonAddress: DAEMON_ADDRESS,
    walletRpcBin: WALLET_RPC_BIN,
  });
  manager._port = port;

  // Wire up manager events for logging
  manager.on('stateChange', ({ from, to }) => {
    console.log('  Session port ' + port + ' state: ' + from + ' → ' + to);
  });
  manager.on('processExit', ({ code, signal, port: p }) => {
    console.log('  Session port ' + p + ' process exited with code ' + code + ' signal ' + signal);
  });
  manager.on('unhealthy', () => {
    console.log('  Session port ' + port + ' unhealthy — auto-recovering');
  });
  manager.on('restartFailed', () => {
    console.log('  Session port ' + port + ' restart failed');
  });

  const ok = await manager.spawnAndConnect(walletDir, env);

  const session = {
    token,
    port,
    manager,       // CakeWallet-style RPC manager
    walletDir,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: ok ? 'ready' : 'dead',
    proxyQueue: Promise.resolve(),
  };

  // Sync session.state with manager state for backward compatibility
  manager.on('stateChange', ({ to }) => {
    if (to === 'error' || to === 'disconnected') session.state = 'dead';
    else if (to === 'connecting') session.state = 'restarting';
    else if (to === 'wallet_opening') session.state = 'reopening';
    else session.state = 'ready';
  });

  sessions.set(token, session);

  if (ok) {
    console.log('  Session started: port ' + port + ' (active: ' + sessions.size + ')');
  } else {
    console.log('  Session wallet-rpc failed to start on port ' + port);
    await destroySession(token);
    return null;
  }

  return session;
}

async function destroySession(token) {
  const session = sessions.get(token);
  if (!session) return;

  session.state = 'closing';
  sessions.delete(token);

  // Clean up per-IP session tracking
  if (session.clientIp) {
    const ipSet = sessionsByIp.get(session.clientIp);
    if (ipSet) {
      ipSet.delete(token);
      if (ipSet.size === 0) sessionsByIp.delete(session.clientIp);
    }
  }

  // Graceful shutdown via WalletRpcManager (handles store, close_wallet, kill)
  if (session.manager) {
    await session.manager.shutdown();
  } else {
    // Legacy fallback
    try { await walletRpc(session.port, 'store', {}, 5000); } catch (_) {}
    try { await walletRpc(session.port, 'close_wallet', {}, 3000); } catch (_) {}
    try {
      session.process.kill('SIGTERM');
      setTimeout(() => { try { session.process.kill('SIGKILL'); } catch (_) {} }, 5000);
    } catch (_) {}
  }

  // Release port
  releasePort(session.port);

  // Clean up wallet files
  setTimeout(() => {
    try { fs.rmSync(session.walletDir, { recursive: true, force: true }); } catch (_) {}
  }, 2000);

  console.log('  Session destroyed: port ' + session.port + ' (active: ' + sessions.size + ')');
}

function getSession(req) {
  // Try cookie first, then X-Session-Id header (for Electron desktop / cross-origin)
  const token = parseCookie(req, 'musd_session') || req.headers['x-session-id'] || null;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  session.lastActivity = Date.now();
  return session;
}

// Periodic idle session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.lastActivity > SESSION_IDLE_MS) {
      console.log('  Session idle timeout: port ' + session.port);
      destroySession(token);
    } else if (now - session.createdAt > SESSION_MAX_AGE_MS) {
      console.log('  Session absolute timeout: port ' + session.port);
      destroySession(token);
    }
  }
}, CLEANUP_INTERVAL);

// Periodic wallet state save — every 5 minutes, call `store` on all active sessions
// This prevents data loss if wallet-rpc crashes or gets OOM-killed
setInterval(() => {
  for (const [, session] of sessions) {
    if (session.state === 'ready' && session.walletFilename) {
      walletRpc(session.port, 'store', {}, 5000).catch(() => {});
    }
  }
}, 5 * 60 * 1000);

// ===== HTTP Server =====

function parseTarget(target) {
  if (!target || typeof target !== 'string') return null;
  target = target.trim();
  if (!target.startsWith('http://') && !target.startsWith('https://')) return null;
  try {
    const u = new URL(target);
    const host = (u.hostname || '').toLowerCase();
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') return null;
    return { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), protocol: u.protocol };
  } catch (_) {
    return null;
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {

  const clientIp = getClientIp(req);

  // --- CORS preflight for Electron desktop and allowed origins ---
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '';
    if (origin === 'null' || origin === 'file://' || origin.startsWith('app://') || ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id, X-CSRF-Token, X-Biometric-Token',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }
  }

  // --- CORS: Set headers early for all responses from Electron / allowed origins ---
  const reqOrigin = req.headers.origin || '';
  if (reqOrigin && (reqOrigin === 'null' || reqOrigin === 'file://' || reqOrigin.startsWith('app://') || ALLOWED_ORIGINS.has(reqOrigin))) {
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function(statusCode, reasonOrHeaders, headers) {
      const h = headers || (typeof reasonOrHeaders === 'object' ? reasonOrHeaders : {});
      if (!h['Access-Control-Allow-Origin']) {
        h['Access-Control-Allow-Origin'] = reqOrigin === 'null' ? '*' : reqOrigin;
        h['Access-Control-Allow-Credentials'] = 'true';
      }
      if (headers) return originalWriteHead(statusCode, reasonOrHeaders, headers);
      return originalWriteHead(statusCode, h);
    };
  }

  // --- Security: Global rate limiting ---
  if (!checkGlobalRate(clientIp)) {
    logSecurity('rate_limit_global', { ip: clientIp, url: req.url });
    return sendJson(res, 429, { error: 'Too many requests. Please slow down.' });
  }

  // --- Security: Origin validation on all non-GET requests ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!validateOrigin(req)) {
      logSecurity('origin_rejected', { ip: clientIp, origin: req.headers.origin, url: req.url });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
  }

  // --- Security: CSRF token validation ---
  // Enforced on sensitive state-changing endpoints. /json_rpc is already protected by
  // session-cookie auth + origin validation + RPC method whitelist, so CSRF is defense-in-depth
  // but should not block the bootstrapping flow before the client captures the token.
  // CSRF is checked inside /json_rpc only for the 'transfer' method (the actual fund-moving call).
  // For mining/daemon endpoints, CSRF is enforced since they're less frequently called.

  // --- Session API ---

  if (req.method === 'POST' && req.url === '/api/session') {
    // Rate limit session creation per IP
    if (!checkRateLimit(clientIp)) {
      return sendJson(res, 429, { error: 'Too many sessions. Please wait a moment and try again.' });
    }
    // Create a new session (or return existing)
    let existing = getSession(req);
    if (existing && existing.state === 'ready') {
      return sendJson(res, 200, { status: 'ready', session_id: existing.token, port: existing.port, csrfToken: existing.csrfToken });
    }
    if (existing && (existing.state === 'starting' || existing.state === 'restarting')) {
      return sendJson(res, 200, { status: existing.state, session_id: existing.token, csrfToken: existing.csrfToken });
    }
    // Dead — try auto-restart before destroying
    if (existing && existing.state === 'dead') {
      await autoRestartSession(existing);
      if (existing.state === 'ready') {
        return sendJson(res, 200, { status: 'ready', session_id: existing.token, port: existing.port, csrfToken: existing.csrfToken });
      }
      await destroySession(existing.token);
    }
    // Per-IP session limit
    const ipSessions = sessionsByIp.get(clientIp);
    if (ipSessions && ipSessions.size >= MAX_SESSIONS_PER_IP) {
      logSecurity('session_limit_exceeded', { ip: clientIp });
      return sendJson(res, 429, { error: 'Too many active sessions. Please close a tab and try again.' });
    }
    const session = await createSession();
    if (!session) {
      return sendJson(res, 503, { error: 'Server at capacity. Please try again later.' });
    }
    // Generate CSRF token for this session
    session.csrfToken = crypto.randomBytes(32).toString('hex');
    session.clientIp = clientIp;
    // Track per-IP sessions
    if (!sessionsByIp.has(clientIp)) sessionsByIp.set(clientIp, new Set());
    sessionsByIp.get(clientIp).add(session.token);
    logSecurity('session_created', { ip: clientIp, port: session.port });
    setSessionCookie(res, session.token);
    return sendJson(res, 200, { status: session.state, session_id: session.token, csrfToken: session.csrfToken });
  }

  if (req.method === 'GET' && req.url === '/api/session/status') {
    const session = getSession(req);
    if (!session) return sendJson(res, 200, { status: 'none' });
    return sendJson(res, 200, { status: session.state, csrfToken: session.csrfToken });
  }

  // Lightweight keepalive — updates lastActivity so idle cleanup doesn't kill the session
  if (req.method === 'POST' && req.url === '/api/session/keepalive') {
    const session = getSession(req);  // getSession already updates lastActivity
    if (!session) return sendJson(res, 200, { status: 'none' });
    // Also ping wallet-rpc to make sure it's responsive; auto-restart if dead
    if (session.state === 'dead') {
      console.log('  Keepalive detected dead session on port ' + session.port + ', auto-restarting');
      autoRestartSession(session);
    }
    return sendJson(res, 200, { status: session.state });
  }

  if (req.method === 'DELETE' && req.url === '/api/session') {
    const session = getSession(req);
    if (session) await destroySession(session.token);
    // Clear cookie
    res.setHeader('Set-Cookie', 'musd_session=; Path=/; HttpOnly; Max-Age=0');
    return sendJson(res, 200, { status: 'closed' });
  }

  // Handle beacon (POST with action:close) for page unload
  if (req.method === 'POST' && req.url === '/api/session/close') {
    const session = getSession(req);
    if (session) destroySession(session.token); // fire-and-forget
    res.setHeader('Set-Cookie', 'musd_session=; Path=/; HttpOnly; Max-Age=0');
    return sendJson(res, 200, { status: 'closed' });
  }

  // --- WebAuthn biometric authentication API ---

  // Helper: read JSON body from request
  function readJsonBody(req, maxSize) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      const limit = maxSize || 16 * 1024;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) { req.destroy(); reject(new Error('Body too large')); return; }
        body += chunk;
      });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); }
        catch (_) { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  // POST /api/webauthn/status-by-seed — check if biometric is registered for a seed (before wallet restore)
  if (req.method === 'POST' && req.url === '/api/webauthn/status-by-seed') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    try {
      const body = await readJsonBody(req);
      const sHash = body.seedHash;
      if (!sHash || typeof sHash !== 'string') return sendJson(res, 400, { error: 'seedHash required' });
      const cred = findCredentialBySeedHash(sHash);
      if (cred) {
        return sendJson(res, 200, { registered: true, walletHash: cred.walletHash, walletAddress: cred.walletAddress || '' });
      }
      return sendJson(res, 200, { registered: false });
    } catch (e) {
      return sendJson(res, 500, { error: 'Failed to check seed status' });
    }
  }

  // GET /api/webauthn/status?address=<walletAddress>
  if (req.method === 'GET' && req.url.startsWith('/api/webauthn/status')) {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    const urlObj = new URL(req.url, 'http://localhost');
    const address = urlObj.searchParams.get('address') || '';
    if (!address) return sendJson(res, 400, { error: 'address parameter required' });
    const wHash = walletHash(address);
    return sendJson(res, 200, { registered: hasCredential(wHash), walletHash: wHash });
  }

  // POST /api/webauthn/register-options
  if (req.method === 'POST' && req.url === '/api/webauthn/register-options') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    try {
      const body = await readJsonBody(req);
      const address = body.walletAddress;
      const seedHash = body.seedHash || '';
      if (!address) return sendJson(res, 400, { error: 'walletAddress required' });
      const wHash = walletHash(address);
      if (hasCredential(wHash)) {
        return sendJson(res, 409, { error: 'Biometric already registered for this wallet. Remove it first to re-register.' });
      }
      const rpID = getRpId(req);
      const userIDBytes = crypto.createHash('sha256').update(wHash).digest();
      // Convert to Uint8Array for WebAuthn
      const userID = new Uint8Array(userIDBytes);
      const options = await generateRegistrationOptions({
        rpName: 'MoneroUSD',
        rpID,
        userID,
        userName: address.slice(0, 12) + '...' + address.slice(-6),
        userDisplayName: 'MoneroUSD Wallet',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        },
        attestationType: 'none',
      });
      // Store challenge in session
      session._webauthnRegChallenge = {
        challenge: options.challenge,
        walletHash: wHash,
        walletAddress: address,
        seedHash: seedHash,
        expiresAt: Date.now() + 120000,
      };
      return sendJson(res, 200, options);
    } catch (e) {
      logSecurity('webauthn_register_options_error', { ip: clientIp, error: e.message });
      return sendJson(res, 500, { error: 'Failed to generate registration options' });
    }
  }

  // POST /api/webauthn/register-verify
  if (req.method === 'POST' && req.url === '/api/webauthn/register-verify') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    if (!session._webauthnRegChallenge || Date.now() > session._webauthnRegChallenge.expiresAt) {
      return sendJson(res, 400, { error: 'Registration challenge expired. Start again.' });
    }
    try {
      const body = await readJsonBody(req);
      const rpID = getRpId(req);
      const expectedOrigin = getOrigin(req);
      // Build allowed origins list
      const origins = [expectedOrigin, ...ALLOWED_ORIGINS];
      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge: session._webauthnRegChallenge.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        logSecurity('webauthn_register_failed', { ip: clientIp });
        return sendJson(res, 403, { error: 'Biometric registration verification failed' });
      }
      const { credential } = verification.registrationInfo;
      const wHash = session._webauthnRegChallenge.walletHash;
      // Save credential to disk
      saveCredential(wHash, {
        credentialId: Buffer.from(credential.id).toString('base64url'),
        credentialPublicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: ['internal'],
        walletHash: wHash,
        walletAddress: session._webauthnRegChallenge.walletAddress || '',
        seedHash: session._webauthnRegChallenge.seedHash || '',
        createdAt: new Date().toISOString(),
      });
      session.walletHash = wHash;
      delete session._webauthnRegChallenge;
      logSecurity('webauthn_registered', { ip: clientIp, walletHash: wHash });
      return sendJson(res, 200, { success: true });
    } catch (e) {
      logSecurity('webauthn_register_verify_error', { ip: clientIp, error: e.message });
      return sendJson(res, 500, { error: 'Registration verification error: ' + e.message });
    }
  }

  // POST /api/webauthn/auth-options
  if (req.method === 'POST' && req.url === '/api/webauthn/auth-options') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    try {
      const body = await readJsonBody(req);
      const address = body.walletAddress;
      if (!address) return sendJson(res, 400, { error: 'walletAddress required' });
      const wHash = walletHash(address);
      const cred = loadCredential(wHash);
      if (!cred) {
        return sendJson(res, 404, { error: 'No biometric registered for this wallet', needsRegistration: true });
      }
      const rpID = getRpId(req);
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [{
          id: cred.credentialId,
          type: 'public-key',
          transports: ['internal'],
        }],
        userVerification: 'required',
      });
      session._webauthnAuthChallenge = {
        challenge: options.challenge,
        walletHash: wHash,
        expiresAt: Date.now() + 120000,
      };
      return sendJson(res, 200, options);
    } catch (e) {
      logSecurity('webauthn_auth_options_error', { ip: clientIp, error: e.message });
      return sendJson(res, 500, { error: 'Failed to generate auth options' });
    }
  }

  // POST /api/webauthn/auth-verify
  if (req.method === 'POST' && req.url === '/api/webauthn/auth-verify') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    if (!session._webauthnAuthChallenge || Date.now() > session._webauthnAuthChallenge.expiresAt) {
      return sendJson(res, 400, { error: 'Auth challenge expired. Try again.' });
    }
    try {
      const body = await readJsonBody(req);
      const wHash = session._webauthnAuthChallenge.walletHash;
      const cred = loadCredential(wHash);
      if (!cred) {
        return sendJson(res, 404, { error: 'Credential not found' });
      }
      const rpID = getRpId(req);
      const expectedOrigin = getOrigin(req);
      const origins = [expectedOrigin, ...ALLOWED_ORIGINS];
      const pubKeyBytes = new Uint8Array(Buffer.from(cred.credentialPublicKey, 'base64url'));
      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: session._webauthnAuthChallenge.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: cred.credentialId,
          publicKey: pubKeyBytes,
          counter: cred.counter,
          transports: cred.transports || ['internal'],
        },
      });
      if (!verification.verified) {
        logSecurity('webauthn_auth_failed', { ip: clientIp, walletHash: wHash });
        return sendJson(res, 403, { error: 'Biometric verification failed. Transaction declined.' });
      }
      // Update counter
      cred.counter = verification.authenticationInfo.newCounter;
      saveCredential(wHash, cred);
      // Generate one-time biometric auth token
      const bioToken = crypto.randomBytes(32).toString('hex');
      if (!session.bioTokens) session.bioTokens = new Map();
      session.bioTokens.set(bioToken, {
        expiresAt: Date.now() + 60000, // 60 seconds
        walletHash: wHash,
      });
      session.walletHash = wHash;
      delete session._webauthnAuthChallenge;
      logSecurity('webauthn_auth_success', { ip: clientIp, walletHash: wHash });
      return sendJson(res, 200, { success: true, bioToken });
    } catch (e) {
      logSecurity('webauthn_auth_verify_error', { ip: clientIp, error: e.message });
      return sendJson(res, 500, { error: 'Auth verification error: ' + e.message });
    }
  }

  // DELETE /api/webauthn/credential — remove biometric (requires biometric verification first)
  if (req.method === 'DELETE' && req.url === '/api/webauthn/credential') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    // Must provide a valid bioToken to remove a credential (proves biometric ownership)
    const bioToken = req.headers['x-biometric-token'] || '';
    if (!bioToken || !session.bioTokens) {
      return sendJson(res, 403, { error: 'Biometric verification required to remove credential' });
    }
    const tokenData = session.bioTokens.get(bioToken);
    if (!tokenData || Date.now() > tokenData.expiresAt) {
      return sendJson(res, 403, { error: 'Biometric token expired' });
    }
    const wHash = tokenData.walletHash;
    deleteCredential(wHash);
    session.bioTokens.delete(bioToken);
    logSecurity('webauthn_credential_removed', { ip: clientIp, walletHash: wHash });
    return sendJson(res, 200, { success: true });
  }

  // POST /api/session/set-wallet — link wallet address to session for biometric validation
  if (req.method === 'POST' && req.url === '/api/session/set-wallet') {
    const session = getSession(req);
    if (!session) return sendJson(res, 401, { error: 'Session required' });
    try {
      const body = await readJsonBody(req);
      if (body.walletAddress) {
        session.walletHash = walletHash(body.walletAddress);
      }
      return sendJson(res, 200, { success: true });
    } catch (_) {
      return sendJson(res, 400, { error: 'Invalid request' });
    }
  }

  // --- Swap service proxy (same-origin for browser) ---

  if (req.url.startsWith('/api/swap-proxy/')) {
    const swapOrigin = req.headers.origin || '';
    const swapCorsOrigin = ALLOWED_ORIGINS.has(swapOrigin) ? swapOrigin : '';
    // CORS preflight
    if (req.method === 'OPTIONS') {
      const preflightHeaders = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
        'Access-Control-Max-Age': '86400',
      };
      if (swapCorsOrigin) preflightHeaders['Access-Control-Allow-Origin'] = swapCorsOrigin;
      res.writeHead(204, preflightHeaders);
      res.end();
      return;
    }
    const swapPath = req.url.replace('/api/swap-proxy/', '/');
    const swapUrl = `http://127.0.0.1:8787${swapPath}`;
    const proxyReq = http.request(swapUrl, {
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:8787' },
      timeout: 15000,
    }, (proxyRes) => {
      const respHeaders = {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      };
      if (swapCorsOrigin) respHeaders['Access-Control-Allow-Origin'] = swapCorsOrigin;
      res.writeHead(proxyRes.statusCode, respHeaders);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      sendJson(res, 502, { error: 'Swap service unavailable' });
    });
    if (req.method === 'POST' || req.method === 'PUT') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
    return;
  }

  // --- Delete wallet cache (for re-restore with correct height) ---
  if (req.method === 'POST' && req.url === '/delete_wallet_cache') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const session = getSession(req);
      if (!session) return sendJson(res, 401, { error: 'No session' });
      try {
        const { filename } = JSON.parse(body || '{}');
        if (!filename || /[\/\\]/.test(filename)) return sendJson(res, 400, { error: 'Invalid filename' });
        // Delete both .wallet (cache) and .keys files so restore_deterministic_wallet
        // can recreate them from the seed. The seed is always provided by the client
        // on re-restore, so no key material is lost.
        const walletFile = path.join(session.walletDir, filename);
        const candidates = [walletFile, walletFile + '.wallet', walletFile + '.keys', walletFile + '.wallet.keys'];
        let deleted = false;
        for (const f of candidates) {
          try {
            if (fs.existsSync(f)) {
              fs.unlinkSync(f);
              deleted = true;
              console.log('  Deleted wallet file: ' + path.basename(f));
            }
          } catch (_) {}
        }
        sendJson(res, 200, { deleted });
      } catch (e) {
        sendJson(res, 400, { error: 'Invalid request' });
      }
    });
    return;
  }

  // --- Wallet JSON-RPC proxy (per-session) ---

  if (req.method === 'POST' && req.url === '/json_rpc') {
    let body = '';
    let bodySize = 0;
    const MAX_BODY = 64 * 1024; // 64KB — wallet RPC payloads are small
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(); res.writeHead(413); res.end('Request too large'); return; }
      body += chunk;
    });
    req.on('end', async () => {
      // Get or create session
      let session = getSession(req);
      if (!session || session.state === 'dead') {
        if (session) await destroySession(session.token);
        session = await createSession();
        if (!session) {
          return sendJson(res, 503, { error: { message: 'Server at capacity. Please try again later.' } });
        }
        setSessionCookie(res, session.token);
      }

      if (session.state === 'starting' || session.state === 'restarting' || session.state === 'reopening') {
        // Wait briefly for the session to become ready instead of failing immediately
        const waitStart = Date.now();
        const maxWait = session.state === 'reopening' ? 15000 : 5000; // reopening can take longer
        while (session.state === 'starting' || session.state === 'restarting' || session.state === 'reopening') {
          if (Date.now() - waitStart > maxWait) break;
          await new Promise(ok => setTimeout(ok, 300));
        }
        if (session.state !== 'ready' && session.state !== 'reopening') {
          return sendJson(res, 503, { error: { message: 'Wallet engine is starting. Please wait a moment and try again.' } });
        }
      }

      if (session.state === 'dead') {
        // Attempt auto-recovery before failing
        await autoRestartSession(session);
        if (session.state !== 'ready') {
          return sendJson(res, 502, { error: { message: 'Wallet session could not be recovered. Please refresh the page.' } });
        }
      }

      if (session.state !== 'ready' && session.state !== 'reopening') {
        return sendJson(res, 502, { error: { message: 'Wallet session is not available. Please refresh the page.' } });
      }

      session.lastActivity = Date.now();

      // RPC rate limiting
      if (!checkRpcRate(clientIp)) {
        logSecurity('rate_limit_rpc', { ip: clientIp });
        return sendJson(res, 429, { error: { message: 'Too many RPC requests. Please slow down.' } });
      }

      let method = '';
      let parsedBody;
      try {
        parsedBody = JSON.parse(body || '{}');
        method = (parsedBody.method || '').toString();
      } catch (_) {
        parsedBody = {};
      }

      // FCMP++: Auto-inject ring_size=0 for transfer calls.
      // FCMP++ uses full-chain membership proofs instead of ring signatures,
      // so no decoy outputs are needed. Without this, wallet-rpc uses a default
      // ring size that fails on this blockchain.
      if (method === 'transfer' && parsedBody.params) {
        if (parsedBody.params.ring_size == null) {
          parsedBody.params.ring_size = 0;
        }
        // Dandelion++: create tx without relaying so we control propagation
        parsedBody.params.do_not_relay = true;
        parsedBody.params.get_tx_hex = true;
        body = JSON.stringify(parsedBody);
      }

      // RPC method whitelist
      if (method && !ALLOWED_RPC_METHODS.has(method)) {
        logSecurity('rpc_method_blocked', { ip: clientIp, method });
        return sendJson(res, 403, { error: { message: 'Method not allowed' } });
      }

      // Prevent set_daemon with empty address (crashes wallet-rpc binary)
      if (method === 'set_daemon' && parsedBody.params) {
        const addr = (parsedBody.params.address || '').trim();
        if (!addr) {
          return sendJson(res, 200, { jsonrpc: '2.0', id: parsedBody.id || '0', result: { status: 'ok' } });
        }
      }

      // CSRF enforcement for fund-moving method
      if (method === 'transfer' && session && session.csrfToken) {
        const reqCsrf = req.headers['x-csrf-token'] || '';
        if (reqCsrf !== session.csrfToken) {
          logSecurity('csrf_transfer_blocked', { ip: clientIp });
          return sendJson(res, 403, { error: { message: 'CSRF token required for transfers' } });
        }
      }

      // ===== Biometric enforcement for protected operations =====
      const BIOMETRIC_PROTECTED_METHODS = new Set(['transfer', 'freeze', 'thaw']);
      if (BIOMETRIC_PROTECTED_METHODS.has(method) && session) {
        const bioToken = req.headers['x-biometric-token'] || '';
        // Check if this wallet has a registered biometric
        const wHash = session.walletHash;
        if (wHash && hasCredential(wHash)) {
          if (!bioToken) {
            return sendJson(res, 403, { error: { message: 'Biometric authentication required', code: 'BIOMETRIC_REQUIRED' } });
          }
          if (!session.bioTokens) {
            return sendJson(res, 403, { error: { message: 'Biometric token invalid', code: 'BIOMETRIC_REQUIRED' } });
          }
          const tokenData = session.bioTokens.get(bioToken);
          if (!tokenData || Date.now() > tokenData.expiresAt) {
            logSecurity('biometric_token_expired', { ip: clientIp, method });
            return sendJson(res, 403, { error: { message: 'Biometric token expired. Please verify again.', code: 'BIOMETRIC_REQUIRED' } });
          }
          // CRITICAL: Verify biometric was registered for THIS wallet, not a different one
          if (tokenData.walletHash !== wHash) {
            logSecurity('biometric_wallet_mismatch', { ip: clientIp, method, expected: wHash, got: tokenData.walletHash });
            return sendJson(res, 403, { error: { message: 'Biometric does not match this wallet. Transaction declined.' } });
          }
          // One-time use — consume the token
          session.bioTokens.delete(bioToken);
        }
        // If no credential registered, allow through (biometric is optional until registered)
      }

      // CakeWallet-style: route through WalletRpcManager
      // The manager handles queuing, state validation, health checks,
      // auto-restart, daemon connection, and FCMP++ ring_size injection.
      const timeoutMs = method === 'refresh' ? 600000
        : method === 'rescan_blockchain' ? 300000
        : method === 'restore_deterministic_wallet' ? 600000
        : method === 'transfer' ? 180000  // FCMP++ proof construction can take 30-120s
        : method === 'get_transfers' ? 180000  // Large wallets with many mining payouts
        : method === 'create_wallet' ? 60000   // Includes key generation; relay clients need headroom
        : method === 'open_wallet' ? 60000
        : method === 'set_daemon' ? 10000
        : 90000;

      const doRpc = async () => {
        try {
          const params = (parsedBody.params || {});
          const result = await session.manager.rpc(method, params, { timeoutMs });

          // Track wallet filename for session persistence (no passwords stored)
          if (method === 'restore_deterministic_wallet' || method === 'open_wallet' || method === 'create_wallet') {
            if (params.filename) {
              session.walletFilename = params.filename;
              // SECURITY: Do NOT store wallet password in session
            }
          }

          // Dandelion++: route tx then strip tx_hex from response
          if (method === 'transfer' && result && result.tx_hex && result.tx_hash) {
            const txHex = result.tx_hex;
            const txHash = result.tx_hash;
            delete result.tx_hex;
            dandelionRoute(txHex, txHash).catch(err =>
              logSecurity('dandelion_route_error', { msg: err.message })
            );
          }

          // Coinbase unlock window: flag mining payouts within 10 blocks
          if (method === 'get_transfers' && result) {
            await enforceCoinbaseLock(result).catch(() => {});
          }

          const responseData = { jsonrpc: '2.0', id: parsedBody.id || '0', result };
          const headers = { 'Content-Type': 'application/json' };
          if (!parseCookie(req, 'musd_session')) {
            headers['Set-Cookie'] = 'musd_session=' + session.token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200';
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify(responseData));
        } catch (err) {
          const errMsg = err.message || 'Wallet RPC error';
          // If manager reports state error, try auto-restart
          if (/Cannot execute.*in state/.test(errMsg) && session.manager) {
            const restarted = await session.manager.restart().catch(() => false);
            if (restarted) {
              try {
                const params = (parsedBody.params || {});
                const retryResult = await session.manager.rpc(method, params, { timeoutMs });
                const responseData = { jsonrpc: '2.0', id: parsedBody.id || '0', result: retryResult };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responseData));
                return;
              } catch (_) {}
            }
          }
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: errMsg } }));
        }
      };

      // Serialize mutating requests per-session; read-only run concurrently
      if (CONCURRENT_RPC_METHODS.has(method)) {
        doRpc();
      } else {
        session.proxyQueue = session.proxyQueue.then(doRpc);
      }
    });
    return;
  }

  // --- Daemon RPC proxy (shared, requires session) ---

  if (req.method === 'POST' && req.url === '/daemon_rpc') {
    // Daemon RPC is read-only public info (get_info, get_block_count, etc.)
    // No session auth required — daemon info is public on any Monero node.
    // Rate limiting still applies via global rate limiter above.
    let body = '';
    let bodySize = 0;
    const MAX_BODY = 16 * 1024; // 16KB limit for daemon RPC
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(); res.writeHead(413); res.end('Request too large'); return; }
      body += chunk;
    });
    req.on('end', () => {
      const dParsed = parseTarget(DAEMON_RPC) || { hostname: '127.0.0.1', port: '17750', protocol: 'http:' };
      const opts = {
        hostname: dParsed.hostname,
        port: dParsed.port,
        path: '/json_rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const proxy = http.request(opts, (rpcRes) => {
        let buf = '';
        rpcRes.on('data', (chunk) => (buf += chunk));
        rpcRes.on('end', () => {
          res.writeHead(rpcRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(buf);
        });
      });
      proxy.setTimeout(30000, () => { proxy.destroy(); res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Daemon RPC timed out' } })); });
      proxy.on('error', () => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Daemon unreachable' } })); });
      proxy.write(body);
      proxy.end();
    });
    return;
  }

  // --- Mining REST proxy (requires session) ---

  const miningRestPaths = ['/start_mining', '/stop_mining', '/mining_status'];
  if (miningRestPaths.includes(req.url.split('?')[0])) {
    // start_mining and stop_mining require authenticated session + CSRF
    // mining_status is read-only (daemon info) and doesn't require auth
    const miningPath = req.url.split('?')[0];
    if (miningPath === '/start_mining' || miningPath === '/stop_mining') {
      const mSession = getSession(req);
      if (!mSession) {
        logSecurity('unauth_mining', { ip: clientIp, path: req.url });
        return sendJson(res, 401, { error: 'Session required' });
      }
      if (mSession.csrfToken && (req.headers['x-csrf-token'] || '') !== mSession.csrfToken) {
        return sendJson(res, 403, { error: 'Invalid CSRF token' });
      }
    }
    let body = '';
    let bodySize = 0;
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > 16 * 1024) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      // Enforce node owner's MINER_ADDRESS for /start_mining — mining rewards
      // must only go to the node operator's wallet, never to arbitrary addresses.
      if (miningPath === '/start_mining') {
        if (!MINER_ADDRESS) {
          return sendJson(res, 400, { error: 'MINER_ADDRESS not configured. Set it via environment variable when starting your node.' });
        }
        try {
          const parsed = body ? JSON.parse(body) : {};
          parsed.miner_address = MINER_ADDRESS;
          body = JSON.stringify(parsed);
        } catch (_) {
          body = JSON.stringify({ miner_address: MINER_ADDRESS, threads_count: 1, do_background_mining: true, ignore_battery: true });
        }
      }
      const dParsed = parseTarget(DAEMON_RPC) || { hostname: '127.0.0.1', port: '17750', protocol: 'http:' };
      const opts = {
        hostname: dParsed.hostname,
        port: dParsed.port,
        path: req.url,
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
      const proxy = http.request(opts, (rpcRes) => {
        let buf = '';
        rpcRes.on('data', (chunk) => (buf += chunk));
        rpcRes.on('end', () => {
          const origin = req.headers.origin || '';
          const corsOrigin = ALLOWED_ORIGINS.has(origin) ? origin : '';
          const corsHeaders = { 'Content-Type': 'application/json' };
          if (corsOrigin) corsHeaders['Access-Control-Allow-Origin'] = corsOrigin;
          res.writeHead(rpcRes.statusCode || 200, corsHeaders);
          res.end(buf);
        });
      });
      proxy.setTimeout(15000, () => { proxy.destroy(); sendJson(res, 502, { error: 'Daemon timeout' }); });
      proxy.on('error', () => { sendJson(res, 502, { error: 'Daemon unreachable' }); });
      if (body) proxy.write(body);
      proxy.end();
    });
    return;
  }

  // --- Protocol health ---

  if (req.method === 'GET' && req.url === '/api/protocol-health') {
    const ratio = await fetchReserveRatio().catch(() => null);
    sendJson(res, 200, {
      reserve_ratio: ratio !== null ? Math.round(ratio * 10000) / 100 : null,
      reserve_ratio_pct: ratio !== null ? (ratio * 100).toFixed(2) + '%' : 'unknown',
      min_required_pct: (RESERVE_MIN_RATIO * 100).toFixed(0) + '%',
      mining_active: ratio === null || ratio >= RESERVE_MIN_RATIO,
      status: ratio === null ? 'unknown' : ratio >= RESERVE_MIN_RATIO ? 'healthy' : 'undercollateralized',
    });
    return;
  }

  // --- Dandelion++ stem endpoint ---

  if (req.method === 'POST' && req.url === '/api/dandelion/stem') {
    if (DANDELION_RELAY_PEERS.length === 0) {
      return sendJson(res, 403, { error: 'Dandelion stem not enabled on this node' });
    }
    let body = '';
    let bodySize = 0;
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > 64 * 1024) { req.destroy(); return; }
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const txHex = parsed.tx_as_hex;
        if (!txHex || typeof txHex !== 'string' || !/^[0-9a-fA-F]+$/.test(txHex)) {
          return sendJson(res, 400, { error: 'Invalid tx_as_hex' });
        }
        const txHash = crypto.createHash('sha256').update(txHex).digest('hex');
        sendJson(res, 200, { status: 'ok' });
        dandelionRoute(txHex, txHash).catch(() => {});
      } catch (_) {
        sendJson(res, 400, { error: 'Invalid request body' });
      }
    });
    return;
  }

  // --- Static files ---

  let urlPath = req.url.split('?')[0];
  let file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  file = path.resolve(rendererDir, path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, ''));
  if (!file.startsWith(path.resolve(rendererDir))) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for non-file routes (e.g. /wallet)
      const fallback = path.join(rendererDir, 'index.html');
      if (file !== fallback && !path.extname(urlPath)) {
        fs.readFile(fallback, (err2, fallbackData) => {
          if (err2) { res.writeHead(404); res.end('Not found'); return; }
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.end(fallbackData);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(file);
    res.setHeader('Content-Type', MIMES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(data);
  });
});

// ===== Graceful shutdown =====

async function shutdownAll() {
  console.log('\n  Shutting down all sessions...');
  const promises = [];
  for (const token of sessions.keys()) {
    promises.push(destroySession(token));
  }
  await Promise.all(promises);
  process.exit(0);
}

process.on('SIGTERM', shutdownAll);
process.on('SIGINT', shutdownAll);

// ===== Start server =====

const HOST = process.env.HOST || '127.0.0.1'; // Only accessible via nginx reverse proxy
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  MoneroUSD Wallet (browser) — per-user wallet-rpc');
  console.log('  Open in your browser:  http://localhost:' + PORT);
  console.log('  Daemon RPC proxy:      ' + DAEMON_RPC);
  console.log('  Session ports:         ' + SESSION_PORT_START + '-' + SESSION_PORT_END);
  console.log('  Max sessions:          ' + MAX_SESSIONS);
  console.log('  Idle timeout:          ' + (SESSION_IDLE_MS / 60000) + ' min');
  console.log('');
  // Ensure session dir exists
  fs.mkdirSync(SESSION_DIR_BASE, { recursive: true, mode: 0o700 });
  // NOTE: Stale wallet-rpc cleanup is handled by the IIFE at module load time
  // (cleanupStaleWalletRpc). A second cleanup here caused a race condition:
  // incoming requests could create sessions (spawning wallet-rpc processes)
  // before this callback ran, and this cleanup would SIGKILL those new processes.
  startMempoolMiner();
});

// --- Auto-mine: poll daemon mempool every 2s, mine 1 block when txs are pending ---
const MINE_POLL_MS = 2000;
let miningInProgress = false;

function daemonRpc(method, params) {
  return new Promise((resolve, reject) => {
    const dParsed = parseTarget(DAEMON_RPC) || { hostname: '127.0.0.1', port: '17750', protocol: 'http:' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params: params || {} });
    const opts = {
      hostname: dParsed.hostname, port: dParsed.port, path: '/json_rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Mining rewards are restricted to the node owner's wallet address.
// Set MINER_ADDRESS via environment variable when starting your node.
// If not set, mining reward payouts will fail (no default address leaked).
const MINER_ADDRESS = process.env.MINER_ADDRESS || '';

function daemonRest(urlPath, body) {
  return new Promise((resolve, reject) => {
    const dParsed = parseTarget(DAEMON_RPC) || { hostname: '127.0.0.1', port: '17750', protocol: 'http:' };
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: dParsed.hostname, port: dParsed.port, path: urlPath,
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

// ===== Dandelion++ helpers =====

function daemonSendRaw(txHex) {
  return new Promise((resolve, reject) => {
    const dParsed = parseTarget(DAEMON_RPC) || { hostname: '127.0.0.1', port: '17750' };
    const body = JSON.stringify({ tx_as_hex: txHex, do_not_relay: false });
    const opts = {
      hostname: dParsed.hostname, port: parseInt(dParsed.port, 10),
      path: '/send_raw_transaction', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (r) => {
      let buf = '';
      r.on('data', c => (buf += c));
      r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve({}); } });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('daemon send_raw timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function stemForwardToPeer(peer, txHex) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(peer + '/api/dandelion/stem'); } catch (_) {
      return reject(new Error('Invalid peer URL: ' + peer));
    }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? require('https') : http;
    const body = JSON.stringify({ tx_as_hex: txHex });
    const opts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = mod.request(opts, (r) => {
      let buf = '';
      r.on('data', c => (buf += c));
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) resolve();
        else reject(new Error('Stem peer returned HTTP ' + r.statusCode));
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Stem peer timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function dandelionRoute(txHex, txHash) {
  if (DANDELION_RELAY_PEERS.length > 0 && Math.random() < DANDELION_STEM_PROB) {
    const peer = DANDELION_RELAY_PEERS[Math.floor(Math.random() * DANDELION_RELAY_PEERS.length)];
    const timeoutMs = 30000 + Math.random() * 30000;
    const handle = setTimeout(async () => {
      if (dandelionPool.has(txHash)) {
        dandelionPool.delete(txHash);
        logSecurity('dandelion_failsafe_fluff', { tx: txHash.slice(0, 8) });
        await daemonSendRaw(txHex).catch(() => {});
      }
    }, timeoutMs);
    dandelionPool.set(txHash, { txHex, handle });
    try {
      await stemForwardToPeer(peer, txHex);
    } catch (e) {
      clearTimeout(handle);
      dandelionPool.delete(txHash);
      logSecurity('dandelion_stem_fallback', { peer, tx: txHash.slice(0, 8) });
      await daemonSendRaw(txHex);
    }
  } else {
    await daemonSendRaw(txHex);
  }
}

// ===== Coinbase unlock window helpers =====

async function getChainHeight() {
  const now = Date.now();
  if (cachedChainHeight > 0 && now - chainHeightFetchedAt < 30000) return cachedChainHeight;
  try {
    const r = await daemonRpc('get_block_count', {});
    if (r && r.result && r.result.count > 0) {
      cachedChainHeight = r.result.count - 1;
      chainHeightFetchedAt = now;
    }
  } catch (_) {}
  return cachedChainHeight;
}

async function enforceCoinbaseLock(result) {
  const currentHeight = await getChainHeight();
  if (!currentHeight) return;
  for (const key of ['in', 'block']) {
    const list = result[key];
    if (!Array.isArray(list)) continue;
    for (const tx of list) {
      const feeZero = tx.fee === 0 || tx.fee === '0';
      const isCoinbase = tx.is_coinbase === true
        || tx.type === 'block'
        || (feeZero && !Array.isArray(tx.destinations) && (tx.type === 'in' || !tx.type));
      if (isCoinbase && tx.height > 0) {
        const age = currentHeight - tx.height;
        if (age < COINBASE_UNLOCK_BLOCKS) {
          tx.coinbase_locked = true;
          tx.coinbase_unlocks_at = tx.height + COINBASE_UNLOCK_BLOCKS;
          tx.confirmations_needed = COINBASE_UNLOCK_BLOCKS - age;
        }
      }
    }
  }
}

async function checkMempoolAndMine() {
  if (miningInProgress || !MINER_ADDRESS) return;
  try {
    const poolCheck = await daemonRest('/get_transaction_pool');
    const txCount = (poolCheck && poolCheck.transactions && poolCheck.transactions.length) || 0;
    if (txCount === 0) return;

    const ratio = await fetchReserveRatio();
    if (ratio !== null && ratio < RESERVE_MIN_RATIO) {
      console.log(`  Auto-mine: reserve ratio ${(ratio * 100).toFixed(1)}% — halted until reserve reaches ${(RESERVE_MIN_RATIO * 100).toFixed(0)}%`);
      return;
    }

    miningInProgress = true;
    console.log('  Auto-mine: ' + txCount + ' tx(s) in mempool, mining…');

    const info = await daemonRpc('get_info', {});
    const startHeight = (info && info.result && info.result.height) || 0;

    await daemonRest('/start_mining', {
      miner_address: MINER_ADDRESS, threads_count: 1,
      do_background_mining: false, ignore_battery: true,
    });

    let mined = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((ok) => setTimeout(ok, 500));
      const cur = await daemonRpc('get_info', {});
      const curHeight = (cur && cur.result && cur.result.height) || 0;
      if (curHeight > startHeight) {
        console.log('  Auto-mine: block mined at height ' + curHeight);
        mined = true;
        break;
      }
    }

    await daemonRest('/stop_mining').catch(() => {});
    if (!mined) {
      console.log('  Auto-mine: mining started but no new block detected');
    } else if (MINER_ADDRESS) {
      // Pay dynamic block reward from treasury after successful mine
      payBlockReward(MINER_ADDRESS).catch(() => {});
    }
  } catch (e) {
    daemonRest('/stop_mining').catch(() => {});
  } finally {
    miningInProgress = false;
  }
}

function startMempoolMiner() {
  setInterval(checkMempoolAndMine, MINE_POLL_MS);
  console.log('  Auto-mine: polling mempool every ' + (MINE_POLL_MS / 1000) + 's');
}

