'use strict';

const { EventEmitter } = require('events');

// Connection states — adapted from CakeWallet's wallet connection lifecycle
const STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',       // wallet-rpc alive, no wallet open
  WALLET_OPENING: 'wallet_opening',
  SYNCING: 'syncing',           // wallet open, refresh in progress
  SYNCED: 'synced',             // wallet open, fully synced
  ERROR: 'error',
};

// Which RPC methods are allowed in each state
const STATE_ALLOWED_METHODS = {
  [STATE.DISCONNECTED]: new Set(['get_version']),
  [STATE.CONNECTING]: new Set(['get_version']),
  [STATE.CONNECTED]: new Set([
    'get_version', 'get_languages',
    'open_wallet', 'create_wallet', 'restore_deterministic_wallet', 'close_wallet',
    'set_daemon', 'auto_refresh',
    // Allow balance/transfer when wallet is already open but state hasn't advanced to syncing
    // (e.g. server mode where restore + refresh are called sequentially by client)
    'get_address', 'get_balance', 'get_height', 'get_accounts',
    'get_transfers', 'get_transfer_by_txid', 'query_key', 'get_attribute', 'set_attribute',
    'incoming_transfers', 'refresh', 'store',
    'transfer', 'freeze', 'thaw',
    'change_wallet_password', 'rescan_blockchain',
  ]),
  [STATE.WALLET_OPENING]: new Set(['get_version']),
  [STATE.SYNCING]: new Set([
    'get_version', 'get_address', 'get_balance', 'get_height',
    'get_accounts', 'get_transfers', 'get_transfer_by_txid',
    'query_key', 'get_languages', 'get_attribute', 'set_attribute',
    'auto_refresh', 'incoming_transfers', 'refresh',
    'set_daemon', 'close_wallet', 'store',
    // Allow mutations during sync — they queue behind the current refresh chunk
    'transfer', 'freeze', 'thaw',
    'change_wallet_password', 'rescan_blockchain',
  ]),
  [STATE.SYNCED]: new Set([
    'get_version', 'get_address', 'get_balance', 'get_height',
    'get_accounts', 'get_transfers', 'get_transfer_by_txid',
    'query_key', 'get_languages', 'get_attribute', 'set_attribute',
    'auto_refresh', 'incoming_transfers', 'refresh',
    'set_daemon', 'close_wallet', 'store',
    'transfer', 'freeze', 'thaw',
    'open_wallet', 'create_wallet', 'restore_deterministic_wallet',
    'change_wallet_password', 'rescan_blockchain',
  ]),
  [STATE.ERROR]: new Set(['get_version']),
};

// Valid state transitions
const VALID_TRANSITIONS = {
  [STATE.DISCONNECTED]: [STATE.CONNECTING],
  [STATE.CONNECTING]: [STATE.CONNECTED, STATE.ERROR, STATE.DISCONNECTED],
  [STATE.CONNECTED]: [STATE.WALLET_OPENING, STATE.SYNCING, STATE.SYNCED, STATE.ERROR, STATE.DISCONNECTED],
  [STATE.WALLET_OPENING]: [STATE.CONNECTED, STATE.SYNCING, STATE.SYNCED, STATE.ERROR, STATE.DISCONNECTED],
  [STATE.SYNCING]: [STATE.SYNCED, STATE.CONNECTED, STATE.ERROR, STATE.DISCONNECTED],
  [STATE.SYNCED]: [STATE.SYNCING, STATE.CONNECTED, STATE.WALLET_OPENING, STATE.ERROR, STATE.DISCONNECTED],
  [STATE.ERROR]: [STATE.CONNECTING, STATE.DISCONNECTED],
};

class ConnectionStateMachine extends EventEmitter {
  constructor() {
    super();
    this._state = STATE.DISCONNECTED;
    this._walletFilename = '';
    // SECURITY: Do NOT store wallet password in the state machine.
    // Passwords should only be passed to wallet-rpc during open/restore,
    // never cached in memory.
    this._daemonAddress = '';
    this._walletHeight = 0;
    this._daemonHeight = 0;
    this._syncPercent = 0;
    this._consecutiveSyncedRefreshes = 0;
  }

  get state() { return this._state; }
  get walletFilename() { return this._walletFilename; }
  get daemonAddress() { return this._daemonAddress; }
  get walletHeight() { return this._walletHeight; }
  get daemonHeight() { return this._daemonHeight; }
  get syncPercent() { return this._syncPercent; }

  transition(newState, meta = {}) {
    const oldState = this._state;
    if (oldState === newState) return true;
    const valid = VALID_TRANSITIONS[oldState];
    if (!valid || !valid.includes(newState)) {
      this.emit('invalid_transition', { from: oldState, to: newState, meta });
      return false;
    }
    this._state = newState;
    this.emit('stateChange', { from: oldState, to: newState, meta });

    // Reset sync tracking on disconnect/error
    if (newState === STATE.DISCONNECTED || newState === STATE.ERROR) {
      this._consecutiveSyncedRefreshes = 0;
      this._syncPercent = 0;
    }
    return true;
  }

  canExecute(method) {
    const allowed = STATE_ALLOWED_METHODS[this._state];
    return allowed ? allowed.has(method) : false;
  }

  // Track wallet lifecycle (filename only — no passwords stored)
  setWallet(filename) {
    this._walletFilename = filename || '';
  }

  clearWallet() {
    this._walletFilename = '';
    this._walletHeight = 0;
    this._daemonHeight = 0;
    this._syncPercent = 0;
    this._consecutiveSyncedRefreshes = 0;
  }

  setDaemon(address) {
    this._daemonAddress = address || '';
  }

  // Update sync progress — returns true if we just became synced
  updateSyncProgress(walletHeight, daemonHeight, blocksFetched) {
    this._walletHeight = walletHeight || 0;
    this._daemonHeight = daemonHeight || 0;
    if (this._daemonHeight > 0) {
      this._syncPercent = Math.min(100, Math.round((this._walletHeight / this._daemonHeight) * 100));
    }
    this.emit('syncProgress', {
      walletHeight: this._walletHeight,
      daemonHeight: this._daemonHeight,
      percent: this._syncPercent,
      blocksFetched: blocksFetched || 0,
    });

    // CakeWallet pattern: 3 consecutive refreshes with 0 blocks = synced
    if (blocksFetched === 0) {
      this._consecutiveSyncedRefreshes++;
    } else {
      this._consecutiveSyncedRefreshes = 0;
    }
    if (this._consecutiveSyncedRefreshes >= 3 || (this._walletHeight > 0 && this._walletHeight >= this._daemonHeight)) {
      if (this._state === STATE.SYNCING) {
        this.transition(STATE.SYNCED);
        return true;
      }
    }
    return false;
  }

  getStatus() {
    return {
      state: this._state,
      walletFilename: this._walletFilename,
      daemonAddress: this._daemonAddress,
      walletHeight: this._walletHeight,
      daemonHeight: this._daemonHeight,
      syncPercent: this._syncPercent,
    };
  }

  // Force reset (for catastrophic failures)
  reset() {
    this._state = STATE.DISCONNECTED;
    this.clearWallet();
    this._daemonAddress = '';
    this.emit('stateChange', { from: 'any', to: STATE.DISCONNECTED, meta: { reason: 'reset' } });
  }
}

ConnectionStateMachine.STATE = STATE;
module.exports = ConnectionStateMachine;
