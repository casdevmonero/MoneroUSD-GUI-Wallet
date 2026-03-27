'use strict';

const { EventEmitter } = require('events');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  intervalMs: 15000,       // Check every 15 seconds
  timeoutMs: 8000,         // 8-second ping timeout (wallet-rpc is single-threaded; can be slow mid-sync)
  failureThreshold: 5,     // 5 consecutive failures = unhealthy (75s of no response before restart)
  lockCheckEnabled: true,   // Check for stale .lock files
};

class HealthMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this._opts = Object.assign({}, DEFAULTS, options);
    this._timer = null;
    this._running = false;
    this._consecutiveFailures = 0;
    this._healthy = true;
    this._port = 0;
    this._process = null;
    this._walletDir = '';
  }

  get isHealthy() { return this._healthy; }
  get consecutiveFailures() { return this._consecutiveFailures; }

  /**
   * Pause health checks during blocking RPC operations.
   * wallet-rpc is single-threaded — restore, refresh, and rescan block
   * all other calls including health pings. Without pausing, the monitor
   * would declare the process unhealthy and trigger a restart mid-operation.
   */
  pause() { this._paused = true; }
  resume() {
    this._paused = false;
    this._consecutiveFailures = 0; // reset after a known-blocking operation
  }

  /**
   * Start monitoring a wallet-rpc process.
   * @param {number} port - The RPC port to ping
   * @param {object} [proc] - The child_process handle (for alive check)
   * @param {string} [walletDir] - Wallet directory (for lock file check)
   */
  start(port, proc, walletDir) {
    this.stop();
    this._port = port;
    this._process = proc || null;
    this._walletDir = walletDir || '';
    this._running = true;
    this._consecutiveFailures = 0;
    this._healthy = true;
    this._tick();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Update port after auto-restart */
  updatePort(port) { this._port = port; }

  /** Update process handle after restart */
  updateProcess(proc) { this._process = proc; }

  async _tick() {
    if (!this._running) return;

    // Skip health check if paused (blocking RPC in progress)
    if (this._paused) {
      if (this._running) {
        this._timer = setTimeout(() => this._tick(), this._opts.intervalMs);
      }
      return;
    }

    const alive = await this._checkHealth();
    if (alive) {
      if (!this._healthy) {
        this._healthy = true;
        this.emit('healthy', { port: this._port });
      }
      this._consecutiveFailures = 0;
    } else {
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= this._opts.failureThreshold && this._healthy) {
        this._healthy = false;
        this.emit('unhealthy', {
          port: this._port,
          failures: this._consecutiveFailures,
          processAlive: this._isProcessAlive(),
        });
      }
    }

    if (this._running) {
      this._timer = setTimeout(() => this._tick(), this._opts.intervalMs);
    }
  }

  _checkHealth() {
    return new Promise((resolve) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_version', params: {} });
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
            const data = JSON.parse(buf);
            resolve(!!(data && data.result));
          } catch (_) {
            resolve(false);
          }
        });
      });
      req.setTimeout(this._opts.timeoutMs, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.write(body);
      req.end();
    });
  }

  _isProcessAlive() {
    if (!this._process) return false;
    try {
      // process.kill(0) doesn't kill — it tests if process exists
      return !this._process.killed && this._process.exitCode === null;
    } catch (_) {
      return false;
    }
  }

  /**
   * Check for stale wallet lock files and remove them.
   * @param {string} walletFilename - The wallet filename to check
   * @returns {boolean} true if lock was cleared
   */
  clearStaleLock(walletFilename) {
    if (!this._opts.lockCheckEnabled || !this._walletDir || !walletFilename) return false;
    const lockPath = path.join(this._walletDir, walletFilename + '.lock');
    try {
      if (fs.existsSync(lockPath)) {
        // If the process is dead, the lock is definitely stale
        if (!this._isProcessAlive()) {
          fs.unlinkSync(lockPath);
          this.emit('lockCleared', { file: lockPath });
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  /** One-shot health check (for use before critical operations) */
  async ping() {
    return this._checkHealth();
  }
}

module.exports = HealthMonitor;
