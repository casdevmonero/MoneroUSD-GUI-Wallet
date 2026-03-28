'use strict';

/**
 * WalletRpcManager — manages USDm-wallet-rpc process lifecycle, request
 * queuing, health monitoring, and automatic reconnection.
 *
 * Modes:
 *   'server'   — browser relay: spawns one wallet-rpc per user session
 *   'electron' — desktop app: connects to a locally running wallet-rpc,
 *                also handles remote relay connections
 */

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// FCMP++ uses full-chain membership proofs — ring_size=0 for all transactions
const FCMP_RING_SIZE = 0;

/**
 * Serialize BigInt amounts correctly for wallet-rpc.
 * wallet-rpc expects "amount" as a raw JSON integer, not a quoted string.
 * JS BigInt → string → this regex converts back to unquoted integer in JSON.
 */
function jsonStringifyRpc(obj) {
  const json = JSON.stringify(obj);
  return json.replace(/"amount":"(\d+)"/g, '"amount":$1');
}

/**
 * Parse wallet-rpc response: amounts come back as large integers that JS
 * Number can't represent exactly — convert them to quoted strings.
 */
function parseRpcResponse(buf) {
  try {
    const patched = buf.replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"');
    return JSON.parse(patched);
  } catch (_) {
    return JSON.parse(buf);
  }
}

