/**
 * Serve the wallet UI in the browser and proxy JSON-RPC to per-user USDm-wallet-rpc instances.
 * Each browser session gets its own wallet-rpc process on a unique port.
 * Run: node server.js
 * Then open: http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
  return ALLOWED_ORIGINS.has(origin);
}

// Per-user session config
const SESSION_PORT_START = 28000;
const SESSION_PORT_END   = 28999;
const MAX_SESSIONS       = 200;
const SESSION_IDLE_MS    = 30 * 60 * 1000;  // 30 min idle timeout
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
  'auto_refresh',
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
    'musd_session=' + token + '; Path=/; HttpOnly; SameSite=Strict;' + secure + ' Max-Age=3600');
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

const MAX_AUTO_RESTARTS = 3;
const AUTO_RESTART_WINDOW_MS = 60000; // reset counter after 1 min of stability

async function autoRestartSession(session) {
  if (session.state === 'closing') return;
  session._restartCount = (session._restartCount || 0) + 1;
  if (session._restartCount > MAX_AUTO_RESTARTS) {
    console.log('  Session port ' + session.port + ' exceeded max auto-restarts, marking dead');
    session.state = 'dead';
    return;
  }
  console.log('  Auto-restarting wallet-rpc on port ' + session.port + ' (attempt ' + session._restartCount + ')');
  session.state = 'restarting';

  // Kill old process if still around
  try { session.process.kill('SIGKILL'); } catch (_) {}

  await new Promise(ok => setTimeout(ok, 500));

  const env = Object.assign({}, process.env, {
    MONEROUSD_ENABLE_FCMP: '1',
    MONEROUSD_ALLOW_LOW_MIXIN: '1',
    MONEROUSD_DISABLE_TX_LIMITS: '1',
  });

  const args = [
    '--rpc-bind-ip', '127.0.0.1',
    '--rpc-bind-port', String(session.port),
    '--disable-rpc-login',
    '--wallet-dir', session.walletDir,
    '--daemon-address', DAEMON_ADDRESS,
    '--trusted-daemon',
    '--log-file', path.join(session.walletDir, 'wallet-rpc.log'),
    '--log-level', '0',
    '--max-concurrency', '8',
    '--non-interactive',
  ];

  const proc = spawn(WALLET_RPC_BIN, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  session.process = proc;
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  proc.on('exit', (code) => {
    if (session.state !== 'closing') {
      console.log('  Session wallet-rpc exited unexpectedly (port ' + session.port + ', code ' + code + ') — will auto-restart');
      session.state = 'dead';
      autoRestartSession(session);
    }
  });
  proc.on('error', (err) => {
    console.log('  Session wallet-rpc spawn error: ' + err.message + ' — will auto-restart');
    session.state = 'dead';
    autoRestartSession(session);
  });

  const ready = await waitForWalletRpc(session.port, 10);
  if (ready) {
    session.state = 'ready';
    // Reset restart counter after stability window
    setTimeout(() => { session._restartCount = 0; }, AUTO_RESTART_WINDOW_MS);
    console.log('  Session auto-restarted successfully on port ' + session.port);
  } else {
    // Port may be occupied by stale process — try a new port
    console.log('  Session auto-restart failed on port ' + session.port + ', trying new port');
    try { session.process.kill('SIGKILL'); } catch (_) {}
    releasePort(session.port);
    const newPort = await allocatePort();
    if (!newPort) {
      console.log('  No free ports available for auto-restart');
      session.state = 'dead';
      return;
    }
    session.port = newPort;
    const retryArgs = [
      '--rpc-bind-ip', '127.0.0.1',
      '--rpc-bind-port', String(newPort),
      '--disable-rpc-login',
      '--wallet-dir', session.walletDir,
      '--daemon-address', DAEMON_ADDRESS,
      '--trusted-daemon',
      '--log-file', path.join(session.walletDir, 'wallet-rpc.log'),
      '--log-level', '0',
      '--max-concurrency', '8',
      '--non-interactive',
    ];
    const retryProc = spawn(WALLET_RPC_BIN, retryArgs, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    session.process = retryProc;
    retryProc.stderr.on('data', () => {});
    retryProc.stdout.on('data', () => {});
    retryProc.on('exit', (code2) => {
      if (session.state !== 'closing') {
        session.state = 'dead';
        autoRestartSession(session);
      }
    });
    retryProc.on('error', () => { session.state = 'dead'; });
    const retryReady = await waitForWalletRpc(newPort, 10);
    if (retryReady) {
      session.state = 'ready';
      setTimeout(() => { session._restartCount = 0; }, AUTO_RESTART_WINDOW_MS);
      console.log('  Session auto-restarted on new port ' + newPort);
    } else {
      console.log('  Session auto-restart failed on new port ' + newPort);
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
  });

  const args = [
    '--rpc-bind-ip', '127.0.0.1',
    '--rpc-bind-port', String(port),
    '--disable-rpc-login',
    '--wallet-dir', walletDir,
    '--daemon-address', DAEMON_ADDRESS,
    '--trusted-daemon',
    '--log-file', path.join(walletDir, 'wallet-rpc.log'),
    '--log-level', '0',
    '--max-concurrency', '8',
    '--non-interactive',
  ];

  const proc = spawn(WALLET_RPC_BIN, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const session = {
    token,
    port,
    process: proc,
    walletDir,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'starting',
    proxyQueue: Promise.resolve(),
  };

  // Handle unexpected exit — auto-restart
  proc.on('exit', (code) => {
    if (session.state !== 'closing') {
      console.log('  Session wallet-rpc exited unexpectedly (port ' + port + ', code ' + code + ') — will auto-restart');
      session.state = 'dead';
      autoRestartSession(session);
    }
  });

  proc.on('error', (err) => {
    console.log('  Session wallet-rpc spawn error: ' + err.message + ' — will auto-restart');
    session.state = 'dead';
    autoRestartSession(session);
  });

  // Capture stderr for debugging
  proc.stderr.on('data', () => {}); // drain
  proc.stdout.on('data', () => {}); // drain

  sessions.set(token, session);

  // Wait for it to be ready — 10 retries with fast intervals (~3s total)
  const ready = await waitForWalletRpc(port, 10);
  if (ready) {
    session.state = 'ready';
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

  // Try graceful close_wallet
  try {
    await walletRpc(session.port, 'close_wallet', {}, 3000);
  } catch (_) {}

  // Kill process
  try {
    session.process.kill('SIGTERM');
    // Force kill after 5s
    setTimeout(() => {
      try { session.process.kill('SIGKILL'); } catch (_) {}
    }, 5000);
  } catch (_) {}

  // Release port
  releasePort(session.port);

  // Clean up wallet files
  setTimeout(() => {
    try { fs.rmSync(session.walletDir, { recursive: true, force: true }); } catch (_) {}
  }, 2000);

  console.log('  Session destroyed: port ' + session.port + ' (active: ' + sessions.size + ')');
}

function getSession(req) {
  const token = parseCookie(req, 'musd_session');
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
      return sendJson(res, 200, { status: 'ready', port: existing.port, csrfToken: existing.csrfToken });
    }
    if (existing && (existing.state === 'starting' || existing.state === 'restarting')) {
      return sendJson(res, 200, { status: existing.state, csrfToken: existing.csrfToken });
    }
    // Dead — try auto-restart before destroying
    if (existing && existing.state === 'dead') {
      await autoRestartSession(existing);
      if (existing.state === 'ready') {
        return sendJson(res, 200, { status: 'ready', port: existing.port, csrfToken: existing.csrfToken });
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
    return sendJson(res, 200, { status: session.state, csrfToken: session.csrfToken });
  }

  if (req.method === 'GET' && req.url === '/api/session/status') {
    const session = getSession(req);
    if (!session) return sendJson(res, 200, { status: 'none' });
    return sendJson(res, 200, { status: session.state, csrfToken: session.csrfToken });
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
        transports: credential.transports || ['internal'],
        walletHash: wHash,
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
      const credIdBytes = Buffer.from(cred.credentialId, 'base64url');
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [{
          id: credIdBytes,
          type: 'public-key',
          transports: cred.transports || ['internal'],
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
      const credIdBytes = Buffer.from(cred.credentialId, 'base64url');
      const pubKeyBytes = Buffer.from(cred.credentialPublicKey, 'base64url');
      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: session._webauthnAuthChallenge.challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: credIdBytes,
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

      if (session.state === 'starting' || session.state === 'restarting') {
        // Wait briefly for the session to become ready instead of failing immediately
        const waitStart = Date.now();
        while (session.state === 'starting' || session.state === 'restarting') {
          if (Date.now() - waitStart > 5000) break;
          await new Promise(ok => setTimeout(ok, 300));
        }
        if (session.state !== 'ready') {
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

      if (session.state !== 'ready') {
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
          body = JSON.stringify(parsedBody);
        }
      }

      // RPC method whitelist
      if (method && !ALLOWED_RPC_METHODS.has(method)) {
        logSecurity('rpc_method_blocked', { ip: clientIp, method });
        return sendJson(res, 403, { error: { message: 'Method not allowed' } });
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

      const PROXY_TIMEOUT_MS = method === 'refresh' ? 600000
        : method === 'rescan_blockchain' ? 300000
        : method === 'restore_deterministic_wallet' ? 600000
        : method === 'set_daemon' ? 10000
        : 90000;

      const opts = {
        hostname: '127.0.0.1',
        port: session.port,
        path: '/json_rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };

      let responded = false;
      function send502(msg) {
        if (responded) return;
        responded = true;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: msg } }));
      }

      const doProxy = () =>
        new Promise((resolve) => {
          const proxy = http.request(opts, (rpcRes) => {
            let buf = '';
            rpcRes.on('error', () => {
              if (!responded) send502('Wallet RPC connection error.');
              resolve();
            });
            rpcRes.on('data', (chunk) => (buf += chunk));
            rpcRes.on('end', () => {
              if (responded) { resolve(); return; }
              responded = true;
              try {
                // Preserve uint64 precision
                const raw = (buf || '')
                  .replace(/"balance"\s*:\s*(\d+)/g, '"balance":"$1"')
                  .replace(/"unlocked_balance"\s*:\s*(\d+)/g, '"unlocked_balance":"$1"')
                  .replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"');
                const data = JSON.parse(raw);
                // Ensure session cookie is set on RPC responses too
                const headers = { 'Content-Type': 'application/json' };
                if (!parseCookie(req, 'musd_session')) {
                  headers['Set-Cookie'] = 'musd_session=' + session.token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600';
                }
                res.writeHead(rpcRes.statusCode, headers);
                res.end(JSON.stringify(data));
              } catch (_) {
                res.writeHead(rpcRes.statusCode, { 'Content-Type': 'application/json' });
                res.end(buf);
              }
              resolve();
            });
          });
          proxy.setTimeout(PROXY_TIMEOUT_MS, () => {
            proxy.destroy();
            send502(method === 'refresh'
              ? 'Sync is taking longer than ' + (PROXY_TIMEOUT_MS / 60000) + ' minutes. Try again later.'
              : 'Wallet RPC timed out. Please refresh the page.');
            resolve();
          });
          proxy.on('error', () => {
            send502('Wallet RPC error. Please refresh the page to start a new session.');
            resolve();
          });
          proxy.write(body);
          proxy.end();
        });

      // Serialize mutating requests per-session; read-only run concurrently
      if (CONCURRENT_RPC_METHODS.has(method)) {
        doProxy();
      } else {
        session.proxyQueue = session.proxyQueue.then(doProxy);
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

const MINER_ADDRESS = process.env.MINER_ADDRESS || 'Moz5T2Abptdgu8AoXTkjNibmu5cnLtDYS29tmCUnYamd99oizcM9uLJFniiGiZUzAq3ZSyYyc1ZqkeTWCcR7A3YJR5tkrwS';

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

async function checkMempoolAndMine() {
  if (miningInProgress || !MINER_ADDRESS) return;
  try {
    const poolCheck = await daemonRest('/get_transaction_pool');
    const txCount = (poolCheck && poolCheck.transactions && poolCheck.transactions.length) || 0;
    if (txCount === 0) return;

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
    if (!mined) console.log('  Auto-mine: mining started but no new block detected');
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
