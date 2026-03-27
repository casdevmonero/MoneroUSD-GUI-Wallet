'use strict';

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ConnectionStateMachine = require('./ConnectionStateMachine');
const RpcQueue = require('./RpcQueue');
const ReconnectionManager = require('./ReconnectionManager');
const HealthMonitor = require('./HealthMonitor');

/**
 * JSON.stringify replacement that correctly serializes large integer amounts.
 * The wallet-rpc expects "amount" fields as raw JSON numbers (not quoted strings),
 * but JavaScript's Number type loses precision for values > Number.MAX_SAFE_INTEGER.
 * This function allows passing amounts as strings and emits them as raw JSON integers.
 */
function jsonStringifyRpc(obj) {
  const json = JSON.stringify(obj);
  // Convert "amount":"<digits>" → "amount":<digits> so epee parses as uint64
  return json.replace(/"amount":"(\d+)"/g, '"amount":$1');
}
const NodeSelector = require('./NodeSelector');

const STATE = ConnectionStateMachine.STATE;
const TIER = NodeSelector.TIER;

// FCMP++ uses full-chain membership proofs — ring_size=0 for all transactions
const FCMP_RING_SIZE = 0;

/**
 * WalletRpcManager — CakeWallet-inspired RPC management layer for MoneroUSD.
 *
 * Manages the wallet-rpc process lifecycle, connection state, request queuing,
 * health monitoring, automatic reconnection, and node selection.
 *
 * Usage (main process):
 *   const mgr = new WalletRpcManager();
 *   mgr.on('stateChange', ...);
 *   await mgr.connect(port);
 *   const result = await mgr.rpc('get_balance', {});
 *
 * Usage (server sessions):
 *   const mgr = new WalletRpcManager({ mode: 'server' });
 *   await mgr.spawnAndConnect(walletDir, env);
 */
class WalletRpcManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._mode = options.mode || 'electron'; // 'electron' | 'server'
    this._port = 0;
    this._process = null;
    this._walletDir = options.walletDir || '';
    this._daemonAddress = options.daemonAddress || '';
    this._walletRpcBin = options.walletRpcBin || '';

    // Core modules
    this.stateMachine = new ConnectionStateMachine();
    this.queue = new RpcQueue();
    this.reconnector = new ReconnectionManager();
    this.health = new HealthMonitor();
    this.nodes = new NodeSelector();

    // Wire up events
    this._wireEvents();

    // Remote session state (for Electron connecting to relay)
    this._remoteCookies = new Map();
    this._remoteCsrfTokens = new Map();
  }

  get state() { return this.stateMachine.state; }
  get port() { return this._port; }

  // ==================== Lifecycle ====================

  /**
   * Connect to an existing wallet-rpc on a given port.
   */
  async connect(port) {
    this._port = port;
    this.stateMachine.transition(STATE.CONNECTING);

    const alive = await this.health.ping();
    if (!alive) {
      this.stateMachine.transition(STATE.ERROR, { reason: 'wallet-rpc not responding on port ' + port });
      return false;
    }

    this.stateMachine.transition(STATE.CONNECTED);
    this.health.start(port, this._process, this._walletDir);
    return true;
  }

  /**
   * Spawn a new wallet-rpc process and connect to it.
   * Used by server.js for per-session wallet-rpc.
   */
  async spawnAndConnect(walletDir, env, extraArgs = []) {
    this._walletDir = walletDir;
    this.stateMachine.transition(STATE.CONNECTING);

    const port = this._port;
    if (!port) {
      this.stateMachine.transition(STATE.ERROR, { reason: 'no port assigned' });
      return false;
    }

    // Pass --daemon-address so wallet-rpc stays alive (binary requires it).
    // The daemon connection is needed for restore/sync — the single-threaded
    // nature means restore_deterministic_wallet may trigger auto-sync, but
    // this is handled by the queue (high-priority ops cancel refresh).
    const args = [
      '--rpc-bind-ip', '127.0.0.1',
      '--rpc-bind-port', String(port),
      '--disable-rpc-login',
      '--wallet-dir', walletDir,
      '--log-level', '0',
      '--non-interactive',
    ];

    // Add daemon address (required for binary to stay alive)
    if (this._daemonAddress) {
      args.push('--daemon-address', this._daemonAddress, '--trusted-daemon');
    }

    // Add log file if provided
    if (extraArgs.length === 0 && walletDir) {
      args.push('--log-file', require('path').join(walletDir, 'wallet-rpc.log'));
    }

    args.push(...extraArgs);

    const proc = spawn(this._walletRpcBin, args, {
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this._process = proc;
    proc.stderr.on('data', () => {}); // drain
    proc.stdout.on('data', () => {}); // drain

    proc.on('exit', (code, signal) => {
      if (this.stateMachine.state !== STATE.DISCONNECTED) {
        this.emit('processExit', { code, signal, port });
        this.stateMachine.transition(STATE.ERROR, { reason: 'process exited with code ' + code + (signal ? ' signal ' + signal : '') });
      }
    });

    proc.on('error', (err) => {
      this.emit('processError', { error: err.message, port });
      this.stateMachine.transition(STATE.ERROR, { reason: 'spawn error: ' + err.message });
    });

    // Wait for wallet-rpc to become responsive
    const ready = await this._waitForReady(port, 10);
    if (ready) {
      this.stateMachine.transition(STATE.CONNECTED);
      this.health.start(port, proc, walletDir);
      return true;
    }

    this.stateMachine.transition(STATE.ERROR, { reason: 'wallet-rpc failed to start' });
    return false;
  }

  /**
   * Restart the wallet-rpc process (after crash or health failure).
   */
  async restart() {
    this.queue.pause();
    this.health.stop();

    // Kill old process
    if (this._process) {
      try { this._process.kill('SIGTERM'); } catch (_) {}
      await new Promise(r => setTimeout(r, 1000));
      try { this._process.kill('SIGKILL'); } catch (_) {}
    }

    const walletFilename = this.stateMachine.walletFilename;
    this.stateMachine.reset();

    // Clear stale lock files
    if (walletFilename) {
      this.health.clearStaleLock(walletFilename);
    }

    // Re-spawn
    const env = Object.assign({}, process.env, {
      MONEROUSD_ENABLE_FCMP: '1',
      MONEROUSD_ALLOW_LOW_MIXIN: '1',
      MONEROUSD_DISABLE_TX_LIMITS: '1',
      MONEROUSD_DISABLE_UNLOCKS: '1',
    });

    const ok = await this.spawnAndConnect(this._walletDir, env);
    if (!ok) {
      this.emit('restartFailed');
      return false;
    }

    // SECURITY: Do NOT auto-reopen wallet after restart.
    // The user must re-authenticate (enter password) to open their wallet.
    // Storing passwords in memory for auto-reopen is a security risk.
    if (walletFilename) {
      this.emit('walletClosed', { filename: walletFilename, reason: 'process_restart' });
    }

    this.queue.resume();
    return true;
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    this.health.stop();
    this.reconnector.stop();
    this.queue.reset();

    if (this._process) {
      try {
        await this._rawRpc('store', {}, 5000);
      } catch (_) {}
      try {
        await this._rawRpc('close_wallet', {}, 3000);
      } catch (_) {}
      try { this._process.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { this._process.kill('SIGKILL'); } catch (_) {}
      }, 5000);
    }

    this.stateMachine.transition(STATE.DISCONNECTED);
  }

  // ==================== RPC ====================

  /**
   * Execute an RPC call through the queue with state validation.
   * @param {string} method - RPC method name
   * @param {object} params - RPC parameters
   * @param {object} options - { timeoutMs, priority, bioToken }
   */
  async rpc(method, params = {}, options = {}) {
    // State validation
    if (!this.stateMachine.canExecute(method)) {
      const state = this.stateMachine.state;
      // Allow wallet operations to wait briefly for connecting state
      if (state === STATE.CONNECTING || state === STATE.WALLET_OPENING) {
        await this._waitForState([STATE.CONNECTED, STATE.SYNCING, STATE.SYNCED], 10000);
        if (!this.stateMachine.canExecute(method)) {
          throw new Error('Cannot execute ' + method + ' in state ' + this.stateMachine.state);
        }
      } else {
        throw new Error('Cannot execute ' + method + ' in state ' + state);
      }
    }

    // FCMP++: Auto-inject ring_size for transfer calls
    if (method === 'transfer' && params && params.ring_size == null) {
      params = Object.assign({}, params, { ring_size: FCMP_RING_SIZE });
    }

    // Validate set_daemon address (prevent crash from empty address)
    if (method === 'set_daemon' && params) {
      if (params.address && params.address.trim()) {
        this.stateMachine.setDaemon(params.address);
      }
      // Don't send set_daemon with empty address — it can crash the binary
      if (!params.address || !params.address.trim()) {
        return { status: 'ok' };
      }
    }

    // Track wallet open/close
    if (method === 'restore_deterministic_wallet' || method === 'open_wallet' || method === 'create_wallet') {
      this.stateMachine.transition(STATE.WALLET_OPENING);
    }

    // Methods that block wallet-rpc (single-threaded) for extended periods.
    // Health monitor must be paused during these to avoid false unhealthy events.
    const BLOCKING_METHODS = new Set([
      'restore_deterministic_wallet', 'open_wallet', 'create_wallet',
      'refresh', 'rescan_blockchain',
      'transfer',  // FCMP++ proof construction blocks wallet-rpc for 30-60s
    ]);

    const executeFn = async (m, p, opts) => {
      const isBlocking = BLOCKING_METHODS.has(m);
      if (isBlocking) this.health.pause();

      let result;
      try {
        result = await this._rawRpc(m, p, opts.timeoutMs || options.timeoutMs || 30000);
      } catch (e) {
        if (isBlocking) this.health.resume();
        // Reset state on error so retries aren't blocked by WALLET_OPENING
        if (m === 'restore_deterministic_wallet' || m === 'open_wallet' || m === 'create_wallet') {
          this.stateMachine.transition(STATE.CONNECTED);
        }
        throw e;
      }
      if (isBlocking) this.health.resume();

      // Post-call state transitions
      if (m === 'restore_deterministic_wallet' || m === 'open_wallet' || m === 'create_wallet') {
        if (params.filename) this.stateMachine.setWallet(params.filename);
        this.stateMachine.transition(STATE.SYNCING);
        // NOTE: No set_daemon call here — daemon address is already set via --daemon-address
        // at spawn time (spawnAndConnect lines 111-113). A fire-and-forget rawRpc call here
        // ties up the single-threaded wallet-rpc and causes health ping timeouts.
      }

      if (m === 'close_wallet') {
        this.stateMachine.clearWallet();
        this.stateMachine.transition(STATE.CONNECTED);
      }

      if (m === 'refresh' && result) {
        const h = result.height || 0;
        const bf = result.blocks_fetched || 0;
        this.stateMachine.updateSyncProgress(h, this.stateMachine.daemonHeight || h, bf);
      }

      return result;
    };

    // For transaction broadcasts: use node failover
    if (method === 'transfer') {
      return this._executeWithFailover(executeFn, method, params, options);
    }

    return this.queue.enqueue(executeFn, method, params, options);
  }

  /**
   * Transaction broadcast with node failover.
   * Privacy: never broadcast through more than one remote node.
   */
  async _executeWithFailover(executeFn, method, params, options) {
    const merged = Object.assign({}, options, { priority: 'high' });
    try {
      const result = await this.queue.enqueue(executeFn, method, params, merged);
      this.nodes.reportSuccess(this.nodes.getBestNode(true));
      return result;
    } catch (firstErr) {
      const msg = String(firstErr.message || '');
      // Only failover on connection errors, not wallet errors (insufficient balance, etc.)
      // Do NOT treat timeout as connection error for transfers — FCMP++ proof construction
      // legitimately takes 30-120s on single-threaded wallet-rpc.
      const isConnectionErr = /ECONNRESET|ECONNREFUSED|socket hang up|connection reset/i.test(msg);
      if (!isConnectionErr) throw firstErr;

      // Try to reconnect and retry once
      this.nodes.reportFailure(this.nodes.getBestNode(true));
      const reconnected = await this.reconnector.tryNow(() => this.health.ping());
      if (reconnected) {
        return this.queue.enqueue(executeFn, method, params, merged);
      }
      throw firstErr;
    }
  }

  // ==================== Incremental Sync ====================

  /**
   * CakeWallet-style incremental refresh: short-burst refresh calls with progress updates.
   * Cancellable by higher-priority operations (send, stake).
   */
  async incrementalRefresh(startHeight, onProgress, options = {}) {
    const maxTimeMs = options.maxTimeMs || 300000;
    const began = Date.now();
    let totalFetched = 0;

    if (this.stateMachine.state !== STATE.SYNCING && this.stateMachine.state !== STATE.SYNCED) {
      if (this.stateMachine.state === STATE.CONNECTED) {
        this.stateMachine.transition(STATE.SYNCING);
      }
    }

    // Disable auto_refresh to prevent mutex contention during client-driven sync
    await this.rpc('auto_refresh', { enable: false }, { timeoutMs: 5000 }).catch(() => {});

    while (Date.now() - began < maxTimeMs) {
      try {
        const result = await this.rpc('refresh', {
          start_height: totalFetched === 0 ? (startHeight || 0) : undefined,
        }, { timeoutMs: 60000, priority: 'normal' });

        const fetched = (result && result.blocks_fetched) || 0;
        totalFetched += fetched;

        if (onProgress) {
          onProgress({
            blocksFetched: totalFetched,
            height: this.stateMachine.walletHeight,
            daemonHeight: this.stateMachine.daemonHeight,
            percent: this.stateMachine.syncPercent,
          });
        }

        // Synced: 0 blocks fetched
        if (fetched === 0) break;

        // Small delay between refresh batches to let other RPCs through
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        const msg = String(e.message || '');
        if (/cancel/i.test(msg)) break; // Refresh was cancelled by higher-priority op
        throw e;
      }
    }

    // Do NOT re-enable auto_refresh — wallet-rpc is single-threaded and
    // auto_refresh blocks all other calls (health pings, get_balance, transfers).
    // The client drives sync via its own periodic refresh schedule.

    return { blocks_fetched: totalFetched };
  }

  // ==================== Remote Relay (Electron mode) ====================

  /**
   * Execute RPC through a remote relay server (for Electron connecting to hosted relay).
   * Manages session cookies, CSRF tokens, and transparent session init.
   */
  async remoteRpc(baseUrl, method, params = {}, timeoutMs = 30000) {
    const u = new URL(baseUrl);
    const isHttps = u.protocol === 'https:';

    // Ensure session exists
    if (!this._remoteCookies.has(u.hostname)) {
      await this._initRemoteSession(baseUrl);
    }

    const body = jsonStringifyRpc({ jsonrpc: '2.0', id: '0', method, params });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };

    const cookie = this._remoteCookies.get(u.hostname);
    if (cookie) headers['Cookie'] = cookie;
    const csrf = this._remoteCsrfTokens.get(u.hostname);
    if (csrf) headers['X-CSRF-Token'] = csrf;

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: '/json_rpc',
        method: 'POST',
        headers,
      };

      const req = (isHttps ? https : http).request(opts, (res) => {
        // Capture session cookies
        if (res.headers['set-cookie']) {
          for (const sc of res.headers['set-cookie']) {
            const match = sc.match(/musd_session=([^;]+)/);
            if (match && match[1]) this._remoteCookies.set(u.hostname, 'musd_session=' + match[1]);
          }
        }

        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try {
            // Preserve uint64 precision
            const raw = (buf || '')
              .replace(/"balance"\s*:\s*(\d+)/g, '"balance":"$1"')
              .replace(/"unlocked_balance"\s*:\s*(\d+)/g, '"unlocked_balance":"$1"')
              .replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"');
            const data = JSON.parse(raw || '{}');

            if (data.error) {
              const errMsg = data.error.message || 'RPC error';
              // Session expired — clear and retry once
              if (/refresh.*page|new session/i.test(errMsg)) {
                this._remoteCookies.delete(u.hostname);
                this._remoteCsrfTokens.delete(u.hostname);
              }
              reject(new Error(errMsg));
            } else {
              resolve(data.result);
            }
          } catch (e) {
            reject(new Error('Invalid RPC response: ' + (e.message || 'parse error')));
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.write(body);
      req.end();
    });
  }

  async _initRemoteSession(baseUrl) {
    return new Promise((resolve, reject) => {
      const u = new URL(baseUrl);
      const isHttps = u.protocol === 'https:';
      const headers = { 'Content-Type': 'application/json' };
      const cookie = this._remoteCookies.get(u.hostname);
      if (cookie) headers['Cookie'] = cookie;

      const opts = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: '/api/session',
        method: 'POST',
        headers,
      };

      const req = (isHttps ? https : http).request(opts, (res) => {
        if (res.headers['set-cookie']) {
          for (const sc of res.headers['set-cookie']) {
            const match = sc.match(/musd_session=([^;]+)/);
            if (match && match[1]) this._remoteCookies.set(u.hostname, 'musd_session=' + match[1]);
          }
        }
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(buf);
            if (data && data.csrfToken) this._remoteCsrfTokens.set(u.hostname, data.csrfToken);
            resolve(data);
          } catch (_) { resolve(null); }
        });
      });
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Session init timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  // ==================== Internal ====================

  /** Raw RPC call directly to wallet-rpc on localhost (no queue, no state checks) */
  _rawRpc(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const body = jsonStringifyRpc({ jsonrpc: '2.0', id: '0', method, params: params || {} });
      const req = http.request({
        hostname: '127.0.0.1',
        port: this._port,
        path: '/json_rpc',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try {
            const raw = (buf || '')
              .replace(/"balance"\s*:\s*(\d+)/g, '"balance":"$1"')
              .replace(/"unlocked_balance"\s*:\s*(\d+)/g, '"unlocked_balance":"$1"')
              .replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"');
            const data = JSON.parse(raw);
            if (data.error) reject(new Error(data.error.message || 'RPC error'));
            else resolve(data.result);
          } catch (e) {
            reject(new Error('Invalid RPC response'));
          }
        });
      });
      req.setTimeout(timeoutMs || 30000, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async _waitForReady(port, maxRetries) {
    for (let i = 0; i < (maxRetries || 10); i++) {
      try {
        const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_version', params: {} });
        const alive = await new Promise((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1', port, path: '/json_rpc', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
              try { const d = JSON.parse(buf); resolve(!!(d && d.result)); } catch (_) { resolve(false); }
            });
          });
          req.setTimeout(1500, () => { req.destroy(); resolve(false); });
          req.on('error', () => resolve(false));
          req.write(body);
          req.end();
        });
        if (alive) return true;
      } catch (_) {}
      await new Promise(ok => setTimeout(ok, i === 0 ? 200 : 300));
    }
    return false;
  }

  _waitForState(targetStates, maxMs) {
    return new Promise((resolve) => {
      if (targetStates.includes(this.stateMachine.state)) return resolve(true);
      let timer;
      const handler = ({ to }) => {
        if (targetStates.includes(to)) {
          clearTimeout(timer);
          this.stateMachine.removeListener('stateChange', handler);
          resolve(true);
        }
      };
      this.stateMachine.on('stateChange', handler);
      timer = setTimeout(() => {
        this.stateMachine.removeListener('stateChange', handler);
        resolve(false);
      }, maxMs || 10000);
    });
  }

  _wireEvents() {
    // Forward state machine events
    this.stateMachine.on('stateChange', (data) => this.emit('stateChange', data));
    this.stateMachine.on('syncProgress', (data) => this.emit('syncProgress', data));

    // Health monitor triggers reconnection
    this.health.on('unhealthy', (data) => {
      this.emit('unhealthy', data);
      if (!data.processAlive) {
        // Process died — restart
        this.restart().catch(() => {});
      } else {
        // Process alive but not responding — try reconnection
        this.reconnector.start(async () => {
          const alive = await this.health.ping();
          if (alive) {
            this.stateMachine.transition(STATE.CONNECTED);
            this.queue.resume();
            return true;
          }
          return false;
        });
      }
    });

    this.health.on('healthy', () => {
      this.reconnector.stop();
      this.queue.resume();
      this.emit('healthy');
    });

    // Reconnection events
    this.reconnector.on('reconnected', (data) => this.emit('reconnected', data));
    this.reconnector.on('exhausted', (data) => {
      this.emit('reconnectionExhausted', data);
      // Last resort: full restart
      this.restart().catch(() => {});
    });

    // Queue events
    this.queue.on('refreshCancelled', () => this.emit('refreshCancelled'));
  }
}

// Re-export for convenience
WalletRpcManager.STATE = STATE;
WalletRpcManager.TIER = TIER;
WalletRpcManager.ConnectionStateMachine = ConnectionStateMachine;
WalletRpcManager.RpcQueue = RpcQueue;
WalletRpcManager.ReconnectionManager = ReconnectionManager;
WalletRpcManager.HealthMonitor = HealthMonitor;
WalletRpcManager.NodeSelector = NodeSelector;

module.exports = WalletRpcManager;