class WalletRpcManager extends EventEmitter {
  static STATE = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    WALLET_OPENING: 'wallet_opening',
    SYNCING: 'syncing',
    ERROR: 'error',
  };

  constructor(options = {}) {
    super();
    this._mode = options.mode || 'electron'; // 'electron' | 'server'
    this._port = options.port || 27750;
    this._walletRpcBin = options.walletRpcBin || '';
    this._daemonAddress = options.daemonAddress || 'http://127.0.0.1:17750';
    this._walletDir = options.walletDir || '';

    this._state = WalletRpcManager.STATE.DISCONNECTED;
    this._proc = null;           // child_process
    this._queue = Promise.resolve(); // serialise RPC calls
    this._healthTimer = null;
    this._unhealthyCount = 0;
    this._shutdownRequested = false;

    // Electron remote relay state
    this._remoteCookies = new Map();
    this._remoteCsrfTokens = new Map();
  }

  get state() { return this._state; }
  get port() { return this._port; }

  _setState(to) {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this.emit('stateChange', { from, to });
  }

  // ─── Server mode ─────────────────────────────────────────────────────────

  /**
   * Spawn wallet-rpc binary and wait until it responds to get_version.
   * Returns true on success, false on failure.
   */
  async spawnAndConnect(walletDir, env = {}) {
    if (!this._walletRpcBin) {
      console.error('[rpc] walletRpcBin not configured');
      return false;
    }

    this._shutdownRequested = false;
    this._setState(WalletRpcManager.STATE.CONNECTING);

    const args = [
      '--rpc-bind-port', String(this._port),
      '--rpc-bind-ip', '127.0.0.1',
      '--wallet-dir', walletDir || this._walletDir,
      '--daemon-address', this._daemonAddress,
      '--trusted-daemon',
      '--log-level', '0',
    ];

    try {
      this._proc = spawn(this._walletRpcBin, args, {
        env: Object.assign({}, process.env, env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this._proc.stdout.on('data', () => {});
      this._proc.stderr.on('data', () => {});

      this._proc.on('exit', (code, signal) => {
        this.emit('processExit', { code, signal, port: this._port });
        if (!this._shutdownRequested) {
          this._setState(WalletRpcManager.STATE.DISCONNECTED);
          this._scheduleRestart();
        }
      });

      this._proc.on('error', (err) => {
        console.error('[rpc] spawn error:', err.message);
        this._setState(WalletRpcManager.STATE.ERROR);
      });

      // Wait for wallet-rpc to start accepting connections
      const ready = await this._waitForReady(15000);
      if (ready) {
        this._setState(WalletRpcManager.STATE.CONNECTED);
        this._startHealthMonitor();
        return true;
      } else {
        this._killProc();
        this._setState(WalletRpcManager.STATE.ERROR);
        return false;
      }
    } catch (e) {
      console.error('[rpc] spawnAndConnect error:', e.message);
      this._setState(WalletRpcManager.STATE.ERROR);
      return false;
    }
  }

  async _waitForReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this._rawRpc('get_version', {}, 2000);
        return true;
      } catch (_) {
        await new Promise(ok => setTimeout(ok, 500));
      }
    }
    return false;
  }

  _startHealthMonitor() {
    this._stopHealthMonitor();
    this._unhealthyCount = 0;
    this._healthTimer = setInterval(async () => {
      if (this._shutdownRequested) return;
      try {
        await this._rawRpc('get_version', {}, 3000);
        this._unhealthyCount = 0;
      } catch (_) {
        this._unhealthyCount++;
        if (this._unhealthyCount >= 3) {
          this.emit('unhealthy');
          this._stopHealthMonitor();
          this._scheduleRestart();
        }
      }
    }, 10000);
  }

  _stopHealthMonitor() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  async _scheduleRestart() {
    if (this._shutdownRequested) return;
    await new Promise(ok => setTimeout(ok, 2000));
    if (!this._shutdownRequested) await this.restart();
  }

  async restart() {
    this._stopHealthMonitor();
    this._killProc();
    this._setState(WalletRpcManager.STATE.CONNECTING);

    const ok = await this._waitForReady(10000);
    if (ok) {
      this._setState(WalletRpcManager.STATE.CONNECTED);
      this._startHealthMonitor();
      return true;
    }

    // Try respawning
    if (this._walletRpcBin && this._walletDir) {
      const respawned = await this.spawnAndConnect(this._walletDir);
      if (respawned) return true;
    }

    this._setState(WalletRpcManager.STATE.ERROR);
    this.emit('restartFailed');
    return false;
  }

  async shutdown() {
    this._shutdownRequested = true;
    this._stopHealthMonitor();
    try {
      await this._rawRpc('store', {}, 5000);
    } catch (_) {}
    try {
      await this._rawRpc('close_wallet', {}, 3000);
    } catch (_) {}
    this._killProc();
    this._setState(WalletRpcManager.STATE.DISCONNECTED);
  }

  _killProc() {
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch (_) {}
      this._proc = null;
    }
  }

  // ─── Electron mode ────────────────────────────────────────────────────────

  /** Connect to an already-running local wallet-rpc (Electron mode). */
  async connect(port) {
    this._port = port;
    this._setState(WalletRpcManager.STATE.CONNECTING);
    const ready = await this._waitForReady(10000);
    if (ready) {
      this._setState(WalletRpcManager.STATE.CONNECTED);
    } else {
      this._setState(WalletRpcManager.STATE.DISCONNECTED);
    }
  }

  // ─── Core RPC ─────────────────────────────────────────────────────────────

  /**
   * Make a wallet-rpc call. Queued to serialise access.
   * Automatically injects ring_size=0 for transfer calls (FCMP++).
   */
  async rpc(method, params = {}, options = {}) {
    // FCMP++: inject ring_size=0 for transfers
    if (method === 'transfer' && params && params.ring_size == null) {
      params = Object.assign({}, params, { ring_size: FCMP_RING_SIZE });
    }

    const timeoutMs = options.timeoutMs || 30000;

    // Serialise: queue this call after the previous one
    const result = await new Promise((resolve, reject) => {
      this._queue = this._queue.then(async () => {
        try {
          const r = await this._rawRpc(method, params, timeoutMs);
          resolve(r);
        } catch (e) {
          reject(e);
        }
      });
    });

    return result;
  }

  /** Raw HTTP JSON-RPC call to local wallet-rpc (no queuing). */
  _rawRpc(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const body = jsonStringifyRpc({
        jsonrpc: '2.0', id: '0', method, params: params || {},
      });
      const req = http.request({
        hostname: '127.0.0.1',
        port: this._port,
        path: '/json_rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try {
            const d = parseRpcResponse(buf);
            if (d && d.error) {
              return reject(new Error(d.error.message || 'wallet RPC error'));
            }
            resolve(d ? d.result : null);
          } catch (e) {
            reject(new Error('Invalid wallet RPC response: ' + e.message));
          }
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error('wallet RPC timed out'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ─── Remote relay (Electron connecting to monerousd.org) ─────────────────

  async remoteRpc(baseUrl, method, params = {}, timeoutMs = 30000) {
    const cookies = this._remoteCookies.get(baseUrl) || '';
    const csrfToken = this._remoteCsrfTokens.get(baseUrl) || '';

    // Initialise session if we don't have cookies yet
    if (!cookies) {
      await this._initRemoteSession(baseUrl).catch(() => {});
    }

    return this._remoteCall(baseUrl, method, params, timeoutMs);
  }

  async _initRemoteSession(baseUrl) {
    const url = baseUrl.replace(/\/$/, '') + '/api/session-init';
    const result = await this._httpFetch(url, {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 10000,
      withCookies: true,
      baseUrl,
    });
    if (result && result.csrfToken) {
      this._remoteCsrfTokens.set(baseUrl, result.csrfToken);
    }
    return result;
  }

  _remoteCall(baseUrl, method, params, timeoutMs) {
    const url = baseUrl.replace(/\/$/, '') + '/json_rpc';
    const csrfToken = this._remoteCsrfTokens.get(baseUrl) || '';
    const body = jsonStringifyRpc({ jsonrpc: '2.0', id: '0', method, params });

    return new Promise((resolve, reject) => {
      const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
      if (!u) return reject(new Error('Invalid remote URL'));

      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;
      const cookies = this._remoteCookies.get(baseUrl) || '';

      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (cookies) headers['Cookie'] = cookies;
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers,
      }, (res) => {
        // Store cookies
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');
          this._remoteCookies.set(baseUrl, cookieStr);
        }

        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try {
            const d = parseRpcResponse(buf);
            if (d && d.error) return reject(new Error(d.error.message || 'remote RPC error'));
            resolve(d ? d.result : null);
          } catch (e) {
            reject(new Error('Invalid remote RPC response'));
          }
        });
      });

      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('remote RPC timed out')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _httpFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
      if (!u) return reject(new Error('Invalid URL'));

      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;
      const body = options.body || '';
      const cookies = options.baseUrl ? (this._remoteCookies.get(options.baseUrl) || '') : '';

      const headers = { 'Content-Type': 'application/json' };
      if (body) headers['Content-Length'] = Buffer.byteLength(body);
      if (cookies) headers['Cookie'] = cookies;

      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers,
      }, (res) => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie && options.baseUrl) {
          const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');
          this._remoteCookies.set(options.baseUrl, cookieStr);
        }
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); }
        });
      });

      req.setTimeout(options.timeoutMs || 15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

module.exports = WalletRpcManager;
