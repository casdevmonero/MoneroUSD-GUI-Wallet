(function () {
  const RPC_STORAGE_KEY = 'monerousd_rpc_url';
  const BALANCE_STORAGE_KEY = 'monerousd_balance';
  const DAEMON_URL_STORAGE_KEY = 'monerousd_daemon_url';
  const SWAP_BACKEND_STORAGE_KEY = 'monerousd_swap_backend_url';
  const ACTIVE_SWAP_STORAGE_KEY = 'monerousd_active_swap';
  const isBrowser = typeof window !== 'undefined' && !window.electronAPI;
  const DEFAULT_RPC = 'http://127.0.0.1:27750';
  // Same node as CLI: Haven RPC_DEFAULT_PORT = 17750 (cryptonote_config.h). GUI connects wallet RPC to this daemon via set_daemon.
  const DEFAULT_DAEMON_URL = 'http://127.0.0.1:17750';
  const DEFAULT_SWAP_BACKEND = 'http://127.0.0.1:8787';
  // Dashboard balance: USDm only. Never use XUSD or other assets for balance.
  const ASSET_USDM = 'USDm';
  // 1.0 USDm = 1e8 atomic units (8 decimal places, CRYPTONOTE_DISPLAY_DECIMAL_POINT = 8).
  const USDM_ATOMIC_UNIT = 1e8;

  // Safe localStorage access to avoid cache/storage errors (QUOTA_EXCEEDED, SecurityError, disabled storage).
  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('localStorage get failed:', e);
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      if (e && e.name === 'QuotaExceededError' && typeof console !== 'undefined' && console.warn)
        console.warn('localStorage quota exceeded; settings not persisted.');
      else if (typeof console !== 'undefined' && console.warn) console.warn('localStorage set failed:', e);
    }
  }

  let rpcUrl = storageGet(RPC_STORAGE_KEY) || DEFAULT_RPC;
  let currentWalletAddress = '';
  if (!storageGet(DAEMON_URL_STORAGE_KEY)) storageSet(DAEMON_URL_STORAGE_KEY, DEFAULT_DAEMON_URL);
  if (!storageGet(RPC_STORAGE_KEY)) storageSet(RPC_STORAGE_KEY, DEFAULT_RPC);
  if (!storageGet(SWAP_BACKEND_STORAGE_KEY)) storageSet(SWAP_BACKEND_STORAGE_KEY, DEFAULT_SWAP_BACKEND);

  function getDaemonUrl() {
    const el = document.getElementById('daemonUrl');
    const stored = storageGet(DAEMON_URL_STORAGE_KEY);
    const v = (el ? el.value.trim() : null) || stored || '';
    return v || DEFAULT_DAEMON_URL;
  }

  function setDaemonUrl(url) {
    if (url) storageSet(DAEMON_URL_STORAGE_KEY, url);
    const el = document.getElementById('daemonUrl');
    if (el) el.value = url || '';
  }

  async function getSyncInfo() {
    try {
      const r = await rpc('get_sync_info', {}, { timeoutMs: 15000 });
      if (r && (r.height != null || r.target_height != null))
        return { height: Number(r.height) || 0, target_height: Number(r.target_height) || 0 };
    } catch (_) {}
    try {
      const r = await rpc('get_height', {}, { timeoutMs: 10000 });
      return { height: Number(r && r.height) || 0, target_height: 0 };
    } catch (_) {}
    return { height: 0, target_height: 0 };
  }

  // Configure wallet RPC like Monero: set daemon and enable periodic blockchain refresh so balance updates.
  const AUTO_REFRESH_PERIOD_SEC = 20; // match USDm-wallet-rpc DEFAULT_AUTO_REFRESH_PERIOD
  async function configureWalletRpcMoneroStyle() {
    const daemonUrl = getDaemonUrl();
    await rpc('set_daemon', { address: daemonUrl, trusted: true }, { timeoutMs: 8000 });
    try {
      await rpc('auto_refresh', { enable: true, period: AUTO_REFRESH_PERIOD_SEC }, { timeoutMs: 5000 });
    } catch (e) {
      if (e && !/restricted|denied|unavailable/i.test(String(e.message))) console.warn('auto_refresh:', e);
    }
  }

  async function setDaemonAndRefresh(startHeight, onProgress, options = {}) {
    const daemonUrl = getDaemonUrl();
    const refreshTimeoutMs = options.refreshTimeoutMs != null ? options.refreshTimeoutMs : 600000;
    let lastErr = '';
    for (const url of [daemonUrl]) {
      try {
        if (onProgress) onProgress('Connecting to USDm node… ' + url.replace(/^https?:\/\//, '').slice(0, 40));
        await rpc('set_daemon', { address: url, trusted: true }, { timeoutMs: 8000 });
      } catch (e) {
        lastErr = (e && e.message) ? String(e.message) : '';
        if (onProgress) onProgress('Daemon connection failed.');
        continue;
      }
      try {
        let syncBefore = await getSyncInfo();
        const blockMsg = syncBefore.target_height > 0
          ? ' Block ' + (syncBefore.height || 0).toLocaleString() + ' / ' + syncBefore.target_height.toLocaleString() + '.'
          : '';
        if (onProgress) onProgress('Scanning USDm blockchain…' + blockMsg);
        const res = await rpc('refresh', { start_height: startHeight }, { timeoutMs: refreshTimeoutMs });
        const blocks = (res && res.blocks_fetched != null) ? res.blocks_fetched : 0;
        let syncAfter = await getSyncInfo();
        const afterBlockMsg = syncAfter.target_height > 0
          ? ' Block ' + syncAfter.height.toLocaleString() + ' / ' + syncAfter.target_height.toLocaleString() + '.'
          : '';
        if (onProgress) onProgress((blocks > 0 ? 'Fetched ' + blocks.toLocaleString() + ' blocks. ' : '') + afterBlockMsg + ' Synced.');
        return { ok: true, blocks_fetched: blocks };
      } catch (e) {
        lastErr = (e && e.message) ? String(e.message) : '';
        if (!/no connection to daemon|connection|refused|failed/i.test(lastErr)) throw e;
      }
    }
    throw new Error(lastErr || 'Could not connect to daemon. Is your local USDm node (USDmd) running on ' + daemonUrl + '?');
  }

  function loadStoredBalances() {
    try {
      const raw = storageGet(BALANCE_STORAGE_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      return { usdm: data && data.usdm != null ? data.usdm : undefined };
    } catch (_) {
      return {};
    }
  }

  function saveStoredBalances(usdmAtomic) {
    try {
      const cur = loadStoredBalances();
      const data = { usdm: usdmAtomic != null ? String(usdmAtomic) : cur.usdm };
      storageSet(BALANCE_STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function applyStoredBalances() {
    const cur = loadStoredBalances();
    const usdmEl = document.getElementById('balanceUsdm');
    const val = cur.usdm != null && cur.usdm !== '' ? cur.usdm : null;
    if (usdmEl && val != null && amountAsBigInt(val) !== 0n) usdmEl.textContent = formatAmount(val);
  }

  function showSyncStatus(text, visible) {
    const el = document.getElementById('syncStatusBanner');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !visible || !text);
  }

  function showBlockProgress(text, visible) {
    const el = document.getElementById('blockProgress');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !visible || !text);
  }

  async function updateDashboardSyncInfo() {
    try {
      const info = await getSyncInfo();
      if (info.target_height > 0) {
        showBlockProgress('Block ' + (info.height || 0).toLocaleString() + ' / ' + info.target_height.toLocaleString(), true);
        showSyncStatus('', false);
      } else if (info.height > 0) {
        showBlockProgress('Block ' + info.height.toLocaleString(), true);
        showSyncStatus('', false);
      } else {
        showBlockProgress('', false);
        if (info.height === 0 && info.target_height === 0) {
          showSyncStatus('Not connected to daemon. Set Daemon URL in Settings, start USDmd, then click Refresh.', true);
        }
      }
    } catch (_) {
      showBlockProgress('', false);
    }
  }

  function getRpcUrl() {
    const el = document.getElementById('rpcUrl');
    const fromInput = el ? (el.value || '').trim() : '';
    return fromInput || rpcUrl || DEFAULT_RPC;
  }

  function setRpcUrl(url) {
    rpcUrl = url;
    storageSet(RPC_STORAGE_KEY, url);
    const el = document.getElementById('rpcUrl');
    if (el) el.value = url;
  }

  function getSwapBackendUrl() {
    const el = document.getElementById('swapBackendUrl');
    const stored = storageGet(SWAP_BACKEND_STORAGE_KEY);
    const v = (el ? el.value.trim() : null) || stored || '';
    return v || DEFAULT_SWAP_BACKEND;
  }

  function setSwapBackendUrl(url) {
    if (url) storageSet(SWAP_BACKEND_STORAGE_KEY, url);
    const el = document.getElementById('swapBackendUrl');
    if (el) el.value = url || '';
  }

  function getFetchUrl() {
    const isBrowser = typeof window !== 'undefined' && !window.electronAPI;
    if (isBrowser) return (window.location.origin || 'http://localhost:3000');
    return getRpcUrl();
  }

  function getRpcHeaders() {
    const isBrowser = typeof window !== 'undefined' && !window.electronAPI;
    const headers = { 'Content-Type': 'application/json' };
    if (isBrowser) {
      const url = getRpcUrl();
      headers['X-Wallet-RPC-URL'] = url && url.startsWith('http') ? url : DEFAULT_RPC;
    }
    return headers;
  }

  const LOCAL_NODE_HINT = ' Local nodes only: run USDmd (port 17750) and ./start-wallet-rpc.sh (port 27750). No public Haven nodes.';

  function networkErrorHint() {
    const isBrowser = typeof window !== 'undefined' && !window.electronAPI;
    if (isBrowser) {
      return ' Run node server.js and open http://localhost:3000. Verify local USDmd and USDm-wallet-rpc are running.';
    }
    return LOCAL_NODE_HINT;
  }

  const RPC_RETRY_ATTEMPTS = 3;
  const RPC_RETRY_DELAY_MS = 2000;

  function isRetryableRpcError(msg, status) {
    const s = String(msg || '');
    return status === 502 ||
      /ECONNRESET|ECONNREFUSED|connection reset|unreachable|refused|timed out|Failed to fetch|502|socket hang up/i.test(s);
  }

  let rpcQueue = Promise.resolve();

  // Track in-flight refresh/rescan AbortControllers so they can be cancelled before import.
  const inflightRefreshControllers = new Set();

  // Abort all in-flight refresh/rescan requests so the wallet RPC server is free for import.
  function abortInflightRefreshes() {
    for (const c of inflightRefreshControllers) {
      try { c.abort(); } catch (_) {}
    }
    inflightRefreshControllers.clear();
  }

  // Read-only RPC methods safe to run without waiting in the queue.
  // These must not block behind long-running operations like 'refresh'.
  const CONCURRENT_CLIENT_RPC = new Set([
    'get_version', 'get_address', 'get_balance', 'get_height',
    'get_accounts', 'get_transfers', 'get_transfer_by_txid',
    'query_key', 'get_languages', 'get_attribute',
    'incoming_transfers', 'get_sync_info',
  ]);

  async function rpc(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs;
    const rpcUrl = getRpcUrl();
    // Read-only methods bypass the queue so they aren't blocked by long-running refresh/rescan.
    if (CONCURRENT_CLIENT_RPC.has(method)) {
      return rpcUnqueued(method, params, options, timeoutMs, rpcUrl);
    }
    const prev = rpcQueue;
    let resolveNext;
    const next = new Promise((r) => { resolveNext = r; });
    rpcQueue = next;
    const run = async () => {
      await prev;
      try {
        return await rpcUnqueued(method, params, options, timeoutMs, rpcUrl);
      } finally {
        resolveNext();
      }
    };
    return run();
  }

  async function rpcUnqueued(method, params, options, timeoutMs, rpcUrl) {
    let lastErr;
    for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt++) {
      try {
        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.invokeRpc === 'function') {
          return await window.electronAPI.invokeRpc(rpcUrl, method, params, timeoutMs || 30000);
        }

        const url = getFetchUrl();
        const controller = new AbortController();
        let timeoutId;
        if (timeoutMs) {
          timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        }
        const isRefreshLike = (method === 'refresh' || method === 'rescan_blockchain');
        if (isRefreshLike) inflightRefreshControllers.add(controller);
        let res;
        try {
          res = await fetch(url + '/json_rpc', {
            method: 'POST',
            headers: getRpcHeaders(),
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: '0',
              method: method,
              params: params,
            }),
            signal: controller.signal,
          });
        } catch (e) {
          if (timeoutId) clearTimeout(timeoutId);
          if (isRefreshLike) inflightRefreshControllers.delete(controller);
          const isAbort = (e && (e.name === 'AbortError' || /abort/i.test(String(e.message))));
          if (isAbort) {
            throw new Error('Request timed out.' + networkErrorHint());
          }
          throw e;
        }
        if (timeoutId) clearTimeout(timeoutId);
        if (isRefreshLike) inflightRefreshControllers.delete(controller);
        const text = await res.text();
        let data;
        try {
          const raw = (text || '')
            .replace(/"balance"\s*:\s*(\d+)/g, '"balance":"$1"')
            .replace(/"unlocked_balance"\s*:\s*(\d+)/g, '"unlocked_balance":"$1"')
            .replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"');
          data = raw ? JSON.parse(raw) : {};
        } catch (_) {
          data = {};
        }
        if (!res.ok) {
          const msg = (data.error && data.error.message) ? data.error.message : ('RPC request failed: ' + res.status);
          if (res.status === 502 && attempt < RPC_RETRY_ATTEMPTS && isRetryableRpcError(msg, 502)) {
            lastErr = new Error(msg + LOCAL_NODE_HINT);
            await new Promise(r => setTimeout(r, RPC_RETRY_DELAY_MS));
            continue;
          }
          throw new Error(msg + (res.status === 502 ? LOCAL_NODE_HINT : ''));
        }
        if (data.error) throw new Error(data.error.message || 'RPC error');
        return data.result;
      } catch (e) {
        lastErr = e;
        const msg = (e && e.message) || '';
        if (attempt < RPC_RETRY_ATTEMPTS && isRetryableRpcError(msg)) {
          await new Promise(r => setTimeout(r, RPC_RETRY_DELAY_MS));
          continue;
        }
        const hint = /fetch|network|failed|refused|unreachable|timed out|ECONNRESET|reset/i.test(String(msg)) ? networkErrorHint() : '';
        throw new Error(msg + hint);
      }
    }
    throw lastErr;
  }

  async function swapFetch(path, options = {}) {
    let base = getSwapBackendUrl().replace(/\/$/, '');
    // When in browser and backend is default (127.0.0.1:8787), use same-origin so server proxy works
    const isBrowser = typeof window !== 'undefined' && !window.electronAPI;
    if (isBrowser && (!base || base === DEFAULT_SWAP_BACKEND || base.includes('127.0.0.1:8787'))) {
      base = (window.location.origin || '').replace(/\/$/, '');
    }
    const url = base + path;
    const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 15000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
      if (!res.ok) {
        const msg = (data && data.error) ? data.error : ('Swap backend error: ' + res.status);
        throw new Error(String(msg));
      }
      return data;
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? 'Swap backend timed out.' : (e.message || 'Swap backend error.');
      throw new Error(msg);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Normalize amount to BigInt; supports string (no precision loss) or number. */
  function amountAsBigInt(amount) {
    if (amount == null || amount === '') return 0n;
    if (typeof amount === 'bigint') return amount;
    if (typeof amount === 'string') return BigInt(amount.trim() || '0');
    return BigInt(String(Math.floor(Number(amount))));
  }

  /** Format atomic amount (USDM_ATOMIC_UNIT = 1.0) for display; same as CLI wallet. */
  function formatAmount(amount) {
    if (amount == null || amount === '') return '—';
    try {
      const a = amountAsBigInt(amount);
      const whole = Number(a / BigInt(USDM_ATOMIC_UNIT));
      const frac = Number(a % BigInt(USDM_ATOMIC_UNIT)) / USDM_ATOMIC_UNIT;
      return (whole + frac).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    } catch (_) {
      return '—';
    }
  }

  function parseDecimalToAtomic(input, decimals) {
    const raw = String(input || '').trim();
    if (!raw) return 0n;
    const m = raw.match(/^(\d+)(?:\.(\d+))?$/);
    if (!m) return 0n;
    const whole = BigInt(m[1] || '0');
    const fracRaw = (m[2] || '').slice(0, decimals).padEnd(decimals, '0');
    const frac = fracRaw ? BigInt(fracRaw) : 0n;
    const base = BigInt(10) ** BigInt(decimals);
    return whole * base + frac;
  }

  function formatDecimalFromAtomic(amountAtomic, decimals, maxFraction) {
    try {
      const a = amountAsBigInt(amountAtomic);
      const base = BigInt(10) ** BigInt(decimals);
      const whole = a / base;
      const frac = a % base;
      const fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFraction);
      const trimmed = fracStr.replace(/0+$/, '');
      return trimmed ? `${whole.toString()}.${trimmed}` : whole.toString();
    } catch (_) {
      return '0';
    }
  }

  // Minimal QR generator (based on Nayuki QR Code generator).
  const qrcodegen = (() => {
    const Ecc = { LOW: 0, MEDIUM: 1, QUARTILE: 2, HIGH: 3 };
    const ECC_CODEWORDS = [
      [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
      [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    ];
    const NUM_ERROR_CORRECTION_BLOCKS = [
      [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
      [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
      [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
      [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
    ];

    function QrCode(version, ecc, dataCodewords, mask) {
      this.version = version;
      this.ecc = ecc;
      this.mask = mask;
      this.size = version * 4 + 17;
      this.modules = Array.from({ length: this.size }, () => Array(this.size).fill(false));
      this.isFunction = Array.from({ length: this.size }, () => Array(this.size).fill(false));
      this.drawFunctionPatterns();
      const allCodewords = this.addEccAndInterleave(dataCodewords);
      this.drawCodewords(allCodewords);
      if (mask === -1) {
        let minPenalty = Infinity;
        let bestMask = 0;
        for (let i = 0; i < 8; i++) {
          this.applyMask(i);
          this.drawFormatBits(i);
          const penalty = this.getPenaltyScore();
          if (penalty < minPenalty) {
            minPenalty = penalty;
            bestMask = i;
          }
          this.applyMask(i);
        }
        this.mask = bestMask;
      }
      this.applyMask(this.mask);
      this.drawFormatBits(this.mask);
    }

    QrCode.encodeText = function (text, ecc) {
      const segs = [QrSegment.makeBytes(text)];
      return QrCode.encodeSegments(segs, ecc);
    };

    QrCode.encodeSegments = function (segs, ecc) {
      let version = 1;
      for (; version <= 40; version++) {
        const dataCapacityBits = QrCode.getNumDataCodewords(version, ecc) * 8;
        if (QrSegment.getTotalBits(segs, version) <= dataCapacityBits) break;
      }
      const bb = [];
      for (const seg of segs) {
        QrSegment.appendBits(seg.modeBits, 4, bb);
        QrSegment.appendBits(seg.numChars, QrSegment.numCharCountBits(seg.modeBits, version), bb);
        for (const b of seg.data) bb.push(b);
      }
      const dataCapacityBits = QrCode.getNumDataCodewords(version, ecc) * 8;
      QrSegment.appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
      while (bb.length % 8 !== 0) bb.push(0);
      for (let padByte = 0xec; bb.length < dataCapacityBits;) {
        QrSegment.appendBits(padByte, 8, bb);
        padByte = padByte === 0xec ? 0x11 : 0xec;
      }
      const dataCodewords = [];
      for (let i = 0; i < bb.length; i += 8) {
        let val = 0;
        for (let j = 0; j < 8; j++) val = (val << 1) | bb[i + j];
        dataCodewords.push(val);
      }
      return new QrCode(version, ecc, dataCodewords, -1);
    };

    QrCode.getNumDataCodewords = function (version, ecc) {
      const total = QrCode.getNumRawDataModules(version) / 8;
      const eccCodewords = ECC_CODEWORDS[ecc][version - 1];
      return total - eccCodewords * NUM_ERROR_CORRECTION_BLOCKS[ecc][version - 1];
    };

    QrCode.getNumRawDataModules = function (version) {
      const size = version * 4 + 17;
      let result = size * size - 64 * 3 - 15 * 2 - 1;
      if (version >= 2) {
        const numAlign = Math.floor(version / 7) + 2;
        result -= (numAlign - 1) * (numAlign - 1) * 25;
        result -= (numAlign - 2) * 2 * 20;
      }
      if (version >= 7) result -= 36;
      return result;
    };

    QrCode.prototype.drawFunctionPatterns = function () {
      const size = this.size;
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          const on = i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
          this.setFunctionModule(0 + i, 0 + j, on);
          this.setFunctionModule(size - 7 + i, 0 + j, on);
          this.setFunctionModule(0 + i, size - 7 + j, on);
        }
      }
      for (let i = 0; i < size; i++) {
        this.setFunctionModule(6, i, i % 2 === 0);
        this.setFunctionModule(i, 6, i % 2 === 0);
      }
      const alignPos = this.getAlignmentPatternPositions();
      for (let i = 0; i < alignPos.length; i++) {
        for (let j = 0; j < alignPos.length; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === alignPos.length - 1) || (i === alignPos.length - 1 && j === 0)) continue;
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
        }
      }
      this.setFunctionModule(size - 8, 8, true);
    };

    QrCode.prototype.getAlignmentPatternPositions = function () {
      if (this.version === 1) return [];
      const numAlign = Math.floor(this.version / 7) + 2;
      const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 17 - 13) / (numAlign - 1));
      const result = [6];
      for (let i = 1; i < numAlign - 1; i++) result.push(this.size - 7 - (numAlign - 2 - i) * step);
      result.push(this.size - 7);
      return result;
    };

    QrCode.prototype.drawAlignmentPattern = function (x, y) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    };

    QrCode.prototype.setFunctionModule = function (x, y, isDark) {
      this.modules[y][x] = isDark;
      this.isFunction[y][x] = true;
    };

    QrCode.prototype.addEccAndInterleave = function (data) {
      const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.ecc][this.version - 1];
      const blockEccLen = ECC_CODEWORDS[this.ecc][this.version - 1];
      const rawCodewords = QrCode.getNumRawDataModules(this.version) / 8;
      const numShortBlocks = numBlocks - rawCodewords % numBlocks;
      const shortBlockLen = Math.floor(rawCodewords / numBlocks);
      const blocks = [];
      let k = 0;
      for (let i = 0; i < numBlocks; i++) {
        const datalen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
        const block = data.slice(k, k + datalen);
        k += datalen;
        const ecc = QrCode.reedSolomonCompute(block, blockEccLen);
        blocks.push(block.concat(ecc));
      }
      const result = [];
      for (let i = 0; i < blocks[0].length; i++) {
        for (let j = 0; j < blocks.length; j++) {
          if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
            if (i < blocks[j].length) result.push(blocks[j][i]);
          }
        }
      }
      return result;
    };

    QrCode.reedSolomonCompute = function (data, degree) {
      const result = new Array(degree).fill(0);
      for (const b of data) {
        const factor = b ^ result[0];
        result.shift();
        result.push(0);
        for (let i = 0; i < degree; i++) {
          result[i] ^= QrCode.reedSolomonMultiply(QrCode.reedSolomonComputeDivisor(degree)[i], factor);
        }
      }
      return result;
    };

    QrCode.reedSolomonComputeDivisor = function (degree) {
      let result = [1];
      for (let i = 0; i < degree; i++) {
        const next = [];
        for (let j = 0; j < result.length; j++) next[j] = QrCode.reedSolomonMultiply(result[j], 0x02);
        next.unshift(0);
        for (let j = 0; j < result.length; j++) next[j + 1] ^= result[j];
        result = next;
      }
      return result.slice(1);
    };

    QrCode.reedSolomonMultiply = function (x, y) {
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        if (((y >>> i) & 1) !== 0) z ^= x;
      }
      return z;
    };

    QrCode.prototype.drawCodewords = function (data) {
      let i = 0;
      for (let right = this.size - 1; right >= 1; right -= 2) {
        if (right === 6) right--;
        for (let vert = 0; vert < this.size; vert++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            const y = ((right + 1) & 2) === 0 ? this.size - 1 - vert : vert;
            if (!this.isFunction[y][x]) {
              const bit = ((data[Math.floor(i / 8)] >>> (7 - (i % 8))) & 1) !== 0;
              this.modules[y][x] = bit;
              i++;
            }
          }
        }
      }
    };

    QrCode.prototype.applyMask = function (mask) {
      for (let y = 0; y < this.size; y++) {
        for (let x = 0; x < this.size; x++) {
          if (!this.isFunction[y][x]) {
            const invert = mask === 0 ? (x + y) % 2 === 0
              : mask === 1 ? y % 2 === 0
                : mask === 2 ? x % 3 === 0
                  : mask === 3 ? (x + y) % 3 === 0
                    : mask === 4 ? (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
                      : mask === 5 ? (x * y) % 2 + (x * y) % 3 === 0
                        : mask === 6 ? ((x * y) % 2 + (x * y) % 3) % 2 === 0
                          : (x + y + (x * y) % 3) % 2 === 0;
            if (invert) this.modules[y][x] = !this.modules[y][x];
          }
        }
      }
    };

    QrCode.prototype.drawFormatBits = function (mask) {
      let data = (this.ecc << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, ((bits >>> i) & 1) !== 0);
      this.setFunctionModule(8, 7, ((bits >>> 6) & 1) !== 0);
      this.setFunctionModule(8, 8, ((bits >>> 7) & 1) !== 0);
      this.setFunctionModule(7, 8, ((bits >>> 8) & 1) !== 0);
      for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, ((bits >>> i) & 1) !== 0);
      for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
      for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, ((bits >>> i) & 1) !== 0);
    };

    QrCode.prototype.getPenaltyScore = function () {
      let result = 0;
      for (let y = 0; y < this.size; y++) {
        let runColor = false;
        let runLen = 0;
        for (let x = 0; x < this.size; x++) {
          const color = this.modules[y][x];
          if (color === runColor) {
            runLen++;
            if (runLen === 5) result += 3;
            else if (runLen > 5) result++;
          } else {
            runColor = color;
            runLen = 1;
          }
        }
      }
      for (let x = 0; x < this.size; x++) {
        let runColor = false;
        let runLen = 0;
        for (let y = 0; y < this.size; y++) {
          const color = this.modules[y][x];
          if (color === runColor) {
            runLen++;
            if (runLen === 5) result += 3;
            else if (runLen > 5) result++;
          } else {
            runColor = color;
            runLen = 1;
          }
        }
      }
      for (let y = 0; y < this.size - 1; y++) {
        for (let x = 0; x < this.size - 1; x++) {
          const c = this.modules[y][x];
          if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) result += 3;
        }
      }
      let dark = 0;
      for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (this.modules[y][x]) dark++;
      const total = this.size * this.size;
      const k = Math.abs(dark * 20 - total * 10) / total;
      result += k * 10;
      return result;
    };

    function QrSegment(modeBits, numChars, data) {
      this.modeBits = modeBits;
      this.numChars = numChars;
      this.data = data;
    }
    QrSegment.makeBytes = function (text) {
      const data = [];
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        for (let j = 7; j >= 0; j--) data.push((c >>> j) & 1);
      }
      return new QrSegment(0x4, text.length, data);
    };
    QrSegment.appendBits = function (val, len, out) {
      for (let i = len - 1; i >= 0; i--) out.push((val >>> i) & 1);
    };
    QrSegment.getTotalBits = function (segs, version) {
      let sum = 0;
      for (const seg of segs) {
        sum += 4 + QrSegment.numCharCountBits(seg.modeBits, version) + seg.data.length;
      }
      return sum;
    };
    QrSegment.numCharCountBits = function (modeBits, version) {
      if (modeBits === 0x4) return version < 10 ? 8 : version < 27 ? 16 : 16;
      return 8;
    };
    return { QrCode, QrSegment, Ecc };
  })();

  function renderQrToCanvas(text, canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!text) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.Ecc.MEDIUM);
    const scale = Math.floor(canvas.width / qr.size);
    const margin = Math.floor((canvas.width - qr.size * scale) / 2);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) {
          ctx.fillRect(margin + x * scale, margin + y * scale, scale, scale);
        }
      }
    }
  }

  let rpcFailureCount = 0;
  const RPC_BACKOFF_THRESHOLD = 3;

  function setRpcStatus(connected, balanceZero) {
    const el = document.getElementById('rpcStatus');
    if (!el) return;
    el.classList.toggle('connected', connected);
    el.querySelector('span:last-child').textContent = connected ? 'Connected' : 'Disconnected';
    updateBalanceRpcHint(!connected, balanceZero === true);
  }

  function updateBalanceRpcHint(disconnected, balanceZero) {
    const hintEl = document.getElementById('balanceRpcHint');
    if (!hintEl) return;
    if (disconnected) {
      hintEl.textContent = 'Local nodes only. Run USDmd (17750) and ./start-wallet-rpc.sh (27750), then Settings → Save or Refresh.';
      hintEl.classList.remove('hidden');
    } else if (balanceZero) {
      hintEl.textContent = 'Balance updates when the wallet syncs. Run USDmd, set Daemon URL in Settings, then click Refresh.';
      hintEl.classList.remove('hidden');
    } else {
      hintEl.textContent = '';
      hintEl.classList.add('hidden');
    }
  }

  function isNoWalletError(e) {
    const msg = (e && e.message) ? String(e.message) : '';
    return /no wallet file|wallet not open|not open/i.test(msg);
  }

  async function checkConnection(options = {}) {
    const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 25000;
    try {
      await rpc('get_version', {}, { timeoutMs: Math.min(timeoutMs, 10000) });
    } catch (e) {
      setRpcStatus(false);
      throw e;
    }
    try {
      const r = await rpc('get_balance', { account_index: 0, all_accounts: false, all_assets: false, asset_type: ASSET_USDM, strict: false }, { timeoutMs });
      setRpcStatus(true);
      return { ok: true, noWallet: false, balance: r };
    } catch (e) {
      if (isNoWalletError(e)) {
        setRpcStatus(true);
        return { ok: true, noWallet: true };
      }
      setRpcStatus(false);
      throw e;
    }
  }

  /** Read balance/unlocked_balance from a balance entry; supports snake_case and camelCase. */
  function readBalanceFromEntry(entry) {
    if (!entry) return { balance: 0n, unlocked_balance: 0n };
    const bal = entry.balance ?? entry.Balance ?? 0;
    const un = entry.unlocked_balance ?? entry.unlockedBalance ?? bal;
    return { balance: amountAsBigInt(bal), unlocked_balance: amountAsBigInt(un) };
  }

  /** Extract USDm balance only. Ignores XUSD and all other assets – dashboard shows USDm only. */
  function parseBalanceFromResult(result) {
    if (!result) return { balance: 0n, unlocked_balance: 0n };
    const list = Array.isArray(result.balances) ? result.balances : [];
    const usdmOnly = list.filter(e => {
      const a = String(e.asset_type || e.assetType || '').toUpperCase();
      return a === 'USDM';
    });
    if (usdmOnly.length > 0) {
      return readBalanceFromEntry(usdmOnly[0]);
    }
    if (list.length === 0 && (result.balance != null || result.unlocked_balance != null)) {
      return {
        balance: amountAsBigInt(result.balance ?? 0),
        unlocked_balance: amountAsBigInt(result.unlocked_balance != null ? result.unlocked_balance : result.balance ?? 0),
      };
    }
    return { balance: 0n, unlocked_balance: 0n };
  }

  // Balance from wallet RPC get_balance – USDm only. Wallet must be synced (click Refresh) for balance to match blockchain.
  async function refreshBalances() {
    try {
      const usdmResult = await rpc('get_balance', {
        account_index: 0,
        all_accounts: false,
        all_assets: false,
        asset_type: ASSET_USDM,
        strict: false,
      });
      let parsed = parseBalanceFromResult(usdmResult);
      let usedTransferFallback = false;
      if (parsed.balance === 0n && parsed.unlocked_balance === 0n) {
        try {
          const transfers = await rpc('get_transfers', { in: true, out: false, pending: false, pool: false }, { timeoutMs: 120000 });
          const inList = transfers.in || [];
          let sumIn = 0n;
          for (const t of inList) {
            const a = String(t.asset_type || t.assetType || '').trim().toLowerCase();
            if (a === 'usdm') sumIn += amountAsBigInt(t.amount);
          }
          if (sumIn > 0n) {
            parsed = { balance: sumIn, unlocked_balance: sumIn };
            usedTransferFallback = true;
            if (typeof console !== 'undefined' && console.log) console.log('Balance from get_transfers (in) fallback:', String(sumIn));
          }
        } catch (_) {}
      }
      if (typeof window !== 'undefined') window.__lastGetBalanceResult = usdmResult;
      if (typeof console !== 'undefined' && console.log) console.log('get_balance result', usdmResult, 'parsed', { balance: String(parsed.balance), unlocked_balance: String(parsed.unlocked_balance) });
      rpcFailureCount = 0;
      setRpcStatus(true);
      const usdmDisplay = parsed.unlocked_balance > 0n ? parsed.unlocked_balance : parsed.balance;
      const balanceUsdmEl = document.getElementById('balanceUsdm');
      if (balanceUsdmEl) balanceUsdmEl.textContent = formatAmount(usdmDisplay);
      const unlockedUsdmEl = document.getElementById('unlockedUsdm');
      if (unlockedUsdmEl) unlockedUsdmEl.textContent = '';
      saveStoredBalances(usdmDisplay);
      const hintEl = document.getElementById('balanceRpcHint');
      const debugEl = document.getElementById('balanceDebug');
      if (usedTransferFallback && balanceUsdmEl) {
        balanceUsdmEl.textContent = formatAmount(usdmDisplay) + ' (from history)';
      }
      if (hintEl) {
        if (usdmDisplay === 0n && !usedTransferFallback) {
          const addrLine = currentWalletAddress ? ' Wallet: ' + formatAddressShort(currentWalletAddress) + '.' : '';
          hintEl.textContent = 'Balance is 0. Set Daemon URL in Settings (same node as CLI), then click Refresh (↻). If still 0, try Rescan to rebuild wallet view.' + addrLine;
          hintEl.classList.remove('hidden');
          if (debugEl) { debugEl.textContent = 'Debug: __lastGetBalanceResult in Console.'; debugEl.classList.remove('hidden'); }
        } else {
          hintEl.textContent = usedTransferFallback ? 'Balance from transfer history (get_balance returned 0).' : '';
          hintEl.classList.toggle('hidden', !usedTransferFallback);
          if (debugEl) debugEl.classList.add('hidden');
        }
      }
      return usdmResult;
    } catch (e) {
      const noWallet = isNoWalletError(e);
      if (!noWallet) rpcFailureCount += 1;
      setRpcStatus(noWallet); // connected but no wallet = still show Connected
      const balanceUsdmEl = document.getElementById('balanceUsdm');
      if (balanceUsdmEl) balanceUsdmEl.textContent = '—';
      const unlockedUsdmEl = document.getElementById('unlockedUsdm');
      if (unlockedUsdmEl) unlockedUsdmEl.textContent = '';
      if (noWallet) {
        const hintEl = document.getElementById('balanceRpcHint');
        const debugEl = document.getElementById('balanceDebug');
        if (hintEl) {
          hintEl.textContent = 'No wallet open in the RPC. Use Import to restore from seed, or start USDm-wallet-rpc with --wallet-file=YourWallet.';
          hintEl.classList.remove('hidden');
        }
        if (debugEl) debugEl.classList.add('hidden');
      }
      if (rpcFailureCount >= RPC_BACKOFF_THRESHOLD) {
        stopBalanceRefreshInterval();
      }
      console.error('refreshBalances failed:', e);
    }
  }

  async function refreshAddress() {
    const qrCanvas = document.getElementById('receiveQrCanvas');
    const qrWrap = document.getElementById('receiveQrWrap');
    try {
      const result = await rpc('get_address', { account_index: 0 });
      const addr = result.address || result.addresses?.[0]?.address || '';
      currentWalletAddress = addr || '';
      document.getElementById('receiveAddress').textContent = addr || 'Connect wallet RPC in Settings';
      if (qrCanvas && qrWrap) {
        if (addr && !addr.startsWith('Connect')) {
          renderQrToCanvas(addr, qrCanvas);
          qrWrap.classList.remove('hidden');
        } else {
          renderQrToCanvas('', qrCanvas);
          qrWrap.classList.add('hidden');
        }
      }
    } catch (e) {
      currentWalletAddress = '';
      document.getElementById('receiveAddress').textContent = 'Connect wallet RPC in Settings';
      if (qrCanvas && qrWrap) {
        renderQrToCanvas('', qrCanvas);
        qrWrap.classList.add('hidden');
      }
    }
  }

  function formatAddressShort(addr) {
    if (!addr || addr.length < 12) return addr || '';
    return addr.slice(0, 6) + '…' + addr.slice(-6);
  }

  async function refreshTransfers() {
    const listEl = document.getElementById('historyList');
    const recentEl = document.getElementById('recentList');
    if (!listEl) return;
    try {
      const result = await rpc('get_transfers', {
        in: true,
        out: true,
        pending: true,
        pool: true,
      }, { timeoutMs: 120000 });
      const inList = result.in || [];
      const outList = result.out || [];
      const pendingList = result.pending || [];
      const poolList = result.pool || [];
      const all = [
        ...inList.map((t) => ({ ...t, type: 'in' })),
        ...outList.map((t) => ({ ...t, type: 'out' })),
        ...pendingList.map((t) => ({ ...t, type: 'pending' })),
        ...poolList.map((t) => ({ ...t, type: 'pool' })),
      ].sort((a, b) => (b.timestamp || b.unlock_time || 0) - (a.timestamp || a.unlock_time || 0));

      const typeFilter = (document.getElementById('historyType') || {}).value || 'all';
      let show = all;
      if (typeFilter === 'in') show = all.filter((t) => t.type === 'in');
      else if (typeFilter === 'out') show = all.filter((t) => t.type === 'out');
      else if (typeFilter === 'pending') show = all.filter((t) => t.type === 'pending' || t.type === 'pool');

      listEl.innerHTML =
        show.length === 0
          ? 'No transactions.'
          : show
              .slice(0, 50)
              .map(
                (t) =>
                  `<div class="history-item">
                    <span>${t.type === 'in' ? '↓' : t.type === 'out' ? '↑' : '◐'} ${formatAmount(t.amount)} ${t.asset_type || ASSET_USDM}</span>
                    <span class="text-muted">${t.txid ? t.txid.slice(0, 8) + '…' : ''}</span>
                  </div>`
              )
              .join('');

      if (recentEl) {
        recentEl.innerHTML =
          all.length === 0
            ? 'No recent transactions. Connect wallet RPC in Settings.'
            : all
                .slice(0, 5)
                .map(
                  (t) =>
                    `${t.type === 'in' ? '↓' : '↑'} ${formatAmount(t.amount)} ${t.asset_type || ASSET_USDM}`
                )
                .join(' • ');
      }
    } catch (e) {
      listEl.innerHTML = 'Connect wallet RPC in Settings and click Refresh.';
      if (recentEl) recentEl.innerHTML = 'No recent transactions. Connect wallet RPC in Settings.';
    }
  }

  function showMessage(id, text, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.toggle('success', !isError && text);
  }

  function bindNavigation() {
    const titles = {
      dashboard: 'Dashboard',
      send: 'Send',
      receive: 'Receive',
      swap: 'Swap',
      history: 'History',
      import: 'Import',
      settings: 'Settings',
    };
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
        const panel = document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1));
        if (panel) panel.classList.add('active');
        const titleEl = document.getElementById('pageTitle');
        if (titleEl) titleEl.textContent = titles[page] || page;
        if (page === 'dashboard') {
          applyStoredBalances();
          startBalanceRefreshInterval();
        }
      });
    });

    document.querySelectorAll('.quick-btn[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.goto;
        const navBtn = document.querySelector('.nav-btn[data-page="' + page + '"]');
        if (navBtn) navBtn.click();
      });
    });
  }

  function bindSwap() {
    const openBtn = document.getElementById('btnOpenSwap');
    const modal = document.getElementById('swapModal');
    const closeBtn = document.getElementById('swapModalClose');
    const backdrop = modal ? modal.querySelector('.modal-backdrop') : null;
    const fromSel = document.getElementById('swapFromAsset');
    const toSel = document.getElementById('swapToAsset');
    const flipBtn = document.getElementById('swapFlipBtn');
    const amountEl = document.getElementById('swapAmount');
    const amountLabel = document.getElementById('swapAmountLabel');
    const priceEl = document.getElementById('swapPrice');
    const quoteEl = document.getElementById('swapQuote');
    const usdmAddrGroup = document.getElementById('swapUsdmAddressGroup');
    const usdmAddrInput = document.getElementById('swapUsdmAddress');
    const payoutGroup = document.getElementById('swapPayoutAddressGroup');
    const payoutInput = document.getElementById('swapPayoutAddress');
    const payoutLabel = document.getElementById('swapPayoutLabel');
    const depositSection = document.getElementById('swapDepositSection');
    const depositAddressEl = document.getElementById('swapDepositAddress');
    const depositAmountEl = document.getElementById('swapDepositAmount');
    const qrCanvas = document.getElementById('swapQrCanvas');
    const statusEl = document.getElementById('swapStatus');
    const actionBtn = document.getElementById('swapActionBtn');
    const backendHint = document.getElementById('swapBackendHint');

    if (backendHint) backendHint.textContent = 'Swap backend: ' + getSwapBackendUrl();

    let lastPrice = null;
    let swapId = null;
    let pollTimer = null;
    let priceTimer = null;
    let swapMode = 'crypto_to_usdm';
    let swapAsset = 'BTC';
    let burnAddress = '';
    let depositAddress = '';
    let lastBurnTxHash = '';
    let ownerSecret = '';

    function saveActiveSwap() {
      if (!swapId) return;
      storageSet(ACTIVE_SWAP_STORAGE_KEY, JSON.stringify({
        swapId, burnAddress, depositAddress, lastBurnTxHash, ownerSecret, swapMode, swapAsset,
      }));
    }

    function loadActiveSwap() {
      try {
        const raw = storageGet(ACTIVE_SWAP_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_) { return null; }
    }

    function clearActiveSwap() {
      try { localStorage.removeItem(ACTIVE_SWAP_STORAGE_KEY); } catch (_) {}
    }

    function isCrypto(asset) {
      return asset === 'BTC' || asset === 'XMR';
    }

    function setStatus(text, type, opts) {
      if (!statusEl) return;
      if (opts && opts.html) {
        statusEl.innerHTML = text || '';
      } else {
        statusEl.textContent = text || '';
      }
      statusEl.classList.toggle('error', type === 'error');
      statusEl.classList.toggle('success', type === 'success');
    }

    function makeTxLink(txHash, label) {
      if (!txHash) return '';
      const short = txHash.slice(0, 8) + '…' + txHash.slice(-8);
      const displayLabel = label || short;
      // Link to the local explorer; falls back to hash display if no explorer configured
      const daemonUrl = getDaemonUrl().replace(/:\d+$/, '');
      const explorerBase = daemonUrl.replace(/:\d+$/, '') + ':8081';
      return '<a href="' + explorerBase + '/tx/' + txHash + '" target="_blank" rel="noopener" id="swapBurnTxLink" style="color:#4fc3f7;text-decoration:underline;cursor:pointer" title="View transaction">' + displayLabel + '</a>';
    }

    function openModal() {
      if (!modal) return;
      modal.classList.remove('hidden');
      if (usdmAddrInput && currentWalletAddress) usdmAddrInput.value = currentWalletAddress;
      updateBackendHint();

      // Try to restore an active swap (for resume)
      const saved = loadActiveSwap();
      if (saved && saved.swapId) {
        swapId = saved.swapId;
        burnAddress = saved.burnAddress || '';
        depositAddress = saved.depositAddress || '';
        lastBurnTxHash = saved.lastBurnTxHash || '';
        ownerSecret = saved.ownerSecret || '';
        swapMode = saved.swapMode || swapMode;
        swapAsset = saved.swapAsset || swapAsset;
        if (fromSel) fromSel.value = swapMode === 'usdm_to_crypto' ? 'USDm' : swapAsset;
        if (toSel) toSel.value = swapMode === 'usdm_to_crypto' ? swapAsset : 'USDm';
        normalizePair();
        // Set button to resume mode
        if (actionBtn) {
          actionBtn.textContent = swapMode === 'usdm_to_crypto' ? 'Resume burn & swap' : 'Resume swap';
          actionBtn.disabled = false;
        }
        setStatus('Active swap found. Checking status…');
        startPolling();
        pollSwapStatus(); // immediate check
      } else {
        resetSwapUi();
      }

      refreshPrice();
      if (priceTimer) clearInterval(priceTimer);
      priceTimer = setInterval(refreshPrice, 20000);
    }

    function closeModal() {
      if (!modal) return;
      modal.classList.add('hidden');
      stopPolling();
      if (priceTimer) clearInterval(priceTimer);
      priceTimer = null;
    }

    function updateBackendHint() {
      if (backendHint) backendHint.textContent = 'Swap backend: ' + getSwapBackendUrl();
    }

    function normalizePair() {
      const from = fromSel?.value || 'BTC';
      const to = toSel?.value || 'USDm';
      if (from === 'USDm' && to === 'USDm') {
        toSel.value = 'BTC';
      } else if (from !== 'USDm' && to !== 'USDm') {
        toSel.value = 'USDm';
      }
      swapMode = (from === 'USDm') ? 'usdm_to_crypto' : 'crypto_to_usdm';
      swapAsset = (from === 'USDm') ? toSel.value : fromSel.value;
      usdmAddrGroup?.classList.toggle('hidden', swapMode !== 'crypto_to_usdm');
      payoutGroup?.classList.toggle('hidden', swapMode !== 'usdm_to_crypto');
      if (payoutLabel) payoutLabel.textContent = 'Your ' + swapAsset + ' payout address';
      if (amountLabel) amountLabel.textContent = 'Amount (' + (swapMode === 'crypto_to_usdm' ? swapAsset : 'USDm') + ')';
    }

    function resetSwapUi() {
      swapId = null;
      burnAddress = '';
      depositAddress = '';
      lastBurnTxHash = '';
      ownerSecret = '';
      depositSection?.classList.add('hidden');
      depositAddressEl.textContent = '—';
      depositAmountEl.textContent = '—';
      renderQrToCanvas('', qrCanvas);
      setStatus('Ready.');
      if (actionBtn) actionBtn.disabled = false;
      if (actionBtn) actionBtn.textContent = swapMode === 'crypto_to_usdm' ? 'Generate swap' : 'Burn USDm & swap';
    }

    async function refreshPrice() {
      const asset = swapAsset;
      if (!isCrypto(asset)) {
        lastPrice = null;
        priceEl.textContent = '—';
        quoteEl.textContent = '—';
        return;
      }
      try {
        const data = await swapFetch('/api/price?asset=' + asset);
        lastPrice = Number(data && data.price_usd) || null;
        priceEl.textContent = lastPrice ? `$${lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} / ${asset}` : '—';
        updateQuote();
      } catch (e) {
        lastPrice = null;
        priceEl.textContent = 'Unavailable';
        setStatus('Price feed unavailable. Start the swap backend.', 'error');
      }
    }

    function updateQuote() {
      const raw = (amountEl?.value || '').trim();
      if (!raw || !lastPrice) {
        quoteEl.textContent = '—';
        return;
      }
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0) {
        quoteEl.textContent = '—';
        return;
      }
      if (swapMode === 'crypto_to_usdm') {
        const usdm = amount * lastPrice;
        quoteEl.textContent = `${usdm.toFixed(2)} USDm`;
      } else {
        const crypto = amount / lastPrice;
        const decimals = swapAsset === 'BTC' ? 8 : 12;
        quoteEl.textContent = `${crypto.toFixed(decimals)} ${swapAsset}`;
      }
    }

    async function createSwap() {
      const amountRaw = (amountEl?.value || '').trim();
      const amount = Number(amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount.');
      if (!lastPrice) throw new Error('Price feed unavailable.');

      if (swapMode === 'crypto_to_usdm') {
        const usdmAddr = (usdmAddrInput?.value || '').trim();
        if (!usdmAddr) throw new Error('Enter your USDm wallet address.');
        const res = await swapFetch('/api/swaps', {
          method: 'POST',
          body: {
            direction: 'crypto_to_usdm',
            asset: swapAsset,
            amount: amountRaw,
            usdmAddress: usdmAddr,
          },
        });
        swapId = res.swap_id;
        depositAddress = res.deposit_address;
        ownerSecret = res.owner_secret || '';
        saveActiveSwap();
        depositSection?.classList.remove('hidden');
        depositAddressEl.textContent = depositAddress;
        depositAmountEl.textContent = `Send ${amountRaw} ${swapAsset} to mint ${res.expected_usdm} USDm`;
        renderQrToCanvas(depositAddress, qrCanvas);
        setStatus('Waiting for deposit…');
        actionBtn.textContent = 'Waiting for deposit';
        actionBtn.disabled = true;
      } else {
        const payoutAddr = (payoutInput?.value || '').trim();
        if (!payoutAddr) throw new Error('Enter your payout address.');
        const res = await swapFetch('/api/swaps', {
          method: 'POST',
          body: {
            direction: 'usdm_to_crypto',
            asset: swapAsset,
            amount_usdm: amountRaw,
            payoutAddress: payoutAddr,
          },
        });
        swapId = res.swap_id;
        burnAddress = res.burn_address;
        ownerSecret = res.owner_secret || '';
        saveActiveSwap();
        setStatus('Preparing USDm burn…');
      }
    }

    async function submitBurn() {
      const amountRaw = (amountEl?.value || '').trim();
      const burnAtomic = parseDecimalToAtomic(amountRaw, 8);
      if (burnAtomic <= 0n) throw new Error('Enter a valid USDm amount.');
      if (!burnAddress) throw new Error('Burn address not available.');
      const dust = 1n;
      const amountAtomic = dust;
      const balance = await rpc('get_balance', { account_index: 0, all_accounts: false, all_assets: false, asset_type: ASSET_USDM, strict: false });
      const parsed = parseBalanceFromResult(balance);
      const available = parsed.unlocked_balance > 0n ? parsed.unlocked_balance : parsed.balance;
      if (available < burnAtomic + amountAtomic) {
        throw new Error('Insufficient USDm balance for burn.');
      }
      const res = await rpc('transfer', {
        destinations: [{ amount: Number(amountAtomic), burn_amount: Number(burnAtomic), address: burnAddress }],
        priority: 1,
        source_asset: ASSET_USDM,
        destination_asset: ASSET_USDM,
        get_tx_key: true,
        get_tx_hex: false,
        get_tx_metadata: false,
      });
      const burnBody = { tx_hash: res.tx_hash };
      if (ownerSecret) burnBody.owner_secret = ownerSecret;
      await swapFetch(`/api/swaps/${swapId}/burn`, { method: 'POST', body: burnBody });
      lastBurnTxHash = res.tx_hash;
      saveActiveSwap();
      setStatus('Burn submitted — ' + makeTxLink(res.tx_hash, 'View TX') + ' (waiting for confirmations)', '', { html: true });
      actionBtn.textContent = 'Waiting for burn confirmations…';
      actionBtn.disabled = true;
      return res.tx_hash;
    }

    async function pollSwapStatus() {
      if (!swapId) return;
      try {
        const res = await swapFetch(`/api/swaps/${swapId}`);
        if (!res) return;
        const status = res.status || '';
        const txHash = res.burn_tx || res.deposit_tx || lastBurnTxHash || '';
        const burnConf = res.burn_confirmations != null ? Number(res.burn_confirmations) : null;
        const burnReq = res.burn_confirmations_required != null ? Number(res.burn_confirmations_required) : null;
        const depConf = res.deposit_confirmations != null ? Number(res.deposit_confirmations) : null;
        const depReq = res.deposit_confirmations_required != null ? Number(res.deposit_confirmations_required) : null;

        if (status === 'awaiting_deposit') {
          if (depConf != null && depReq != null) {
            setStatus('Waiting for deposit confirmations (' + depConf + '/' + depReq + ')…');
          } else {
            setStatus('Waiting for deposit…');
          }
        } else if (status === 'deposit_confirmed') {
          const mintedTxLink = res.minted_tx ? ' — ' + makeTxLink(res.minted_tx, 'View mint TX') : '';
          setStatus('Deposit confirmed. Minting USDm…' + mintedTxLink, '', { html: !!mintedTxLink });
        } else if (status === 'minted') {
          const mintLink = res.minted_tx ? ' — ' + makeTxLink(res.minted_tx, 'View TX') : '';
          setStatus('USDm minted and sent!' + mintLink, 'success', { html: !!mintLink });
          stopPolling();
        } else if (status === 'awaiting_burn') {
          setStatus('Awaiting USDm burn.');
          if (actionBtn) {
            actionBtn.textContent = 'Resume burn & swap';
            actionBtn.disabled = false;
          }
        } else if (status === 'burn_submitted') {
          const confText = (burnConf != null && burnReq != null)
            ? ' (' + burnConf + '/' + burnReq + ' confirmations)'
            : '';
          const txLink = txHash ? ' — ' + makeTxLink(txHash, 'View TX') : '';
          setStatus('Burn submitted' + confText + txLink, '', { html: !!txLink });
          if (actionBtn) {
            actionBtn.textContent = 'Waiting for burn confirmations…';
            actionBtn.disabled = true;
          }
        } else if (status === 'burn_confirmed') {
          const txLink = txHash ? ' — ' + makeTxLink(txHash, 'View TX') : '';
          setStatus('Burn confirmed. Sending payout…' + txLink, '', { html: !!txLink });
        } else if (status === 'payout_sent') {
          const payoutLink = res.payout_tx ? ' — ' + makeTxLink(res.payout_tx, 'View payout TX') : '';
          setStatus('Payout sent!' + payoutLink, 'success', { html: !!payoutLink });
          stopPolling();
        } else if (status === 'failed') {
          setStatus(res.error || 'Swap failed.', 'error');
          stopPolling();
        }
      } catch (_) {}
    }

    function startPolling() {
      stopPolling();
      pollTimer = setInterval(pollSwapStatus, 6000);
    }

    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }

    async function handleSwapAction() {
      try {
        actionBtn.disabled = true;
        // Resume existing burn swap if swap already created but burn not yet submitted
        if (swapId && burnAddress && swapMode === 'usdm_to_crypto') {
          setStatus('Resuming burn…');
          await submitBurn();
          startPolling();
          return;
        }
        setStatus('Creating swap…');
        await createSwap();
        if (swapMode === 'usdm_to_crypto') {
          await submitBurn();
        }
        startPolling();
      } catch (e) {
        setStatus(e.message || 'Swap failed.', 'error');
        actionBtn.disabled = false;
      }
    }

    fromSel?.addEventListener('change', () => { normalizePair(); resetSwapUi(); refreshPrice(); updateQuote(); });
    toSel?.addEventListener('change', () => { normalizePair(); resetSwapUi(); refreshPrice(); updateQuote(); });
    amountEl?.addEventListener('input', updateQuote);
    flipBtn?.addEventListener('click', () => {
      const from = fromSel.value;
      const to = toSel.value;
      fromSel.value = to;
      toSel.value = from;
      normalizePair();
      resetSwapUi();
      refreshPrice();
      updateQuote();
    });
    actionBtn?.addEventListener('click', handleSwapAction);
    openBtn?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    backdrop?.addEventListener('click', closeModal);

    normalizePair();
  }

  function bindSend() {
    document.getElementById('btnSend')?.addEventListener('click', async () => {
      const address = document.getElementById('sendAddress').value.trim();
      const amountStr = document.getElementById('sendAmount').value.trim();
      const priority = parseInt(document.getElementById('sendPriority').value, 10) || 1;
      if (!address || !amountStr) {
        showMessage('sendMessage', 'Enter address and amount.', true);
        return;
      }
      const amount = Math.round(parseFloat(amountStr) * USDM_ATOMIC_UNIT);
      if (!(amount > 0)) {
        showMessage('sendMessage', 'Invalid amount.', true);
        return;
      }
      showMessage('sendMessage', 'Sending…');
      try {
        await rpc('transfer', {
          destinations: [{ amount: amount, address: address }],
          priority: priority,
          source_asset: ASSET_USDM,
          destination_asset: ASSET_USDM,
          get_tx_key: true,
          get_tx_hex: false,
          get_tx_metadata: false,
        });
        showMessage('sendMessage', 'Transaction submitted successfully.', false);
        document.getElementById('sendAddress').value = '';
        document.getElementById('sendAmount').value = '';
        await refreshBalances();
        await refreshTransfers();
      } catch (e) {
        showMessage('sendMessage', e.message || 'Send failed.', true);
      }
    });
  }

  function bindReceive() {
    document.getElementById('btnCopyAddress')?.addEventListener('click', () => {
      const addr = document.getElementById('receiveAddress').textContent;
      if (addr && !addr.startsWith('Connect')) {
        navigator.clipboard.writeText(addr);
        const btn = document.getElementById('btnCopyAddress');
        if (btn) {
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = 'Copy'), 2000);
        }
      }
    });
  }

  function bindSettings() {
    document.getElementById('rpcUrl').value = rpcUrl;
    const daemonEl = document.getElementById('daemonUrl');
    if (daemonEl) daemonEl.value = storageGet(DAEMON_URL_STORAGE_KEY) || DEFAULT_DAEMON_URL;
    const swapBackendEl = document.getElementById('swapBackendUrl');
    if (swapBackendEl) swapBackendEl.value = storageGet(SWAP_BACKEND_STORAGE_KEY) || DEFAULT_SWAP_BACKEND;
    document.getElementById('btnSaveRpc')?.addEventListener('click', async () => {
      const url = document.getElementById('rpcUrl').value.trim();
      const daemonUrl = (document.getElementById('daemonUrl') || {}).value.trim() || DEFAULT_DAEMON_URL;
      const swapBackendUrl = (document.getElementById('swapBackendUrl') || {}).value.trim() || DEFAULT_SWAP_BACKEND;
      setDaemonUrl(daemonUrl);
      setSwapBackendUrl(swapBackendUrl);
      const hint = document.getElementById('swapBackendHint');
      if (hint) hint.textContent = 'Swap backend: ' + getSwapBackendUrl();
      if (!url) return;
      setRpcUrl(url);
      rpcFailureCount = 0;
      showMessage('settingsMessage', 'Saved. Connecting…');
      try {
        const result = await checkConnection({ timeoutMs: 25000 });
        if (result.noWallet) {
          showMessage('settingsMessage', 'Connected. No wallet open — use Import to restore from seed or create a wallet.', false);
        } else {
          await configureWalletRpcMoneroStyle().catch(() => {});
          showMessage('settingsMessage', 'Connected. Daemon set; auto-refresh enabled (Monero-style).', false);
          await refreshBalances();
          await refreshAddress();
          await refreshTransfers();
          startBalanceRefreshInterval();
          rpc('refresh', { start_height: 0 }, { timeoutMs: 600000 })
            .then(() => { refreshBalances(); updateDashboardSyncInfo(); })
            .catch(() => {});
        }
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : 'Connection failed';
        showMessage('settingsMessage', msg.length > 60 ? msg.slice(0, 57) + '…' : msg, true);
      }
    });
  }

  async function runRescanBlockchain() {
    const btn = document.getElementById('btnRescan');
    if (btn) btn.disabled = true;
    showSyncStatus('Rescanning blockchain (rebuilding wallet view)…', true);
    try {
      await rpc('rescan_blockchain', { hard: false }, { timeoutMs: 300000 });
      showSyncStatus('Rescan done. Syncing from daemon…', true);
      await setDaemonAndRefresh(0, (msg) => showSyncStatus(msg, true));
      await refreshAddress();
      await refreshBalances();
      await refreshTransfers();
      updateDashboardSyncInfo();
      showSyncStatus('', false);
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : '';
      showSyncStatus('Rescan failed: ' + (msg.length > 50 ? msg.slice(0, 47) + '…' : msg), true);
      setTimeout(() => showSyncStatus('', false), 8000);
    }
    if (btn) btn.disabled = false;
  }

  function bindRefresh() {
    document.getElementById('btnRefresh')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnRefresh');
      if (btn) btn.disabled = true;
      showSyncStatus('Syncing USDm blockchain… Connecting to node…', true);
      let refreshError = '';
      try {
        const res = await setDaemonAndRefresh(0, (msg) => showSyncStatus(msg, true));
        showSyncStatus((res.blocks_fetched > 0 ? 'Fetched ' + res.blocks_fetched.toLocaleString() + ' blocks. ' : '') + 'Updating balance…', true);
      } catch (e) {
        refreshError = (e && e.message) ? String(e.message) : '';
        const short = refreshError.length > 50 ? refreshError.slice(0, 47) + '…' : refreshError;
        showSyncStatus(short ? 'Sync failed: ' + short + ' Start local USDm node (USDmd) and wallet RPC.' : 'Sync failed. Start USDmd and ./start-wallet-rpc.sh', true);
      }
      await refreshAddress();
      await refreshBalances();
      await refreshTransfers();
      updateDashboardSyncInfo();
      startBalanceRefreshInterval();
      setTimeout(async () => {
        await refreshBalances();
        updateDashboardSyncInfo();
      }, 2500);
      if (refreshError) setTimeout(() => showSyncStatus('', false), 8000);
      else showSyncStatus('', false);
      if (btn) btn.disabled = false;
    });
  }

  function bindHistoryFilter() {
    document.getElementById('historyType')?.addEventListener('change', refreshTransfers);
  }

  function bindDiagnostics() {
    document.getElementById('btnDiagnostics')?.addEventListener('click', async () => {
      const out = document.getElementById('diagnosticsOutput');
      if (!out) return;
      out.classList.remove('hidden');
      out.textContent = 'Running diagnostics…';
      const lines = [];
      const push = (label, value) => lines.push(label + (value != null ? ' ' + value : ''));
      const safeJson = (obj) => {
        try {
          const s = JSON.stringify(obj, null, 2);
          return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
        } catch (_) {
          return '[unserializable]';
        }
      };
      push('Time:', new Date().toISOString());
      push('Wallet RPC:', getRpcUrl());
      push('Daemon URL:', getDaemonUrl());
      try {
        const v = await rpc('get_version', {}, { timeoutMs: 8000 });
        push('get_version:', safeJson(v));
      } catch (e) {
        push('get_version error:', (e && e.message) ? e.message : String(e));
      }
      try {
        const r = await checkConnection({ timeoutMs: 15000 });
        push('wallet open:', r && !r.noWallet ? 'yes' : 'no');
      } catch (e) {
        push('wallet open:', 'unknown');
      }
      try {
        const s = await getSyncInfo();
        push('sync height:', (s.height || 0).toLocaleString() + ' / ' + (s.target_height || 0).toLocaleString());
      } catch (e) {
        push('sync height:', 'unknown');
      }
      try {
        const h = await rpc('get_height', {}, { timeoutMs: 8000 });
        push('wallet height:', h && h.height != null ? Number(h.height).toLocaleString() : 'unknown');
      } catch (e) {
        push('wallet height:', 'unknown');
      }
      try {
        const a = await rpc('get_address', { account_index: 0 }, { timeoutMs: 8000 });
        const addr = a?.address || a?.addresses?.[0]?.address || '';
        push('address:', addr ? formatAddressShort(addr) : 'unknown');
      } catch (e) {
        push('address:', 'unknown');
      }
      try {
        const b = await rpc('get_balance', { account_index: 0, all_accounts: false, all_assets: false, asset_type: ASSET_USDM, strict: false }, { timeoutMs: 15000 });
        const parsed = parseBalanceFromResult(b);
        const disp = parsed.unlocked_balance > 0n ? parsed.unlocked_balance : parsed.balance;
        push('USDm balance (atomic):', String(disp));
        push('get_balance raw:', safeJson(b));
      } catch (e) {
        push('get_balance error:', (e && e.message) ? e.message : String(e));
      }
      out.textContent = lines.join('\n');
    });
  }

  function bindImport() {
    const seedEl = document.getElementById('importSeed');
    const toggleBtn = document.getElementById('importSeedToggle');
    if (toggleBtn && seedEl) {
      toggleBtn.addEventListener('click', () => {
        const masked = seedEl.classList.toggle('masked');
        toggleBtn.textContent = masked ? 'Show' : 'Hide';
      });
    }

    document.getElementById('btnImport')?.addEventListener('click', async () => {
      const seedEl = document.getElementById('importSeed');
      const passwordEl = document.getElementById('importPassword');
      const languageEl = document.getElementById('importLanguage');
      const heightEl = document.getElementById('importRestoreHeight');
      const rawSeed = (seedEl?.value || '').trim();
      const seed = rawSeed.replace(/[\s,]+/g, ' ').trim();
      const password = (passwordEl?.value || '').trim();
      const language = (languageEl?.value || 'English').trim() || 'English';
      const restoreHeight = Math.max(0, parseInt(heightEl?.value, 10) || 0);

      if (!seed) {
        showMessage('importMessage', 'Enter your 25-word seed phrase.', true);
        return;
      }
      const wordCount = seed.split(/\s+/).length;
      if (wordCount !== 12 && wordCount !== 24 && wordCount !== 25) {
        showMessage('importMessage', 'Seed must be 12, 24, or 25 words (Monero/Haven use 25). You have ' + wordCount + ' words.', true);
        return;
      }

      showMessage('importMessage', 'Importing… (seed is not stored or logged)');
      // Abort any in-flight refresh/rescan so the wallet RPC server is free for import
      abortInflightRefreshes();
      // Flush the RPC queue so any long-running refresh doesn't block import
      rpcQueue = Promise.resolve();
      try {
        // Close any open wallet first (longer timeout in case server is finishing a request)
        await rpc('close_wallet', {}, { timeoutMs: 30000 }).catch(() => {});
        const filename = 'imported_' + Date.now() + '.wallet';
        const result = await rpc('restore_deterministic_wallet', {
          seed: seed,
          password: password,
          filename: filename,
          restore_height: restoreHeight,
          language: language,
          autosave_current: true,
        }, { timeoutMs: 120000 });
        if (seedEl) seedEl.value = '';
        if (passwordEl) passwordEl.value = '';
        const addr = result.address || '';
        setRpcStatus(true);
        showMessage('importMessage', 'Wallet restored. Syncing in background…', false);
        const dashboardBtn = document.querySelector('.nav-btn[data-page="dashboard"]');
        if (dashboardBtn) dashboardBtn.click();
        const balUsdm = document.getElementById('balanceUsdm');
        if (balUsdm) balUsdm.textContent = '…';
        showSyncStatus('Syncing in background. You can use the app; balance will update when sync completes.', true);
        function updateUsdmFromResult(r) {
          if (!r) return;
          const el = document.getElementById('balanceUsdm');
          if (!el) return;
          const { balance, unlocked_balance } = parseBalanceFromResult(r);
          const disp = unlocked_balance > 0n ? unlocked_balance : balance;
          el.textContent = formatAmount(disp);
          saveStoredBalances(disp);
        }
        (async function runSyncInBackground() {
          const daemonUrl = getDaemonUrl();
          let refreshOk = false;
          let setDaemonOk = false;
          let daemonReachable = false;
          try {
            await rpc('set_daemon', { address: daemonUrl, trusted: true }, { timeoutMs: 8000 });
            setDaemonOk = true;
            try {
              const hi = await rpc('get_height', {}, { timeoutMs: 5000 });
              daemonReachable = hi && (hi.height != null || hi.height === 0);
            } catch (_) {}
          } catch (e) {
            const msg = (e && e.message) ? String(e.message) : '';
            showSyncStatus('Could not connect to daemon. Start USDmd (port 17750), set Daemon URL in Settings to ' + daemonUrl + ', then click Refresh to sync.', true);
            showMessage('importMessage', 'Import complete. Daemon not connected: start USDmd, set Daemon URL in Settings (' + daemonUrl + '), then click Refresh to sync.', false);
          }
          if (setDaemonOk) {
            if (!daemonReachable) {
              showSyncStatus('Daemon set but node may be unreachable. Start USDmd (17750). If balance stays 0, click Refresh (↻) or Rescan.', true);
            }
            try {
              showSyncStatus('Syncing wallet to blockchain (this can take several minutes). Block height will appear below.', true);
              await rpc('refresh', { start_height: restoreHeight }, { timeoutMs: 600000 });
              refreshOk = true;
            } catch (e) {
              const msg = (e && e.message) ? String(e.message) : '';
              showSyncStatus('Sync failed or timed out: ' + (msg.length > 40 ? msg.slice(0, 37) + '…' : msg) + ' Click Refresh (↻) or Rescan to retry.', true);
              rpc('refresh', { start_height: 0 }, { timeoutMs: 600000 }).then(() => { refreshBalances(); updateDashboardSyncInfo(); }).catch(() => {});
            }
          }
          await new Promise(r => setTimeout(r, 3000));
          const fetchAndShowBalance = async () => {
            try {
              const r = await rpc('get_balance', { account_index: 0, all_accounts: false, all_assets: false, asset_type: ASSET_USDM, strict: false }, { timeoutMs: 15000 });
                updateUsdmFromResult(r);
              } catch (_) {
                try {
                  const r2 = await rpc('get_balance', { account_index: 0, all_accounts: false, all_assets: false, asset_type: ASSET_USDM, strict: false }, { timeoutMs: 15000 });
                updateUsdmFromResult(r2);
              } catch (_2) {
                const el = document.getElementById('balanceUsdm');
                if (el) { el.textContent = '—'; }
              }
            }
          };
          await fetchAndShowBalance();
          [3500, 8000, 15000].forEach(ms => setTimeout(fetchAndShowBalance, ms));
          await refreshAddress();
          await refreshTransfers();
          showSyncStatus('', false);
          const finalMsg = !setDaemonOk
            ? 'Import complete. Start USDmd (17750), set Daemon URL in Settings to ' + daemonUrl + ', then click Refresh to sync.'
            : refreshOk
              ? 'Wallet restored. Balance updated.'
              : 'Import complete. If balance stays 0: ensure USDmd is running and Daemon URL matches CLI (17750), click Refresh (↻), or Rescan to rebuild wallet view.';
          showMessage('importMessage', finalMsg, false);
        })().catch(() => {
          showSyncStatus('', false);
          showMessage('importMessage', 'Import complete. Click Refresh to sync.', false);
        });
        let pollCount = 0;
        let pollFailures = 0;
        let pollInterval = null;
        const startPollAfterMs = 4000;
        const pollEveryMs = 5000;
        setTimeout(() => {
          pollInterval = setInterval(async () => {
            pollCount += 1;
            try {
              const syncInfo = await getSyncInfo();
              if (syncInfo.target_height > 0) {
                showSyncStatus('Syncing… Block ' + (syncInfo.height || 0).toLocaleString() + ' / ' + syncInfo.target_height.toLocaleString() + '. Balance updates as sync completes.', true);
                showBlockProgress('Block ' + (syncInfo.height || 0).toLocaleString() + ' / ' + syncInfo.target_height.toLocaleString(), true);
              }
            } catch (_) {}
            try {
              const r = await refreshBalances();
              if (r) {
                updateUsdmFromResult(r);
                pollFailures = 0;
                setRpcStatus(true);
              }
            } catch (_) { pollFailures += 1; }
            try { await refreshAddress(); } catch (_) {}
            try { await refreshTransfers(); } catch (_) {}
            try { await updateDashboardSyncInfo(); } catch (_) {}
            if (pollCount >= 60 || pollFailures >= 10) {
              clearInterval(pollInterval);
              if (pollFailures >= 10) showSyncStatus('', false);
            }
          }, pollEveryMs);
          (async () => {
            try {
              const r = await refreshBalances();
              if (r) { updateUsdmFromResult(r); setRpcStatus(true); }
            } catch (_) {}
            try { await refreshAddress(); } catch (_) {}
            try { await refreshTransfers(); } catch (_) {}
            try { await updateDashboardSyncInfo(); } catch (_) {}
          })();
        }, startPollAfterMs);
      } catch (e) {
        const msg = e.message || 'Import failed.';
        let friendly = msg;
        if (/Electrum-style word list failed verification/i.test(msg)) {
          friendly = 'Seed verification failed. Check: all words spelled correctly, same language, no extra characters. Monero/Haven use 25 words; the last word is a checksum.';
        } else if (/timed out|abort/i.test(msg)) {
          friendly = 'Import timed out. The wallet RPC did not respond. Start it with: ./start-wallet-rpc.sh (from monerousd-desktop). Then try Import again.';
        } else if (/fetch|network|refused|unreachable/i.test(msg)) {
          friendly = 'Cannot reach the wallet RPC. Start it with: ./start-wallet-rpc.sh. If using the browser, also run: node server.js and open http://localhost:3000.';
        }
        showMessage('importMessage', friendly, true);
      }
    });
  }

  let balanceRefreshIntervalId = null;

  function startBalanceRefreshInterval() {
    if (balanceRefreshIntervalId != null) return;
    if (rpcFailureCount >= RPC_BACKOFF_THRESHOLD) return;
    balanceRefreshIntervalId = setInterval(() => {
      if (rpcFailureCount >= RPC_BACKOFF_THRESHOLD) return;
      const dashboard = document.getElementById('pageDashboard');
      if (dashboard && dashboard.classList.contains('active')) {
        checkConnection().then((r) => { if (r && !r.noWallet) refreshBalances(); }).catch(() => {});
      }
    }, 25000);
  }

  function stopBalanceRefreshInterval() {
    if (balanceRefreshIntervalId != null) {
      clearInterval(balanceRefreshIntervalId);
      balanceRefreshIntervalId = null;
    }
  }

  function init() {
    applyStoredBalances();
    bindNavigation();
    bindSwap();
    bindSend();
    bindReceive();
    bindImport();
    bindSettings();
    bindRefresh();
    bindRescan();
    bindDiagnostics();
    bindHistoryFilter();
    checkConnection()
      .then(async (r) => {
        if (r && !r.noWallet) {
          await configureWalletRpcMoneroStyle().catch(() => {});
          // Run one blockchain refresh in background (Monero-style) so balance updates; UI stays responsive.
          rpc('refresh', { start_height: 0 }, { timeoutMs: 600000 })
            .then(() => { refreshBalances(); updateDashboardSyncInfo(); })
            .catch(() => {});
        }
        await refreshAddress();
        await refreshBalances();
        await refreshTransfers();
        await updateDashboardSyncInfo();
        startBalanceRefreshInterval();
      })
      .catch(() => {});

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const dashboard = document.getElementById('pageDashboard');
        if (dashboard && dashboard.classList.contains('active')) {
          checkConnection().then((r) => { if (r && !r.noWallet) refreshBalances(); }).catch(() => {});
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
