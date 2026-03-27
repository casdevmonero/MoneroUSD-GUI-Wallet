'use strict';

const { EventEmitter } = require('events');

const DEFAULTS = {
  initialDelayMs: 500,
  maxDelayMs: 30000,
  multiplier: 2,
  jitter: 0.25,     // +/- 25%
  maxAttempts: 10,
};

class ReconnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._opts = Object.assign({}, DEFAULTS, options);
    this._attempt = 0;
    this._timer = null;
    this._active = false;
    this._aborted = false;
  }

  get isActive() { return this._active; }
  get attempt() { return this._attempt; }

  /**
   * Start reconnection loop.
   * @param {Function} connectFn - async function that attempts to connect. Returns true on success.
   */
  start(connectFn) {
    if (this._active) return;
    this._active = true;
    this._aborted = false;
    this._attempt = 0;
    this.emit('started');
    this._loop(connectFn);
  }

  stop() {
    this._active = false;
    this._aborted = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.emit('stopped');
  }

  async _loop(connectFn) {
    while (this._active && this._attempt < this._opts.maxAttempts) {
      this._attempt++;
      const delay = this._computeDelay();
      this.emit('attempting', { attempt: this._attempt, delayMs: delay });

      await new Promise(resolve => {
        this._timer = setTimeout(resolve, delay);
      });
      this._timer = null;

      if (!this._active || this._aborted) return;

      try {
        const success = await connectFn();
        if (success) {
          this._active = false;
          this._attempt = 0;
          this.emit('reconnected', { attempts: this._attempt });
          return;
        }
      } catch (e) {
        this.emit('attemptFailed', { attempt: this._attempt, error: e.message });
      }
    }

    if (this._active) {
      this._active = false;
      this.emit('exhausted', { attempts: this._attempt });
    }
  }

  _computeDelay() {
    const base = Math.min(
      this._opts.initialDelayMs * Math.pow(this._opts.multiplier, this._attempt - 1),
      this._opts.maxDelayMs
    );
    const jitterRange = base * this._opts.jitter;
    return Math.round(base + (Math.random() * 2 - 1) * jitterRange);
  }

  /** Immediate reconnect attempt (skip delay), e.g. after process restart */
  async tryNow(connectFn) {
    try {
      const success = await connectFn();
      if (success) {
        this.stop();
        this.emit('reconnected', { attempts: 0 });
        return true;
      }
    } catch (_) {}
    return false;
  }
}

module.exports = ReconnectionManager;
