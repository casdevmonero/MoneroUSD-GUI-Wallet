'use strict';

const { EventEmitter } = require('events');

// Methods that can run concurrently (read-only, no wallet state mutation)
const READ_ONLY_METHODS = new Set([
  'get_version', 'get_address', 'get_balance', 'get_height',
  'get_accounts', 'get_transfers', 'get_transfer_by_txid',
  'query_key', 'get_languages', 'get_attribute',
  'auto_refresh', 'incoming_transfers',
]);

// Methods that mutate wallet state — must be serialized
const MUTATING_METHODS = new Set([
  'transfer', 'open_wallet', 'close_wallet', 'create_wallet',
  'restore_deterministic_wallet', 'set_daemon', 'store',
  'freeze', 'thaw', 'set_attribute', 'change_wallet_password',
  'rescan_blockchain',
]);

// Long-running methods that can be cancelled by higher-priority work
const CANCELLABLE_METHODS = new Set(['refresh', 'rescan_blockchain']);

class RpcQueue extends EventEmitter {
  constructor() {
    super();
    this._mutationQueue = Promise.resolve();
    this._activeRefreshAbort = null;
    this._paused = false;
    this._inflightCount = 0;
  }

  get inflightCount() { return this._inflightCount; }

  /**
   * Enqueue an RPC call with proper serialization.
   * @param {Function} executeFn - async function(method, params, options) that performs the actual RPC
   * @param {string} method - RPC method name
   * @param {object} params - RPC params
   * @param {object} options - { priority: 'high'|'normal', timeoutMs, signal }
   * @returns {Promise<any>} RPC result
   */
  async enqueue(executeFn, method, params, options = {}) {
    if (this._paused) {
      throw new Error('RPC queue is paused. Wallet is reconnecting.');
    }

    const priority = options.priority || 'normal';

    // Read-only methods bypass the queue entirely — run concurrently
    if (READ_ONLY_METHODS.has(method)) {
      return this._executeTracked(executeFn, method, params, options);
    }

    // High-priority mutations (transfer, freeze, thaw) cancel any running refresh
    if (priority === 'high' && MUTATING_METHODS.has(method)) {
      this.cancelRefresh();
    }

    // refresh is special: cancellable, runs in mutation lane
    if (method === 'refresh') {
      return this._enqueueRefresh(executeFn, params, options);
    }

    // All other mutating methods: serialize
    return this._enqueueMutation(executeFn, method, params, options);
  }

  async _enqueueRefresh(executeFn, params, options) {
    const abortController = new AbortController();
    const prevAbort = this._activeRefreshAbort;
    this._activeRefreshAbort = abortController;

    // Cancel previous refresh if still running
    if (prevAbort) prevAbort.abort();

    const merged = Object.assign({}, options, { signal: abortController.signal });

    return new Promise((resolve, reject) => {
      const prev = this._mutationQueue;
      let resolveNext;
      this._mutationQueue = new Promise(r => { resolveNext = r; });

      const run = async () => {
        await prev;
        try {
          if (abortController.signal.aborted) {
            throw new Error('Refresh cancelled');
          }
          const result = await this._executeTracked(executeFn, 'refresh', params, merged);
          resolve(result);
        } catch (e) {
          reject(e);
        } finally {
          if (this._activeRefreshAbort === abortController) {
            this._activeRefreshAbort = null;
          }
          resolveNext();
        }
      };
      run();
    });
  }

  async _enqueueMutation(executeFn, method, params, options) {
    return new Promise((resolve, reject) => {
      const prev = this._mutationQueue;
      let resolveNext;
      this._mutationQueue = new Promise(r => { resolveNext = r; });

      const run = async () => {
        await prev;
        try {
          const result = await this._executeTracked(executeFn, method, params, options);
          resolve(result);
        } catch (e) {
          reject(e);
        } finally {
          resolveNext();
        }
      };
      run();
    });
  }

  async _executeTracked(executeFn, method, params, options) {
    this._inflightCount++;
    this.emit('rpcStart', { method });
    try {
      const result = await executeFn(method, params, options);
      this.emit('rpcEnd', { method, success: true });
      return result;
    } catch (e) {
      this.emit('rpcEnd', { method, success: false, error: e.message });
      throw e;
    } finally {
      this._inflightCount--;
    }
  }

  /** Cancel any active refresh call */
  cancelRefresh() {
    if (this._activeRefreshAbort) {
      this._activeRefreshAbort.abort();
      this._activeRefreshAbort = null;
      this.emit('refreshCancelled');
    }
  }

  /** Pause the queue (during reconnection) */
  pause() {
    this._paused = true;
    this.cancelRefresh();
  }

  /** Resume the queue */
  resume() {
    this._paused = false;
  }

  /** Hard reset — drain everything */
  reset() {
    this.cancelRefresh();
    this._mutationQueue = Promise.resolve();
    this._paused = false;
    this._inflightCount = 0;
  }
}

RpcQueue.READ_ONLY_METHODS = READ_ONLY_METHODS;
RpcQueue.MUTATING_METHODS = MUTATING_METHODS;
RpcQueue.CANCELLABLE_METHODS = CANCELLABLE_METHODS;
module.exports = RpcQueue;
