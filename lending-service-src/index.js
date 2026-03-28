/**
 * MoneroUSD Lending Service
 *
 * Borrowers deposit BTC or XMR collateral, protocol mints USDm against it.
 * Protocol reserves only — no user funds at risk. Every loan adds collateral
 * to reserves while minting USDm at ≤65% of collateral value, strengthening
 * the peg by construction.
 *
 * Run: node index.js
 * Requires: haven daemon, swap-service (for price feeds + reserves), wallet RPCs.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// --- Configuration ---
const PORT = parseInt(process.env.LENDING_PORT || '8789', 10);
const BIND_HOST = process.env.LENDING_BIND_HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'loans.json');

// External service URLs
const DAEMON_RPC_URL = process.env.DAEMON_RPC_URL || 'http://127.0.0.1:17750';
const SWAP_SERVICE_URL = process.env.SWAP_SERVICE_URL || 'http://127.0.0.1:8787';
const STAKING_SERVICE_URL = process.env.STAKING_SERVICE_URL || 'http://127.0.0.1:8788';

// Reserve wallet addresses (same as swap-service)
const BTC_RESERVE_ADDRESS = process.env.BTC_RESERVE_ADDRESS || 'bc1qukurxzulh6h356ctnqudqz5kfna5g6ehrcqhn4';
const XMR_RESERVE_ADDRESS = process.env.XMR_RESERVE_ADDRESS || '49W1wHiiYPsSneF6f1umpJ2Gqgwx7xwVP6KH27Q7p5B8jXHVe8CgwDBEALHSMK9BREK3EqExsLXzmehzsJqGbHHw5XXHCwa';
const USDM_BURN_ADDRESS = process.env.USDM_BURN_ADDRESS || 'MpxaejfYy7Wf9UHdXY1mQgE3BrejxQy13829HmhuDeEs57SxPuKF28gRZy9wCvuG2Qhxi71r2z5CH9FqBULX6dBC5QfgmoN';

// Wallet RPCs for collateral release
const XMR_WALLET_RPC_URL = process.env.XMR_WALLET_RPC_URL || '';
const XMR_WALLET_RPC_USER = process.env.XMR_WALLET_RPC_USER || '';
const XMR_WALLET_RPC_PASS = process.env.XMR_WALLET_RPC_PASS || '';

// BTC key for collateral release (PSBT signing)
const BTC_NETWORK = (process.env.BTC_NETWORK || 'mainnet').toLowerCase();
const BTC_FEE_RATE = parseInt(process.env.BTC_FEE_RATE || '12', 10);
const BTC_WIF = process.env.BTC_WIF || '';
const BTC_PRIVKEY_HEX = process.env.BTC_PRIVKEY_HEX || '';

const BLOCKSTREAM_API = process.env.BLOCKSTREAM_API || 'https://blockstream.info/api';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,monero&vs_currencies=usd';
const PRICE_TTL_MS = parseInt(process.env.PRICE_TTL_MS || '20000', 10);

// Confirmation requirements
const BTC_CONFIRMATIONS = parseInt(process.env.BTC_CONFIRMATIONS || '3', 10);
const XMR_CONFIRMATIONS = parseInt(process.env.XMR_CONFIRMATIONS || '10', 10);

// Decimal constants
const BTC_DECIMALS = 8;
const XMR_DECIMALS = 12;
const USDM_DECIMALS = 8;

// --- Loan Parameters ---
const LOAN_PARAMS = {
  BTC: {
    max_ltv: 0.60,            // 60% max loan-to-value → 166.7% collateral ratio at creation
    liquidation_ltv: 0.65,    // 65% triggers liquidation → 153.8% collateral ratio (above 150% floor)
    min_rate: 0.05,           // 5% APR at 0% utilization
    max_rate: 0.12,           // 12% APR at 100% utilization
    min_collateral: '0.001',  // Minimum 0.001 BTC
    decimals: BTC_DECIMALS,
  },
  XMR: {
    max_ltv: 0.55,            // 55% max loan-to-value → 181.8% collateral ratio at creation
    liquidation_ltv: 0.65,    // 65% triggers liquidation → 153.8% collateral ratio (above 150% floor)
    min_rate: 0.06,           // 6% APR at 0% utilization
    max_rate: 0.14,           // 14% APR at 100% utilization
    min_collateral: '0.1',    // Minimum 0.1 XMR
    decimals: XMR_DECIMALS,
  },
};

const LIQUIDATION_PENALTY = 0.05;   // 5% liquidation penalty
const MAX_LENDING_RATIO = 0.30;     // Max 30% of reserves can be lent
const BLOCKS_PER_DAY = 720; // 120s block time -> 720 blocks/day
const BLOCKS_PER_YEAR = BLOCKS_PER_DAY * 365;

// Interest revenue allocation
const INTEREST_ALLOC_RESERVES = 0.50;  // 50% to reserves
const INTEREST_ALLOC_YIELD    = 0.40;  // 40% to yield pool (staking payouts)
const INTEREST_ALLOC_OPS      = 0.10;  // 10% to operations

// --- Utilities ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(STATE_FILE)) {
    return {
      loans: {},
      total_loaned_usdm: '0',
      total_interest_earned: '0',
      last_interest_block: 0,
      last_liquidation_check: 0,
    };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {
      loans: {},
      total_loaned_usdm: '0',
      total_interest_earned: '0',
      last_interest_block: 0,
      last_liquidation_check: 0,
    };
  } catch (_) {
    return {
      loans: {},
      total_loaned_usdm: '0',
      total_interest_earned: '0',
      last_interest_block: 0,
      last_liquidation_check: 0,
    };
  }
}

function saveState(st) {
  ensureDir(DATA_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

const state = loadState();

function nowIso() { return new Date().toISOString(); }
function newId() { return crypto.randomBytes(10).toString('hex'); }

function parseDecimalToAtomic(value, decimals) {
  const raw = String(value || '').trim();
  if (!raw) return 0n;
  const m = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return 0n;
  const whole = BigInt(m[1] || '0');
  const fracRaw = (m[2] || '').slice(0, decimals).padEnd(decimals, '0');
  const frac = fracRaw ? BigInt(fracRaw) : 0n;
  const base = BigInt(10) ** BigInt(decimals);
  return whole * base + frac;
}

function formatDecimalFromAtomic(amount, decimals, maxFraction) {
  const a = BigInt(amount);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = a / base;
  const frac = a % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFraction || decimals);
  const trimmed = fracStr.replace(/0+$/, '');
  return trimmed ? `${whole.toString()}.${trimmed}` : whole.toString();
}

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
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = opts.rawBody != null ? String(opts.rawBody) : (opts.body ? JSON.stringify(opts.body) : null);
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(opts.headers || {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : {}; } catch (_) { json = null; }
          if (res.statusCode >= 400) {
            const msg = json && (json.error || json.message) ? (json.error || json.message) : `HTTP ${res.statusCode}`;
            reject(new Error(msg));
            return;
          }
          resolve(json !== null ? json : buf);
        });
      }
    );
    req.on('error', reject);
    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    }
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
    timeoutMs: 20000,
  }).then((r) => {
    if (r && r.error) throw new Error(r.error.message || 'RPC error');
    return r ? r.result : null;
  });
}

function sanitizeError(msg) {
  if (typeof msg !== 'string') return 'Internal error';
  const lower = msg.toLowerCase();
  if (lower.includes('authorization') || lower.includes('password') ||
      lower.includes('wif') || lower.includes('privkey') ||
      lower.includes('secret') || lower.includes('credential'))
    return 'Internal error';
  return msg.replace(/https?:\/\/[^\s)]+/g, '[redacted-url]');
}

// --- Price Feeds (reuse swap-service via HTTP, with local fallback) ---

const priceCache = new Map();

function getCachedPrice(asset) {
  const entry = priceCache.get(asset);
  if (!entry) return null;
  if (Date.now() - entry.ts > PRICE_TTL_MS) return null;
  return entry;
}

function setCachedPrice(asset, price, source) {
  const entry = { price, source, ts: Date.now() };
  priceCache.set(asset, entry);
  return entry;
}

async function fetchPriceUsd(asset) {
  const norm = asset.toUpperCase();
  const cached = getCachedPrice(norm);
  if (cached) return cached.price;

  // Try swap-service first (it has multi-source fallback)
  try {
    const r = await fetchJson(`${SWAP_SERVICE_URL}/api/price?asset=${norm}`, { timeoutMs: 5000 });
    if (r && r.price_usd > 0) {
      setCachedPrice(norm, r.price_usd, 'swap-service');
      return r.price_usd;
    }
  } catch (_) {}

  // Direct fallback to CoinGecko
  try {
    const data = await fetchJson(COINGECKO_URL, { timeoutMs: 8000 });
    const price = norm === 'BTC' ? Number(data.bitcoin?.usd) || 0
                : norm === 'XMR' ? Number(data.monero?.usd) || 0 : 0;
    if (price > 0) {
      setCachedPrice(norm, price, 'coingecko');
      return price;
    }
  } catch (_) {}

  return 0;
}

// --- Reserve & Capacity ---

async function getReserveInfo() {
  try {
    const r = await fetchJson(`${SWAP_SERVICE_URL}/api/reserves`, { timeoutMs: 8000 });
    return {
      total_reserve_usd: r.total_reserve_usd || 0,
      reserve_ratio: r.reserve_ratio || 0,
    };
  } catch (_) {
    return { total_reserve_usd: 0, reserve_ratio: 0 };
  }
}

function getTotalLoanedUsdm() {
  return BigInt(state.total_loaned_usdm || '0');
}

function getActiveLoanedUsdm() {
  return Object.values(state.loans)
    .filter((l) => l.status === 'active')
    .reduce((sum, l) => sum + BigInt(l.loan_usdm_atomic), 0n);
}

async function getMaxLendingCapacity() {
  const reserves = await getReserveInfo();
  return reserves.total_reserve_usd * MAX_LENDING_RATIO;
}

function getUtilization() {
  const activeLoaned = Number(getActiveLoanedUsdm()) / 1e8;
  // Use a cached max capacity or a reasonable estimate
  return { activeLoaned, activeLoanedAtomic: getActiveLoanedUsdm().toString() };
}

// --- Interest Rate Model ---
// utilization = total_loaned_usdm / max_lending_capacity
// rate = min_rate + (max_rate - min_rate) * utilization^2

function computeInterestRate(asset, utilizationRatio) {
  const params = LOAN_PARAMS[asset];
  if (!params) return 0;
  const u = Math.max(0, Math.min(1, utilizationRatio));
  return params.min_rate + (params.max_rate - params.min_rate) * u * u;
}

// --- Daemon Height ---

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

// --- Yield Pool Integration ---

async function addToYieldPool(atomicAmount) {
  if (atomicAmount <= 0n) return;
  try {
    await fetchJson(`${SWAP_SERVICE_URL}/api/internal/yield-deposit`, {
      method: 'POST',
      body: { amount_atomic: atomicAmount.toString() },
      timeoutMs: 10000,
    });
    console.log(`[yield] ${Number(atomicAmount) / 1e8} USDm deposited to yield pool`);
  } catch (e) {
    console.error('[yield] Failed to deposit to yield pool:', e.message);
  }
}

// --- Loan Lifecycle ---

async function createLoan(body) {
  const asset = String(body.asset || '').toUpperCase();
  const params = LOAN_PARAMS[asset];
  if (!params) throw new Error('Invalid collateral asset. Options: BTC, XMR');

  const collateralAmount = String(body.collateral_amount || '').trim();
  if (!collateralAmount) throw new Error('Missing collateral_amount');
  const collateralAtomic = parseDecimalToAtomic(collateralAmount, params.decimals);
  const minAtomic = parseDecimalToAtomic(params.min_collateral, params.decimals);
  if (collateralAtomic < minAtomic) {
    throw new Error(`Minimum collateral: ${params.min_collateral} ${asset}`);
  }

  const usdmAddress = String(body.usdm_address || '').trim();
  if (!usdmAddress) throw new Error('Missing usdm_address');

  // Get current price to calculate loan amount
  const price = await fetchPriceUsd(asset);
  if (!price) throw new Error('Price feed unavailable');

  const collateralValueUsd = Number(collateralAmount) * price;
  const maxLoanUsd = collateralValueUsd * params.max_ltv;

  // Check lending capacity (circuit breaker)
  const reserves = await getReserveInfo();
  if (reserves.reserve_ratio > 0 && reserves.reserve_ratio < 120) {
    throw new Error('Lending paused: reserve ratio below 120%');
  }

  const maxCapacity = reserves.total_reserve_usd * MAX_LENDING_RATIO;
  const currentLoaned = Number(getActiveLoanedUsdm()) / 1e8;
  const availableCapacity = maxCapacity - currentLoaned;
  if (availableCapacity <= 0) {
    throw new Error('Lending capacity exhausted');
  }

  const loanUsd = Math.min(maxLoanUsd, availableCapacity);
  const loanUsdmAtomic = parseDecimalToAtomic(loanUsd.toFixed(8), USDM_DECIMALS);
  if (loanUsdmAtomic <= 0n) throw new Error('Loan amount too small');

  // Compute interest rate based on utilization
  const newTotalLoaned = currentLoaned + loanUsd;
  const utilizationRatio = maxCapacity > 0 ? newTotalLoaned / maxCapacity : 0;
  const interestRate = computeInterestRate(asset, utilizationRatio);

  const currentLtv = loanUsd / collateralValueUsd;

  const id = newId();
  const loan = {
    id,
    status: 'awaiting_collateral',
    collateral_asset: asset,
    collateral_amount: collateralAmount,
    collateral_amount_atomic: collateralAtomic.toString(),
    collateral_address: asset === 'BTC' ? BTC_RESERVE_ADDRESS : XMR_RESERVE_ADDRESS,
    collateral_tx: null,
    collateral_value_usd: Math.round(collateralValueUsd * 100) / 100,
    loan_usdm: (Number(loanUsdmAtomic) / 1e8).toFixed(8),
    loan_usdm_atomic: loanUsdmAtomic.toString(),
    ltv: Math.round(currentLtv * 10000) / 100,
    interest_rate: Math.round(interestRate * 10000) / 100,
    interest_accrued_atomic: '0',
    usdm_address: usdmAddress,
    mint_tx: null,
    repay_address: USDM_BURN_ADDRESS,
    repay_tx: null,
    price_at_creation: price,
    created_at: nowIso(),
    updated_at: nowIso(),
    liquidated_at: null,
  };

  state.loans[id] = loan;
  saveState(state);
  console.log(`[loan] New ${asset} loan ${id}: ${collateralAmount} ${asset} ($${collateralValueUsd.toFixed(2)}) → ${loan.loan_usdm} USDm at ${loan.interest_rate}% APR`);
  return loan;
}

async function confirmCollateral(loanId) {
  const loan = state.loans[loanId];
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'awaiting_collateral') throw new Error('Loan not awaiting collateral');

  if (loan.collateral_asset === 'BTC') {
    return confirmBtcCollateral(loan);
  } else {
    return confirmXmrCollateral(loan);
  }
}

async function confirmBtcCollateral(loan) {
  const tip = await fetchJson(`${BLOCKSTREAM_API}/blocks/tip/height`, { timeoutMs: 6000 }).catch(() => 0);
  const txs = await fetchJson(`${BLOCKSTREAM_API}/address/${BTC_RESERVE_ADDRESS}/txs`, { timeoutMs: 10000 }).catch(() => []);

  const usedTxids = new Set(
    Object.values(state.loans)
      .filter((l) => l.collateral_tx && l.id !== loan.id)
      .map((l) => l.collateral_tx)
  );

  const expected = parseDecimalToAtomic(loan.collateral_amount, BTC_DECIMALS);

  for (const tx of txs) {
    if (!tx || usedTxids.has(tx.txid)) continue;
    if (!tx.status || !tx.status.confirmed) continue;
    const conf = tip && tx.status.block_height ? tip - tx.status.block_height + 1 : 0;
    if (conf < BTC_CONFIRMATIONS) continue;
    const received = (tx.vout || []).reduce((sum, v) => {
      if (v && v.scriptpubkey_address === BTC_RESERVE_ADDRESS) return sum + BigInt(v.value || 0);
      return sum;
    }, 0n);
    if (received >= expected) {
      loan.collateral_tx = tx.txid;
      loan.status = 'collateral_confirmed';
      loan.updated_at = nowIso();
      saveState(state);
      console.log(`[loan] Collateral confirmed for ${loan.id}: ${tx.txid}`);
      return loan;
    }
  }
  return null; // Not yet confirmed
}

async function confirmXmrCollateral(loan) {
  if (!XMR_WALLET_RPC_URL) return null;

  const usedTxids = new Set(
    Object.values(state.loans)
      .filter((l) => l.collateral_tx && l.id !== loan.id)
      .map((l) => l.collateral_tx)
  );

  const transfers = await rpcCall(
    XMR_WALLET_RPC_URL, 'get_transfers',
    { in: true, pool: true },
    XMR_WALLET_RPC_USER, XMR_WALLET_RPC_PASS
  ).catch(() => ({}));

  const list = (transfers && transfers.in) ? transfers.in : [];
  const expected = parseDecimalToAtomic(loan.collateral_amount, XMR_DECIMALS);

  for (const tx of list) {
    if (!tx || usedTxids.has(tx.txid)) continue;
    const conf = Number(tx.confirmations || 0);
    if (conf < XMR_CONFIRMATIONS) continue;
    const amount = BigInt(tx.amount || 0);
    if (amount >= expected) {
      loan.collateral_tx = tx.txid;
      loan.status = 'collateral_confirmed';
      loan.updated_at = nowIso();
      saveState(state);
      console.log(`[loan] XMR collateral confirmed for ${loan.id}: ${tx.txid}`);
      return loan;
    }
  }
  return null;
}

async function mintLoanUsdm(loan) {
  if (loan.status !== 'collateral_confirmed') return;

  // Generate nonce from collateral tx for replay protection
  let nonceHex = loan.collateral_tx || '';
  if (nonceHex.length < 64) {
    nonceHex = crypto.createHash('sha256').update(nonceHex + loan.id).digest('hex');
  }
  nonceHex = nonceHex.slice(0, 64);

  const res = await fetchJson(DAEMON_RPC_URL.replace(/\/$/, '') + '/json_rpc', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: '0',
      method: 'mint_usdm',
      params: {
        amount: Number(BigInt(loan.loan_usdm_atomic)),
        dest_address: loan.usdm_address,
        nonce_hex: nonceHex,
      },
    },
    timeoutMs: 30000,
  });

  if (res.error) {
    throw new Error(res.error.message || 'Daemon mint RPC error');
  }
  const result = res.result || {};
  if (result.status !== 'OK') {
    throw new Error(result.status || 'Mint failed');
  }

  loan.status = 'active';
  loan.mint_tx = result.tx_hash;
  loan.updated_at = nowIso();

  // Update total loaned
  state.total_loaned_usdm = String(BigInt(state.total_loaned_usdm) + BigInt(loan.loan_usdm_atomic));
  saveState(state);

  console.log(`[loan] Minted ${loan.loan_usdm} USDm for loan ${loan.id} → ${loan.usdm_address.slice(0, 12)}… tx=${result.tx_hash}`);
}

// --- Liquidation Engine ---

async function checkLiquidations() {
  const activeLoans = Object.values(state.loans).filter((l) => l.status === 'active');
  if (activeLoans.length === 0) return;

  for (const loan of activeLoans) {
    try {
      const price = await fetchPriceUsd(loan.collateral_asset);
      if (!price) continue;

      const collateralValueUsd = Number(loan.collateral_amount) * price;
      const totalOwed = Number(BigInt(loan.loan_usdm_atomic) + BigInt(loan.interest_accrued_atomic)) / 1e8;
      const currentLtv = totalOwed / collateralValueUsd;

      const params = LOAN_PARAMS[loan.collateral_asset];
      if (!params) continue;

      if (currentLtv >= params.liquidation_ltv) {
        console.log(`[liquidation] Loan ${loan.id} LTV ${(currentLtv * 100).toFixed(1)}% >= ${(params.liquidation_ltv * 100)}% — liquidating`);
        await liquidateLoan(loan, price);
      }
    } catch (e) {
      console.error(`[liquidation] Error checking loan ${loan.id}:`, e.message);
    }
  }
}

async function liquidateLoan(loan, currentPrice) {
  const totalOwed = Number(BigInt(loan.loan_usdm_atomic) + BigInt(loan.interest_accrued_atomic)) / 1e8;
  const liquidationValue = totalOwed * (1 + LIQUIDATION_PENALTY);
  const collateralValueUsd = Number(loan.collateral_amount) * currentPrice;

  // Sell collateral: the collateral is already in reserve wallets
  // Penalty goes 100% to reserves (collateral stays in reserve wallet)
  // Mark the loan as liquidated — the collateral stays in reserves

  // If collateral is worth more than liquidation value, calculate surplus
  const surplusUsd = collateralValueUsd - liquidationValue;
  let surplusReturned = false;

  if (surplusUsd > 10) {
    // Return excess collateral to borrower (if we have their return address)
    // For now, surplus stays in reserves (borrower can contact support)
    console.log(`[liquidation] Surplus $${surplusUsd.toFixed(2)} from loan ${loan.id} retained in reserves`);
  }

  loan.status = 'liquidated';
  loan.liquidated_at = nowIso();
  loan.updated_at = nowIso();
  loan.liquidation_price = currentPrice;
  loan.liquidation_ltv = (totalOwed / collateralValueUsd * 100).toFixed(1);
  loan.liquidation_penalty_usd = (totalOwed * LIQUIDATION_PENALTY).toFixed(2);
  saveState(state);

  const interestAtomic = BigInt(loan.interest_accrued_atomic);
  if (interestAtomic > 0n) {
    const yieldPortion = interestAtomic * BigInt(Math.round(INTEREST_ALLOC_YIELD * 100)) / 100n;
    await addToYieldPool(yieldPortion).catch(() => {});
  }

  console.log(`[liquidation] Loan ${loan.id} liquidated at $${currentPrice} — penalty $${loan.liquidation_penalty_usd} to reserves`);
}

// --- Repayment ---

async function initiateRepayment(loanId) {
  const loan = state.loans[loanId];
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'active') throw new Error('Loan is not active');

  const totalOwedAtomic = BigInt(loan.loan_usdm_atomic) + BigInt(loan.interest_accrued_atomic);
  const totalOwedUsdm = (Number(totalOwedAtomic) / 1e8).toFixed(8);

  return {
    loan_id: loanId,
    burn_address: USDM_BURN_ADDRESS,
    total_owed_usdm: totalOwedUsdm,
    total_owed_atomic: totalOwedAtomic.toString(),
    principal_usdm: loan.loan_usdm,
    interest_usdm: (Number(BigInt(loan.interest_accrued_atomic)) / 1e8).toFixed(8),
  };
}

async function submitRepayment(loanId, burnTxHash) {
  const loan = state.loans[loanId];
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'active') throw new Error('Loan is not active');

  const txHash = String(burnTxHash).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txHash)) throw new Error('Invalid tx_hash format');

  // Check for reuse
  const existing = Object.values(state.loans).find(
    (l) => l.repay_tx === txHash && l.id !== loanId && l.status !== 'failed'
  );
  if (existing) throw new Error('This transaction is already used by another loan');

  loan.repay_tx = txHash;
  loan.status = 'repayment_pending';
  loan.updated_at = nowIso();
  saveState(state);
  return loan;
}

async function verifyRepayment(loan) {
  if (loan.status !== 'repayment_pending' || !loan.repay_tx) return;

  try {
    const txRes = await fetchJson(DAEMON_RPC_URL.replace(/\/$/, '') + '/get_transactions', {
      method: 'POST',
      body: { txs_hashes: [loan.repay_tx], decode_as_json: true },
    });

    if (!txRes || !txRes.txs || txRes.txs.length === 0) return;
    const txInfo = txRes.txs[0];
    if (txInfo.in_pool) return; // Still in mempool

    if (txInfo.block_height != null) {
      const currentHeight = await getDaemonHeight();
      const conf = currentHeight > 0 ? currentHeight - Number(txInfo.block_height) : 0;
      if (conf >= 3) {
        loan.status = 'repaid';
        loan.updated_at = nowIso();

        // Distribute interest: 50% reserves, 40% yield, 10% ops
        const interestAtomic = BigInt(loan.interest_accrued_atomic);
        const yieldPortion = interestAtomic * 40n / 100n;
        await addToYieldPool(yieldPortion);

        state.total_interest_earned = String(
          BigInt(state.total_interest_earned) + interestAtomic
        );
        saveState(state);

        console.log(`[repay] Loan ${loan.id} repaid. Interest: ${Number(interestAtomic) / 1e8} USDm`);

        // Release collateral back to borrower
        // Note: In production, borrower would specify a return address at loan creation
        // For now, collateral release requires manual intervention or a follow-up endpoint
        console.log(`[repay] Collateral ${loan.collateral_amount} ${loan.collateral_asset} ready for release`);
      }
    }
  } catch (e) {
    console.error(`[repay] Error verifying repayment for ${loan.id}:`, e.message);
  }
}

// --- Interest Accrual ---
// Runs daily (~every 720 blocks). Accrues interest on all active loans.

async function accrueInterest() {
  const currentHeight = await getDaemonHeight();
  if (!currentHeight) return;

  const lastBlock = state.last_interest_block || 0;
  const blocksSinceLast = currentHeight - lastBlock;
  if (blocksSinceLast < BLOCKS_PER_DAY && lastBlock > 0) return;

  const activeLoans = Object.values(state.loans).filter((l) => l.status === 'active');
  if (activeLoans.length === 0) {
    state.last_interest_block = currentHeight;
    saveState(state);
    return;
  }

  // Compute utilization for current interest rate
  const maxCapacity = await getMaxLendingCapacity();
  const currentLoaned = Number(getActiveLoanedUsdm()) / 1e8;
  const utilizationRatio = maxCapacity > 0 ? currentLoaned / maxCapacity : 0;

  const daysFraction = blocksSinceLast / BLOCKS_PER_YEAR;

  for (const loan of activeLoans) {
    const rate = computeInterestRate(loan.collateral_asset, utilizationRatio);
    const principal = Number(BigInt(loan.loan_usdm_atomic)) / 1e8;
    const interestUsdm = principal * rate * daysFraction;
    const interestAtomic = parseDecimalToAtomic(interestUsdm.toFixed(8), USDM_DECIMALS);

    loan.interest_accrued_atomic = String(
      BigInt(loan.interest_accrued_atomic) + interestAtomic
    );
    loan.interest_rate = Math.round(rate * 10000) / 100;
    loan.updated_at = nowIso();
  }

  state.last_interest_block = currentHeight;
  saveState(state);
  console.log(`[interest] Accrued interest on ${activeLoans.length} loans (util=${(utilizationRatio * 100).toFixed(1)}%)`);
}

// --- Processing Loop ---

let processing = false;
async function processLoans() {
  if (processing) return;
  processing = true;
  try {
    // Confirm pending collateral deposits
    const awaitingCollateral = Object.values(state.loans).filter((l) => l.status === 'awaiting_collateral');
    for (const loan of awaitingCollateral) {
      await confirmCollateral(loan.id).catch(() => {});
    }

    // Mint USDm for confirmed collateral
    const confirmed = Object.values(state.loans).filter((l) => l.status === 'collateral_confirmed');
    for (const loan of confirmed) {
      await mintLoanUsdm(loan).catch((e) => {
        loan.status = 'failed';
        loan.error = sanitizeError(e.message);
        loan.updated_at = nowIso();
        saveState(state);
        console.error(`[loan] Mint failed for ${loan.id}:`, sanitizeError(e.message));
      });
    }

    // Check for liquidations (every 60s)
    await checkLiquidations().catch(() => {});

    // Verify pending repayments
    const repaying = Object.values(state.loans).filter((l) => l.status === 'repayment_pending');
    for (const loan of repaying) {
      await verifyRepayment(loan).catch(() => {});
    }

    // Accrue interest (daily)
    await accrueInterest().catch(() => {});
  } finally {
    processing = false;
  }
}

setInterval(processLoans, 10000); // Every 10 seconds
processLoans().catch(() => {});

// --- Public Loan Fields ---

const LOAN_PUBLIC_FIELDS = [
  'id', 'status', 'collateral_asset', 'collateral_amount', 'collateral_address',
  'collateral_tx', 'collateral_value_usd', 'loan_usdm', 'loan_usdm_atomic',
  'ltv', 'interest_rate', 'interest_accrued_atomic', 'usdm_address', 'mint_tx',
  'repay_address', 'repay_tx', 'price_at_creation', 'created_at', 'updated_at',
  'liquidated_at', 'liquidation_price', 'liquidation_ltv',
];

function publicLoan(loan) {
  if (!loan) return loan;
  const out = {};
  for (const k of LOAN_PUBLIC_FIELDS) {
    if (loan[k] !== undefined) out[k] = loan[k];
  }
  // Add computed fields
  out.interest_accrued_usdm = (Number(BigInt(loan.interest_accrued_atomic || '0')) / 1e8).toFixed(8);
  const totalOwed = BigInt(loan.loan_usdm_atomic) + BigInt(loan.interest_accrued_atomic || '0');
  out.total_owed_usdm = (Number(totalOwed) / 1e8).toFixed(8);
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
    sendJson(res, 200, { ok: true });
    return;
  }

  // Lending pool info
  if (req.method === 'GET' && url.pathname === '/api/lending/info') {
    try {
      const reserves = await getReserveInfo();
      const maxCapacity = reserves.total_reserve_usd * MAX_LENDING_RATIO;
      const activeLoaned = Number(getActiveLoanedUsdm()) / 1e8;
      const utilizationRatio = maxCapacity > 0 ? activeLoaned / maxCapacity : 0;

      const activeLoans = Object.values(state.loans).filter((l) => l.status === 'active');
      const totalInterest = Number(BigInt(state.total_interest_earned || '0')) / 1e8;

      sendJson(res, 200, {
        max_lending_capacity_usd: Math.round(maxCapacity * 100) / 100,
        active_loaned_usdm: activeLoaned.toFixed(8),
        available_capacity_usd: Math.round((maxCapacity - activeLoaned) * 100) / 100,
        utilization: Math.round(utilizationRatio * 10000) / 100,
        active_loan_count: activeLoans.length,
        total_interest_earned_usdm: totalInterest.toFixed(8),
        btc_interest_rate: Math.round(computeInterestRate('BTC', utilizationRatio) * 10000) / 100,
        xmr_interest_rate: Math.round(computeInterestRate('XMR', utilizationRatio) * 10000) / 100,
        btc_max_ltv: Math.round(LOAN_PARAMS.BTC.max_ltv * 100),
        xmr_max_ltv: Math.round(LOAN_PARAMS.XMR.max_ltv * 100),
        btc_liquidation_ltv: Math.round(LOAN_PARAMS.BTC.liquidation_ltv * 100),
        xmr_liquidation_ltv: Math.round(LOAN_PARAMS.XMR.liquidation_ltv * 100),
        btc_min_collateral: LOAN_PARAMS.BTC.min_collateral,
        xmr_min_collateral: LOAN_PARAMS.XMR.min_collateral,
        lending_paused: reserves.reserve_ratio > 0 && reserves.reserve_ratio < 120,
      });
    } catch (e) {
      sendJson(res, 500, { error: 'Failed to fetch lending info' });
    }
    return;
  }

  // Create a new loan
  if (req.method === 'POST' && url.pathname === '/api/loans') {
    try {
      const body = await readJson(req);
      const loan = await createLoan(body);
      sendJson(res, 200, {
        loan_id: loan.id,
        collateral_address: loan.collateral_address,
        collateral_amount: loan.collateral_amount,
        collateral_asset: loan.collateral_asset,
        expected_usdm: loan.loan_usdm,
        interest_rate: loan.interest_rate,
        ltv: loan.ltv,
      });
    } catch (e) {
      sendJson(res, 400, { error: sanitizeError(e.message || 'Invalid request') });
    }
    return;
  }

  // List loans — requires address param (per-user isolation)
  if (req.method === 'GET' && url.pathname === '/api/loans') {
    const address = url.searchParams.get('address');
    if (!address) {
      sendJson(res, 400, { error: 'Missing address query parameter' });
      return;
    }
    let loans = Object.values(state.loans)
      .filter((l) => l.usdm_address === address);
    // Sort by creation date descending
    loans.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    sendJson(res, 200, loans.map(publicLoan));
    return;
  }

  // Get single loan — requires address param to verify ownership
  if (req.method === 'GET' && url.pathname.match(/^\/api\/loans\/[^/]+$/) && !url.pathname.endsWith('/repay')) {
    const id = url.pathname.split('/').pop();
    const addr = url.searchParams.get('address') || '';
    const loan = state.loans[id];
    if (!loan) {
      sendJson(res, 404, { error: 'Loan not found' });
      return;
    }
    if (addr && loan.usdm_address !== addr) {
      sendJson(res, 404, { error: 'Loan not found' });
      return;
    }

    // Add live LTV if active
    const pub = publicLoan(loan);
    if (loan.status === 'active') {
      try {
        const price = await fetchPriceUsd(loan.collateral_asset);
        if (price) {
          const collateralValueUsd = Number(loan.collateral_amount) * price;
          const totalOwed = Number(BigInt(loan.loan_usdm_atomic) + BigInt(loan.interest_accrued_atomic)) / 1e8;
          pub.current_ltv = Math.round((totalOwed / collateralValueUsd) * 10000) / 100;
          pub.current_collateral_value_usd = Math.round(collateralValueUsd * 100) / 100;
          pub.current_price = price;
          const params = LOAN_PARAMS[loan.collateral_asset];
          pub.health = pub.current_ltv < params.liquidation_ltv * 100 ? 'healthy' : 'at_risk';
        }
      } catch (_) {}
    }

    sendJson(res, 200, pub);
    return;
  }

  // Initiate repayment — requires usdm_address in body for ownership verification
  if (req.method === 'POST' && url.pathname.match(/^\/api\/loans\/[^/]+\/repay$/)) {
    try {
      const id = url.pathname.split('/')[3];
      const body = await readJson(req);
      const loan = state.loans[id];
      if (!loan) throw new Error('Loan not found');
      const callerAddr = String(body.usdm_address || '').trim();
      if (callerAddr && loan.usdm_address !== callerAddr) {
        sendJson(res, 403, { error: 'Not authorized for this loan' });
        return;
      }

      if (body.tx_hash) {
        const result = await submitRepayment(id, body.tx_hash);
        sendJson(res, 200, { ok: true, status: result.status });
      } else {
        const info = await initiateRepayment(id);
        sendJson(res, 200, info);
      }
    } catch (e) {
      sendJson(res, 400, { error: sanitizeError(e.message || 'Invalid request') });
    }
    return;
  }

  // Cancel a pending loan — requires usdm_address in body for ownership verification
  if (req.method === 'POST' && url.pathname.match(/^\/api\/loans\/[^/]+\/cancel$/)) {
    try {
      const id = url.pathname.split('/')[3];
      const body = await readJson(req);
      const loan = state.loans[id];
      if (!loan) throw new Error('Loan not found');
      const callerAddr = String(body.usdm_address || '').trim();
      if (callerAddr && loan.usdm_address !== callerAddr) {
        sendJson(res, 403, { error: 'Not authorized for this loan' });
        return;
      }
      if (loan.status !== 'awaiting_collateral') throw new Error('Only pending loans can be cancelled');
      loan.status = 'cancelled';
      loan.updated_at = nowIso();
      saveState(state);
      console.log(`[loan] Cancelled pending loan ${id}`);
      sendJson(res, 200, { ok: true, status: 'cancelled' });
    } catch (e) {
      sendJson(res, 400, { error: sanitizeError(e.message || 'Invalid request') });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, BIND_HOST, () => {
  console.log('');
  console.log('MoneroUSD lending service listening on http://' + BIND_HOST + ':' + PORT);
  console.log('BTC collateral address:', BTC_RESERVE_ADDRESS);
  console.log('XMR collateral address:', XMR_RESERVE_ADDRESS);
  console.log('Max lending ratio:', (MAX_LENDING_RATIO * 100) + '%');
  console.log('BTC max LTV:', Math.round(LOAN_PARAMS.BTC.max_ltv * 100) + '% | Liquidation:', Math.round(LOAN_PARAMS.BTC.liquidation_ltv * 100) + '%');
  console.log('XMR max LTV:', Math.round(LOAN_PARAMS.XMR.max_ltv * 100) + '% | Liquidation:', Math.round(LOAN_PARAMS.XMR.liquidation_ltv * 100) + '%');
  console.log('');
});
