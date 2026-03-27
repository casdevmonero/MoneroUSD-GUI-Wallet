'use strict';

const { EventEmitter } = require('events');

// Privacy tiers — never broadcast a transaction through more than one remote node
const TIER = {
  LOCAL: 'local',       // Best privacy: direct connection to local daemon
  ONION: 'onion',       // Good: Tor hidden service
  RELAY: 'relay',       // Acceptable: trusted relay with session isolation
  REMOTE: 'remote',     // Fallback: direct clearnet remote node (warns user)
};

class NodeSelector extends EventEmitter {
  constructor() {
    super();
    this._nodes = [];     // { url, tier, score, failures, successes, lastSeen, avgResponseMs }
    this._broadcastNode = null;  // Track which node was used for the last broadcast (privacy)
  }

  /**
   * Add a node to the selection pool.
   * @param {string} url - Node URL (e.g. http://127.0.0.1:17750)
   * @param {string} tier - Privacy tier (local, onion, relay, remote)
   */
  addNode(url, tier = TIER.REMOTE) {
    if (!url || this._nodes.find(n => n.url === url)) return;
    this._nodes.push({
      url,
      tier,
      score: tier === TIER.LOCAL ? 100 : tier === TIER.ONION ? 80 : tier === TIER.RELAY ? 60 : 40,
      failures: 0,
      successes: 0,
      lastSeen: 0,
      avgResponseMs: 0,
    });
    this._sortNodes();
  }

  removeNode(url) {
    this._nodes = this._nodes.filter(n => n.url !== url);
  }

  /** Get the best available node for a given operation */
  getBestNode(forBroadcast = false) {
    if (this._nodes.length === 0) return null;

    // For broadcasts: prefer local/onion, and never use more than one remote node
    if (forBroadcast) {
      // If we already broadcast through a remote node, use the same one (correlation prevention)
      if (this._broadcastNode) {
        const prev = this._nodes.find(n => n.url === this._broadcastNode);
        if (prev && prev.failures < 5) return prev.url;
      }
      // Prefer highest privacy tier
      const best = this._nodes.find(n => n.score > 0);
      if (best) {
        this._broadcastNode = best.url;
        return best.url;
      }
      return null;
    }

    // For non-broadcast operations, just pick the best scoring node
    const alive = this._nodes.filter(n => n.score > 0);
    return alive.length > 0 ? alive[0].url : (this._nodes[0] ? this._nodes[0].url : null);
  }

  /** Get all nodes sorted by preference */
  getNodes() {
    return this._nodes.map(n => ({
      url: n.url,
      tier: n.tier,
      score: n.score,
      healthy: n.failures < 3,
    }));
  }

  /** Report a successful RPC call to a node */
  reportSuccess(url, responseMs) {
    const node = this._nodes.find(n => n.url === url);
    if (!node) return;
    node.successes++;
    node.failures = Math.max(0, node.failures - 1); // Slowly recover from failures
    node.lastSeen = Date.now();
    if (responseMs != null) {
      node.avgResponseMs = node.avgResponseMs
        ? Math.round(node.avgResponseMs * 0.7 + responseMs * 0.3)
        : responseMs;
    }
    this._recalcScore(node);
    this._sortNodes();
  }

  /** Report a failed RPC call to a node */
  reportFailure(url) {
    const node = this._nodes.find(n => n.url === url);
    if (!node) return;
    node.failures++;
    this._recalcScore(node);
    this._sortNodes();
    if (node.failures >= 5) {
      this.emit('nodeDown', { url, tier: node.tier, failures: node.failures });
    }
  }

  /** Reset broadcast tracking (after transaction confirmed or on new session) */
  resetBroadcastTracking() {
    this._broadcastNode = null;
  }

  _recalcScore(node) {
    // Base score from privacy tier
    let base = node.tier === TIER.LOCAL ? 100
      : node.tier === TIER.ONION ? 80
      : node.tier === TIER.RELAY ? 60
      : 40;

    // Penalize failures heavily
    base -= node.failures * 15;

    // Bonus for responsiveness (under 500ms)
    if (node.avgResponseMs > 0 && node.avgResponseMs < 500) {
      base += 5;
    } else if (node.avgResponseMs > 5000) {
      base -= 10;
    }

    node.score = Math.max(0, Math.min(100, base));
  }

  _sortNodes() {
    this._nodes.sort((a, b) => b.score - a.score);
  }
}

NodeSelector.TIER = TIER;
module.exports = NodeSelector;
