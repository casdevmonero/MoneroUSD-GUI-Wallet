(function () {
  const RPC_STORAGE_KEY = 'monerousd_rpc_url';
  const BALANCE_STORAGE_KEY = 'monerousd_balance';
  const WALLET_BALANCE_MAP_KEY = 'monerousd_wallet_balance_map';
  const DAEMON_URL_STORAGE_KEY = 'monerousd_daemon_url';
  const LIGHT_WALLET_URL_KEY = 'monerousd_light_wallet_url';
  const LIGHT_WALLET_TOKEN_KEY = 'monerousd_light_wallet_token';
  const LIGHT_WALLET_ENABLED_KEY = 'monerousd_light_wallet_enabled';
  const SWAP_BACKEND_STORAGE_KEY = 'monerousd_swap_backend_url';
  const WALLET_LIST_KEY = 'monerousd_wallet_list'; // legacy — no longer used for storage
  const ACTIVE_WALLET_KEY = 'monerousd_active_wallet';
  const FIRST_WALLET_KEY = 'monerousd_first_wallet';
  const PRIMARY_WALLET_KEY = 'monerousd_primary_wallet'; // the onboarded wallet filename — used to scope addressbook
  const isBrowser = typeof window !== 'undefined' && !window.electronAPI;
  // Both browser and desktop default to relay. Desktop users can switch to local node.
  const _LH = 'localhost'; // local loopback for desktop node connections
  const RELAY_RPC_URL = isBrowser ? (window.location.origin || 'https://monerousd.org') : 'https://monerousd.org';
  const RELAY_DAEMON_URL = isBrowser ? (window.location.origin || 'https://monerousd.org') : 'https://monerousd.org';
  const LOCAL_RPC_URL = 'http://' + _LH + ':27750';
  const LOCAL_DAEMON_URL = 'http://' + _LH + ':17750';
  const DEFAULT_RPC = RELAY_RPC_URL;
  const DEFAULT_DAEMON_URL = RELAY_DAEMON_URL;
  const DEFAULT_SWAP_BACKEND = 'https://swap.monerousd.org';
  const LEGACY_SWAP_BACKEND = 'http://' + _LH + ':8787';
  const DEFAULT_EXPLORER_URL = 'https://explorer.monerousd.org';
  const BTC_EXPLORER_URL = 'https://mempool.space';
  const XMR_EXPLORER_URL = 'https://xmrchain.net';
  const BTC_RESERVE_ADDRESS = 'bc1qukurxzulh6h356ctnqudqz5kfna5g6ehrcqhn4';
  const XMR_RESERVE_ADDRESS = '49W1wHiiYPsSneF6f1umpJ2Gqgwx7xwVP6KH27Q7p5B8jXHVe8CgwDBEALHSMK9BREK3EqExsLXzmehzsJqGbHHw5XXHCwa';
  // Dashboard balance: USDm only. Never use XUSD or other assets for balance.
  const ASSET_USDM = 'USDm';
  // 1.0 USDm = 1e8 atomic units (8 decimal places, CRYPTONOTE_DISPLAY_DECIMAL_POINT = 8).
  const USDM_ATOMIC_UNIT = 1e8;
  const USDM_DECIMALS = 8;
  const SWAP_HISTORY_KEY = 'monerousd_swap_history';
  const walletPasswordCache = new Map();

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

  // HTML entity escaping — prevents XSS when interpolating external data into innerHTML
  function escHtml(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Get the block explorer TX URL for a given asset
  function getTxExplorerUrl(asset, txid) {
    if (!txid) return '';
    if (asset === 'BTC') return BTC_EXPLORER_URL + '/tx/' + txid;
    if (asset === 'XMR') return XMR_EXPLORER_URL + '/tx/' + txid;
    return DEFAULT_EXPLORER_URL + '/tx/' + txid; // USDm / default
  }

  // Build a clickable TX link for a given asset
  function txLink(asset, txid, opts) {
    if (!txid) return '';
    const safe = escHtml(txid);
    const url = getTxExplorerUrl(asset, safe);
    const label = (opts && opts.label) || (safe.slice(0, 12) + '…');
    const cls = (opts && opts.cls) || 'tx-link';
    return '<a href="' + url + '" target="_blank" rel="noopener" class="' + cls + '" title="View on explorer">' + label + '</a>';
  }

  // Clipboard helper — works on HTTP (non-secure) contexts via textarea fallback
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function sanitizeWalletName(name) {
    return String(name || '').trim();
  }

  function displayWalletLabel(index) {
    return `wallet ${index + 1}`;
  }

  function getPrimaryWallet() {
    return (storageGet(PRIMARY_WALLET_KEY) || '').trim();
  }

  function setPrimaryWallet(name) {
    storageSet(PRIMARY_WALLET_KEY, sanitizeWalletName(name));
  }

  // Wallet list is scoped per primary wallet so different seeds have isolated addressbooks
  function walletListStorageKey() {
    const primary = getPrimaryWallet();
    return primary ? WALLET_LIST_KEY + '_' + primary : WALLET_LIST_KEY;
  }

  function loadWalletList() {
    try {
      const raw = storageGet(walletListStorageKey());
      const list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) return [];
      const cleaned = list.map((v) => sanitizeWalletName(v)).filter((v) => v);
      const unique = [];
      cleaned.forEach((v) => {
        if (!unique.includes(v)) unique.push(v);
      });
      return unique;
    } catch (_) {
      return [];
    }
  }

  function saveWalletList(list) {
    storageSet(walletListStorageKey(), JSON.stringify(list));
  }

  function activeWalletStorageKey() {
    const primary = getPrimaryWallet();
    return primary ? ACTIVE_WALLET_KEY + '_' + primary : ACTIVE_WALLET_KEY;
  }

  function getActiveWalletName() {
    return (storageGet(activeWalletStorageKey()) || '').trim();
  }

  function setActiveWalletName(name) {
    storageSet(activeWalletStorageKey(), name ? String(name).trim() : '');
  }

  // --- Swap history persistence (keyed by wallet address) ---
  function loadSwapHistory() {
    try {
      const raw = storageGet(SWAP_HISTORY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function saveSwapHistory(history) {
    storageSet(SWAP_HISTORY_KEY, JSON.stringify(history));
  }

  function getSwapsForWallet(walletAddr) {
    if (!walletAddr) return [];
    const history = loadSwapHistory();
    return Array.isArray(history[walletAddr]) ? history[walletAddr] : [];
  }

  function saveSwapRecord(walletAddr, record) {
    if (!walletAddr || !record || !record.swap_id) return;
    const history = loadSwapHistory();
    if (!Array.isArray(history[walletAddr])) history[walletAddr] = [];
    const idx = history[walletAddr].findIndex((s) => s.swap_id === record.swap_id);
    if (idx >= 0) {
      history[walletAddr][idx] = { ...history[walletAddr][idx], ...record };
    } else {
      history[walletAddr].unshift(record);
    }
    // Keep last 50 swaps per wallet
    if (history[walletAddr].length > 50) history[walletAddr] = history[walletAddr].slice(0, 50);
    saveSwapHistory(history);
  }

  function firstWalletStorageKey() {
    const primary = getPrimaryWallet();
    return primary ? FIRST_WALLET_KEY + '_' + primary : FIRST_WALLET_KEY;
  }

  function getFirstWalletName() {
    return (storageGet(firstWalletStorageKey()) || '').trim();
  }

  function setFirstWalletName(name) {
    const trimmed = sanitizeWalletName(name);
    if (!trimmed) return;
    storageSet(firstWalletStorageKey(), trimmed);
    upsertWalletName(trimmed);
  }

  function ensureFirstWalletName() {
    if (getFirstWalletName()) return true;
    const fallback = getActiveWalletName() || 'wallet1';
    setFirstWalletName(fallback);
    if (!getActiveWalletName()) setActiveWalletName(fallback);
    return true;
  }

  function getNextWalletName() {
    const list = loadWalletList();
    const names = [...new Set(['wallet1', ...list])];
    let max = 1;
    names.forEach((name) => {
      const match = /^wallet(\d+)$/i.exec(String(name || '').trim());
      if (match) {
        const n = parseInt(match[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    });
    return `wallet${max + 1}`;
  }

  function isWalletExistsError(msg) {
    return /exists|already exists|file exists|eexist/i.test(String(msg || ''));
  }

  async function createUniqueWallet() {
    ensureFirstWalletName();
    const base = getNextWalletName();
    const startMatch = /^wallet(\d+)$/i.exec(base);
    const startNum = startMatch ? parseInt(startMatch[1], 10) : 2;
    for (let i = 0; i < 25; i += 1) {
      const filename = `wallet${startNum + i}`;
      try {
        await rpcImmediate('create_wallet', { filename, password: '', language: 'English' }, { timeoutMs: 30000 });
        return filename;
      } catch (e) {
        const msg = e && e.message ? e.message : '';
        if (isWalletExistsError(msg)) {
          upsertWalletName(filename);
          continue;
        }
        throw e;
      }
    }
    throw new Error('No available wallet name');
  }

  function upsertWalletName(name) {
    const trimmed = sanitizeWalletName(name);
    if (!trimmed) return [];
    const list = loadWalletList();
    if (!list.includes(trimmed)) list.push(trimmed);
    saveWalletList(list);
    return list;
  }

  function removeWalletName(name) {
    const trimmed = sanitizeWalletName(name);
    const list = loadWalletList().filter((v) => v !== trimmed);
    saveWalletList(list);
    if (getActiveWalletName() === trimmed) setActiveWalletName('');
    return list;
  }

  function getOrderedWalletList() {
    const list = loadWalletList();
    const first = getFirstWalletName();
    const ordered = [];
    if (first) ordered.push(first);
    list.forEach((name) => {
      if (!ordered.includes(name)) ordered.push(name);
    });
    return ordered;
  }

  // Default both browser and desktop to relay URLs.
  // Migrate any old localhost defaults to relay (users who explicitly set custom
  // localhost URLs can re-enter them via "Use custom node" toggle).
  if (isBrowser) {
    // Browser: always reset to relay origin on each load (no caching between sessions)
    storageSet(RPC_STORAGE_KEY, DEFAULT_RPC);
    storageSet(DAEMON_URL_STORAGE_KEY, DEFAULT_DAEMON_URL);
  } else {
    // Desktop: migrate old localhost defaults to relay; preserve intentional custom URLs
    const storedRpc = storageGet(RPC_STORAGE_KEY) || '';
    const storedDaemon = storageGet(DAEMON_URL_STORAGE_KEY) || '';
    if (!storedRpc || storedRpc === LOCAL_RPC_URL) {
      storageSet(RPC_STORAGE_KEY, DEFAULT_RPC);
    }
    if (!storedDaemon || storedDaemon === LOCAL_DAEMON_URL) {
      storageSet(DAEMON_URL_STORAGE_KEY, DEFAULT_DAEMON_URL);
    }
  }
  let rpcUrl = storageGet(RPC_STORAGE_KEY) || DEFAULT_RPC;
  let currentWalletAddress = '';
  const storedSwapBackend = storageGet(SWAP_BACKEND_STORAGE_KEY);
  if (!storedSwapBackend || storedSwapBackend === LEGACY_SWAP_BACKEND) {
    storageSet(SWAP_BACKEND_STORAGE_KEY, DEFAULT_SWAP_BACKEND);
  }
  if (!storageGet(LIGHT_WALLET_ENABLED_KEY)) storageSet(LIGHT_WALLET_ENABLED_KEY, 'false');

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
    // Use rpcImmediate to avoid getting stuck behind long-running queued requests
    try {
      const r = await rpcImmediate('get_height', {}, { timeoutMs: 10000 });
      if (r && r.height != null)
        return { height: Number(r.height) || 0, target_height: 0 };
    } catch (_) {}
    return { height: 0, target_height: 0 };
  }

  // Configure wallet RPC: enable periodic blockchain refresh so balance updates.
  // Note: skip set_daemon — wallet-rpc already has --daemon-address from startup.
  // Calling set_daemon on a freshly restored/opened wallet triggers a blocking
  // background sync that freezes all subsequent RPC calls.
  const AUTO_REFRESH_PERIOD_SEC = 10;
  async function configureWalletRpcMoneroStyle() {
    try {
      await rpcImmediate('auto_refresh', { enable: true, period: AUTO_REFRESH_PERIOD_SEC }, { timeoutMs: 5000 });
    } catch (e) {
      if (e && !/restricted|denied|unavailable/i.test(String(e.message))) console.warn('auto_refresh:', e);
    }
  }

  // Get daemon blockchain height via wallet RPC get_height (proxied through server).
  async function getDaemonHeight() {
    try {
      const r = await rpcImmediate('get_height', {}, { timeoutMs: 5000 });
      return Number(r && r.height) || 0;
    } catch (_) {
      return 0;
    }
  }

  // Cancellation token for background syncs — set to true to abort any running incrementalRefresh
  let syncCancelled = false;
  function cancelBackgroundSync() { syncCancelled = true; }

  // Incremental refresh: call wallet RPC refresh in short bursts, reporting progress.
  // This avoids timeout on large chains and keeps the UI responsive.
  async function incrementalRefresh(startHeight, onProgress, options = {}) {
    syncCancelled = false;
    const BATCH_TIMEOUT = 15000;
    const maxTime = options.maxTimeMs || 600000;
    const began = Date.now();
    let totalFetched = 0;
    let walletHeight = startHeight || 0;
    const daemonHeight = await getDaemonHeight() || 1;

    while (Date.now() - began < maxTime) {
      if (syncCancelled) return { ok: false, blocks_fetched: totalFetched, cancelled: true };
      try {
        const res = await rpcImmediate('refresh', { start_height: walletHeight }, { timeoutMs: BATCH_TIMEOUT });
        if (syncCancelled) return { ok: false, blocks_fetched: totalFetched, cancelled: true };
        const fetched = (res && res.blocks_fetched != null) ? res.blocks_fetched : 0;
        totalFetched += fetched;
        // Get updated wallet height
        const hi = await rpcImmediate('get_height', {}, { timeoutMs: 5000 }).catch(() => null);
        walletHeight = (hi && hi.height) ? Number(hi.height) : walletHeight + fetched;
        const pct = daemonHeight > 0 ? Math.min(100, Math.round((walletHeight / daemonHeight) * 100)) : 0;
        if (onProgress) onProgress('Syncing… ' + walletHeight.toLocaleString() + ' / ' + daemonHeight.toLocaleString() + ' blocks (' + pct + '%)');
        // If we fetched 0 or wallet caught up, we're done
        if (fetched === 0 || walletHeight >= daemonHeight) break;
      } catch (e) {
        if (syncCancelled) return { ok: false, blocks_fetched: totalFetched, cancelled: true };
        const msg = String((e && e.message) || '');
        // Timeout is expected for large batches — just continue
        if (/timed out|abort/i.test(msg)) {
          const hi = await rpcImmediate('get_height', {}, { timeoutMs: 5000 }).catch(() => null);
          walletHeight = (hi && hi.height) ? Number(hi.height) : walletHeight;
          const pct = daemonHeight > 0 ? Math.min(100, Math.round((walletHeight / daemonHeight) * 100)) : 0;
          if (onProgress) onProgress('Syncing… ' + walletHeight.toLocaleString() + ' / ' + daemonHeight.toLocaleString() + ' blocks (' + pct + '%)');
          continue;
        }
        // If wallet was closed (switch in progress), stop silently
        if (/no wallet|not open/i.test(msg)) return { ok: false, blocks_fetched: totalFetched, cancelled: true };
        throw e;
      }
    }
    return { ok: true, blocks_fetched: totalFetched };
  }

  async function setDaemonAndRefresh(startHeight, onProgress, options = {}) {
    // Skip set_daemon — wallet-rpc already has --daemon-address from startup.
    // Calling set_daemon on a freshly restored wallet triggers a blocking background
    // sync that freezes all subsequent RPC calls.
    if (onProgress) onProgress('Syncing…');
    return incrementalRefresh(startHeight, onProgress, options);
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

  function loadBalanceMap() {
    try {
      const raw = storageGet(WALLET_BALANCE_MAP_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch (_) {
      return {};
    }
  }

  function saveBalanceMap(map) {
    storageSet(WALLET_BALANCE_MAP_KEY, JSON.stringify(map || {}));
  }

  function setStoredBalanceForWallet(walletName, usdmAtomic) {
    if (!walletName) return;
    const map = loadBalanceMap();
    map[walletName] = usdmAtomic != null ? String(usdmAtomic) : map[walletName];
    saveBalanceMap(map);
  }

  function getStoredBalanceForWallet(walletName) {
    if (!walletName) return null;
    const map = loadBalanceMap();
    return map[walletName] != null ? map[walletName] : null;
  }

  function saveStoredBalances(usdmAtomic) {
    try {
      const cur = loadStoredBalances();
      const data = { usdm: usdmAtomic != null ? String(usdmAtomic) : cur.usdm };
      storageSet(BALANCE_STORAGE_KEY, JSON.stringify(data));
      const active = getActiveWalletName();
      if (active) setStoredBalanceForWallet(active, usdmAtomic);
    } catch (_) {}
  }

  function setBalanceDisplayAtomic(amountAtomic) {
    const usdmEl = document.getElementById('balanceUsdm');
    if (!usdmEl) return;
    const amt = amountAtomic != null ? amountAtomic : 0n;
    usdmEl.textContent = '$' + formatAmount(amt);
  }

  function updateSendBalanceHint(rawInput) {
    const el = document.getElementById('sendBalanceHint');
    if (!el) return;
    const available = lastUsdmBalanceAtomic || 0n;
    let message = 'Available: $' + formatAmount(available);
    let isError = false;
    const raw = (rawInput || '').trim();
    if (raw) {
      const amt = parseDecimalToAtomic(raw, USDM_DECIMALS);
      if (amt > 0n) {
        if (amt > available) {
          const diff = amt - available;
          message += ' • Short by $' + formatAmount(diff);
          isError = true;
        } else {
          const remaining = available - amt;
          message += ' • Remaining $' + formatAmount(remaining);
        }
      }
    }
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.toggle('success', !isError);
  }

  function applyStoredBalances() {
    const usdmEl = document.getElementById('balanceUsdm');
    const active = getActiveWalletName();
    if (!active) {
      setBalanceDisplayAtomic(0n);
      return;
    }
    const stored = active ? getStoredBalanceForWallet(active) : null;
    if (stored != null && stored !== '') {
      setBalanceDisplayAtomic(stored);
      return;
    }
    const cur = loadStoredBalances();
    const val = cur.usdm != null && cur.usdm !== '' ? cur.usdm : null;
    if (val != null && amountAsBigInt(val) !== 0n) setBalanceDisplayAtomic(val);
    else if (usdmEl) usdmEl.textContent = '$0.00';
  }

  function applyStoredBalanceForWallet(walletName) {
    const stored = getStoredBalanceForWallet(walletName);
    if (stored != null && stored !== '') {
      setBalanceDisplayAtomic(stored);
    } else {
      setBalanceDisplayAtomic(0n);
    }
  }

  function showSyncStatus(text, visible) {
    const el = document.getElementById('syncStatusBanner');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !visible || !text);
  }

  function showBlockProgress(_text, _visible) {}

  async function refreshDashboardReserveRatio() {
    // Reserve ratio is internal — not shown to users
  }

  async function updateDashboardSyncInfo() {
    try {
      const info = await getSyncInfo();
      showBlockProgress('', false);
      if (info.height > 0) {
        // Wallet has synced blocks — daemon is reachable
        showSyncStatus('', false);
        return;
      }
      // Height is 0 — check if daemon itself is reachable before showing error
      try {
        const resp = await fetch('/daemon_rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info', params: {} }),
        });
        const data = await resp.json();
        if (data && data.result && data.result.height > 0) {
          // Daemon is running fine — wallet just hasn't synced yet
          showSyncStatus('Daemon connected (height ' + data.result.height + '). Click Refresh to sync wallet.', true);
          return;
        }
      } catch (_) {}
      showSyncStatus(isBrowser
        ? 'Not connected to daemon. The server may be syncing — try clicking Refresh in a moment.'
        : 'Not connected to daemon. Set Daemon URL in Settings, start USDmd, then click Refresh.', true);
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

  function getLightWalletConfig() {
    const urlEl = document.getElementById('lightWalletUrl');
    const tokenEl = document.getElementById('lightWalletToken');
    const enabledEl = document.getElementById('lightWalletEnabled');
    const storedUrl = storageGet(LIGHT_WALLET_URL_KEY) || '';
    const storedToken = storageGet(LIGHT_WALLET_TOKEN_KEY) || '';
    const storedEnabled = storageGet(LIGHT_WALLET_ENABLED_KEY) === 'true';
    const url = (urlEl ? urlEl.value.trim() : '') || storedUrl;
    const token = (tokenEl ? tokenEl.value.trim() : '') || storedToken;
    const enabled = enabledEl ? !!enabledEl.checked : storedEnabled;
    return { url, token, enabled: enabled && !!url };
  }

  function setLightWalletConfig(url, token, enabled) {
    if (url != null) storageSet(LIGHT_WALLET_URL_KEY, url);
    if (token != null) storageSet(LIGHT_WALLET_TOKEN_KEY, token);
    storageSet(LIGHT_WALLET_ENABLED_KEY, enabled ? 'true' : 'false');
    const urlEl = document.getElementById('lightWalletUrl');
    const tokenEl = document.getElementById('lightWalletToken');
    const enabledEl = document.getElementById('lightWalletEnabled');
    if (urlEl) urlEl.value = url || '';
    if (tokenEl) tokenEl.value = token || '';
    if (enabledEl) enabledEl.checked = !!enabled;
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
    // Browser mode: session routing handled by cookies — no extra header needed
    // Desktop mode: direct localhost connection — no header needed
    return { 'Content-Type': 'application/json' };
  }

  const LOCAL_NODE_HINT = ' Local nodes only: run USDmd (port 17750) and ./start-wallet-rpc.sh (port 27750). No public Haven nodes.';

  function networkErrorHint() {
    const isBrowser = typeof window !== 'undefined' && !window.electronAPI;
    if (isBrowser) {
      return ' The wallet server may be temporarily unavailable. Try refreshing the page or check back shortly.';
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
  let importInFlight = false;
  let switchInFlight = false;
  let autoRefreshSuspended = false;

  async function rpc(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs;
    const rpcUrl = getRpcUrl();
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

  function suspendAutoRefresh() {
    autoRefreshSuspended = true;
    stopBalanceRefreshInterval();
  }

  function resumeAutoRefresh() {
    autoRefreshSuspended = false;
    startBalanceRefreshInterval();
  }

  async function rpcViaLightWallet(light, method, params, timeoutMs) {
    const base = light.url.replace(/\/$/, '');
    const controller = timeoutMs ? new AbortController() : null;
    let timeoutId;
    if (controller && timeoutMs) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (light.token) headers.Authorization = 'Bearer ' + light.token;
      const res = await fetch(base + '/json_rpc', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
        signal: controller ? controller.signal : undefined,
      });
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
        const msg = (data.error && (data.error.message || data.error)) || ('Light wallet error: ' + res.status);
        throw new Error(String(msg));
      }
      if (data.error) throw new Error(data.error.message || 'Light wallet RPC error');
      return data.result;
    } catch (e) {
      const isAbort = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
      if (isAbort) throw new Error('Light wallet timed out.');
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function rpcUnqueued(method, params, options, timeoutMs, rpcUrl) {
    let lastErr;
    for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt++) {
      try {
        const light = getLightWalletConfig();
        if (light.enabled) {
          return await rpcViaLightWallet(light, method, params, timeoutMs || 30000);
        }
        if (typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.invokeRpc === 'function') {
          return await window.electronAPI.invokeRpc(rpcUrl, method, params, timeoutMs || 30000);
        }

        const url = getFetchUrl();
        const controller = timeoutMs ? new AbortController() : null;
        let timeoutId;
        if (controller && timeoutMs) {
          timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        }
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
            signal: controller ? controller.signal : undefined,
          });
        } catch (e) {
          if (timeoutId) clearTimeout(timeoutId);
          const isAbort = (e && (e.name === 'AbortError' || /abort/i.test(String(e.message))));
          if (isAbort) {
            throw new Error('Request timed out.' + networkErrorHint());
          }
          throw e;
        }
        if (timeoutId) clearTimeout(timeoutId);
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
          const hint502 = isBrowser ? ' The wallet server may be temporarily unavailable.' : LOCAL_NODE_HINT;
          if (res.status === 502 && attempt < RPC_RETRY_ATTEMPTS && isRetryableRpcError(msg, 502)) {
            lastErr = new Error(msg + hint502);
            await new Promise(r => setTimeout(r, RPC_RETRY_DELAY_MS));
            continue;
          }
          throw new Error(msg + (res.status === 502 ? hint502 : ''));
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

  async function rpcImmediate(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs;
    const rpcUrl = getRpcUrl();
    return rpcUnqueued(method, params, options, timeoutMs, rpcUrl);
  }

  // Single-attempt RPC call — no retries. Use for long-running ops like restore.
  async function rpcNoRetry(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs || 120000;
    const rpcUrl = getRpcUrl();
    const url = getFetchUrl();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url + '/json_rpc', {
        method: 'POST',
        headers: getRpcHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
      if (!res.ok) throw new Error((data.error && data.error.message) || 'RPC error: ' + res.status);
      if (data.error) throw new Error(data.error.message || 'RPC error');
      return data.result;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e && e.name === 'AbortError') throw new Error('Request timed out.');
      throw e;
    }
  }

  async function openWalletByName(filename, passwordHint = '') {
    const name = sanitizeWalletName(filename);
    let password = String(passwordHint || '');
    if (!password && walletPasswordCache.has(name)) password = walletPasswordCache.get(name);
    const tryOpen = async (pw) => {
      await rpcImmediate('close_wallet', {}, { timeoutMs: 8000 }).catch(() => {});
      // Brief pause after close to let wallet-rpc finish saving before opening next wallet
      await new Promise((ok) => setTimeout(ok, 100));
      await rpcImmediate('open_wallet', { filename: name, password: pw || '' }, { timeoutMs: 15000 });
      if (pw) walletPasswordCache.set(name, pw);
    };
    try {
      await tryOpen(password);
      return;
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : '';
      if (/invalid password|password required|wrong password/i.test(msg)) {
        const entered = typeof window !== 'undefined' && window.prompt
          ? window.prompt('Enter password for ' + name + ':', '')
          : '';
        if (entered != null && String(entered).length >= 0) {
          await tryOpen(String(entered));
          return;
        }
      }
      throw e;
    }
  }

  async function swapFetch(path, options = {}) {
    const base = getSwapBackendUrl().replace(/\/$/, '');
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

  function updateSwapUsdmBalanceDisplay() {
    const el = document.getElementById('swapUsdmBalance');
    if (!el) return;
    const val = lastUsdmBalanceAtomic > 0n ? formatAmount(lastUsdmBalanceAtomic) : '—';
    el.textContent = 'USDm balance: ' + val;
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
    const minSize = 160;
    const scale = Math.max(1, Math.floor(minSize / qr.size));
    const size = Math.max(minSize, qr.size * scale + 8);
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const margin = Math.max(4, Math.floor((canvas.width - qr.size * scale) / 2));
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
  let lastUsdmBalanceAtomic = 0n;
  let refreshInFlight = false;
  let lastRefreshAttemptAt = 0;

  function setRpcStatus(connected, balanceZero) {
    const el = document.getElementById('rpcStatus');
    if (!el) return;
    el.classList.toggle('connected', connected);
    el.querySelector('span:last-child').textContent = connected ? 'Connected' : 'Disconnected';
    updateBalanceRpcHint(!connected, balanceZero === true);
  }

  function updateBalanceRpcHint(disconnected, balanceZero) {
    return;
  }

  function isNoWalletError(e) {
    const msg = (e && e.message) ? String(e.message) : '';
    return /no wallet file|wallet not open|not open/i.test(msg);
  }

  async function checkConnection(options = {}) {
    const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 15000;
    try {
      await rpc('get_version', {}, { timeoutMs: Math.min(timeoutMs, 8000) });
    } catch (e) {
      setRpcStatus(false);
      throw e;
    }
    try {
      await rpc('get_address', { account_index: 0 }, { timeoutMs: Math.min(timeoutMs, 8000) });
      setRpcStatus(true);
      return { ok: true, noWallet: false };
    } catch (e) {
      if (isNoWalletError(e)) {
        setRpcStatus(true);
        setActiveWalletName('');
        lastUsdmBalanceAtomic = 0n;
        setBalanceDisplayAtomic(0n);
        updateSwapUsdmBalanceDisplay();
        document.dispatchEvent(new Event('swapBalanceUpdated'));
        return { ok: true, noWallet: true };
      }
      // Wallet may be busy; still treat as connected to avoid hanging UI.
      setRpcStatus(true);
      return { ok: true, noWallet: false, addressError: (e && e.message) ? String(e.message) : 'address error' };
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
    if (result.total_balance != null || result.total_unlocked_balance != null) {
      return {
        balance: amountAsBigInt(result.total_balance ?? 0),
        unlocked_balance: amountAsBigInt(result.total_unlocked_balance != null ? result.total_unlocked_balance : result.total_balance ?? 0),
      };
    }
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

  async function fetchUsdmBalance() {
    const primary = await rpc('get_balance', {
      account_index: 0,
      all_accounts: false,
      all_assets: false,
      asset_type: ASSET_USDM,
      strict: false,
    });
    let parsed = parseBalanceFromResult(primary);
    let raw = primary;
    let source = 'get_balance';
    if (parsed.balance === 0n && parsed.unlocked_balance === 0n) {
      try {
        const allAssets = await rpc('get_balance', {
          account_index: 0,
          all_accounts: false,
          all_assets: true,
          asset_type: ASSET_USDM,
          strict: false,
        });
        const parsedAll = parseBalanceFromResult(allAssets);
        if (parsedAll.balance > 0n || parsedAll.unlocked_balance > 0n) {
          parsed = parsedAll;
          raw = allAssets;
          source = 'get_balance(all_assets)';
        }
      } catch (_) {}
    }
    if (parsed.balance === 0n && parsed.unlocked_balance === 0n) {
      try {
        const accounts = await rpc('get_accounts', { tag: '', strict_balances: false, regexp: false });
        const parsedAccounts = parseBalanceFromResult(accounts);
        if (parsedAccounts.balance > 0n || parsedAccounts.unlocked_balance > 0n) {
          parsed = parsedAccounts;
          raw = accounts;
          source = 'get_accounts';
        }
      } catch (_) {}
    }
    return { parsed, raw, source };
  }

  let lastIncomingUsdmTotals = null;
  let lastIncomingUsdmAt = 0;

  async function fetchIncomingUsdmTotals(options = {}) {
    const now = Date.now();
    const minAgeMs = options.minAgeMs != null ? options.minAgeMs : 15000;
    const force = options.force === true;
    if (!force && lastIncomingUsdmTotals && now - lastIncomingUsdmAt < minAgeMs) return lastIncomingUsdmTotals;
    const incoming = await rpc('incoming_transfers', { transfer_type: 'all' });
    const list = incoming.transfers || [];
    let total = 0n;
    let unlocked = 0n;
    for (const t of list) {
      const a = String(t.asset_type || t.assetType || '').trim().toLowerCase();
      if (a !== 'usdm') continue;
      const amt = amountAsBigInt(t.amount);
      total += amt;
      if (t.unlocked === true) unlocked += amt;
    }
    lastIncomingUsdmTotals = { total, unlocked, count: list.length };
    lastIncomingUsdmAt = now;
    return lastIncomingUsdmTotals;
  }

  // Balance from wallet RPC get_balance – USDm only. Wallet must be synced (click Refresh) for balance to match blockchain.
  async function refreshBalances(options = {}) {
    if (!options.force && (importInFlight || switchInFlight)) return;
    try {
      const { parsed, raw, source } = await fetchUsdmBalance();
      let usedTransferFallback = false;
      let usedIncomingTotals = false;
      let incomingTotals = null;
      if (parsed.balance === 0n && parsed.unlocked_balance === 0n) {
        const now = Date.now();
        if (!refreshInFlight && now - lastRefreshAttemptAt > 15000) {
          refreshInFlight = true;
          lastRefreshAttemptAt = now;
          rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 60000 })
            .then(() => { refreshBalances({ force: true }); updateDashboardSyncInfo(); })
            .catch(() => {})
            .finally(() => { refreshInFlight = false; });
        }
        try {
          incomingTotals = await fetchIncomingUsdmTotals({ minAgeMs: 0 });
          if (incomingTotals.total > 0n) {
            const unlocked = incomingTotals.unlocked > 0n ? incomingTotals.unlocked : incomingTotals.total;
            parsed = { balance: incomingTotals.total, unlocked_balance: unlocked };
            usedIncomingTotals = true;
            if (typeof console !== 'undefined' && console.log) console.log('Balance from incoming_transfers fallback');
          }
        } catch (_) {
          try {
            const transfers = await rpc('get_transfers', { in: true, out: false, pending: false, pool: false });
            const inList = transfers.in || [];
            let sumIn = 0n;
            for (const t of inList) {
              const a = String(t.asset_type || t.assetType || '').trim().toLowerCase();
              if (a === 'usdm') sumIn += amountAsBigInt(t.amount);
            }
            if (sumIn > 0n) {
              parsed = { balance: sumIn, unlocked_balance: sumIn };
              usedTransferFallback = true;
              if (typeof console !== 'undefined' && console.log) console.log('Balance from get_transfers (in) fallback');
            }
          } catch (_) {}
        }
      } else {
        try {
          incomingTotals = incomingTotals || await fetchIncomingUsdmTotals({ minAgeMs: 15000 });
          if (incomingTotals.total > parsed.balance) {
            const unlocked = incomingTotals.unlocked > 0n ? incomingTotals.unlocked : incomingTotals.total;
            parsed = { balance: incomingTotals.total, unlocked_balance: unlocked };
            usedIncomingTotals = true;
            if (typeof console !== 'undefined' && console.log) console.log('Balance from incoming_transfers (overflow-safe)');
          }
        } catch (_) {}
      }
      // Balance debug data intentionally not exposed on window for security
      if (typeof console !== 'undefined' && console.log) {
        console.log('get_balance completed, source:', source);
      }
      rpcFailureCount = 0;
      setRpcStatus(true);
      const usdmDisplay = parsed.unlocked_balance > 0n ? parsed.unlocked_balance : parsed.balance;
      lastUsdmBalanceAtomic = usdmDisplay;
      const balanceUsdmEl = document.getElementById('balanceUsdm');
      setBalanceDisplayAtomic(usdmDisplay);
      updateSwapUsdmBalanceDisplay();
      document.dispatchEvent(new Event('swapBalanceUpdated'));
      updateSendBalanceHint((document.getElementById('sendAmount') || {}).value || '');
      const unlockedUsdmEl = document.getElementById('unlockedUsdm');
      if (unlockedUsdmEl) unlockedUsdmEl.textContent = '';
      saveStoredBalances(usdmDisplay);
      const hintEl = document.getElementById('balanceRpcHint');
      const debugEl = document.getElementById('balanceDebug');
      if ((usedIncomingTotals || usedTransferFallback) && balanceUsdmEl) {
        if (balanceUsdmEl) balanceUsdmEl.textContent = '$' + formatAmount(usdmDisplay) + (usedIncomingTotals ? ' (from outputs)' : ' (from history)');
      }
      if (hintEl) {
        if (usdmDisplay === 0n && !usedTransferFallback) {
          const addrLine = currentWalletAddress ? ' Wallet: ' + formatAddressShort(currentWalletAddress) + '.' : '';
          hintEl.textContent = 'Balance is 0. Set Daemon URL in Settings (same node as CLI), then click Refresh (↻). If still 0, try Rescan to rebuild wallet view.' + addrLine;
          hintEl.classList.remove('hidden');
          if (debugEl) { debugEl.textContent = 'Debug: __lastGetBalanceResult in Console.'; debugEl.classList.remove('hidden'); }
        } else {
          const hint = usedIncomingTotals
            ? 'Balance from wallet outputs (overflow-safe).'
            : (usedTransferFallback ? 'Balance from transfer history (get_balance returned 0).' : '');
          hintEl.textContent = hint;
          hintEl.classList.toggle('hidden', !hint);
          if (debugEl) debugEl.classList.add('hidden');
        }
      }
      return raw;
    } catch (e) {
      const noWallet = isNoWalletError(e);
      if (!noWallet) rpcFailureCount += 1;
      setRpcStatus(noWallet); // connected but no wallet = still show Connected
      lastUsdmBalanceAtomic = 0n;
      setBalanceDisplayAtomic(0n);
      updateSwapUsdmBalanceDisplay();
      document.dispatchEvent(new Event('swapBalanceUpdated'));
      updateSendBalanceHint((document.getElementById('sendAmount') || {}).value || '');
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
    try {
      const result = await rpc('get_address', { account_index: 0 });
      const addr = result.address || result.addresses?.[0]?.address || '';
      currentWalletAddress = addr || '';
      if (addr && typeof window._triggerSwapSync === 'function') {
        window._triggerSwapSync();
      }
      document.getElementById('receiveAddress').textContent = addr || 'Connect wallet RPC in Settings';
      const canvas = document.getElementById('receiveQrCanvas');
      renderQrToCanvas(addr || '', canvas);
      // Migrate swap history from filename-based keys to the real wallet address
      if (addr) {
        try {
          const history = loadSwapHistory();
          const fallbackKeys = [getActiveWalletName(), getPrimaryWallet(), '_default'].filter(Boolean);
          let migrated = false;
          for (const oldKey of fallbackKeys) {
            if (oldKey === addr) continue;
            if (Array.isArray(history[oldKey]) && history[oldKey].length > 0) {
              if (!Array.isArray(history[addr])) history[addr] = [];
              for (const rec of history[oldKey]) {
                const exists = history[addr].some((s) => s.swap_id === rec.swap_id);
                if (!exists) history[addr].push(rec);
              }
              delete history[oldKey];
              migrated = true;
            }
          }
          if (migrated) {
            history[addr].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
            if (history[addr].length > 50) history[addr] = history[addr].slice(0, 50);
            saveSwapHistory(history);
          }
        } catch (_) {}
      }
    } catch (e) {
      currentWalletAddress = '';
      document.getElementById('receiveAddress').textContent = 'Connect wallet RPC in Settings';
      const canvas = document.getElementById('receiveQrCanvas');
      renderQrToCanvas('', canvas);
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
      });
      const inList = result.in || [];
      const outList = result.out || [];
      const pendingList = result.pending || [];
      const poolList = result.pool || [];
      const all = [
        // Preserve original type — 'block' for mining payouts, 'in' for regular receives
        ...inList.map((t) => ({ ...t, type: t.type || 'in' })),
        ...outList.map((t) => ({ ...t, type: 'out' })),
        ...pendingList.map((t) => ({ ...t, type: 'pending' })),
        ...poolList.map((t) => ({ ...t, type: 'pool' })),
      ].sort((a, b) => (b.timestamp || b.unlock_time || 0) - (a.timestamp || a.unlock_time || 0));

      const typeFilter = (document.getElementById('historyType') || {}).value || 'all';
      let show = all;
      if (typeFilter === 'in') show = all.filter((t) => t.type === 'in' || t.type === 'block');
      else if (typeFilter === 'out') show = all.filter((t) => t.type === 'out');
      else if (typeFilter === 'pending') show = all.filter((t) => t.type === 'pending' || t.type === 'pool');

      listEl.innerHTML =
        show.length === 0
          ? 'No transactions.'
          : show
              .slice(0, 50)
              .map(
                (t) => {
                  const isMiningPayout = t.type === 'block';
                  const icon = isMiningPayout ? '⛏' : t.type === 'in' ? '↓' : t.type === 'out' ? '↑' : '◐';
                  const label = isMiningPayout ? '<span class="tx-mining">Mining Payout</span> ' : '';
                  const conf = t.confirmations;
                  const confLabel = t.type === 'pending' || t.type === 'pool'
                    ? '<span class="tx-pending">Pending</span>'
                    : conf !== undefined
                      ? `<span class="tx-confirmed">${escHtml(conf)} conf</span>`
                      : '';
                  const explorerBase = DEFAULT_EXPLORER_URL;
                  const safeTxid = escHtml(t.txid || '');
                  const txLink = t.txid
                    ? `<a href="${explorerBase}/tx/${safeTxid}" target="_blank" class="tx-link">${safeTxid.slice(0, 8)}…</a>`
                    : '';
                  return `<div class="history-item${isMiningPayout ? ' history-item-mining' : ''}">
                    <span>${icon} ${label}${escHtml(formatAmount(t.amount))} ${escHtml(t.asset_type || ASSET_USDM)}</span>
                    <span>${confLabel} ${txLink}</span>
                  </div>`;
                }
              )
              .join('');

      if (recentEl) {
        renderRecentActivity(all, recentEl);
      }
    } catch (e) {
      listEl.innerHTML = 'Connect wallet RPC in Settings and click Refresh.';
      if (recentEl) recentEl.innerHTML = '<div class="recent-empty">No recent transactions</div>';
    }
  }

  async function renderRecentActivity(transfers, container) {
    const explorerBase = DEFAULT_EXPLORER_URL;

    // Build unified list from wallet transfers
    const items = transfers.map((t) => {
      const isMiningPayout = t.type === 'block';
      const isIn = t.type === 'in' || isMiningPayout;
      const isPending = t.type === 'pending' || t.type === 'pool';
      return {
        icon: isMiningPayout ? '⛏' : isIn ? '↓' : t.type === 'out' ? '↑' : '◐',
        dirClass: isMiningPayout ? 'recent-item-mining' : isIn ? 'recent-item-in' : 'recent-item-out',
        label: isMiningPayout ? 'Mining Payout' : isIn ? 'Received' : t.type === 'out' ? 'Sent' : 'Pending',
        amount: formatAmount(t.amount),
        asset: t.asset_type || ASSET_USDM,
        sign: isIn ? '+' : '-',
        time: t.timestamp ? t.timestamp * 1000 : 0,
        isPending,
        txid: t.txid || '',
        source: isMiningPayout ? 'mining' : 'transfer',
      };
    });

    // Merge staking events
    try {
      const stakesRes = await fetch(getStakingUrl() + '/api/staking/stakes?address=' + encodeURIComponent(currentWalletAddress)).then(r => r.json()).catch(() => ({}));
      const stakes = stakesRes.stakes || [];
      stakes.forEach((s) => {
        // Add the stake creation event
        const stakeTime = s.created_at ? new Date(s.created_at).getTime() : 0;
        const stakeAmt = (Number(BigInt(s.amount_atomic || '0')) / 1e8).toFixed(2);
        const stakeTxid = s.tx_hash || '';
        items.push({
          icon: '⛓',
          dirClass: 'recent-item-out',
          label: 'Staked (' + (s.tier_label || s.tier || '?') + ')',
          amount: stakeAmt,
          asset: ASSET_USDM,
          sign: '🔒',
          time: stakeTime,
          isPending: false,
          txid: stakeTxid,
          source: 'stake',
        });
        // If unstaked, add the unstake event (same tx_hash — the original stake tx)
        if (s.status === 'unstaked' && s.updated_at) {
          const unstakeTime = new Date(s.updated_at).getTime();
          items.push({
            icon: '🔓',
            dirClass: 'recent-item-in',
            label: 'Unstaked (' + (s.tier_label || s.tier || '?') + ')',
            amount: stakeAmt,
            asset: ASSET_USDM,
            sign: '+',
            time: unstakeTime,
            isPending: false,
            txid: stakeTxid,
            source: 'unstake',
          });
        }
      });
    } catch (_) {}

    // Merge swap history
    const swapKey = currentWalletAddress || getActiveWalletName() || '_default';
    const swaps = getSwapsForWallet(swapKey);
    swaps.forEach((s) => {
      const isMint = s.direction === 'crypto_to_usdm';
      const txid = isMint ? (s.minted_tx || '') : (s.burn_tx || s.payout_tx || '');
      // Skip swaps that already appear as a wallet transfer (match by txid)
      if (txid && items.some((it) => it.txid === txid)) return;
      const isPending = s.status && s.status !== 'minted' && s.status !== 'payout_sent' && s.status !== 'failed';
      const isFailed = s.status === 'failed';
      const time = s.created_at ? new Date(s.created_at).getTime() : 0;
      // For explorer links: minted TXs are on USDm chain, payout TXs are on BTC/XMR chain
      const txExplorerAsset = isMint ? 'USDm' : (s.asset || 'USDm');
      items.push({
        icon: '⇄',
        dirClass: isMint ? 'recent-item-in' : 'recent-item-out',
        label: isMint ? 'Swap ' + (s.asset || '?') + ' → USDm' : 'Swap USDm → ' + (s.asset || '?'),
        amount: isMint ? (s.expected_usdm || s.amount || '?') : (s.expected_crypto || s.amount_usdm || '?'),
        asset: isMint ? 'USDm' : (s.asset || '?'),
        sign: isMint ? '+' : '-',
        time,
        isPending,
        isFailed,
        txid,
        txExplorerAsset,
        source: 'swap',
      });
    });

    // Sort newest first
    items.sort((a, b) => b.time - a.time);

    if (items.length === 0) {
      container.innerHTML = '<div class="recent-empty">No recent transactions</div>';
      return;
    }

    container.innerHTML = items.map((t) => {
      const timeStr = t.time ? new Date(t.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      let statusHtml = '';
      if (t.isPending) statusHtml = '<span class="recent-status recent-status-pending">Pending</span>';
      else if (t.isFailed) statusHtml = '<span class="recent-status recent-status-failed">Failed</span>';

      const recentTxLink = t.txid
        ? ' ' + txLink(t.txExplorerAsset || 'USDm', t.txid, { label: escHtml(t.txid).slice(0, 10) + '…', cls: 'recent-tx-link' })
        : '';

      return `<div class="recent-item ${escHtml(t.dirClass)}">
        <div class="recent-item-icon">${escHtml(t.icon)}</div>
        <div class="recent-item-info">
          <span class="recent-item-label">${escHtml(t.label)}</span>
          <span class="recent-item-time">${escHtml(timeStr)}${statusHtml ? ' ' + statusHtml : ''}${recentTxLink}</span>
        </div>
        <div class="recent-item-amount ${escHtml(t.dirClass)}">${escHtml(t.sign)}${escHtml(t.amount)} ${escHtml(t.asset)}</div>
      </div>`;
    }).join('');
  }

  function showMessage(id, text, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.toggle('success', !isError && text);
  }

  function bindNavigation() {
    // Mobile menu toggle
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebarNav = document.getElementById('sidebarNav');
    if (mobileMenuBtn && sidebarNav) {
      mobileMenuBtn.addEventListener('click', () => {
        sidebarNav.classList.toggle('mobile-open');
        mobileMenuBtn.textContent = sidebarNav.classList.contains('mobile-open') ? '\u2715' : '\u2630';
      });
    }

    const titles = {
      dashboard: 'Dashboard',
      send: 'Send',
      receive: 'Receive',
      addressbook: 'Addressbook',
      swap: 'Swap',
      staking: 'Staking',
      lending: 'Lending',
      history: 'History',
      import: 'Import',
      settings: 'Settings',
    };
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        // Close mobile menu on nav selection
        if (sidebarNav) { sidebarNav.classList.remove('mobile-open'); }
        if (mobileMenuBtn) { mobileMenuBtn.textContent = '\u2630'; }
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
        // Clear seed input when navigating away from import page (security)
        if (page !== 'import') {
          const impSeed = document.getElementById('importSeed');
          if (impSeed) { impSeed.value = ''; impSeed.classList.add('masked'); }
          const impToggle = document.getElementById('importSeedToggle');
          if (impToggle) impToggle.textContent = 'Show';
        }
      });
    });

    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const page = btn.dataset.goto;
        const navBtn = document.querySelector('.nav-btn[data-page="' + page + '"]');
        if (navBtn) navBtn.click();
      });
    });
  }

  function bindWalletActions() {
    const disconnectBtn = document.getElementById('btnDisconnectWallet');
    const createBtn = document.getElementById('btnCreateWallet');
    const viewKeyBtn = document.getElementById('btnViewKey');
    const viewKeyValue = document.getElementById('viewKeyValue');
    const viewKeyMsg = document.getElementById('viewKeyMessage');
    const copyViewKeyBtn = document.getElementById('btnCopyViewKey');

    function setViewKeyDisplay(key) {
      if (viewKeyValue) viewKeyValue.textContent = key || '—';
    }

    disconnectBtn?.addEventListener('click', async () => {
      if (!confirm('Disconnect the current wallet?')) return;
      showSyncStatus('Disconnecting wallet…', true);
      try {
        await rpc('close_wallet', {}, { timeoutMs: 8000 });
        currentWalletAddress = '';
        const balanceUsdmEl = document.getElementById('balanceUsdm');
        const unlockedUsdmEl = document.getElementById('unlockedUsdm');
        lastUsdmBalanceAtomic = 0n;
        if (balanceUsdmEl) balanceUsdmEl.textContent = '$' + formatAmount(0n);
        if (unlockedUsdmEl) unlockedUsdmEl.textContent = '';
        updateSwapUsdmBalanceDisplay();
        document.dispatchEvent(new Event('swapBalanceUpdated'));
        document.getElementById('receiveAddress').textContent = 'Connect wallet RPC in Settings';
        setViewKeyDisplay('—');
        setActiveWalletName('');
        const listEl = document.getElementById('historyList');
        const recentEl = document.getElementById('recentList');
        if (listEl) listEl.textContent = 'No wallet connected.';
        if (recentEl) recentEl.textContent = 'No wallet connected.';
        showSyncStatus('Wallet disconnected.', true);
        renderAddressbook();
      } catch (e) {
        const msg = (e && e.message) ? e.message : 'Unknown error';
        showSyncStatus('Disconnect failed: ' + msg, true);
      }
      setTimeout(() => showSyncStatus('', false), 6000);
    });

    createBtn?.addEventListener('click', async () => {
      showSyncStatus('Creating wallet…', true);
      try {
        const filename = await createUniqueWallet();
        upsertWalletName(filename);
        setActiveWalletName(filename);
        const sub = await rpc('create_address', { account_index: 0, label: 'Receive' }, { timeoutMs: 8000 }).catch(() => null);
        const subAddr = sub && (sub.address || sub.addresses?.[0]?.address) ? (sub.address || sub.addresses?.[0]?.address) : '';
        if (subAddr) {
          currentWalletAddress = subAddr;
          if (typeof window._triggerSwapSync === 'function') {
            window._triggerSwapSync();
          }
          document.getElementById('receiveAddress').textContent = subAddr;
        } else {
          currentWalletAddress = '';
          await refreshAddress().catch(() => {}); // refreshAddress will trigger sync if address found
        }
        applyStoredBalanceForWallet(filename);
        await configureWalletRpcMoneroStyle().catch(() => {});
        // Sync new wallet with blockchain
        await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 30000 }).catch(() => {});
        await refreshBalances({ force: true }).catch(() => {});
        await refreshTransfers().catch(() => {});
        updateSendBalanceHint((document.getElementById('sendAmount') || {}).value || '');
        renderAddressbook();
        const ordered = getOrderedWalletList();
        const index = Math.max(0, ordered.indexOf(filename));
        showSyncStatus('Wallet created: ' + displayWalletLabel(index) + '. New receive subwallet generated. Back up the seed.', true);
      } catch (e) {
        const msg = (e && e.message) ? e.message : 'Unknown error';
        showSyncStatus('Create wallet failed: ' + msg, true);
      }
      setTimeout(() => showSyncStatus('', false), 8000);
    });

    viewKeyBtn?.addEventListener('click', async () => {
      if (viewKeyMsg) viewKeyMsg.textContent = '';
      try {
        const res = await rpc('query_key', { key_type: 'view_key' }, { timeoutMs: 8000 });
        const key = res && res.key ? String(res.key) : '';
        setViewKeyDisplay(key || '—');
        if (viewKeyMsg) {
          viewKeyMsg.textContent = key ? 'View key loaded (not stored).' : 'No key available.';
          viewKeyMsg.classList.toggle('success', !!key);
          viewKeyMsg.classList.toggle('error', !key);
        }
      } catch (e) {
        setViewKeyDisplay('—');
        if (viewKeyMsg) {
          viewKeyMsg.textContent = 'View key fetch failed: ' + (e.message || 'error');
          viewKeyMsg.classList.add('error');
        }
      }
    });

    copyViewKeyBtn?.addEventListener('click', () => {
      const key = viewKeyValue?.textContent || '';
      if (!key || key === '—') return;
      copyText(key);
      if (viewKeyMsg) {
        viewKeyMsg.textContent = 'Copied.';
        viewKeyMsg.classList.remove('error');
        viewKeyMsg.classList.add('success');
      }
    });
  }

  function bindAddressbook() {
    const addBtn = document.getElementById('btnAddWallet');
    const nameInput = document.getElementById('addressbookWalletName');
    const msgEl = document.getElementById('addressbookMessage');

    function showMessage(text, isError) {
      if (!msgEl) return;
      msgEl.textContent = text || '';
      msgEl.classList.toggle('error', !!isError);
      msgEl.classList.toggle('success', !isError && !!text);
    }

    addBtn?.addEventListener('click', () => {
      const name = (nameInput?.value || '').trim();
      if (!name) return showMessage('Enter a wallet filename.', true);
      upsertWalletName(name);
      if (!getFirstWalletName()) setFirstWalletName(name);
      renderAddressbook();
      showMessage('Saved wallet.', false);
    });
  }

  function renderAddressbook() {
    const listEl = document.getElementById('addressbookList');
    const msgEl = document.getElementById('addressbookMessage');
    if (!listEl) return;
    let list = getOrderedWalletList();
    const active = getActiveWalletName();
    let first = getFirstWalletName();
    if (!first && list.length > 0) {
      setFirstWalletName(list[0]);
      first = getFirstWalletName();
      list = getOrderedWalletList();
    }
    listEl.innerHTML = '';
    if (list.length === 0) {
      listEl.textContent = 'No saved wallets yet.';
      return;
    }
    list.forEach((name, index) => {
      const item = document.createElement('div');
      item.className = 'addressbook-item';
      const meta = document.createElement('div');
      meta.className = 'addressbook-meta';
      const title = document.createElement('div');
      title.className = 'addressbook-name';
      title.textContent = displayWalletLabel(index);
      const tags = document.createElement('div');
      tags.className = 'addressbook-tags';
      if (name === active) {
        const tag = document.createElement('span');
        tag.className = 'addressbook-tag';
        tag.textContent = 'active';
        tags.appendChild(tag);
      }
      if (name === first) {
        const tag = document.createElement('span');
        tag.className = 'addressbook-tag';
        tag.textContent = 'primary';
        tags.appendChild(tag);
      }
      meta.appendChild(title);
      meta.appendChild(tags);
      const actions = document.createElement('div');
      actions.className = 'addressbook-actions';
      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-ghost btn-sm';
      openBtn.textContent = 'Switch';
      openBtn.addEventListener('click', async () => {
        const target = name;
        const displayTarget = displayWalletLabel(index);
        if (target === active) {
          if (msgEl) { msgEl.textContent = displayTarget + ' is already active.'; msgEl.classList.remove('error'); msgEl.classList.add('success'); }
          showSyncStatus('', false);
          return;
        }
        showSyncStatus('Switching wallets…', true);
        if (msgEl) { msgEl.textContent = 'Switching to ' + displayTarget + '…'; msgEl.classList.remove('error'); msgEl.classList.remove('success'); }
        // Cancel any running autoConnect or background sync so they don't compete for wallet RPC
        if (typeof window.__cancelAutoConnect === 'function') window.__cancelAutoConnect();
        cancelBackgroundSync();
        switchInFlight = true;
        importInFlight = false;
        suspendAutoRefresh();
        // Flush the RPC queue so stale queued calls don't block the switch
        rpcQueue = Promise.resolve();
        openBtn.disabled = true;
        let switchWatchdog = null;
        switchWatchdog = setTimeout(() => {
          showSyncStatus('Switch is taking a while — wallet RPC may be syncing. Please wait.', true);
          if (msgEl) { msgEl.textContent = 'Still switching… wallet RPC is busy.'; msgEl.classList.remove('error'); }
        }, 30000);
        try {
          await openWalletByName(target);
          rpcFailureCount = 0;
          upsertWalletName(target);
          setActiveWalletName(target);
          applyStoredBalanceForWallet(target);
          // Show switched immediately with cached data — don't block on sync
          showSyncStatus('Opened ' + displayTarget + '. Syncing…', true);
          if (msgEl) { msgEl.textContent = 'Opened ' + displayTarget; msgEl.classList.remove('error'); msgEl.classList.add('success'); }
          renderAddressbook();

          // Fetch address immediately (fast RPC call), then show UI
          await refreshAddress().catch(() => {});

          // Run the slow sync + balance refresh in background so the switch feels instant
          (async () => {
            try {
              await configureWalletRpcMoneroStyle().catch(() => {});
              // Quick partial refresh first (recent blocks only)
              const heightRes = await rpcImmediate('get_height', {}, { timeoutMs: 5000 }).catch(() => null);
              const walletHeight = heightRes && heightRes.height ? heightRes.height : 0;
              const startH = walletHeight > 100 ? walletHeight - 100 : 0;
              await rpcImmediate('refresh', { start_height: startH }, { timeoutMs: 15000 }).catch(() => {});
              // Fetch balance + transfers in parallel (both are read-only)
              await Promise.all([
                refreshBalances({ force: true }).catch(() => {}),
                refreshTransfers().catch(() => {}),
              ]);
              showSyncStatus('', false);
              if (msgEl) { msgEl.textContent = 'Switch complete: ' + displayTarget + '.'; msgEl.classList.remove('error'); msgEl.classList.add('success'); }
              // Full sync in background if needed
              setTimeout(async () => {
                await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 60000 }).catch(() => {});
                await refreshBalances({ force: true }).catch(() => {});
              }, 2000);
            } catch (_) {}
            setTimeout(() => {
              if (msgEl && msgEl.classList.contains('success')) msgEl.textContent = '';
            }, 4000);
          })();
        } catch (e) {
          const msg = e && e.message ? e.message : 'error';
          const suffix = /invalid password|password/i.test(msg) ? ' (wallet has a password)' : '';
          if (msgEl) { msgEl.textContent = 'Open failed: ' + msg + suffix; msgEl.classList.add('error'); }
          showSyncStatus('Wallet switch failed: ' + msg + suffix, true);
          setTimeout(() => {
            showSyncStatus('', false);
            if (msgEl && msgEl.classList.contains('error')) msgEl.textContent = '';
          }, 6000);
        } finally {
          if (switchWatchdog) clearTimeout(switchWatchdog);
          switchInFlight = false;
          openBtn.disabled = false;
          resumeAutoRefresh();
        }
      });
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-ghost btn-sm';
      deleteBtn.textContent = 'Delete';
      deleteBtn.disabled = name === first || name === active;
      deleteBtn.addEventListener('click', () => {
        if (name === first) return;
        if (!confirm('Remove this wallet from Addressbook? The wallet file remains on the RPC server.')) return;
        removeWalletName(name);
        renderAddressbook();
        if (msgEl) { msgEl.textContent = 'Removed wallet.'; msgEl.classList.remove('error'); msgEl.classList.add('success'); }
      });
      actions.appendChild(openBtn);
      actions.appendChild(deleteBtn);
      item.appendChild(meta);
      item.appendChild(actions);
      listEl.appendChild(item);
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
    const priceMetaEl = document.getElementById('swapPriceMeta');
    const quoteEl = document.getElementById('swapQuote');
    const usdmAddrGroup = document.getElementById('swapUsdmAddressGroup');
    const usdmAddrInput = document.getElementById('swapUsdmAddress');
    const payoutGroup = document.getElementById('swapPayoutAddressGroup');
    const payoutInput = document.getElementById('swapPayoutAddress');
    const payoutLabel = document.getElementById('swapPayoutLabel');
    const depositSection = document.getElementById('swapDepositSection');
    const depositAddressEl = document.getElementById('swapDepositAddress');
    const depositAmountEl = document.getElementById('swapDepositAmount');
    const copyDepositBtn = document.getElementById('swapCopyDepositAddr');
    const qrCanvas = document.getElementById('swapQrCanvas');
    const statusEl = document.getElementById('swapStatus');

    // Copy deposit address button
    if (copyDepositBtn) {
      copyDepositBtn.addEventListener('click', () => {
        const addr = (depositAddressEl?.textContent || '').trim();
        if (!addr || addr === '—') return;
        navigator.clipboard.writeText(addr).then(() => {
          copyDepositBtn.textContent = 'Copied!';
          setTimeout(() => { copyDepositBtn.textContent = 'Copy'; }, 2000);
        }).catch(() => {
          // Fallback for non-HTTPS contexts
          const ta = document.createElement('textarea');
          ta.value = addr;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          copyDepositBtn.textContent = 'Copied!';
          setTimeout(() => { copyDepositBtn.textContent = 'Copy'; }, 2000);
        });
      });
    }
    const actionBtn = document.getElementById('swapActionBtn');
    const cancelBtn = document.getElementById('swapCancelBtn');
    const newSwapBtn = document.getElementById('swapNewBtn');
    const backendHint = document.getElementById('swapBackendHint');
    const swapHistoryList = document.getElementById('swapHistoryList');

    if (backendHint) backendHint.textContent = 'Swap backend: ' + getSwapBackendUrl();

    let lastPrice = null;
    let swapId = null;
    let pollTimer = null;
    let priceTimer = null;
    let priceRetryTimer = null;
    let priceRefreshInFlight = false;
    let swapMode = 'crypto_to_usdm';
    let swapAsset = 'BTC';
    let burnAddress = '';
    let depositAddress = '';
    let reserveAddresses = { BTC: BTC_RESERVE_ADDRESS, XMR: XMR_RESERVE_ADDRESS };
    let lastPriceSource = null;
    let lastPriceAt = null;

    function getSwapWalletKey() {
      // Always prefer the deterministic wallet address (derived from seed).
      // This ensures swap history persists across sessions even if wallet
      // file names differ, as long as the same seed is used.
      return currentWalletAddress || getPrimaryWallet() || getActiveWalletName() || '_default';
    }


    function swapStatusLabel(status) {
      const map = {
        awaiting_deposit: 'Awaiting deposit',
        deposit_confirmed: 'Deposit confirmed',
        minted: 'Minted',
        awaiting_burn: 'Awaiting burn',
        burn_submitted: 'Burn submitted',
        burn_confirmed: 'Burn confirmed',
        payout_sent: 'Payout sent',
        failed: 'Failed',
      };
      return map[status] || status || 'Unknown';
    }

    function swapStatusClass(status) {
      if (status === 'minted' || status === 'payout_sent') return 'success';
      if (status === 'failed') return 'failed';
      return 'pending';
    }

    function isSwapPending(status) {
      return status && status !== 'minted' && status !== 'payout_sent' && status !== 'failed';
    }

    function persistSwap(record) {
      saveSwapRecord(getSwapWalletKey(), record);
      renderSwapHistory();
    }

    function renderSwapHistory() {
      if (!swapHistoryList) return;
      const swaps = getSwapsForWallet(getSwapWalletKey());
      if (!swaps.length) {
        swapHistoryList.textContent = 'No swaps yet.';
        return;
      }
      swapHistoryList.innerHTML = '';
      swaps.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'swap-history-item';
        const dir = s.direction === 'crypto_to_usdm'
          ? `${s.asset || '?'} \u2192 USDm`
          : `USDm \u2192 ${s.asset || '?'}`;
        const amount = s.direction === 'crypto_to_usdm'
          ? (s.amount || '?') + ' ' + (s.asset || '')
          : (s.amount_usdm || '?') + ' USDm';
        const date = s.created_at ? new Date(s.created_at).toLocaleDateString() : '';
        const isMint = s.direction === 'crypto_to_usdm';
        const historyTxid = isMint ? (s.minted_tx || '') : (s.payout_tx || '');
        const historyTxAsset = isMint ? 'USDm' : (s.asset || 'USDm');
        const historyTxHtml = historyTxid ? ' · ' + txLink(historyTxAsset, historyTxid, { label: escHtml(historyTxid).slice(0, 8) + '…' }) : '';
        item.innerHTML =
          '<div class="swap-history-left">' +
            '<span class="swap-history-dir">' + escHtml(dir) + '</span>' +
            '<span class="swap-history-detail">' + escHtml(amount) + (date ? ' \u00b7 ' + escHtml(date) : '') + ' \u00b7 ' + escHtml((s.swap_id || '').slice(0, 8)) + historyTxHtml + '</span>' +
          '</div>' +
          '<span class="swap-history-status ' + escHtml(swapStatusClass(s.status)) + '">' + escHtml(swapStatusLabel(s.status)) + '</span>';
        if (isSwapPending(s.status)) {
          // Add resume + cancel buttons for pending swaps
          const btnWrap = document.createElement('span');
          btnWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
          const resumeBtn = document.createElement('button');
          resumeBtn.className = 'btn btn-sm btn-ghost';
          resumeBtn.textContent = 'Resume';
          resumeBtn.style.cssText = 'font-size:11px;padding:2px 8px;';
          resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); resumeSwap(s); });
          const histCancelBtn = document.createElement('button');
          histCancelBtn.className = 'btn btn-sm';
          histCancelBtn.textContent = 'Cancel';
          histCancelBtn.style.cssText = 'font-size:11px;padding:2px 8px;background:#d9534f;color:#fff;border:none;border-radius:4px;cursor:pointer;';
          histCancelBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Cancel this swap?')) return;
            try {
              histCancelBtn.disabled = true;
              histCancelBtn.textContent = '…';
              await swapFetch(`/api/swaps/${s.swap_id}/cancel`, { method: 'POST' });
              persistSwap({ swap_id: s.swap_id, status: 'cancelled', error: 'Cancelled by user' });
              renderSwapHistory();
            } catch (err) {
              histCancelBtn.textContent = 'Error';
              setTimeout(() => { histCancelBtn.textContent = 'Cancel'; histCancelBtn.disabled = false; }, 2000);
            }
          });
          btnWrap.appendChild(resumeBtn);
          btnWrap.appendChild(histCancelBtn);
          item.querySelector('.swap-history-status')?.replaceWith(btnWrap);
          item.title = 'Pending swap';
        }
        swapHistoryList.appendChild(item);
      });
    }

    function resumeSwap(record) {
      swapId = record.swap_id;
      swapMode = record.direction || 'crypto_to_usdm';
      swapAsset = record.asset || 'BTC';
      burnAddress = record.burn_address || '';
      depositAddress = record.deposit_address || '';
      if (fromSel) fromSel.value = swapMode === 'crypto_to_usdm' ? swapAsset : 'USDm';
      if (toSel) toSel.value = swapMode === 'crypto_to_usdm' ? 'USDm' : swapAsset;
      normalizePair();
      openModal();
      setStatus('Resuming swap ' + (swapId || '').slice(0, 8) + '...');
      if (actionBtn) { actionBtn.disabled = true; actionBtn.textContent = 'Polling...'; }
      if (newSwapBtn) newSwapBtn.classList.remove('hidden');
      if (cancelBtn) cancelBtn.classList.remove('hidden');
      startPolling();
      pollSwapStatus();
    }

    function isCrypto(asset) {
      return asset === 'BTC' || asset === 'XMR';
    }

    function setStatus(text, type) {
      if (!statusEl) return;
      // Use innerHTML for success messages (may contain tx links), textContent otherwise
      if (type === 'success' && text && /<a\s/i.test(text)) {
        statusEl.innerHTML = text;
      } else {
        statusEl.textContent = text || '';
      }
      statusEl.classList.toggle('error', type === 'error');
      statusEl.classList.toggle('success', type === 'success');
    }


    function openModal() {
      if (!modal) return;
      modal.classList.remove('hidden');
      if (usdmAddrInput && currentWalletAddress) usdmAddrInput.value = currentWalletAddress;
      updateBackendHint();
      resetSwapUi();
      updateSwapUsdmBalanceDisplay();
      refreshReserveAddresses();
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
      if (priceRetryTimer) clearTimeout(priceRetryTimer);
      priceRetryTimer = null;
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
      updateDepositSection();
      updateSwapUsdmBalanceDisplay();
    }

    function resetSwapUi() {
      swapId = null;
      burnAddress = '';
      depositAddress = '';
      stopPolling();
      updateDepositSection(true);
      setStatus('Ready.');
      setPriceMeta('—');
      if (actionBtn) { actionBtn.disabled = false; actionBtn.textContent = swapMode === 'crypto_to_usdm' ? 'Generate swap' : 'Burn USDm & swap'; }
      if (newSwapBtn) newSwapBtn.classList.add('hidden');
      if (cancelBtn) cancelBtn.classList.add('hidden');
      if (amountEl) amountEl.disabled = false;
      if (fromSel) fromSel.disabled = false;
      if (toSel) toSel.disabled = false;
    }

    function formatPriceMeta(source, ts) {
      if (!priceMetaEl) return;
      if (!source || !ts) {
        priceMetaEl.textContent = '—';
        return;
      }
      const time = new Date(ts).toLocaleTimeString();
      priceMetaEl.textContent = `Source: ${source} • ${time}`;
    }

    function setPriceMeta(text) {
      if (!priceMetaEl) return;
      priceMetaEl.textContent = text || '—';
    }

    function queuePriceRefresh() {
      if (priceRefreshInFlight) return;
      if (priceRetryTimer) clearTimeout(priceRetryTimer);
      priceRetryTimer = setTimeout(() => {
        priceRetryTimer = null;
        refreshPrice();
      }, 300);
    }

    async function refreshPrice() {
      const asset = swapAsset;
      if (!isCrypto(asset)) {
        lastPrice = null;
        lastPriceSource = null;
        lastPriceAt = null;
        priceEl.textContent = '—';
        setPriceMeta('—');
        quoteEl.textContent = '—';
        return;
      }
      try {
        priceRefreshInFlight = true;
        setPriceMeta('Fetching…');
        const data = await swapFetch('/api/price?asset=' + asset);
        lastPrice = Number(data && data.price_usd) || null;
        lastPriceSource = data && data.source ? String(data.source) : null;
        lastPriceAt = lastPrice ? Date.now() : null;
        priceEl.textContent = lastPrice ? `$${lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} / ${asset}` : '—';
        if (lastPrice) formatPriceMeta(lastPriceSource, lastPriceAt);
        else setPriceMeta('Unavailable');
        updateQuote();
      } catch (e) {
        lastPrice = null;
        lastPriceSource = null;
        lastPriceAt = null;
        priceEl.textContent = 'Unavailable';
        setPriceMeta('Check swap backend URL');
        setStatus('Price feed unavailable. Check Swap Backend URL in Settings.', 'error');
      } finally {
        priceRefreshInFlight = false;
      }
      updateDepositSection();
    }

    function updateQuote() {
      const raw = (amountEl?.value || '').trim();
      if (!raw || !lastPrice) {
        quoteEl.textContent = '—';
        if (raw && !lastPrice) queuePriceRefresh();
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
      updateDepositSection();
      maybeWarnBalance();
    }

    async function refreshReserveAddresses() {
      try {
        const data = await swapFetch('/api/config', { timeoutMs: 8000 });
        if (data && data.btc_reserve_address && data.xmr_reserve_address) {
          reserveAddresses = {
            BTC: data.btc_reserve_address,
            XMR: data.xmr_reserve_address,
          };
        }
      } catch (_) {}
      updateDepositSection();
    }

    function maybeWarnBalance() {
      if (swapMode !== 'usdm_to_crypto' || swapId) return;
      const raw = (amountEl?.value || '').trim();
      const burnAtomic = parseDecimalToAtomic(raw, USDM_DECIMALS);
      const dust = 1n;
      if (burnAtomic > 0n && lastUsdmBalanceAtomic < burnAtomic + dust) {
        setStatus('Not enough USDm for swap', 'error');
        if (actionBtn) actionBtn.disabled = true;
      } else if (actionBtn) {
        actionBtn.disabled = false;
        if (statusEl?.classList.contains('error') && statusEl.textContent === 'Not enough USDm for swap') {
          setStatus('Ready.');
        }
      }
    }

    function updateDepositSection(resetOnly) {
      if (!depositSection) return;
      depositSection.classList.toggle('hidden', swapMode !== 'crypto_to_usdm' || !isCrypto(swapAsset));
      if (swapMode !== 'crypto_to_usdm' || !isCrypto(swapAsset)) {
        depositAddressEl.textContent = '—';
        depositAmountEl.textContent = '—';
        renderQrToCanvas('', qrCanvas);
        return;
      }
      const address = reserveAddresses[swapAsset] || (swapAsset === 'BTC' ? BTC_RESERVE_ADDRESS : XMR_RESERVE_ADDRESS);
      depositAddress = address;
      depositSection.classList.remove('hidden');
      depositAddressEl.textContent = address;
      if (resetOnly) {
        depositAmountEl.textContent = 'Enter amount to see deposit details.';
      } else {
        const raw = (amountEl?.value || '').trim();
        const amount = Number(raw);
        depositAmountEl.textContent = Number.isFinite(amount) && amount > 0
          ? `Send ${raw} ${swapAsset} to the reserve address`
          : 'Enter amount to see deposit details.';
      }
      renderQrToCanvas(address, qrCanvas);
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
        persistSwap({
          swap_id: swapId, direction: 'crypto_to_usdm', asset: swapAsset,
          amount: amountRaw, deposit_address: depositAddress,
          expected_usdm: res.expected_usdm, price_usd: res.price_usd,
          status: 'awaiting_deposit', created_at: new Date().toISOString(),
        });
        depositSection?.classList.remove('hidden');
        depositAddressEl.textContent = depositAddress;
        depositAmountEl.textContent = `Send ${amountRaw} ${swapAsset} to mint ${res.expected_usdm} USDm`;
        renderQrToCanvas(depositAddress, qrCanvas);
        setStatus('Waiting for deposit confirmations…');
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
        persistSwap({
          swap_id: swapId, direction: 'usdm_to_crypto', asset: swapAsset,
          amount_usdm: amountRaw, burn_address: burnAddress,
          payout_address: payoutAddr, expected_crypto: res.expected_crypto,
          price_usd: res.price_usd,
          status: 'awaiting_burn', created_at: new Date().toISOString(),
        });
        setStatus('Preparing USDm burn…');
      }
      // Lock inputs and show "New swap" while swap is active
      if (amountEl) amountEl.disabled = true;
      if (fromSel) fromSel.disabled = true;
      if (toSel) toSel.disabled = true;
      if (newSwapBtn) newSwapBtn.classList.remove('hidden');
      if (cancelBtn) cancelBtn.classList.remove('hidden');
    }

    async function submitBurn() {
      const amountRaw = (amountEl?.value || '').trim();
      const burnAtomic = parseDecimalToAtomic(amountRaw, USDM_DECIMALS);
      if (burnAtomic <= 0n) throw new Error('Enter a valid USDm amount.');
      if (!burnAddress) throw new Error('Burn address not available.');
      const balance = await rpc('get_balance', { account_index: 0, all_accounts: false, all_assets: false, asset_type: ASSET_USDM, strict: false });
      const parsed = parseBalanceFromResult(balance);
      const available = parsed.unlocked_balance > 0n ? parsed.unlocked_balance : parsed.balance;
      if (available < burnAtomic) {
        throw new Error('Not enough USDm for swap');
      }
      // Send the full amount to the provably-unspendable burn address.
      // Coins sent there are permanently destroyed (nobody has the spend key).
      const res = await rpc('transfer', {
        destinations: [{ amount: Number(burnAtomic), address: burnAddress }],
        priority: 1,
        get_tx_key: true,
        get_tx_hex: false,
        get_tx_metadata: false,
      });
      await swapFetch(`/api/swaps/${swapId}/burn`, { method: 'POST', body: { tx_hash: res.tx_hash } });
      persistSwap({ swap_id: swapId, status: 'burn_submitted', burn_tx: res.tx_hash });
      setStatus('Burn submitted. Waiting for confirmation…');
      actionBtn.textContent = 'Waiting for burn confirmation';
      actionBtn.disabled = true;
      return res.tx_hash;
    }

    async function pollSwapStatus() {
      if (!swapId) return;
      try {
        const res = await swapFetch(`/api/swaps/${swapId}`);
        if (!res) return;
        const status = res.status || '';
        // Persist every status update so history stays current
        persistSwap({ swap_id: swapId, status, minted_tx: res.minted_tx, payout_tx: res.payout_tx, error: res.error });
        if (status === 'awaiting_deposit') {
          setStatus('Waiting for deposit confirmations…');
        } else if (status === 'deposit_confirmed') {
          setStatus('Deposit confirmed. Minting USDm…');
        } else if (status === 'minted') {
          const mintTxLink = res.minted_tx
            ? ' ' + txLink('USDm', res.minted_tx)
            : '';
          setStatus('USDm minted and sent.' + mintTxLink, 'success');
          stopPolling();
          if (cancelBtn) cancelBtn.classList.add('hidden');
          refreshBalances({ force: true }).catch(() => {});
          refreshTransfers().catch(() => {});
        } else if (status === 'awaiting_burn') {
          setStatus('Awaiting USDm burn.');
        } else if (status === 'burn_submitted') {
          setStatus('Burn submitted. Waiting for confirmation…');
        } else if (status === 'burn_confirmed') {
          setStatus('Burn confirmed. Sending payout…');
        } else if (status === 'payout_sent') {
          const payoutTxLink = res.payout_tx
            ? ' ' + txLink(swapAsset, res.payout_tx)
            : '';
          setStatus('Payout sent.' + payoutTxLink, 'success');
          stopPolling();
          if (cancelBtn) cancelBtn.classList.add('hidden');
        } else if (status === 'failed') {
          setStatus(escHtml(res.error || 'Swap failed.'), 'error');
          stopPolling();
          if (cancelBtn) cancelBtn.classList.add('hidden');
        } else if (status === 'cancelled') {
          setStatus('Swap cancelled.', 'error');
          stopPolling();
          if (cancelBtn) cancelBtn.classList.add('hidden');
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
        setStatus('Creating swap…');
        actionBtn.disabled = true;
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
    cancelBtn?.addEventListener('click', async () => {
      if (!swapId) return;
      if (!confirm('Cancel this swap? If you already sent a deposit, contact support.')) return;
      try {
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling…';
        await swapFetch(`/api/swaps/${swapId}/cancel`, { method: 'POST' });
        persistSwap({ swap_id: swapId, status: 'cancelled', error: 'Cancelled by user' });
        setStatus('Swap cancelled.', 'error');
        stopPolling();
        cancelBtn.classList.add('hidden');
        renderSwapHistory();
      } catch (e) {
        setStatus('Cancel failed: ' + escHtml(e.message || 'Unknown error'), 'error');
      } finally {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel Swap';
      }
    });
    newSwapBtn?.addEventListener('click', () => {
      resetSwapUi();
      refreshPrice();
      updateQuote();
    });
    openBtn?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    backdrop?.addEventListener('click', closeModal);
    document.addEventListener('swapBalanceUpdated', () => {
      updateSwapUsdmBalanceDisplay();
      maybeWarnBalance();
    });

    normalizePair();
    // Render swap history on init and auto-resume any pending swaps
    renderSwapHistory();
    autoResumePendingSwaps();

    // Recover swap history from server when wallet address is available
    // (handles case where user restores from seed on a new device)
    let _swapSyncRetries = 0;
    let _swapSyncSucceeded = false;
    async function syncSwapHistoryFromServer() {
      // Use fallback chain: currentWalletAddress, or extract address from local swap records
      let addr = currentWalletAddress;
      if (!addr) {
        // Try to find a USDm address from existing local swap history
        const walletKey = getSwapWalletKey();
        const localSwaps = getSwapsForWallet(walletKey);
        for (const s of localSwaps) {
          if (s.payout_address && s.payout_address.length > 20) { addr = s.payout_address; break; }
          if (s.deposit_address && s.deposit_address.length > 20) { addr = s.deposit_address; break; }
        }
      }
      if (!addr) {
        // Wallet address not yet available — retry up to 20 times (60s total)
        if (_swapSyncRetries < 20) {
          _swapSyncRetries++;
          setTimeout(syncSwapHistoryFromServer, 3000);
        }
        return;
      }
      try {
        const res = await swapFetch(`/api/swaps?wallet=${encodeURIComponent(addr)}`);
        if (res && Array.isArray(res.swaps) && res.swaps.length > 0) {
          const walletKey = getSwapWalletKey();
          let changed = false;
          for (const serverSwap of res.swaps) {
            const record = {
              swap_id: serverSwap.id,
              direction: serverSwap.direction,
              asset: serverSwap.asset,
              status: serverSwap.status,
              amount: serverSwap.amount,
              amount_usdm: serverSwap.amount_usdm,
              deposit_address: serverSwap.deposit_address,
              burn_address: serverSwap.burn_address,
              payout_address: serverSwap.payout_address,
              expected_usdm: serverSwap.expected_usdm,
              expected_crypto: serverSwap.expected_crypto,
              price_usd: serverSwap.price_usd,
              minted_tx: serverSwap.minted_tx,
              payout_tx: serverSwap.payout_tx,
              burn_tx: serverSwap.burn_tx,
              error: serverSwap.error,
              created_at: serverSwap.created_at,
            };
            // Only add if not already in local history
            const local = getSwapsForWallet(walletKey);
            if (!local.some((s) => s.swap_id === record.swap_id)) {
              saveSwapRecord(walletKey, record);
              changed = true;
            } else {
              // Update status if server has newer info
              const existing = local.find((s) => s.swap_id === record.swap_id);
              if (existing && existing.status !== record.status) {
                saveSwapRecord(walletKey, record);
                changed = true;
              }
            }
          }
          if (changed) renderSwapHistory();
        }
        _swapSyncSucceeded = true;
        // Always render and auto-resume after sync, even if no new records from server
        renderSwapHistory();
        autoResumePendingSwaps();
      } catch (_) {} // Non-critical — local history still works
    }
    // Expose sync function so code outside bindSwap() scope can trigger it
    window._triggerSwapSync = function() {
      if (!_swapSyncSucceeded) syncSwapHistoryFromServer();
    };
    // Run after a short delay to not block UI initialization
    setTimeout(syncSwapHistoryFromServer, 3000);

    // Background poll ALL pending swaps (not just the focused one)
    let bgPollTimer = null;
    function autoResumePendingSwaps() {
      if (bgPollTimer) clearInterval(bgPollTimer);
      bgPollTimer = setInterval(pollAllPendingSwaps, 10000);
      pollAllPendingSwaps(); // Run immediately
    }
    async function pollAllPendingSwaps() {
      const swaps = getSwapsForWallet(getSwapWalletKey());
      const pending = swaps.filter((s) => isSwapPending(s.status));
      if (pending.length === 0) { if (bgPollTimer) { clearInterval(bgPollTimer); bgPollTimer = null; } return; }
      for (const s of pending) {
        try {
          const res = await swapFetch(`/api/swaps/${s.swap_id}`);
          if (!res) continue;
          if (res.status !== s.status) {
            persistSwap({
              swap_id: s.swap_id, status: res.status,
              minted_tx: res.minted_tx, payout_tx: res.payout_tx, error: res.error,
            });
            renderSwapHistory();
            // If this is the actively focused swap, update UI
            if (swapId === s.swap_id) pollSwapStatus();
          }
        } catch (_) {}
      }
    }
  }

  function bindSend() {
    const amountInput = document.getElementById('sendAmount');
    amountInput?.addEventListener('input', () => updateSendBalanceHint(amountInput.value));
    updateSendBalanceHint(amountInput?.value || '');
    document.getElementById('btnSend')?.addEventListener('click', async () => {
      const address = document.getElementById('sendAddress').value.trim();
      const amountStr = document.getElementById('sendAmount').value.trim();
      const priority = parseInt(document.getElementById('sendPriority').value, 10) || 1;
      if (!address || !amountStr) {
        showMessage('sendMessage', 'Enter address and amount.', true);
        return;
      }
      const amountAtomic = parseDecimalToAtomic(amountStr, USDM_DECIMALS);
      if (!(amountAtomic > 0n)) {
        showMessage('sendMessage', 'Invalid amount.', true);
        return;
      }
      try {
        let available = 0n;
        const { parsed } = await fetchUsdmBalance();
        available = parsed.unlocked_balance > 0n ? parsed.unlocked_balance : parsed.balance;
        if (available === 0n) {
          try {
            const incoming = await fetchIncomingUsdmTotals({ minAgeMs: 0, force: true });
            const incomingAvailable = incoming.unlocked > 0n ? incoming.unlocked : incoming.total;
            if (incomingAvailable > available) available = incomingAvailable;
          } catch (_) {}
        }
        if (available < amountAtomic) {
          updateSendBalanceHint(amountStr);
          showMessage('sendMessage', 'Insufficient USDm balance.', true);
          return;
        }
      } catch (_) {}
      showMessage('sendMessage', 'Sending…');
      try {
        const amount = Number(amountAtomic);
        const txResult = await rpcImmediate('transfer', {
          destinations: [{ amount: amount, address: address }],
          priority: priority,
          get_tx_key: true,
          get_tx_hex: false,
          get_tx_metadata: false,
        });
        const txHash = txResult && (txResult.tx_hash || txResult.txid) || '';
        const explorerBase = DEFAULT_EXPLORER_URL;
        const sendMsgEl = document.getElementById('sendMessage');
        if (sendMsgEl && txHash) {
          sendMsgEl.innerHTML = 'Transaction submitted: <a href="' + explorerBase + '/tx/' + escHtml(txHash) + '" target="_blank" class="tx-link">' + escHtml(txHash.slice(0, 12)) + '…</a> — waiting for confirmation…';
          sendMsgEl.classList.remove('error');
          sendMsgEl.classList.add('success');
        } else {
          showMessage('sendMessage', 'Transaction submitted. Waiting for confirmation…', false);
        }
        document.getElementById('sendAddress').value = '';
        document.getElementById('sendAmount').value = '';
        // Poll for confirmation: auto-mine should pick it up, then refresh balance
        let confirmed = false;
        for (let poll = 0; poll < 15; poll++) {
          await new Promise((ok) => setTimeout(ok, 2000));
          await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 10000 }).catch(() => {});
          await refreshBalances({ force: true }).catch(() => {});
          await refreshTransfers().catch(() => {});
          // Check if tx is no longer pending
          if (txHash) {
            try {
              const transfers = await rpcImmediate('get_transfers', { out: true, pending: false, pool: false }, { timeoutMs: 8000 });
              const outList = transfers.out || [];
              if (outList.some((t) => t.txid === txHash)) { confirmed = true; break; }
            } catch (_) {}
          } else {
            confirmed = true; break;
          }
        }
        if (sendMsgEl && txHash) {
          const label = confirmed ? 'Transaction confirmed' : 'Transaction submitted';
          sendMsgEl.innerHTML = label + ': <a href="' + explorerBase + '/tx/' + escHtml(txHash) + '" target="_blank" class="tx-link">' + escHtml(txHash.slice(0, 12)) + '…</a>';
          sendMsgEl.classList.remove('error');
          sendMsgEl.classList.add('success');
        } else {
          showMessage('sendMessage', confirmed ? 'Transaction confirmed.' : 'Transaction submitted.', false);
        }
        updateSendBalanceHint('');
      } catch (e) {
        showMessage('sendMessage', e.message || 'Send failed.', true);
      }
    });
  }

  function copyToClipboard(text) {
    copyText(text);
  }

  function bindReceive() {
    document.getElementById('btnCopyAddress')?.addEventListener('click', () => {
      const addr = document.getElementById('receiveAddress').textContent;
      if (addr && !addr.startsWith('Connect')) {
        copyToClipboard(addr);
        const btn = document.getElementById('btnCopyAddress');
        if (btn) {
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = 'Copy'), 2000);
        }
      }
    });
  }

  // --- Staking ---
  const STAKING_SERVICE_URL_KEY = 'monerousd_staking_service_url';
  const DEFAULT_STAKING_URL = 'https://staking.monerousd.org';

  function getStakingUrl() {
    return storageGet(STAKING_SERVICE_URL_KEY) || DEFAULT_STAKING_URL;
  }

  async function fetchStakingInfo() {
    try {
      const res = await fetch(getStakingUrl() + '/api/staking/info');
      return await res.json();
    } catch (_) { return null; }
  }

  async function fetchReserves() {
    try {
      const swapUrl = storageGet('monerousd_swap_backend_url') || DEFAULT_SWAP_BACKEND;
      const res = await fetch(swapUrl + '/api/reserves');
      return await res.json();
    } catch (_) { return null; }
  }

  async function fetchMyStakes() {
    if (!currentWalletAddress) return [];
    try {
      const res = await fetch(getStakingUrl() + '/api/staking/stakes?address=' + encodeURIComponent(currentWalletAddress));
      const data = await res.json();
      return data.stakes || [];
    } catch (_) { return []; }
  }

  async function refreshStakingUI() {
    const info = await fetchStakingInfo();
    const totalStakedEl = document.getElementById('stakingTotalStaked');
    const totalYieldEl = document.getElementById('stakingTotalYield');

    if (info) {
      if (totalStakedEl) totalStakedEl.textContent = '$' + Number(info.total_staked_usdm || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (totalYieldEl) totalYieldEl.textContent = '$' + Number(info.total_yield_paid_usdm || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Render user's stakes
    const listEl = document.getElementById('stakesList');
    if (!listEl) return;
    const stakes = await fetchMyStakes();
    if (stakes.length === 0) {
      listEl.innerHTML = '<div class="text-muted">No active stakes.</div>';
      return;
    }
    listEl.innerHTML = stakes.map((s) => {
      const claimable = Number(s.yield_claimable_usdm || 0);
      const locked = s.unlock_block > 0;
      return '<div class="stake-item">' +
        '<div class="stake-item-info">' +
          '<div class="stake-item-tier">' + escHtml(s.tier_label) + ' — ' + escHtml((s.apr * 100).toFixed(1)) + '% APR</div>' +
          '<div class="stake-item-amount">' + escHtml(Number(s.amount_usdm).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' USDm</div>' +
          '<div class="stake-item-yield">Earned: ' + escHtml(Number(s.yield_earned_usdm).toFixed(4)) + ' USDm</div>' +
          (locked ? '<div class="stake-item-lock">Unlocks at block ' + escHtml(s.unlock_block) + '</div>' : '') +
        '</div>' +
        '<div class="stake-item-actions">' +
          (claimable > 0 ? '<button class="btn btn-ghost btn-sm" data-claim="' + escHtml(s.id) + '">Claim ' + escHtml(claimable.toFixed(4)) + '</button>' : '') +
          (s.status === 'active' ? '<button class="btn btn-ghost btn-sm" data-unstake="' + escHtml(s.id) + '">Unstake</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    // Bind claim/unstake buttons
    listEl.querySelectorAll('[data-claim]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.claim;
        btn.disabled = true;
        btn.textContent = 'Claiming...';
        try {
          await fetch(getStakingUrl() + '/api/staking/claim/' + id, { method: 'POST' });
          await refreshStakingUI();
        } catch (e) {
          showMessage('stakeMessage', 'Claim failed: ' + (e.message || 'Unknown error'), true);
        }
        btn.disabled = false;
      });
    });
    listEl.querySelectorAll('[data-unstake]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.unstake;
        btn.disabled = true;
        btn.textContent = 'Unstaking...';
        try {
          // First get the stake details to retrieve key_images
          const infoRes = await fetch(getStakingUrl() + '/api/staking/stakes/' + id);
          const stakeInfo = await infoRes.json();

          // Call unstake on the service
          const res = await fetch(getStakingUrl() + '/api/staking/unstake/' + id, { method: 'POST' });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          // Thaw (unfreeze) the outputs so they return to spendable balance
          const keyImages = stakeInfo.key_images || (data.key_images) || [];
          for (const ki of keyImages) {
            try {
              await rpc('thaw', { key_image: ki });
            } catch (_) { /* output may already be thawed or spent */ }
          }

          await refreshBalances({ force: true }).catch(() => {});
          await refreshStakingUI();
          showMessage('stakeMessage', 'Unstaked successfully. Funds returned to balance.', false);
        } catch (e) {
          showMessage('stakeMessage', 'Unstake failed: ' + (e.message || 'Unknown error'), true);
        }
        btn.disabled = false;
      });
    });
  }

  function bindStaking() {
    const btnStake = document.getElementById('btnStake');
    if (!btnStake) return;

    btnStake.addEventListener('click', async () => {
      const tierEl = document.getElementById('stakeTier');
      const amountEl = document.getElementById('stakeAmount');
      const msg = document.getElementById('stakeMessage');
      const tier = tierEl ? tierEl.value : 'flexible';
      const amountStr = (amountEl ? amountEl.value : '').trim();
      const amount = parseFloat(amountStr);

      if (!amount || amount <= 0) {
        showMessage('stakeMessage', 'Enter a valid amount.', true);
        return;
      }

      const amountAtomic = BigInt(Math.round(amount * 1e8)).toString();
      if (!currentWalletAddress) {
        showMessage('stakeMessage', 'No wallet connected.', true);
        return;
      }

      btnStake.disabled = true;
      btnStake.textContent = 'Staking...';
      showMessage('stakeMessage', 'Preparing stake...', false);

      try {
        const target = BigInt(amountAtomic);

        // Step 1: Check if we have an output that exactly matches the stake amount.
        // If not, send the exact stake amount to ourselves to create a correctly-sized output.
        let transfers = await rpc('incoming_transfers', { transfer_type: 'available' });
        let available = (transfers.transfers || []).filter((t) => !t.spent && !t.frozen);

        // Look for an exact-match output first
        let exactMatch = available.find((t) => BigInt(t.amount) === target);
        let stakeTxHash = '';
        if (!exactMatch) {
          // No exact output — send the stake amount to ourselves to create one
          showMessage('stakeMessage', 'Splitting output for exact stake amount...', false);
          const splitResult = await rpc('transfer', {
            destinations: [{ amount: Number(target), address: currentWalletAddress }],
            priority: 1,
          });
          stakeTxHash = splitResult.tx_hash || '';

          // Wait for the self-transfer to be mined (auto-miner should pick it up)
          showMessage('stakeMessage', 'Waiting for transaction to confirm...', false);
          for (let wait = 0; wait < 30; wait++) {
            await new Promise((ok) => setTimeout(ok, 3000));
            await rpc('refresh', { start_height: 0 }).catch(() => {});
            transfers = await rpc('incoming_transfers', { transfer_type: 'available' });
            available = (transfers.transfers || []).filter((t) => !t.spent && !t.frozen);
            exactMatch = available.find((t) => BigInt(t.amount) === target);
            if (exactMatch) break;
          }
          if (!exactMatch) {
            throw new Error('Could not create exact-amount output. Try again in a moment.');
          }
        } else {
          // Output already exists — find the tx that created it via get_transfers
          try {
            const txHistory = await rpc('get_transfers', { in: true, out: true, pending: false, pool: false });
            const allTxs = [...(txHistory.in || []), ...(txHistory.out || [])];
            // Find the most recent tx as a reasonable reference
            allTxs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            if (allTxs.length > 0) stakeTxHash = allTxs[0].txid || '';
          } catch (_) {}
        }

        // Step 2: Freeze the exact output
        showMessage('stakeMessage', 'Freezing output and creating stake...', false);
        await rpc('freeze', { key_image: exactMatch.key_image });
        const keyImages = [exactMatch.key_image];

        // Step 3: Create stake on the staking service with exact amount
        const res = await fetch(getStakingUrl() + '/api/staking/stake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tier,
            amount_atomic: target.toString(),
            wallet_address: currentWalletAddress,
            key_images: keyImages,
            tx_hash: stakeTxHash,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        showMessage('stakeMessage', 'Staked ' + (Number(target) / 1e8).toFixed(2) + ' USDm successfully!', false);
        if (amountEl) amountEl.value = '';
        await refreshStakingUI();
        await refreshBalances({ force: true }).catch(() => {});
      } catch (e) {
        showMessage('stakeMessage', 'Stake failed: ' + (e.message || 'Unknown error'), true);
      } finally {
        btnStake.disabled = false;
        btnStake.textContent = 'Stake';
      }
    });

    // Refresh staking info when page is shown
    const observer = new MutationObserver(() => {
      const stakingPage = document.getElementById('pageStaking');
      if (stakingPage && stakingPage.classList.contains('active')) {
        refreshStakingUI();
      }
    });
    const stakingPage = document.getElementById('pageStaking');
    if (stakingPage) observer.observe(stakingPage, { attributes: true, attributeFilter: ['class'] });
  }

  // --- Lending ---
  const LENDING_SERVICE_URL_KEY = 'monerousd_lending_service_url';
  const DEFAULT_LENDING_URL = 'https://lending.monerousd.org';

  function getLendingUrl() {
    return storageGet(LENDING_SERVICE_URL_KEY) || DEFAULT_LENDING_URL;
  }

  async function fetchLendingInfo() {
    try {
      const res = await fetch(getLendingUrl() + '/api/lending/info');
      return await res.json();
    } catch (_) { return null; }
  }

  async function fetchMyLoans() {
    // Ensure we have the wallet address — try fetching if not cached yet
    let addr = currentWalletAddress;
    if (!addr) {
      try {
        const r = await rpc('get_address', {});
        if (r && r.address) {
          currentWalletAddress = r.address;
          addr = r.address;
          if (typeof window._triggerSwapSync === 'function') {
            window._triggerSwapSync();
          }
        }
      } catch (_) {}
    }
    if (!addr) return [];
    try {
      const res = await fetch(getLendingUrl() + '/api/loans?address=' + encodeURIComponent(addr));
      return await res.json();
    } catch (_) { return []; }
  }

  async function refreshLendingUI() {
    const info = await fetchLendingInfo();
    const capacityEl = document.getElementById('lendingCapacity');
    const utilEl = document.getElementById('lendingUtilization');
    const btcRateEl = document.getElementById('lendingBtcRate');
    const xmrRateEl = document.getElementById('lendingXmrRate');
    const btcPriceEl = document.getElementById('lendingBtcPrice');
    const xmrPriceEl = document.getElementById('lendingXmrPrice');

    if (info) {
      if (capacityEl) capacityEl.textContent = '$' + Number(info.available_capacity_usd || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      if (utilEl) utilEl.textContent = (info.utilization || 0).toFixed(1) + '%';
      if (btcRateEl) btcRateEl.textContent = (info.btc_interest_rate || 0).toFixed(1) + '% APR';
      if (xmrRateEl) xmrRateEl.textContent = (info.xmr_interest_rate || 0).toFixed(1) + '% APR';
    }

    // Fetch and display live BTC/XMR prices
    const btcPrice = await fetchLendingPrice('BTC');
    const xmrPrice = await fetchLendingPrice('XMR');
    if (btcPriceEl && btcPrice > 0) btcPriceEl.textContent = '$' + btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (xmrPriceEl && xmrPrice > 0) xmrPriceEl.textContent = '$' + xmrPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Render user's loans
    const listEl = document.getElementById('loansList');
    if (!listEl) return;
    const allLoans = await fetchMyLoans();
    // Show active, awaiting_collateral, liquidated, repaid — hide cancelled
    const loans = Array.isArray(allLoans) ? allLoans.filter((l) => l.status !== 'cancelled') : [];
    if (loans.length === 0) {
      listEl.innerHTML = '<div class="text-muted">No active loans.</div>';
      return;
    }
    listEl.innerHTML = loans.map((l) => {
      const statusClass = l.status === 'active' ? 'loan-active' : (l.status === 'liquidated' ? 'loan-liquidated' : (l.status === 'awaiting_collateral' ? 'loan-pending' : ''));
      const interestUsdm = Number(l.interest_accrued_usdm || 0);
      const isPending = l.status === 'awaiting_collateral';
      return '<div class="stake-item ' + statusClass + '">' +
        '<div class="stake-item-info">' +
          '<div class="stake-item-tier">' + escHtml(l.collateral_asset) + ' Loan — ' + escHtml(l.interest_rate) + '% APR' +
            (isPending ? ' <span class="loan-badge-pending">Pending</span>' : '') +
          '</div>' +
          '<div class="stake-item-amount">Collateral: ' + escHtml(l.collateral_amount) + ' ' + escHtml(l.collateral_asset) + '</div>' +
          '<div class="stake-item-amount">Loan amount: ' + escHtml(Number(l.loan_usdm || 0).toFixed(2)) + ' USDm</div>' +
          (isPending ? '' : '<div class="stake-item-yield">Interest: ' + escHtml(interestUsdm.toFixed(4)) + ' USDm | LTV: ' + escHtml(l.current_ltv || l.ltv) + '%</div>') +
          (l.status === 'liquidated' ? '<div class="stake-item-lock" style="color:#e74c3c">Liquidated</div>' : '') +
          (isPending ? '<div class="stake-item-lock" style="color:#FF6600">Awaiting your collateral deposit</div>' : '') +
          (l.status === 'repaid' ? '<div class="stake-item-lock" style="color:#27ae60">Repaid</div>' : '') +
          /* Expandable deposit details for pending loans */
          (isPending ? '<div class="loan-deposit-details hidden" id="loanDeposit_' + escHtml(l.id) + '">' +
            '<div class="loan-deposit-box">' +
              '<div class="loan-deposit-label">Send exactly:</div>' +
              '<div class="loan-deposit-value">' + escHtml(l.collateral_amount) + ' ' + escHtml(l.collateral_asset) + '</div>' +
              '<div class="loan-deposit-label">To this ' + escHtml(l.collateral_asset) + ' address:</div>' +
              '<div class="loan-deposit-addr">' +
                '<code id="loanAddr_' + escHtml(l.id) + '">' + escHtml(l.collateral_address || 'N/A') + '</code>' +
                '<button class="btn btn-ghost btn-sm" data-copy-addr="' + escHtml(l.id) + '">Copy</button>' +
              '</div>' +
              '<div class="loan-deposit-note">Once your deposit is confirmed on-chain, ' + escHtml(Number(l.loan_usdm || 0).toFixed(2)) + ' USDm will be sent to your wallet automatically.</div>' +
            '</div>' +
          '</div>' : '') +
        '</div>' +
        '<div class="stake-item-actions">' +
          (isPending ? '<button class="btn btn-primary btn-sm" data-deposit="' + escHtml(l.id) + '">Complete Deposit</button>' +
            '<button class="btn btn-ghost btn-sm" data-cancel-loan="' + escHtml(l.id) + '">Cancel</button>' : '') +
          (l.status === 'active' ? '<button class="btn btn-ghost btn-sm" data-repay="' + escHtml(l.id) + '">Repay</button>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    // Bind "Complete Deposit" toggle buttons
    listEl.querySelectorAll('[data-deposit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.deposit;
        const detailsEl = document.getElementById('loanDeposit_' + id);
        if (detailsEl) {
          const isHidden = detailsEl.classList.contains('hidden');
          detailsEl.classList.toggle('hidden');
          btn.textContent = isHidden ? 'Hide Details' : 'Complete Deposit';
        }
      });
    });

    // Bind copy address buttons
    listEl.querySelectorAll('[data-copy-addr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.copyAddr;
        const addrEl = document.getElementById('loanAddr_' + id);
        if (addrEl && navigator.clipboard) {
          navigator.clipboard.writeText(addrEl.textContent).then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
          });
        }
      });
    });

    // Bind cancel loan buttons
    listEl.querySelectorAll('[data-cancel-loan]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.cancelLoan;
        if (!confirm('Cancel this loan? This cannot be undone.')) return;
        btn.disabled = true;
        btn.textContent = 'Cancelling...';
        try {
          const res = await fetch(getLendingUrl() + '/api/loans/' + id + '/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          showMessage('loanMessage', 'Loan cancelled.', false);
          await refreshLendingUI();
        } catch (e) {
          showMessage('loanMessage', 'Cancel failed: ' + (e.message || 'Unknown error'), true);
          btn.disabled = false;
          btn.textContent = 'Cancel';
        }
      });
    });

    // Bind repay buttons
    listEl.querySelectorAll('[data-repay]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.repay;
        btn.disabled = true;
        btn.textContent = 'Loading...';
        try {
          const res = await fetch(getLendingUrl() + '/api/loans/' + id + '/repay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          showMessage('loanMessage',
            'To repay, send ' + data.total_owed_usdm + ' USDm to burn address: ' + data.burn_address, false);
        } catch (e) {
          showMessage('loanMessage', 'Repay failed: ' + (e.message || 'Unknown error'), true);
        }
        btn.disabled = false;
        btn.textContent = 'Repay';
      });
    });
  }

  // Live price cache for lending estimate
  let lendingPriceCache = { BTC: 0, XMR: 0, ts: 0 };
  const LENDING_PRICE_TTL = 15000; // 15s

  async function fetchLendingPrice(asset) {
    const now = Date.now();
    if (now - lendingPriceCache.ts < LENDING_PRICE_TTL && lendingPriceCache[asset] > 0) {
      return lendingPriceCache[asset];
    }
    // Try swap backend first
    try {
      const base = getSwapBackendUrl().replace(/\/$/, '');
      const res = await fetch(base + '/api/price?asset=' + asset);
      const data = await res.json();
      if (data && data.price_usd > 0) {
        lendingPriceCache[asset] = data.price_usd;
        lendingPriceCache.ts = now;
        return data.price_usd;
      }
    } catch (_) {}
    // Fallback: CoinGecko direct
    try {
      const ids = asset === 'BTC' ? 'bitcoin' : 'monero';
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd');
      const data = await res.json();
      const price = data && data[ids] && data[ids].usd;
      if (price > 0) {
        lendingPriceCache[asset] = price;
        lendingPriceCache.ts = now;
        return price;
      }
    } catch (_) {}
    return lendingPriceCache[asset] || 0;
  }

  let lendingEstimateTimer = null;
  function updateLendingEstimate() {
    if (lendingEstimateTimer) clearTimeout(lendingEstimateTimer);
    lendingEstimateTimer = setTimeout(async () => {
      const assetEl = document.getElementById('loanAsset');
      const amountEl = document.getElementById('loanCollateralAmount');
      const estimateEl = document.getElementById('loanEstimate');
      if (!estimateEl) return;

      const asset = assetEl ? assetEl.value : 'BTC';
      const amount = parseFloat((amountEl ? amountEl.value : '').trim());
      if (!amount || amount <= 0) {
        estimateEl.textContent = '';
        return;
      }

      const price = await fetchLendingPrice(asset);
      if (!price) {
        estimateEl.textContent = 'Price unavailable';
        return;
      }

      const maxLtv = asset === 'BTC' ? 0.65 : 0.55;
      const collateralValueUsd = amount * price;
      const maxLoanUsd = collateralValueUsd * maxLtv;

      estimateEl.textContent =
        escHtml(asset) + ' price: $' + price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) +
        ' | Collateral: $' + collateralValueUsd.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) +
        ' | Max loan (' + Math.round(maxLtv * 100) + '% LTV): ~' + maxLoanUsd.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' USDm';
    }, 300);
  }

  function bindLending() {
    const btnCreateLoan = document.getElementById('btnCreateLoan');
    if (!btnCreateLoan) return;

    // Auto-fill USDm address from wallet
    const loanAddrEl = document.getElementById('loanUsdmAddress');
    if (loanAddrEl && currentWalletAddress && !loanAddrEl.value) {
      loanAddrEl.value = currentWalletAddress;
    }

    // Live price estimate on input change
    const collateralAmountEl = document.getElementById('loanCollateralAmount');
    const loanAssetEl = document.getElementById('loanAsset');
    if (collateralAmountEl) collateralAmountEl.addEventListener('input', updateLendingEstimate);
    if (loanAssetEl) loanAssetEl.addEventListener('change', updateLendingEstimate);

    btnCreateLoan.addEventListener('click', async () => {
      const assetEl = document.getElementById('loanAsset');
      const amountEl = document.getElementById('loanCollateralAmount');
      const addrEl = document.getElementById('loanUsdmAddress');
      const asset = assetEl ? assetEl.value : 'BTC';
      const amount = (amountEl ? amountEl.value : '').trim();
      const addr = (addrEl ? addrEl.value : '').trim();

      if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        showMessage('loanMessage', 'Enter a valid collateral amount.', true);
        return;
      }
      if (!addr) {
        showMessage('loanMessage', 'Enter your USDm address.', true);
        return;
      }

      btnCreateLoan.disabled = true;
      btnCreateLoan.textContent = 'Creating loan...';

      try {
        const res = await fetch(getLendingUrl() + '/api/loans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            asset,
            collateral_amount: amount,
            usdm_address: addr,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        showMessage('loanMessage',
          'Loan created! Send ' + data.collateral_amount + ' ' + data.collateral_asset +
          ' to ' + data.collateral_address + ' to receive ' + Number(data.expected_usdm).toFixed(2) + ' USDm at ' +
          data.interest_rate + '% APR.', false);
        if (amountEl) amountEl.value = '';
        await refreshLendingUI();
      } catch (e) {
        showMessage('loanMessage', 'Loan creation failed: ' + (e.message || 'Unknown error'), true);
      } finally {
        btnCreateLoan.disabled = false;
        btnCreateLoan.textContent = 'Create Loan';
      }
    });

    // Refresh lending info when page is shown
    const observer = new MutationObserver(() => {
      const lendingPage = document.getElementById('pageLending');
      if (lendingPage && lendingPage.classList.contains('active')) {
        refreshLendingUI();
        // Auto-fill address
        const addrEl = document.getElementById('loanUsdmAddress');
        if (addrEl && currentWalletAddress && !addrEl.value) {
          addrEl.value = currentWalletAddress;
        }
      }
    });
    const lendingPage = document.getElementById('pageLending');
    if (lendingPage) observer.observe(lendingPage, { attributes: true, attributeFilter: ['class'] });
  }

  function bindSettings() {
    const browserNotice = document.getElementById('browserModeNotice');
    const desktopSettings = document.getElementById('desktopRpcSettings');
    const customNodeToggle = document.getElementById('useCustomNodeToggle');

    // Determine if currently using relay (non-localhost RPC)
    const currentRpc = storageGet(RPC_STORAGE_KEY) || DEFAULT_RPC;
    const usingRelay = !/127\.0\.0\.1|localhost/i.test(currentRpc);

    // Show relay-connected notice for both browser and desktop modes
    if (browserNotice) browserNotice.classList.remove('hidden');
    // Hide RPC fields by default when using relay — toggle to reveal
    if (desktopSettings && usingRelay) desktopSettings.classList.add('hidden');
    // Pre-check the toggle if already using custom node
    if (customNodeToggle && !usingRelay) customNodeToggle.checked = true;

    // Wire up the toggle
    if (customNodeToggle) {
      customNodeToggle.addEventListener('change', () => {
        if (desktopSettings) {
          desktopSettings.classList.toggle('hidden', !customNodeToggle.checked);
        }
        // When toggling off custom node, disconnect and reset to relay defaults
        if (!customNodeToggle.checked) {
          setRpcUrl(RELAY_RPC_URL);
          setDaemonUrl(RELAY_DAEMON_URL);
          const rpcEl = document.getElementById('rpcUrl');
          const daemonEl = document.getElementById('daemonUrl');
          if (rpcEl) rpcEl.value = RELAY_RPC_URL;
          if (daemonEl) daemonEl.value = RELAY_DAEMON_URL;
        } else {
          // When toggling on, show empty fields so user can enter their own node details.
          // Do NOT auto-fill with localhost — user must explicitly enter their node URL.
          const rpcEl = document.getElementById('rpcUrl');
          const daemonEl = document.getElementById('daemonUrl');
          if (rpcEl) { rpcEl.value = ''; rpcEl.placeholder = 'e.g. http://192.0.2.1:27750'; }
          if (daemonEl) { daemonEl.value = ''; daemonEl.placeholder = 'e.g. http://192.0.2.1:17750'; }
        }
      });
    }
    const rpcEl = document.getElementById('rpcUrl');
    if (rpcEl) rpcEl.value = rpcUrl;
    const daemonEl = document.getElementById('daemonUrl');
    if (daemonEl) daemonEl.value = storageGet(DAEMON_URL_STORAGE_KEY) || DEFAULT_DAEMON_URL;
    const swapBackendEl = document.getElementById('swapBackendUrl');
    if (swapBackendEl) swapBackendEl.value = storageGet(SWAP_BACKEND_STORAGE_KEY) || DEFAULT_SWAP_BACKEND;
    setLightWalletConfig(storageGet(LIGHT_WALLET_URL_KEY) || '', storageGet(LIGHT_WALLET_TOKEN_KEY) || '', storageGet(LIGHT_WALLET_ENABLED_KEY) === 'true');
    document.getElementById('btnSaveRpc')?.addEventListener('click', async () => {
      const url = document.getElementById('rpcUrl').value.trim();
      const daemonUrl = (document.getElementById('daemonUrl') || {}).value.trim() || DEFAULT_DAEMON_URL;
      const swapBackendUrl = (document.getElementById('swapBackendUrl') || {}).value.trim() || DEFAULT_SWAP_BACKEND;
      const lightUrl = (document.getElementById('lightWalletUrl') || {}).value.trim();
      const lightToken = (document.getElementById('lightWalletToken') || {}).value.trim();
      const lightEnabled = !!(document.getElementById('lightWalletEnabled') || {}).checked;
      setDaemonUrl(daemonUrl);
      setSwapBackendUrl(swapBackendUrl);
      setLightWalletConfig(lightUrl, lightToken, lightEnabled);
      const hint = document.getElementById('swapBackendHint');
      if (hint) hint.textContent = 'Swap backend: ' + getSwapBackendUrl();
      if (!url) return;
      setRpcUrl(url);
      rpcFailureCount = 0;
      showMessage('settingsMessage', 'Saved. Connecting…');
      const connectWatchdog = setTimeout(() => {
        showMessage('settingsMessage', 'Connection still running. You can click Refresh to retry.', true);
        showSyncStatus('', false);
      }, 20000);
      try {
        const result = await checkConnection({ timeoutMs: 12000 });
        if (result.noWallet) {
          showMessage('settingsMessage', 'Connected. No wallet open — use Import to restore from seed or create a wallet.', false);
        } else {
          await configureWalletRpcMoneroStyle().catch(() => {});
          showMessage('settingsMessage', result.addressError ? 'Connected. Wallet may be busy; click Refresh to sync.' : 'Connected. Daemon set; auto-refresh enabled (Monero-style).', false);
          refreshBalances().catch(() => {});
          refreshAddress().catch(() => {});
          refreshTransfers().catch(() => {});
          startBalanceRefreshInterval();
          rpc('refresh', { start_height: 0 }, { timeoutMs: 300000 })
            .then(() => { refreshBalances(); updateDashboardSyncInfo(); })
            .catch(() => {});
        }
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : 'Connection failed';
        showMessage('settingsMessage', msg.length > 60 ? msg.slice(0, 57) + '…' : msg, true);
      } finally {
        clearTimeout(connectWatchdog);
      }
    });
  }

  /* ── Local Node ──────────────────────────────────────────── */
  let nodePollTimer = null;
  let nodeRunning = false;

  function bindLocalNode() {
    const btnCreate = document.getElementById('btnCreateNode');
    const btnStop = document.getElementById('btnStopNode');
    const btnAdvanced = document.getElementById('btnNodeAdvanced');
    const advancedPanel = document.getElementById('nodeAdvanced');
    const setupPanel = document.getElementById('nodeSetupPanel');
    const runningPanel = document.getElementById('nodeRunningPanel');
    const setupSteps = document.getElementById('nodeSetupSteps');
    const setupBox = document.getElementById('nodeSetupBox');
    if (!btnCreate) return;

    const isElectron = !!(window.electronAPI && window.electronAPI.localNodeSetup);

    function showRunningState() {
      if (setupPanel) setupPanel.classList.add('hidden');
      if (runningPanel) runningPanel.classList.remove('hidden');
    }

    function showSetupState() {
      if (setupPanel) setupPanel.classList.remove('hidden');
      if (runningPanel) runningPanel.classList.add('hidden');
      if (setupBox) setupBox.classList.remove('hidden');
      if (setupSteps) setupSteps.classList.add('hidden');
    }

    function markStep(id, status, text) {
      const el = document.getElementById(id);
      if (!el) return;
      el.className = 'node-setup-step ' + status;
      const icon = el.querySelector('.step-icon');
      if (icon) {
        if (status === 'done') icon.textContent = '\u2713';
        else if (status === 'active') icon.textContent = '\u25CF';
        else if (status === 'error') icon.textContent = '\u2717';
        else icon.textContent = '\u25CB';
      }
      if (text) {
        const textNode = el.childNodes[el.childNodes.length - 1];
        if (textNode) textNode.textContent = ' ' + text;
      }
    }

    // One-click Create Node button
    btnCreate.addEventListener('click', async () => {
      btnCreate.disabled = true;
      btnCreate.textContent = 'Setting up...';
      showMessage('nodeMessage', '', false);
      if (setupBox) setupBox.classList.add('hidden');
      if (setupSteps) setupSteps.classList.remove('hidden');

      markStep('stepBinaries', 'active', 'Finding USDmd binaries...');
      markStep('stepDirs', '', 'Creating data directories...');
      markStep('stepDaemon', '', 'Starting USDmd daemon...');
      markStep('stepSync', '', 'Connecting to network...');

      const seedInput = document.getElementById('nodeSeedNode');
      const seeds = seedInput && seedInput.value.trim() ? [seedInput.value.trim()] : [];

      if (isElectron) {
        // Electron mode: use the one-click setup IPC
        const result = await window.electronAPI.localNodeSetup({ seedNodes: seeds });

        if (!result.ok) {
          markStep('stepBinaries', 'error', result.error || 'Setup failed');
          showMessage('nodeMessage', result.error || 'Setup failed', true);
          btnCreate.disabled = false;
          btnCreate.textContent = '\u25B6 Create Node & Start Syncing';
          return;
        }

        // Animate through completed steps
        for (const step of result.steps || []) {
          if (/found.*USDmd|installed.*USDmd/i.test(step)) markStep('stepBinaries', 'done', step);
          if (/created|directory/i.test(step)) markStep('stepDirs', 'done', step);
          if (/started.*USDmd|daemon.*running/i.test(step)) markStep('stepDaemon', 'done', step);
        }
        markStep('stepDirs', 'done', 'Data directories ready');
        if (!result.steps?.some(s => /started|running/i.test(s))) {
          markStep('stepDaemon', 'done', 'Daemon started');
        }
        markStep('stepSync', 'active', 'Syncing with USDm network...');

        // Transition to running view after a moment
        await new Promise(r => setTimeout(r, 1500));
        markStep('stepSync', 'done', 'Connected to network!');
        await new Promise(r => setTimeout(r, 800));

        nodeRunning = true;
        showRunningState();
        startNodePoll();
        showMessage('nodeMessage', 'Node created and running!', false);

      } else {
        // Browser mode: check if daemon is reachable (server manages it)
        markStep('stepBinaries', 'active', 'Checking daemon connection...');
        try {
          const res = await fetch('/daemon_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info', params: {} }),
          });
          const data = await res.json();
          if (data && data.result) {
            markStep('stepBinaries', 'done', 'USDmd daemon found');
            markStep('stepDirs', 'done', 'Data directories ready');
            markStep('stepDaemon', 'done', 'Daemon running at height ' + (data.result.height || 0));
            markStep('stepSync', 'done', 'Connected to network!');
            await new Promise(r => setTimeout(r, 1200));
            nodeRunning = true;
            showRunningState();
            updateNodeUI(data.result);
            startNodePoll();
            showMessage('nodeMessage', 'Connected to node!', false);
          } else {
            throw new Error('No response');
          }
        } catch (e) {
          markStep('stepBinaries', 'error', 'Cannot reach daemon');
          showMessage('nodeMessage', 'No daemon running. Start USDmd first: ./start-mainnet.sh', true);
          btnCreate.disabled = false;
          btnCreate.textContent = '\u25B6 Create Node & Start Syncing';
          return;
        }
      }
    });

    // Stop Node button
    if (btnStop) {
      btnStop.addEventListener('click', async () => {
        btnStop.disabled = true;
        if (isElectron) {
          await window.electronAPI.localNodeStop();
        }
        stopNodePoll();
        nodeRunning = false;
        updateNodeUI(null);
        showSetupState();
        btnCreate.disabled = false;
        btnCreate.textContent = '\u25B6 Create Node & Start Syncing';
        showMessage('nodeMessage', 'Node stopped.', false);
      });
    }

    // Listen for unexpected stops (Electron)
    if (isElectron && window.electronAPI.onLocalNodeStopped) {
      window.electronAPI.onLocalNodeStopped((data) => {
        stopNodePoll();
        nodeRunning = false;
        updateNodeUI(null);
        showSetupState();
        btnCreate.disabled = false;
        btnCreate.textContent = '\u25B6 Create Node & Start Syncing';
        showMessage('nodeMessage', 'Node stopped (exit code ' + data.code + ').', data.code !== 0);
      });
    }

    // Advanced toggle
    if (btnAdvanced && advancedPanel) {
      btnAdvanced.addEventListener('click', () => {
        advancedPanel.classList.toggle('hidden');
        btnAdvanced.textContent = advancedPanel.classList.contains('hidden') ? 'Advanced options' : 'Hide advanced';
      });
    }

    // Check if node is already running on load
    (async () => {
      try {
        let isRunning = false;
        if (isElectron) {
          const status = await window.electronAPI.localNodeStatus();
          if (status.running) {
            isRunning = true;
            updateNodeUI(status);
          }
        } else {
          const res = await fetch('/daemon_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info', params: {} }),
          });
          const data = await res.json();
          if (data && data.result) {
            isRunning = true;
            updateNodeUI(data.result);
          }
        }
        if (isRunning) {
          nodeRunning = true;
          showRunningState();
          startNodePoll();
        }
      } catch (_) {}
    })();
  }

  function startNodePoll() {
    stopNodePoll();
    const isElectron = !!(window.electronAPI && window.electronAPI.localNodeStatus);

    nodePollTimer = setInterval(async () => {
      try {
        if (isElectron) {
          const status = await window.electronAPI.localNodeStatus();
          if (status.running) {
            updateNodeUI(status);
            // Update log
            const logOutput = document.getElementById('nodeLogOutput');
            if (logOutput && status.lastLog) {
              logOutput.textContent = status.lastLog.join('\n');
              logOutput.scrollTop = logOutput.scrollHeight;
            }
          } else {
            stopNodePoll();
            nodeRunning = false;
            updateNodeUI(null);
          }
        } else {
          // Browser mode - poll daemon_rpc
          const res = await fetch('/daemon_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info', params: {} }),
          });
          const data = await res.json();
          if (data && data.result) {
            updateNodeUI(data.result);
          }
        }
      } catch (_) {}
    }, 5000);
  }

  function stopNodePoll() {
    if (nodePollTimer) { clearInterval(nodePollTimer); nodePollTimer = null; }
  }

  function updateNodeUI(data) {
    const indicator = document.getElementById('nodeIndicator');
    const statusText = document.getElementById('nodeStatusText');
    const syncBar = document.getElementById('nodeSyncBar');
    const syncFill = document.getElementById('nodeSyncFill');
    const syncLabel = document.getElementById('nodeSyncLabel');
    const statsEl = document.getElementById('nodeStats');

    if (!data) {
      if (indicator) { indicator.classList.remove('running', 'syncing'); }
      if (statusText) statusText.textContent = 'Not running';
      if (syncBar) syncBar.classList.add('hidden');
      if (statsEl) statsEl.classList.add('hidden');
      return;
    }

    const height = data.height || 0;
    const target = data.targetHeight || data.target_height || height;
    const synced = target <= height || target === 0;
    const syncPct = target > 0 ? Math.min(100, Math.round((height / target) * 100)) : 100;
    const peers = (data.peers || 0) || ((data.outgoing_connections_count || 0) + (data.incoming_connections_count || 0)) || (data.outgoingConnections || 0) + (data.incomingConnections || 0);

    if (indicator) {
      indicator.classList.toggle('running', synced);
      indicator.classList.toggle('syncing', !synced);
    }
    if (statusText) {
      statusText.textContent = synced ? 'Synced — Block ' + height.toLocaleString() : 'Syncing... ' + syncPct + '%';
    }
    if (syncBar) {
      syncBar.classList.toggle('hidden', synced);
    }
    if (syncFill) syncFill.style.width = syncPct + '%';
    if (syncLabel) syncLabel.textContent = syncPct + '%';

    if (statsEl) statsEl.classList.remove('hidden');

    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setEl('nodeHeight', height.toLocaleString());
    setEl('nodeTargetHeight', target > 0 ? target.toLocaleString() : '—');
    setEl('nodePeers', peers.toString());
    setEl('nodeTxPool', (data.txPoolSize || data.tx_pool_size || 0).toString());

    const netHash = data.networkHashrate || data.difficulty ? Math.floor((data.difficulty || 0) / 120) : 0;
    setEl('nodeNetHash', netHash > 0 ? netHash.toLocaleString() + ' H/s' : '—');

    const dbSize = data.databaseSize || data.database_size || 0;
    if (dbSize > 0) {
      const mb = (dbSize / (1024 * 1024)).toFixed(1);
      setEl('nodeDbSize', mb > 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb + ' MB');
    } else {
      setEl('nodeDbSize', '—');
    }
  }

  /* ── Mining / Create Node ─────────────────────────────────── */
  let miningPollTimer = null;

  function bindMining() {
    const btnStart = document.getElementById('btnStartMining');
    const btnStop = document.getElementById('btnStopMining');
    const slider = document.getElementById('miningThreads');
    const label = document.getElementById('miningThreadsLabel');
    if (!btnStart || !btnStop) return;

    // Thread slider
    if (slider && label) {
      const maxCores = navigator.hardwareConcurrency || 8;
      slider.max = Math.max(maxCores, 2);
      slider.value = Math.min(2, maxCores);
      label.textContent = slider.value + ' thread' + (slider.value > 1 ? 's' : '');
      slider.addEventListener('input', () => {
        label.textContent = slider.value + ' thread' + (slider.value > 1 ? 's' : '');
      });
    }

    btnStart.addEventListener('click', async () => {
      if (!currentWalletAddress) {
        showMessage('miningMessage', 'Connect wallet first.', true);
        return;
      }
      btnStart.disabled = true;
      btnStart.textContent = 'Starting...';
      showMessage('miningMessage', '', false);

      const threads = parseInt(slider ? slider.value : '2', 10);
      const bgMining = document.getElementById('miningBackground');
      const doBg = bgMining ? bgMining.checked : true;

      try {
        const res = await fetch('/start_mining', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            miner_address: currentWalletAddress,
            threads_count: threads,
            do_background_mining: doBg,
            ignore_battery: true,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
        if (data.status && data.status !== 'OK') throw new Error(data.status);

        showMessage('miningMessage', 'Mining started with ' + threads + ' thread' + (threads > 1 ? 's' : '') + '!', false);
        btnStop.disabled = false;
        btnStart.textContent = 'Mining...';
        startMiningStatusPoll();
      } catch (e) {
        showMessage('miningMessage', 'Failed: ' + (e.message || 'Unknown error'), true);
        btnStart.disabled = false;
        btnStart.textContent = '\u2699 Start Mining';
      }
    });

    btnStop.addEventListener('click', async () => {
      btnStop.disabled = true;
      try {
        await fetch('/stop_mining', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        showMessage('miningMessage', 'Mining stopped.', false);
      } catch (_) {}
      stopMiningStatusPoll();
      updateMiningUI(false);
      btnStart.disabled = false;
      btnStart.textContent = '\u2699 Start Mining';
    });

    // Check initial mining status
    checkMiningStatus();
  }

  async function checkMiningStatus() {
    try {
      const res = await fetch('/mining_status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (data.active) {
        updateMiningUI(true, data);
        startMiningStatusPoll();
        const btnStart = document.getElementById('btnStartMining');
        const btnStop = document.getElementById('btnStopMining');
        if (btnStart) { btnStart.disabled = true; btnStart.textContent = 'Mining...'; }
        if (btnStop) btnStop.disabled = false;
      }
    } catch (_) {}
  }

  function startMiningStatusPoll() {
    stopMiningStatusPoll();
    miningPollTimer = setInterval(async () => {
      try {
        const res = await fetch('/mining_status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        updateMiningUI(data.active, data);
        if (!data.active) {
          stopMiningStatusPoll();
          const btnStart = document.getElementById('btnStartMining');
          const btnStop = document.getElementById('btnStopMining');
          if (btnStart) { btnStart.disabled = false; btnStart.textContent = '\u2699 Start Mining'; }
          if (btnStop) btnStop.disabled = true;
        }
      } catch (_) {}
    }, 3000);
  }

  function stopMiningStatusPoll() {
    if (miningPollTimer) { clearInterval(miningPollTimer); miningPollTimer = null; }
  }

  function updateMiningUI(active, data) {
    const indicator = document.getElementById('miningIndicator');
    const statusText = document.getElementById('miningStatusText');
    const statsEl = document.getElementById('miningStats');

    if (indicator) {
      indicator.classList.toggle('active', !!active);
    }
    if (statusText) {
      statusText.textContent = active ? 'Mining active' : 'Not mining';
    }
    if (statsEl) {
      statsEl.classList.toggle('hidden', !active);
    }
    if (active && data) {
      const hr = document.getElementById('miningHashrate');
      const diff = document.getElementById('miningDifficulty');
      const reward = document.getElementById('miningBlockReward');
      const threads = document.getElementById('miningActiveThreads');
      if (hr) hr.textContent = (data.speed || 0).toLocaleString() + ' H/s';
      if (diff) diff.textContent = (data.difficulty || 0).toLocaleString();
      if (reward) {
        const r = Number(data.block_reward || 0) / 1e8;
        reward.textContent = r.toFixed(4) + ' USDm';
      }
      if (threads) threads.textContent = data.threads_count || '—';
    }
  }

  async function runRescanBlockchain() {
    const btn = document.getElementById('btnRescan');
    if (btn) btn.disabled = true;
    showSyncStatus('Rescanning blockchain (rebuilding wallet view)…', true);
    try {
      await rpc('rescan_blockchain', { hard: false }, { timeoutMs: 300000 });
      showSyncStatus('Rescan done. Syncing from daemon…', true);
      await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 30000 });
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
        const res = await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 30000 });
        const fetched = (res && res.blocks_fetched) || 0;
        showSyncStatus((fetched > 0 ? 'Fetched ' + fetched.toLocaleString() + ' blocks. ' : '') + 'Updating balance…', true);
      } catch (e) {
        refreshError = (e && e.message) ? String(e.message) : '';
        const short = refreshError.length > 50 ? refreshError.slice(0, 47) + '…' : refreshError;
        showSyncStatus(short
          ? 'Sync failed: ' + short + (isBrowser ? ' Try refreshing the page.' : ' Start local USDm node (USDmd) and wallet RPC.')
          : (isBrowser ? 'Sync failed. Try refreshing the page.' : 'Sync failed. Start USDmd and ./start-wallet-rpc.sh'), true);
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
      try {
        const bAll = await rpc('get_balance', { account_index: 0, all_accounts: false, all_assets: true, asset_type: ASSET_USDM, strict: false }, { timeoutMs: 15000 });
        push('get_balance all_assets raw:', safeJson(bAll));
      } catch (e) {
        push('get_balance all_assets error:', (e && e.message) ? e.message : String(e));
      }
      try {
        const acc = await rpc('get_accounts', { tag: '', strict_balances: false, regexp: false }, { timeoutMs: 15000 });
        push('get_accounts raw:', safeJson(acc));
      } catch (e) {
        push('get_accounts error:', (e && e.message) ? e.message : String(e));
      }
      out.textContent = lines.join('\n');
      out.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
      importInFlight = true;
      // Cancel any running autoConnect or background sync so they don't compete for wallet RPC
      if (typeof window.__cancelAutoConnect === 'function') window.__cancelAutoConnect();
      cancelBackgroundSync();
      suspendAutoRefresh();
      // Flush the RPC queue so stale queued calls don't block import
      rpcQueue = Promise.resolve();
      let importWatchdog = null;
      let importWarning = setTimeout(() => {
        showMessage('importMessage', 'Import is taking a while — the wallet RPC may be syncing. This can take a few minutes.', false);
      }, 45000);
      importWatchdog = setTimeout(() => {
        showMessage('importMessage', 'Import timed out. The wallet RPC is not responding. Make sure the daemon and wallet RPC are running, then try again.', true);
        showSyncStatus('', false);
      }, 150000);
      try {
        // Close any open wallet first to avoid RPC blocking
        await rpcImmediate('close_wallet', {}, { timeoutMs: 8000 }).catch(() => {});

        // Use a deterministic filename so reimporting the same seed opens the same wallet
        const filename = 'monerousd_main.wallet';
        let restoredFresh = false;
        let result;
        try {
          result = await rpcImmediate('restore_deterministic_wallet', {
            seed: seed,
            password: password,
            filename: filename,
            restore_height: restoreHeight,
            language: language,
            autosave_current: true,
          }, { timeoutMs: 180000 });
          restoredFresh = true;
        } catch (restoreErr) {
          const restoreMsg = String((restoreErr && restoreErr.message) || '');
          // Wallet file already exists — just open it (same seed was imported before)
          if (/exists|already exists/i.test(restoreMsg)) {
            try {
              await rpcImmediate('open_wallet', { filename: filename, password: password || '' }, { timeoutMs: 30000 });
            } catch (openErr) {
              // Cache may be corrupted — close and retry once
              console.warn('open_wallet failed, retrying:', openErr && openErr.message);
              await rpcImmediate('close_wallet', {}, { timeoutMs: 5000 }).catch(() => {});
              await rpcImmediate('open_wallet', { filename: filename, password: password || '' }, { timeoutMs: 30000 });
            }
            if (password) walletPasswordCache.set(sanitizeWalletName(filename), password);
            result = await rpcImmediate('get_address', { account_index: 0 }, { timeoutMs: 8000 }).catch(() => ({}));
          } else {
            throw restoreErr;
          }
        }
        // Wallet is already open after restore/open — cache password
        if (restoredFresh && password) walletPasswordCache.set(sanitizeWalletName(filename), password);
        if (seedEl) seedEl.value = '';
        if (passwordEl) passwordEl.value = '';
        const addr = (result && result.address) || '';
        upsertWalletName(filename);
        if (!getFirstWalletName()) setFirstWalletName(filename);
        setActiveWalletName(filename);
        renderAddressbook();
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
        el.textContent = '$' + formatAmount(disp);
        saveStoredBalances(disp);
        }
        (async function runSyncInBackground() {
          const importedName = filename;
          // Enable auto_refresh so wallet keeps syncing in background
          await configureWalletRpcMoneroStyle().catch(() => {});
          // Refresh in a loop with generous timeout — chain may have many blocks
          const MAX_SYNC_ATTEMPTS = 15;
          let synced = false;
          for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
            if (getActiveWalletName() !== importedName) return;
            try {
              const heightInfo = await rpcImmediate('get_height', {}, { timeoutMs: 5000 }).catch(() => null);
              const walletH = (heightInfo && heightInfo.height) || 0;
              const daemonH = await getDaemonHeight();
              const remaining = Math.max(0, daemonH - walletH);
              if (remaining > 0) {
                showSyncStatus('Syncing… ' + walletH + ' / ' + daemonH + ' blocks remaining', true);
              } else if (walletH > 0) {
                showSyncStatus('Syncing…', true);
              }
              // Check if already fully synced
              if (walletH > 0 && remaining <= 0) {
                synced = true;
                break;
              }
              await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 120000 });
              // Check height again after refresh
              const after = await rpcImmediate('get_height', {}, { timeoutMs: 5000 }).catch(() => null);
              if (after && after.height >= daemonH) {
                synced = true;
                break;
              }
            } catch (_) {}
            if (attempt < MAX_SYNC_ATTEMPTS) {
              await new Promise(ok => setTimeout(ok, 3000));
            }
          }
          if (!synced && getActiveWalletName() === importedName) {
            showSyncStatus('Sync incomplete. Balance may update shortly as auto-refresh continues.', true);
          }
          // Only update UI if this wallet is still the active one
          if (getActiveWalletName() !== importedName) return;
          await refreshAddress().catch(() => {});
          await refreshBalances({ force: true }).catch(() => {});
          await refreshTransfers().catch(() => {});
          await updateDashboardSyncInfo().catch(() => {});
          showSyncStatus('', false);
          showMessage('importMessage', 'Wallet restored. Balance updated.', false);
          startBalanceRefreshInterval();
        })().catch(() => {
          if (getActiveWalletName() === filename) {
            showSyncStatus('', false);
            showMessage('importMessage', 'Import complete. Click Refresh to sync.', false);
          }
        });
      } catch (e) {
        const msg = e.message || 'Import failed.';
        let friendly = msg;
        if (/Electrum-style word list failed verification/i.test(msg)) {
          friendly = 'Seed verification failed. Check: all words spelled correctly, same language, no extra characters. Monero/Haven use 25 words; the last word is a checksum.';
        } else if (/timed out|abort/i.test(msg)) {
          friendly = isBrowser
            ? 'Import timed out. The server may be busy — please try again in a moment.'
            : 'Import timed out. The wallet RPC did not respond. Start it with: ./start-wallet-rpc.sh (from monerousd-desktop). Then try Import again.';
        } else if (/fetch|network|refused|unreachable/i.test(msg)) {
          friendly = isBrowser
            ? 'Cannot reach the wallet server. Please try again or refresh the page.'
            : 'Cannot reach the wallet RPC. Start it with: ./start-wallet-rpc.sh.';
        }
        showMessage('importMessage', friendly, true);
      } finally {
        if (importWarning) clearTimeout(importWarning);
        if (importWatchdog) clearTimeout(importWatchdog);
        importInFlight = false;
        resumeAutoRefresh();
      }
    });
  }

  let balanceRefreshIntervalId = null;

  function startBalanceRefreshInterval() {
    if (balanceRefreshIntervalId != null) return;
    if (rpcFailureCount >= RPC_BACKOFF_THRESHOLD) return;
    balanceRefreshIntervalId = setInterval(() => {
      if (rpcFailureCount >= RPC_BACKOFF_THRESHOLD) return;
      if (autoRefreshSuspended || importInFlight || switchInFlight) return;
      const dashboard = document.getElementById('pageDashboard');
      if (dashboard && dashboard.classList.contains('active')) {
        checkConnection().then((r) => { if (r && !r.noWallet) refreshBalances(); }).catch(() => {});
        refreshDashboardReserveRatio();
      }
    }, 10000);
  }

  function stopBalanceRefreshInterval() {
    if (balanceRefreshIntervalId != null) {
      clearInterval(balanceRefreshIntervalId);
      balanceRefreshIntervalId = null;
    }
  }

  // ===== Welcome / Onboarding Page =====
  const WALLET_ONBOARDED_KEY = 'monerousd_onboarded';

  function isOnboarded() {
    return storageGet(WALLET_ONBOARDED_KEY) === '1' && loadWalletList().length > 0;
  }

  function setOnboarded() {
    storageSet(WALLET_ONBOARDED_KEY, '1');
  }

  function showWelcomePage() {
    const welcome = document.getElementById('welcomePage');
    const app = document.getElementById('mainApp');
    if (welcome) welcome.classList.remove('hidden');
    if (app) app.classList.add('hidden');
    // Reset to choose step
    document.getElementById('welcomeChoose')?.classList.remove('hidden');
    document.getElementById('welcomeRestore')?.classList.add('hidden');
    document.getElementById('welcomeNewSeed')?.classList.add('hidden');
    document.getElementById('welcomeVerify')?.classList.add('hidden');
    // Start wave background animation
    if (window.__welcomeBg) window.__welcomeBg.start();
  }

  function showMainApp() {
    const welcome = document.getElementById('welcomePage');
    const app = document.getElementById('mainApp');
    if (welcome) welcome.classList.add('hidden');
    if (app) app.classList.remove('hidden');
    // Stop wave background animation to save CPU
    if (window.__welcomeBg) window.__welcomeBg.stop();
  }

  function bindWelcome() {
    const choosePage = document.getElementById('welcomeChoose');
    const restorePage = document.getElementById('welcomeRestore');
    const newSeedPage = document.getElementById('welcomeNewSeed');
    const verifyPage = document.getElementById('welcomeVerify');
    if (!choosePage) return;

    let generatedSeed = '';
    let generatedPassword = '';
    let createdWalletFilename = '';

    function showStep(step) {
      [choosePage, restorePage, newSeedPage, verifyPage].forEach((el) => el?.classList.add('hidden'));
      step?.classList.remove('hidden');
    }

    // Generate a unique wallet filename using crypto-random bytes
    function generateWalletFilename() {
      if (!isBrowser) return 'monerousd_main.wallet';
      // Browser mode: generate a unique filename per session to prevent collisions
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      return 'musd_' + hex + '.wallet';
    }

    // Create new wallet
    document.getElementById('welcomeCreateBtn')?.addEventListener('click', async () => {
      showStep(newSeedPage);
      const seedDisplay = document.getElementById('welcomeSeedDisplay');
      const msg = document.getElementById('welcomeNewSeedMsg');
      if (seedDisplay) seedDisplay.innerHTML = '<span class="text-muted">Generating new wallet...</span>';
      if (msg) { msg.textContent = ''; msg.classList.remove('error'); }
      try {
        // Flush queue and close any open wallet
        rpcQueue = Promise.resolve();
        await rpcImmediate('close_wallet', {}, { timeoutMs: 5000 }).catch(() => {});
        // Generate a unique filename so we never accidentally open an existing wallet
        const filename = generateWalletFilename();
        try {
          await rpcImmediate('create_wallet', {
            filename: filename,
            password: '',
            language: 'English',
          }, { timeoutMs: 30000 });
        } catch (createErr) {
          const createMsg = String((createErr && createErr.message) || '');
          if (/exists|already exists/i.test(createMsg)) {
            // Wallet file already exists — open it instead
            await rpcImmediate('open_wallet', { filename: filename, password: '' }, { timeoutMs: 15000 });
          } else {
            throw createErr;
          }
        }
        createdWalletFilename = filename;
        // Get the seed from the wallet
        const seedResult = await rpcImmediate('query_key', { key_type: 'mnemonic' }, { timeoutMs: 10000 });
        generatedSeed = (seedResult && seedResult.key) || '';
        if (!generatedSeed) throw new Error('Could not retrieve seed phrase');
        renderSeedDisplay(generatedSeed, seedDisplay);
      } catch (e) {
        if (seedDisplay) seedDisplay.innerHTML = '';
        if (msg) { msg.textContent = 'Error: ' + (e.message || 'Could not create wallet'); msg.classList.add('error'); }
      }
    });

    function renderSeedDisplay(seed, container) {
      if (!container) return;
      const words = seed.split(/\s+/);
      container.innerHTML = '';
      words.forEach((word, i) => {
        const el = document.createElement('span');
        el.className = 'seed-word';
        el.innerHTML = '<span class="seed-word-num">' + (i + 1) + '</span><span class="seed-word-text">' + escHtml(word) + '</span>';
        container.appendChild(el);
      });
    }

    document.getElementById('welcomeSeedCopy')?.addEventListener('click', function () {
      if (!generatedSeed) return;
      const btn = this;
      copyText(generatedSeed).then(() => {
        btn.innerHTML = '<span class="seed-copy-icon">✓</span> Copied!';
        btn.classList.add('seed-copy-success');
        setTimeout(() => {
          btn.innerHTML = '<span class="seed-copy-icon">⧉</span> Copy Seed';
          btn.classList.remove('seed-copy-success');
        }, 2000);
      });
    });

    document.getElementById('welcomeNewSeedBack')?.addEventListener('click', () => showStep(choosePage));

    // Proceed to verification
    document.getElementById('welcomeNewSeedNext')?.addEventListener('click', () => {
      if (!generatedSeed) return;
      generatedPassword = (document.getElementById('welcomeNewPassword')?.value || '').trim();
      const words = generatedSeed.split(/\s+/);
      const label1 = document.getElementById('welcomeVerifyLabel1');
      const label2 = document.getElementById('welcomeVerifyLabel2');
      if (label1) label1.textContent = 'Word #1';
      if (label2) label2.textContent = 'Word #8';
      const input1 = document.getElementById('welcomeVerifyWord1');
      const input2 = document.getElementById('welcomeVerifyWord2');
      if (input1) input1.value = '';
      if (input2) input2.value = '';
      const msg = document.getElementById('welcomeVerifyMsg');
      if (msg) { msg.textContent = ''; msg.classList.remove('error'); }
      showStep(verifyPage);
    });

    // Verify seed
    document.getElementById('welcomeVerifySubmit')?.addEventListener('click', async () => {
      const words = generatedSeed.split(/\s+/);
      const w1 = (document.getElementById('welcomeVerifyWord1')?.value || '').trim().toLowerCase();
      const w8 = (document.getElementById('welcomeVerifyWord2')?.value || '').trim().toLowerCase();
      const msg = document.getElementById('welcomeVerifyMsg');
      if (w1 !== words[0].toLowerCase() || w8 !== words[7].toLowerCase()) {
        if (msg) { msg.textContent = 'Incorrect words. Please check your seed and try again.'; msg.classList.add('error'); }
        return;
      }
      if (msg) { msg.textContent = 'Verified! Opening wallet...'; msg.classList.remove('error'); }
      const walletFile = createdWalletFilename || 'monerousd_main.wallet';
      try {
        // Set password if user chose one
        if (generatedPassword) {
          await rpcImmediate('change_wallet_password', {
            old_password: '',
            new_password: generatedPassword,
          }, { timeoutMs: 10000 });
          walletPasswordCache.set(walletFile, generatedPassword);
        }
        // Scope addressbook to this wallet's primary filename
        setPrimaryWallet(walletFile);
        upsertWalletName(walletFile);
        if (!getFirstWalletName()) setFirstWalletName(walletFile);
        setActiveWalletName(walletFile);
        setOnboarded();
        // Clear cached balances so the new wallet starts at $0
        storageSet(BALANCE_STORAGE_KEY, '');
        storageSet(WALLET_BALANCE_MAP_KEY, '');
        lastUsdmBalanceAtomic = 0n;
        setBalanceDisplayAtomic(0n);
        generatedSeed = '';
        generatedPassword = '';
        createdWalletFilename = '';
        showMainApp();
        initMainApp();
      } catch (e) {
        if (msg) { msg.textContent = 'Error: ' + (e.message || 'Failed to finalize wallet'); msg.classList.add('error'); }
      }
    });

    document.getElementById('welcomeVerifyBack')?.addEventListener('click', () => showStep(newSeedPage));

    // Restore from seed
    document.getElementById('welcomeRestoreBtn')?.addEventListener('click', () => {
      const msg = document.getElementById('welcomeRestoreMsg');
      if (msg) { msg.textContent = ''; msg.classList.remove('error'); }
      showStep(restorePage);
    });
    document.getElementById('welcomeRestoreBack')?.addEventListener('click', () => {
      // Clear seed when navigating away from restore page
      const s = document.getElementById('welcomeRestoreSeed');
      if (s) { s.value = ''; s.classList.add('masked'); }
      const t = document.getElementById('welcomeRestoreSeedToggle');
      if (t) t.textContent = 'Show';
      showStep(choosePage);
    });

    // Show/hide toggle for welcome restore seed phrase
    const welcomeSeedToggle = document.getElementById('welcomeRestoreSeedToggle');
    const welcomeSeedInput = document.getElementById('welcomeRestoreSeed');
    if (welcomeSeedToggle && welcomeSeedInput) {
      welcomeSeedToggle.addEventListener('click', () => {
        const masked = welcomeSeedInput.classList.toggle('masked');
        welcomeSeedToggle.textContent = masked ? 'Show' : 'Hide';
      });
    }

    document.getElementById('welcomeRestoreSubmit')?.addEventListener('click', async () => {
      const seedEl = document.getElementById('welcomeRestoreSeed');
      const passwordEl = document.getElementById('welcomeRestorePassword');
      const heightEl = document.getElementById('welcomeRestoreHeight');
      const msg = document.getElementById('welcomeRestoreMsg');
      const rawSeed = (seedEl?.value || '').trim();
      const seed = rawSeed.replace(/[\s,]+/g, ' ').trim();
      const password = (passwordEl?.value || '').trim();
      const restoreHeight = Math.max(0, parseInt(heightEl?.value, 10) || 0);

      if (!seed) {
        if (msg) { msg.textContent = 'Enter your 25-word seed phrase.'; msg.classList.add('error'); }
        return;
      }
      const wordCount = seed.split(/\s+/).length;
      if (wordCount !== 25 && wordCount !== 24 && wordCount !== 12) {
        if (msg) { msg.textContent = 'Seed must be 25 words. You have ' + wordCount + '.'; msg.classList.add('error'); }
        return;
      }
      if (msg) { msg.textContent = 'Restoring wallet...'; msg.classList.remove('error'); }

      const filename = generateWalletFilename();
      if (password) walletPasswordCache.set(filename, password);
      if (seedEl) seedEl.value = '';
      if (passwordEl) passwordEl.value = '';
      setPrimaryWallet(filename);
      upsertWalletName(filename);
      if (!getFirstWalletName()) setFirstWalletName(filename);
      setActiveWalletName(filename);
      setOnboarded();
      // Clear cached balances so new session starts at $0
      storageSet(BALANCE_STORAGE_KEY, '');
      storageSet(WALLET_BALANCE_MAP_KEY, '');
      lastUsdmBalanceAtomic = 0n;

      // Show main app immediately — don't block on restore
      importInFlight = true; // prevent autoConnect from competing
      showMainApp();
      initMainApp();

      // Watchdog: if restore takes >45s, show a helpful message
      let restoreWatchdog = setTimeout(() => {
        showSyncStatus('Wallet restore is taking a while — the wallet RPC may be syncing with the daemon. This can take a few minutes. If it seems stuck, restart the wallet RPC and try again.', true);
      }, 45000);

      // Run restore in background
      (async function backgroundRestore() {
        try {
          rpcQueue = Promise.resolve();
          await rpcImmediate('close_wallet', {}, { timeoutMs: 5000 }).catch(() => {});
          showSyncStatus('Restoring wallet from seed…', true);
          try {
            await rpcNoRetry('restore_deterministic_wallet', {
              seed: seed,
              password: password,
              filename: filename,
              restore_height: restoreHeight || 1,
              language: 'English',
              autosave_current: false,
            }, { timeoutMs: 300000 });
          } catch (e) {
            const em = String(e && e.message || '');
            if (/exists|already exists/i.test(em)) {
              try {
                await rpcImmediate('open_wallet', { filename: filename, password: password || '' }, { timeoutMs: 30000 });
              } catch (openErr) {
                // open_wallet can fail if the cache files are corrupted — the .keys file
                // is fine but the .wallet cache is incompatible. Show a helpful message.
                const openMsg = String(openErr && openErr.message || '');
                console.warn('open_wallet failed after exists:', openMsg);
                showSyncStatus('Wallet cache may be corrupted. Retrying with fresh restore…', true);
                // Try closing then restoring fresh — wallet-rpc may have partially opened
                await rpcImmediate('close_wallet', {}, { timeoutMs: 5000 }).catch(() => {});
                // If we can't open, try restoring again (wallet-rpc may allow overwrite after close)
                throw openErr;
              }
            } else {
              if (/timed out|abort|timeout/i.test(em)) {
                showSyncStatus(isBrowser
                  ? 'Restore timed out — the server may be busy. Click Refresh to retry.'
                  : 'Restore timed out — the wallet RPC is not responding. Make sure the wallet RPC and daemon are running, then click Refresh to retry.', true);
              } else if (/fetch|network|refused|unreachable|ECONNREFUSED/i.test(em)) {
                showSyncStatus(isBrowser
                  ? 'Cannot reach the wallet server. Try refreshing the page.'
                  : 'Cannot reach wallet RPC. Start it with: ./start-wallet-rpc.sh — then click Refresh to retry.', true);
              } else {
                showSyncStatus('Restore failed: ' + (e.message || 'Unknown error') + '. Click Refresh to retry.', true);
              }
              importInFlight = false;
              return;
            }
          }
          clearTimeout(restoreWatchdog);
          // Wallet is now open — sync it
          // Do NOT call set_daemon — wallet-rpc already has --daemon-address from
          // startup, and calling set_daemon on a freshly restored wallet triggers a
          // blocking background sync that freezes all subsequent RPC calls.
          importInFlight = false;
          showSyncStatus('Wallet restored. Syncing blockchain…', true);
          await configureWalletRpcMoneroStyle().catch(() => {});
          await refreshAddress().catch(() => {});
          // Use incremental refresh (short batches) so we don't freeze the RPC
          await setDaemonAndRefresh(restoreHeight || 0, (msg) => showSyncStatus(msg, true)).catch(() => {});
          rpcQueue = Promise.resolve();
          await refreshBalances({ force: true }).catch(() => {});
          await refreshTransfers().catch(() => {});
          startBalanceRefreshInterval();
          showSyncStatus('', false);
        } catch (e) {
          const errMsg = (e.message || 'Unknown');
          const isCacheErr = /bad_alloc|corrupt|archive|portable_binary|Failed to open wallet/i.test(errMsg);
          if (isCacheErr) {
            showSyncStatus('Wallet cache is corrupted. Delete the .wallet file from your wallet directory and import again.', true);
          } else {
            showSyncStatus('Restore error: ' + errMsg + '. Click Refresh to retry.', true);
          }
        } finally {
          clearTimeout(restoreWatchdog);
          importInFlight = false;
        }
      })();
    });

    // Logout button
    document.getElementById('btnLogout')?.addEventListener('click', async () => {
      try {
        rpcQueue = Promise.resolve();
        if (typeof window.__cancelAutoConnect === 'function') window.__cancelAutoConnect();
        cancelBackgroundSync();
        suspendAutoRefresh();
        stopBalanceRefreshInterval();
        await rpcImmediate('close_wallet', {}, { timeoutMs: 8000 }).catch(() => {});
      } catch (_) {}
      storageSet(WALLET_ONBOARDED_KEY, '');
      storageSet(PRIMARY_WALLET_KEY, '');
      mainAppInitialized = false;
      walletPasswordCache.clear();
      lastUsdmBalanceAtomic = 0n;
      currentWalletAddress = '';
      delete window.__lastGetBalanceResult;
      showWelcomePage();
    });
  }

  let mainAppInitialized = false;
  let uiBindingsAttached = false;

  function initMainApp() {
    if (mainAppInitialized) {
      // Already initialized — just re-trigger sync
      (async () => {
        try {
          rpcQueue = Promise.resolve();
          const r = await checkConnection({ timeoutMs: 8000 });
          if (r && !r.noWallet) {
            await configureWalletRpcMoneroStyle().catch(() => {});
            showSyncStatus('Syncing...', true);
            await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 120000 }).catch(() => {});
            await refreshAddress().catch(() => {});
            await refreshBalances({ force: true }).catch(() => {});
            await refreshTransfers().catch(() => {});
            await updateDashboardSyncInfo().catch(() => {});
            showSyncStatus('', false);
          }
          startBalanceRefreshInterval();
          renderAddressbook();
        } catch (_) {}
      })();
      return;
    }
    mainAppInitialized = true;
    init();
  }

  function init() {
    // Flush any stale RPC queue from previous session
    rpcQueue = Promise.resolve();
    // Clean stale wallet entries from localStorage — only keep wallets that
    // are valid MoneroUSD wallets (monerousd_main.wallet, dest_wallet, or walletN pattern)
    (function cleanWalletList() {
      const list = loadWalletList();
      const validNames = list.filter((name) => {
        // Keep the deterministic import wallet
        if (name === 'monerousd_main.wallet') return true;
        // Keep dest_wallet and test wallets
        if (name === 'dest_wallet') return true;
        // Keep generated wallets (wallet1, wallet2, etc.)
        if (/^wallet\d+$/i.test(name)) return true;
        // Keep randomly generated wallets from onboarding (usdm_<hex>.wallet)
        if (/^usdm_[0-9a-f]+\.wallet$/i.test(name)) return true;
        // Remove everything else (old imported_*, genesis_*, test wallets, etc.)
        return false;
      });
      if (validNames.length !== list.length) {
        saveWalletList(validNames);
        // If active wallet was removed, clear it
        const active = getActiveWalletName();
        if (active && !validNames.includes(active)) {
          setActiveWalletName('');
        }
      }
    })();
    applyStoredBalances();
    // Only attach UI event handlers once to avoid duplicate listeners
    if (!uiBindingsAttached) {
      uiBindingsAttached = true;
      bindNavigation();
      bindWalletActions();
      bindAddressbook();
      bindSwap();
      bindStaking();
      bindLending();
      bindSend();
      bindReceive();
      bindImport();
      bindSettings();
      bindLocalNode();
      bindMining();
      bindRefresh();
      bindDiagnostics();
      bindHistoryFilter();
    }
    renderAddressbook();
    let autoConnectCancelled = false;
    // Expose cancel function so import/switch can abort autoConnect
    window.__cancelAutoConnect = () => { autoConnectCancelled = true; };
    (async function autoConnect() {
      const MAX_RETRIES = 30;
      const RETRY_DELAY = 2000;
      let r = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (autoConnectCancelled || importInFlight || switchInFlight) return;
        try {
          if (attempt > 1) showSyncStatus('Connecting to wallet RPC… (attempt ' + attempt + ')', true);
          else showSyncStatus('Connecting…', true);
          r = await checkConnection({ timeoutMs: 8000 });
          break;
        } catch (_) {
          if (attempt < MAX_RETRIES) {
            await new Promise((ok) => setTimeout(ok, RETRY_DELAY));
          }
        }
      }
      if (autoConnectCancelled || importInFlight || switchInFlight) return;
      if (!r) {
        showSyncStatus('Could not connect to wallet RPC. Check that USDmd and wallet RPC are running.', true);
        return;
      }
      let walletOpen = !r.noWallet;
      if (r.noWallet) {
        if (isBrowser) {
          // SECURITY: In browser mode, never auto-open a previous wallet.
          // Each browser session is a different user — they must import their own seed.
          // Close any leftover wallet to prevent leaking previous user's data.
          await rpcImmediate('close_wallet', {}, { timeoutMs: 5000 }).catch(() => {});
          showSyncStatus('Import your wallet seed to get started.', true);
          // Navigate to import page
          const importBtn = document.querySelector('.nav-btn[data-page="import"]');
          if (importBtn) importBtn.click();
          startBalanceRefreshInterval();
          return;
        }
        // Desktop only: auto-open last wallet (single user)
        const lastActive = getActiveWalletName();
        const managedList = loadWalletList();
        if (lastActive && managedList.includes(lastActive)) {
          try {
            if (autoConnectCancelled || importInFlight) return;
            showSyncStatus('Opening last wallet…', true);
            await openWalletByName(lastActive);
            setActiveWalletName(lastActive);
            renderAddressbook();
            walletOpen = true;
          } catch (_) {
            showSyncStatus('No wallet open. Use Import or Switch to open a wallet.', true);
            startBalanceRefreshInterval();
            return;
          }
        } else {
          showSyncStatus('No wallet open. Use Import or Switch to open a wallet.', true);
          startBalanceRefreshInterval();
          return;
        }
      }
      if (autoConnectCancelled || importInFlight) return;
      if (walletOpen) {
        await configureWalletRpcMoneroStyle().catch(() => {});
      }
      if (autoConnectCancelled || importInFlight) return;
      // Sync wallet with blockchain on startup — use generous timeout for chains with many blocks
      showSyncStatus('Syncing wallet with blockchain…', true);
      await rpcImmediate('refresh', { start_height: 0 }, { timeoutMs: 120000 }).catch(() => {});
      if (autoConnectCancelled || importInFlight) return;
      await refreshAddress().catch(() => {});
      await refreshBalances({ force: true }).catch(() => {});
      await refreshTransfers().catch(() => {});
      await updateDashboardSyncInfo().catch(() => {});
      startBalanceRefreshInterval();
      renderAddressbook();
      showSyncStatus('', false);
    })();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const dashboard = document.getElementById('pageDashboard');
        if (dashboard && dashboard.classList.contains('active')) {
          checkConnection().then((r) => { if (r && !r.noWallet) refreshBalances(); }).catch(() => {});
        }
      }
    });
  }

  /* ── Auto-Update UI ──────────────────────────────────────── */
  function initUpdateUI() {
    if (typeof window.electronAPI === 'undefined') return; // browser mode

    // Create update banner (hidden by default)
    const banner = document.createElement('div');
    banner.id = 'updateBanner';
    banner.className = 'update-banner hidden';
    banner.innerHTML = `
      <div class="update-banner-content">
        <span class="update-banner-icon">🔄</span>
        <span class="update-banner-text" id="updateBannerText">A new version is available</span>
        <div class="update-banner-actions">
          <button class="btn btn-sm btn-primary" id="btnUpdateAction">Download</button>
          <button class="btn btn-sm btn-ghost" id="btnUpdateDismiss">Later</button>
        </div>
        <div class="update-progress hidden" id="updateProgress">
          <div class="update-progress-bar" id="updateProgressBar" style="width:0%"></div>
        </div>
      </div>
    `;
    document.body.prepend(banner);

    const bannerText = document.getElementById('updateBannerText');
    const btnAction = document.getElementById('btnUpdateAction');
    const btnDismiss = document.getElementById('btnUpdateDismiss');
    const progressWrap = document.getElementById('updateProgress');
    const progressBar = document.getElementById('updateProgressBar');

    let pendingVersion = '';

    // Update auto-downloads in the background; show progress banner
    window.electronAPI.onUpdateAvailable((data) => {
      pendingVersion = data.version;
      bannerText.textContent = `Downloading update v${data.version}...`;
      btnAction.textContent = 'Downloading...';
      btnAction.disabled = true;
      progressWrap.classList.remove('hidden');
      progressBar.style.width = '0%';
      btnDismiss.classList.add('hidden');
      banner.classList.remove('hidden');
    });

    window.electronAPI.onUpdateProgress((data) => {
      progressBar.style.width = data.percent + '%';
      bannerText.textContent = `Downloading update v${pendingVersion}... ${data.percent}%`;
      banner.classList.remove('hidden');
    });

    window.electronAPI.onUpdateDownloaded((data) => {
      progressWrap.classList.add('hidden');
      btnDismiss.classList.add('hidden');
      btnAction.disabled = false;
      btnAction.textContent = 'Restart Now';
      btnAction.onclick = () => window.electronAPI.updateInstall();
      // App will auto-restart in 8 seconds; show a persistent countdown
      let countdown = 8;
      bannerText.textContent = `Update v${data.version} ready — restarting in ${countdown}s`;
      banner.classList.remove('hidden');
      // Make banner impossible to miss
      banner.style.background = '#FF6600';
      banner.style.position = 'fixed';
      banner.style.top = '0';
      banner.style.left = '0';
      banner.style.right = '0';
      banner.style.zIndex = '99999';
      const timer = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
          clearInterval(timer);
          bannerText.textContent = `Installing update v${data.version}... restarting now`;
          btnAction.disabled = true;
        } else {
          bannerText.textContent = `Update v${data.version} ready — restarting in ${countdown}s`;
        }
      }, 1000);
    });

    window.electronAPI.onUpdateStatus((data) => {
      if (data.status === 'error') {
        banner.classList.add('hidden');
      }
    });
  }

  // Clear all sensitive inputs (seed phrases, passwords) from the DOM.
  // Called on page unload and when the tab is hidden to prevent the browser
  // from caching sensitive data in session restore, back/forward cache, etc.
  function clearSensitiveInputs() {
    ['welcomeRestoreSeed', 'importSeed'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; el.classList.add('masked'); }
    });
    ['welcomeRestorePassword', 'importPassword', 'welcomeNewPassword', 'welcomeNewPasswordConfirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    // Reset toggle buttons
    ['welcomeRestoreSeedToggle', 'importSeedToggle'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = 'Show';
    });
  }

  // Clear sensitive data when the user leaves the page
  window.addEventListener('beforeunload', () => {
    clearSensitiveInputs();
    // Browser mode: close wallet and destroy server-side session on page close
    // This prevents the next user from seeing the previous user's wallet
    if (isBrowser) {
      try { navigator.sendBeacon('/api/logout', ''); } catch (_) {}
      try { navigator.sendBeacon('/api/session/close', ''); } catch (_) {}
    }
  });
  // Also clear when the tab is hidden (e.g. user switches tabs)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearSensitiveInputs();
  });

  // Initialize a per-user wallet-rpc session on the server
  async function initBrowserSession() {
    try {
      const resp = await fetch('/api/session', { method: 'POST', credentials: 'same-origin' });
      const data = await resp.json();
      if (data.status === 'ready') return true;
      if (data.status === 'starting') {
        // Poll until ready (max 20s)
        for (let i = 0; i < 40; i++) {
          await new Promise(ok => setTimeout(ok, 500));
          const r = await fetch('/api/session/status', { credentials: 'same-origin' });
          const d = await r.json();
          if (d.status === 'ready') return true;
          if (d.status === 'dead' || d.status === 'none') return false;
        }
      }
      if (data.error) console.error('Session error:', data.error);
      return false;
    } catch (e) {
      console.error('Failed to create session:', e);
      return false;
    }
  }

  function bootstrap() {
    bindWelcome();
    initUpdateUI();

    // SECURITY: In browser mode, always clear cached wallet data on load.
    // Each session is private — no user's wallet should persist or leak to another.
    if (isBrowser) {
      // Clear all wallet-related localStorage to prevent session leakage
      storageSet(BALANCE_STORAGE_KEY, '');
      storageSet(WALLET_BALANCE_MAP_KEY, '');
      storageSet(WALLET_ONBOARDED_KEY, '');
      storageSet(PRIMARY_WALLET_KEY, '');
      storageSet(ACTIVE_WALLET_KEY, '');
      storageSet(FIRST_WALLET_KEY, '');
      // NOTE: Do NOT clear SWAP_HISTORY_KEY here — swap history is keyed by wallet
      // address and gets synced from server. Clearing it causes swaps to disappear
      // on refresh until server sync completes (which needs wallet address first).
      // Clear wallet list
      try { localStorage.removeItem(walletListStorageKey()); } catch (_) {}
      walletPasswordCache.clear();

      // Show welcome page immediately, then bootstrap server session in background
      showWelcomePage();

      // Show a status message while session starts
      const welcomeMsg = document.getElementById('welcomeStatus');
      if (welcomeMsg) { welcomeMsg.textContent = 'Starting wallet engine...'; welcomeMsg.classList.remove('hidden'); }

      initBrowserSession().then((ok) => {
        if (welcomeMsg) {
          welcomeMsg.textContent = ok ? '' : 'Could not start wallet engine. Please refresh.';
          if (ok) welcomeMsg.classList.add('hidden');
        }
      });
      return;
    }

    // Desktop (Electron): pre-warm relay session in background so RPC is ready
    // when user creates/restores a wallet. This avoids a 10-20s delay on first RPC call.
    if (window.electronAPI && typeof window.electronAPI.initRemoteSession === 'function') {
      const relayUrl = storageGet(RPC_STORAGE_KEY) || DEFAULT_RPC;
      window.electronAPI.initRemoteSession(relayUrl).catch(() => {});
    }

    // Desktop (Electron): auto-open last wallet if previously onboarded
    if (isOnboarded()) {
      showMainApp();
      initMainApp();
    } else {
      showWelcomePage();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
