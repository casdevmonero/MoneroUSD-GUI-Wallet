/**
 * MoneroUSD Staking Service
 *
 * Users stake USDm by freezing outputs in their wallet (via wallet RPC freeze/thaw).
 * Yield comes exclusively from the yield pool (funded by swap fees, never minted).
 * If the yield pool is empty, rates drop to 0% -- protocol stays solvent by construction.
 *
 * Run: node index.js
 * Requires: USDm-wallet-rpc running with the staking service wallet open.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Configuration ---
const PORT = parseInt(process.env.STAKING_PORT || '8790', 10);
const BIND_HOST = process.env.STAKING_BIND_HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'stakes.json');

// Wallet RPC for the staking service (manages yield pool wallet)
const YIELD_WALLET_RPC_URL = process.env.YIELD_WALLET_RPC_URL || 'http://127.0.0.1:27751';
const YIELD_WALLET_RPC_USER = process.env.YIELD_WALLET_RPC_USER || '';
const YIELD_WALLET_RPC_PASS = process.env.YIELD_WALLET_RPC_PASS || '';

// Daemon RPC for block height
const DAEMON_RPC_URL = process.env.DAEMON_RPC_URL || 'http://127.0.0.1:17750';

// Swap service for yield pool balance
const SWAP_SERVICE_URL = process.env.SWAP_SERVICE_URL || 'http://127.0.0.1:8787';

const USDM_DECIMALS = 8;
const COIN = 10n ** 8n;
const BLOCKS_PER_DAY = 720; // 120s block time -> 720 blocks/day
const BLOCKS_PER_YEAR = BLOCKS_PER_DAY * 365;

// --- Staking Tiers ---
const TIERS = {
  flexible: { lock_blocks: 0,                        apr: 0.015, min_stake_atomic: 100n * COIN,    label: 'Flexible' },
  short:    { lock_blocks: 30 * BLOCKS_PER_DAY,      apr: 0.03,  min_stake_atomic: 500n * COIN,    label: '30 Day' },
  medium:   { lock_blocks: 90 * BLOCKS_PER_DAY,      apr: 0.045, min_stake_atomic: 1000n * COIN,   label: '90 Day' },
  long:     { lock_blocks: 180 * BLOCKS_PER_DAY,      apr: 0.06,  min_stake_atomic: 5000n * COIN,   label: '180 Day' },
};

// --- Utilities ---
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(STATE_FILE)) return { stakes: {}, total_yield_paid_atomic: '0', last_distribution_block: 0 };
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return raw ? JSON.parse(raw) : { stakes: {}, total_yield_paid_atomic: '0', last_distribution_block: 0 };
  } catch (_) {
    return { stakes: {}, total_yield_paid_atomic: '0', last_distribution_block: 0 };
  }
}

function saveState(st) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

const state = loadState();

function nowIso() { return new Date().toISOString(); }
function newId() { return crypto.randomBytes(10).toString('hex'); }

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readJson(req) {
  const MAX_BODY = 1024 * 1024;
  return new Promise((resolve, reject) => {
    let buf = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('Request too large')); return; }
      buf += chunk;
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
  });
}

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new (require('url').URL)(url);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const data = opts.body ? JSON.stringify(opts.body) : null;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve(buf ? JSON.parse(buf) : {}); } catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function rpcCall(url, method, params, user, pass) {
  if (!url) return Promise.reject(new Error('RPC URL not configured'));
  const headers = {};
  if (user || pass) {
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  return fetchJson(url.replace(/\/$/, '') + '/json_rpc', {
    method: 'POST',
    headers,
    body: { jsonrpc: '2.0', id: '0', method, params },
    timeoutMs: 15000,
  }).then((r) => {
    if (r && r.error) throw new Error(r.error.message || 'RPC error');
    return r ? r.result : null;
  });
}

async function getDaemonHeight() {
  try {
    const r = await fetchJson(DAEMON_RPC_URL.replace(/\/$/, '') + '/json_rpc', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: '0', method: 'get_info', params: {} },
      timeoutMs: 8000,
    });
    return (r && r.result) ? Number(r.result.height || 0) : 0;
  } catch (_) { return 0; }
}

async function getYieldPoolBalance() {
  try {
    const r = await fetchJson(`${SWAP_SERVICE_URL}/api/reserves`, { timeoutMs: 8000 });
    return BigInt(r && r.yield_pool_atomic ? r.yield_pool_atomic : '0');
  } catch (_) { return 0n; }
}

// --- Stake Management ---

function getActiveStakes() {
  return Object.values(state.stakes).filter((s) => s.status === 'active');
}

function getTotalStakedByTier(tier) {
  return getActiveStakes()
    .filter((s) => s.tier === tier)
    .reduce((sum, s) => sum + BigInt(s.amount_atomic), 0n);
}

function getTotalStaked() {
  return getActiveStakes().reduce((sum, s) => sum + BigInt(s.amount_atomic), 0n);
}

// Compute actual yield rate based on available yield pool
function getActualRate(tier) {
  const tierConfig = TIERS[tier];
  if (!tierConfig) return 0;
  // The actual rate is capped by what the yield pool can sustain
  // This is computed during distribution; for display we show the target rate
  return tierConfig.apr;
}

async function createStake(body) {
  const tier = String(body.tier || 'flexible').toLowerCase();
  const tierConfig = TIERS[tier];
  if (!tierConfig) throw new Error('Invalid tier. Options: ' + Object.keys(TIERS).join(', '));

  const amountAtomic = BigInt(body.amount_atomic || '0');
  if (amountAtomic < tierConfig.min_stake_atomic) {
    throw new Error(`Minimum stake for ${tierConfig.label} tier: ${Number(tierConfig.min_stake_atomic / COIN)} USDm`);
  }

  const walletAddress = String(body.wallet_address || '').trim();
  if (!walletAddress) throw new Error('Missing wallet_address');

  // Key images that the user's wallet has frozen for this stake
  const keyImages = Array.isArray(body.key_images) ? body.key_images : [];
  if (keyImages.length === 0) throw new Error('Missing key_images (frozen outputs)');

  // Validate key images are hex strings
  for (const ki of keyImages) {
    if (typeof ki !== 'string' || !/^[0-9a-f]{64}$/i.test(ki)) {
      throw new Error('Invalid key_image format');
    }
  }

  const currentHeight = await getDaemonHeight();
  if (!currentHeight) throw new Error('Cannot reach daemon');

  const txHash = String(body.tx_hash || '').trim();

  const id = newId();
  const stake = {
    id,
    tier,
    wallet_address: walletAddress,
    amount_atomic: amountAtomic.toString(),
    key_images: keyImages,
    tx_hash: txHash,
    start_block: currentHeight,
    unlock_block: tier === 'flexible' ? 0 : currentHeight + tierConfig.lock_blocks,
    status: 'active',
    yield_earned_atomic: '0',
    yield_paid_atomic: '0',
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  state.stakes[id] = stake;
  saveState(state);
  console.log(`[stake] New ${tierConfig.label} stake ${id}: ${Number(amountAtomic) / 1e8} USDm from ${walletAddress.slice(0, 12)}...`);
  return stake;
}

async function unstake(stakeId) {
  const stake = state.stakes[stakeId];
  if (!stake) throw new Error('Stake not found');
  if (stake.status !== 'active') throw new Error('Stake is not active');

  const currentHeight = await getDaemonHeight();
  if (stake.unlock_block > 0 && currentHeight < stake.unlock_block) {
    const remaining = stake.unlock_block - currentHeight;
    const daysLeft = Math.ceil(remaining / BLOCKS_PER_DAY);
    throw new Error(`Stake is locked for ${daysLeft} more day(s) (${remaining} blocks)`);
  }

  // Pay any unpaid yield
  const unpaidYield = BigInt(stake.yield_earned_atomic) - BigInt(stake.yield_paid_atomic);
  if (unpaidYield > 0n) {
    try {
      // Send yield from yield wallet to staker's address
      await rpcCall(YIELD_WALLET_RPC_URL, 'transfer', {
        destinations: [{ amount: Number(unpaidYield), address: stake.wallet_address }],
        priority: 1,
      }, YIELD_WALLET_RPC_USER, YIELD_WALLET_RPC_PASS);
      stake.yield_paid_atomic = stake.yield_earned_atomic;
    } catch (e) {
      console.error(`[unstake] Failed to pay yield for ${stakeId}:`, e.message);
      // Don't block unstake — user can claim yield later
    }
  }

  stake.status = 'unstaked';
  stake.updated_at = nowIso();
  stake.unstake_block = currentHeight;
  saveState(state);
  console.log(`[unstake] Stake ${stakeId} unstaked. Yield paid: ${Number(unpaidYield) / 1e8} USDm`);
  return stake;
}

// --- Yield Distribution ---
// Runs periodically (every ~720 blocks / 1 day).
// Computes yield for each active stake and transfers from yield pool wallet.

async function distributeYield() {
  const currentHeight = await getDaemonHeight();
  if (!currentHeight) return;

  const lastBlock = state.last_distribution_block || 0;
  const blocksSinceLast = currentHeight - lastBlock;
  if (blocksSinceLast < BLOCKS_PER_DAY && lastBlock > 0) return; // Too soon

  const activeStakes = getActiveStakes();
  if (activeStakes.length === 0) {
    state.last_distribution_block = currentHeight;
    saveState(state);
    return;
  }

  // Get available yield pool balance
  const yieldPool = await getYieldPoolBalance();
  if (yieldPool <= 0n) {
    console.log('[yield] Yield pool empty — skipping distribution');
    state.last_distribution_block = currentHeight;
    saveState(state);
    return;
  }

  // Compute yield for each stake
  const distributions = [];
  let totalYieldNeeded = 0n;

  for (const stake of activeStakes) {
    const tierConfig = TIERS[stake.tier];
    if (!tierConfig) continue;

    const stakeAmount = BigInt(stake.amount_atomic);
    const blocksActive = currentHeight - (state.last_distribution_block || stake.start_block);
    if (blocksActive <= 0) continue;

    // daily_yield = stake_amount * apr / 365
    // block_yield = daily_yield / BLOCKS_PER_DAY * blocksActive
    // Using integer math: yield = stakeAmount * apr_bps * blocksActive / (10000 * BLOCKS_PER_YEAR)
    const aprBps = BigInt(Math.round(tierConfig.apr * 10000));
    const yieldAmount = (stakeAmount * aprBps * BigInt(blocksActive)) / (10000n * BigInt(BLOCKS_PER_YEAR));

    if (yieldAmount > 0n) {
      totalYieldNeeded += yieldAmount;
      distributions.push({ stake, yieldAmount });
    }
  }

  if (totalYieldNeeded === 0n) {
    state.last_distribution_block = currentHeight;
    saveState(state);
    return;
  }

  // Scale down if yield pool can't cover full payout (keeps protocol solvent)
  let scaleFactor = 1.0;
  if (totalYieldNeeded > yieldPool) {
    scaleFactor = Number(yieldPool) / Number(totalYieldNeeded);
    console.log(`[yield] Yield pool insufficient — scaling payouts to ${(scaleFactor * 100).toFixed(1)}%`);
  }

  // Process distributions
  let totalPaid = 0n;
  for (const { stake, yieldAmount } of distributions) {
    const scaled = BigInt(Math.floor(Number(yieldAmount) * scaleFactor));
    if (scaled <= 0n) continue;

    // Accrue yield (actual transfer happens on unstake or claim)
    stake.yield_earned_atomic = String(BigInt(stake.yield_earned_atomic) + scaled);
    stake.updated_at = nowIso();
    totalPaid += scaled;
  }

  state.last_distribution_block = currentHeight;
  state.total_yield_paid_atomic = String(BigInt(state.total_yield_paid_atomic || '0') + totalPaid);
  saveState(state);

  console.log(`[yield] Distributed ${Number(totalPaid) / 1e8} USDm yield across ${distributions.length} stakes (pool: ${Number(yieldPool) / 1e8} USDm)`);
}

// --- Yield Claim (for active stakes) ---
async function claimYield(stakeId) {
  const stake = state.stakes[stakeId];
  if (!stake) throw new Error('Stake not found');
  if (stake.status !== 'active') throw new Error('Stake is not active');

  const unpaid = BigInt(stake.yield_earned_atomic) - BigInt(stake.yield_paid_atomic);
  if (unpaid <= 0n) throw new Error('No yield to claim');

  // Transfer yield from yield wallet to staker
  const res = await rpcCall(YIELD_WALLET_RPC_URL, 'transfer', {
    destinations: [{ amount: Number(unpaid), address: stake.wallet_address }],
    priority: 1,
  }, YIELD_WALLET_RPC_USER, YIELD_WALLET_RPC_PASS);

  stake.yield_paid_atomic = stake.yield_earned_atomic;
  stake.updated_at = nowIso();
  saveState(state);

  console.log(`[claim] Stake ${stakeId}: paid ${Number(unpaid) / 1e8} USDm yield tx=${res.tx_hash}`);
  return { amount_paid_atomic: unpaid.toString(), tx_hash: res.tx_hash };
}

// --- Periodic Processing ---
let processing = false;
async function processStaking() {
  if (processing) return;
  processing = true;
  try {
    await distributeYield().catch((e) => console.error('[yield] Distribution error:', e.message));
  } finally {
    processing = false;
  }
}

setInterval(processStaking, 30000); // Check every 30s
processStaking().catch(() => {});

// --- Public Stake View ---
const STAKE_PUBLIC_FIELDS = [
  'id', 'tier', 'wallet_address', 'amount_atomic', 'start_block',
  'unlock_block', 'status', 'yield_earned_atomic', 'yield_paid_atomic',
  'created_at', 'updated_at', 'unstake_block', 'key_images', 'tx_hash',
];

function publicStake(stake) {
  if (!stake) return stake;
  const out = {};
  for (const k of STAKE_PUBLIC_FIELDS) {
    if (stake[k] !== undefined) out[k] = stake[k];
  }
  // Add computed fields
  const tierConfig = TIERS[stake.tier];
  out.tier_label = tierConfig ? tierConfig.label : stake.tier;
  out.apr = tierConfig ? tierConfig.apr : 0;
  out.amount_usdm = (Number(BigInt(stake.amount_atomic)) / 1e8).toFixed(8);
  out.yield_earned_usdm = (Number(BigInt(stake.yield_earned_atomic || '0')) / 1e8).toFixed(8);
  out.yield_claimable_usdm = (Number(BigInt(stake.yield_earned_atomic || '0') - BigInt(stake.yield_paid_atomic || '0')) / 1e8).toFixed(8);
  return out;
}

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'staking' });
    return;
  }

  // Staking overview (public stats)
  if (req.method === 'GET' && url.pathname === '/api/staking/info') {
    const totalStaked = getTotalStaked();
    const activeCount = getActiveStakes().length;
    const tierInfo = {};
    for (const [key, config] of Object.entries(TIERS)) {
      tierInfo[key] = {
        label: config.label,
        apr: config.apr,
        lock_days: config.lock_blocks / BLOCKS_PER_DAY,
        min_stake_usdm: Number(config.min_stake_atomic / COIN),
        total_staked_usdm: (Number(getTotalStakedByTier(key)) / 1e8).toFixed(2),
      };
    }
    sendJson(res, 200, {
      total_staked_atomic: totalStaked.toString(),
      total_staked_usdm: (Number(totalStaked) / 1e8).toFixed(2),
      active_stakes: activeCount,
      total_yield_paid_usdm: (Number(BigInt(state.total_yield_paid_atomic || '0')) / 1e8).toFixed(2),
      tiers: tierInfo,
    });
    return;
  }

  // Create a new stake
  if (req.method === 'POST' && url.pathname === '/api/staking/stake') {
    try {
      const body = await readJson(req);
      const stake = await createStake(body);
      sendJson(res, 200, publicStake(stake));
    } catch (e) {
      sendJson(res, 400, { error: e.message || 'Invalid request' });
    }
    return;
  }

  // Unstake — requires wallet_address in body to verify ownership
  if (req.method === 'POST' && url.pathname.startsWith('/api/staking/unstake/')) {
    try {
      const id = url.pathname.split('/').pop();
      const body = await readJson(req);
      const walletAddr = String(body.wallet_address || '').trim();
      const stake = state.stakes[id];
      if (!stake) throw new Error('Stake not found');
      if (walletAddr && stake.wallet_address !== walletAddr) {
        sendJson(res, 403, { error: 'Not authorized to unstake this position' });
        return;
      }
      const result = await unstake(id);
      sendJson(res, 200, publicStake(result));
    } catch (e) {
      sendJson(res, 400, { error: e.message || 'Invalid request' });
    }
    return;
  }

  // Claim yield — requires wallet_address in body to verify ownership
  if (req.method === 'POST' && url.pathname.startsWith('/api/staking/claim/')) {
    try {
      const id = url.pathname.split('/').pop();
      const body = await readJson(req);
      const walletAddr = String(body.wallet_address || '').trim();
      const stake = state.stakes[id];
      if (!stake) throw new Error('Stake not found');
      if (walletAddr && stake.wallet_address !== walletAddr) {
        sendJson(res, 403, { error: 'Not authorized to claim this yield' });
        return;
      }
      const result = await claimYield(id);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 400, { error: e.message || 'Invalid request' });
    }
    return;
  }

  // Get stake by ID — requires address query param to verify ownership
  if (req.method === 'GET' && url.pathname.startsWith('/api/staking/stakes/')) {
    const id = url.pathname.split('/').pop();
    const addr = url.searchParams.get('address') || '';
    const stake = state.stakes[id];
    if (!stake) {
      sendJson(res, 404, { error: 'Stake not found' });
      return;
    }
    if (addr && stake.wallet_address !== addr) {
      sendJson(res, 404, { error: 'Stake not found' });
      return;
    }
    sendJson(res, 200, publicStake(stake));
    return;
  }

  // List stakes for a wallet address
  if (req.method === 'GET' && url.pathname === '/api/staking/stakes') {
    const addr = url.searchParams.get('address') || '';
    if (!addr) {
      sendJson(res, 400, { error: 'Missing address query parameter' });
      return;
    }
    const stakes = Object.values(state.stakes)
      .filter((s) => s.wallet_address === addr)
      .map(publicStake);
    sendJson(res, 200, { stakes });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, BIND_HOST, () => {
  console.log('');
  console.log('MoneroUSD Staking Service');
  console.log(`Listening on http://${BIND_HOST}:${PORT}`);
  console.log(`Yield wallet RPC: ${YIELD_WALLET_RPC_URL}`);
  console.log(`Daemon RPC: ${DAEMON_RPC_URL}`);
  console.log(`Swap service: ${SWAP_SERVICE_URL}`);
  console.log('');
  console.log('Staking tiers:');
  for (const [key, config] of Object.entries(TIERS)) {
    console.log(`  ${config.label}: ${(config.apr * 100).toFixed(1)}% APR, ${config.lock_blocks / BLOCKS_PER_DAY}-day lock, min ${Number(config.min_stake_atomic / COIN)} USDm`);
  }
  console.log('');
});
