#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanRightStable, scanRightSide } from './scan-stable.mjs';
import { fetchSmartSignal, analyzeSmartSignal, scanSmartSignal } from './scan-smart-signal.mjs';
import { setupProxyFromEnv, fetchJson } from './proxy-setup.mjs';
import { checkDumpRisk, scanDumpCoins, formatDumpPushContent } from './scan-dump-risk.mjs';
import { scanShortSignals } from './scan-short-signal.mjs';
import { scanMomentumLong } from './scan-momentum.mjs';
import { recordWhaleSnapshot, getWhaleHistory, getWhaleHistoryBulk, registerActiveSymbol, startWhaleCollector } from './whale-history.mjs';
import { MAX_MARKET_CAP_USD, isEligibleMarketCap, formatMaxMarketCapLabel } from './market-cap-filter.mjs';
import { filterTradFiItems, loadTradFiExclusions, warmupTradFiExclusions, isTradFiSymbol, EXCLUDE_TRADFI_SYMBOLS } from './tradfi-symbol-filter.mjs';
import { warmupSpotSymbols, FILTER_SPOT_ONLY } from './spot-symbol-check.mjs';
import {
  initStrategyReview, savePredictionSnapshot, runStrategyReview,
  getStrategyReviews, getLatestPredictions, startStrategyReviewScheduler,
} from './strategy-review.mjs';
import {
  scanPumpSmartAlerts, buildPumpSmartAlertElements, buildPumpGainerAlertElements,
  PUMP_SMART_MIN_CHANGE, PUMP_SMART_INTERVAL_MIN, PUMP_SMART_SCAN_LIMIT, REALTIME_ALERT_INTERVAL_MIN,
} from './pump-smart-alert.mjs';
import { evaluatePositionHealth, evaluatePositionsBatch } from './position-health.mjs';
import { getUserPositions, addUserPosition, deleteUserPosition } from './user-positions.mjs';
import { initPositionHealthMonitor, startPositionHealthScheduler, runPositionHealthPush } from './position-health-monitor.mjs';
import { initSmartTrendMonitor, startSmartTrendScheduler, runSmartTrendPush, onWatchlistUpdated, captureDaily8amRatioBaseline } from './smart-trend-monitor.mjs';
import { initSmartTrendWatchlist, startSmartTrendWatchlistScheduler, getWatchSymbols, getWatchlistGroups, getWatchlistInfo, refreshSmartTrendWatchlist } from './smart-trend-watchlist.mjs';

const FETCH_TIMEOUT_MS = 15000;

// Load .env file
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envContent = await readFile(join(__dirname, '.env'), 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const match = line.trim().match(/^(\w+)=(.*)$/);
    if (match && match[2] && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch {}

const proxyInfo = setupProxyFromEnv();

const PORT = parseInt(process.env.PORT || '3388', 10);
const WEB_PANEL_ENABLED = process.env.WEB_PANEL_ENABLED !== 'false';
const FAPI_BASE = 'https://fapi.binance.com';
const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_BASE = 'https://pro-api.coinmarketcap.com';
const MC_CACHE_LIMIT = parseInt(process.env.MC_CACHE_LIMIT || '200', 10);

const mcCache = { data: new Map(), ts: 0, TTL: 5 * 60 * 1000 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function proxyBinance(path, { retries = 3 } = {}) {
  const url = `${FAPI_BASE}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const data = await fetchJson(url, { timeoutMs: FETCH_TIMEOUT_MS, preferCurl: true });
      if (data?.code === 0 && data?.msg && !Array.isArray(data)) {
        throw new Error(`币安 API: ${data.msg.slice(0, 100)}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 800 * attempt));
      }
    }
  }
  throw lastErr;
}

function assertTickerArray(tickers, label = 'ticker/24hr') {
  if (Array.isArray(tickers)) return tickers;
  const msg = tickers?.msg || tickers?.message || JSON.stringify(tickers).slice(0, 120);
  throw new Error(`币安 ${label} 数据异常: ${msg}（请检查代理节点）`);
}

const TICKER_24HR_CACHE_TTL_MS = parseInt(process.env.BINANCE_TICKER_CACHE_TTL_SEC || '60', 10) * 1000;
const ticker24hrCache = { data: null, ts: 0, inflight: null };

/** 全量 ticker/24hr 短 TTL 缓存 + 并发去重，避免同一轮推送重复请求 */
async function fetchTicker24hr() {
  if (ticker24hrCache.data && Date.now() - ticker24hrCache.ts < TICKER_24HR_CACHE_TTL_MS) {
    return ticker24hrCache.data;
  }
  if (ticker24hrCache.inflight) return ticker24hrCache.inflight;

  ticker24hrCache.inflight = (async () => {
    try {
      const data = assertTickerArray(await proxyBinance('/fapi/v1/ticker/24hr'));
      ticker24hrCache.data = data;
      ticker24hrCache.ts = Date.now();
      return data;
    } finally {
      ticker24hrCache.inflight = null;
    }
  })();
  return ticker24hrCache.inflight;
}

async function waitForNetworkReady(label = '币安 API', {
  maxAttempts = 12,
  initialDelayMs = 5000,
  maxDelayMs = 60000,
  probe = () => proxyBinance('/fapi/v1/ping'),
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await probe();
      if (attempt > 1) console.log(`  ✓ ${label}已就绪（第 ${attempt} 次尝试）`);
      return;
    } catch (e) {
      if (attempt === maxAttempts) throw new Error(`${label}未就绪: ${e.message}`);
      const delay = Math.min(initialDelayMs * attempt, maxDelayMs);
      console.log(`  ⏳ ${label}未就绪，${Math.round(delay / 1000)}s 后重试 (${attempt}/${maxAttempts})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function getShanghaiParts(date = new Date()) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(date)) {
    parts[type] = value;
  }
  return parts;
}

function getBaseline8amInfo(now = new Date()) {
  const p = getShanghaiParts(now);
  const hour = parseInt(p.hour, 10);
  let base = new Date(`${p.year}-${p.month}-${p.day}T08:00:00+08:00`);
  if (hour < 8) base.setDate(base.getDate() - 1);
  const bp = getShanghaiParts(base);
  const dateKey = `${bp.year}-${bp.month}-${bp.day}`;
  return { dateKey, openTime: base.getTime(), label: `${dateKey} 08:00 上海` };
}

let baseline8amCache = { dateKey: null, prices: {} };

async function pmap(items, fn, concurrency = 20) {
  const results = {};
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const sym = items[i];
      try { results[sym] = await fn(sym); } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function load8amBaselinePrices(symbols) {
  const { dateKey, openTime } = getBaseline8amInfo();
  if (baseline8amCache.dateKey !== dateKey) {
    baseline8amCache = { dateKey, prices: {} };
  }

  const missing = symbols.filter(sym => !baseline8amCache.prices[sym]);
  if (missing.length) {
    const fetched = await pmap(missing, async (sym) => {
      const klines = await proxyBinance(`/fapi/v1/klines?symbol=${sym}&interval=1h&startTime=${openTime}&limit=1`);
      if (!Array.isArray(klines) || klines.length === 0) return null;
      const open = parseFloat(klines[0][1]);
      return open > 0 ? open : null;
    }, 20);
    for (const [sym, price] of Object.entries(fetched)) {
      if (price != null) baseline8amCache.prices[sym] = price;
    }
  }

  return { dateKey, openTime, prices: baseline8amCache.prices };
}

async function handleGainersSince8am(limit) {
  const tickers = await fetchTicker24hr();
  const usdt = tickers.filter(t => t.symbol.endsWith('USDT'));
  const symbols = usdt.map(t => t.symbol);
  const { dateKey, openTime, prices: baselines } = await load8amBaselinePrices(symbols);
  const items = usdt
    .filter(t => baselines[t.symbol] > 0)
    .map(t => {
      const price = parseFloat(t.lastPrice);
      const basePrice = baselines[t.symbol];
      const change = ((price - basePrice) / basePrice) * 100;
      return {
        symbol: t.symbol,
        label: t.symbol.replace(/USDT$/, ''),
        price,
        basePrice,
        volume: parseFloat(t.quoteVolume),
        change,
        change24h: parseFloat(t.priceChangePercent),
      };
    })
    .sort((a, b) => b.change - a.change)
    .slice(0, limit);
  const filteredItems = await filterEligibleSymbols(items, 'symbol');
  const { label } = getBaseline8amInfo();
  return {
    meta: { baselineDate: dateKey, baselineTime: '08:00', timezone: 'Asia/Shanghai', baselineLabel: label, openTime },
    items: filteredItems,
  };
}

async function handleLosersSince8am(limit) {
  const tickers = await fetchTicker24hr();
  const usdt = tickers.filter(t => t.symbol.endsWith('USDT'));
  const symbols = usdt.map(t => t.symbol);
  const { dateKey, openTime, prices: baselines } = await load8amBaselinePrices(symbols);
  const items = usdt
    .filter(t => baselines[t.symbol] > 0)
    .map(t => {
      const price = parseFloat(t.lastPrice);
      const basePrice = baselines[t.symbol];
      const change = ((price - basePrice) / basePrice) * 100;
      return {
        symbol: t.symbol,
        label: t.symbol.replace(/USDT$/, ''),
        price,
        basePrice,
        volume: parseFloat(t.quoteVolume),
        change,
        change24h: parseFloat(t.priceChangePercent),
      };
    })
    .sort((a, b) => a.change - b.change)
    .slice(0, limit);
  const filteredItems = await filterEligibleSymbols(items, 'symbol');
  const { label } = getBaseline8amInfo();
  return {
    meta: { baselineDate: dateKey, baselineTime: '08:00', timezone: 'Asia/Shanghai', baselineLabel: label, openTime },
    items: filteredItems,
  };
}

async function handleGainers24h(limit) {
  const tickers = await fetchTicker24hr();
  const items = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol: t.symbol,
      label: t.symbol.replace(/USDT$/, ''),
      price: parseFloat(t.lastPrice),
      volume: parseFloat(t.quoteVolume),
      change: parseFloat(t.priceChangePercent),
      change24h: parseFloat(t.priceChangePercent),
    }))
    .sort((a, b) => b.change - a.change)
    .slice(0, limit);
  const filteredItems = await filterEligibleSymbols(items, 'symbol');
  return {
    meta: { period: '24h', timezone: 'Asia/Shanghai' },
    items: filteredItems,
  };
}

async function handleLosers24h(limit) {
  const tickers = await fetchTicker24hr();
  const items = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol: t.symbol,
      label: t.symbol.replace(/USDT$/, ''),
      price: parseFloat(t.lastPrice),
      volume: parseFloat(t.quoteVolume),
      change: parseFloat(t.priceChangePercent),
      change24h: parseFloat(t.priceChangePercent),
    }))
    .sort((a, b) => a.change - b.change)
    .slice(0, limit);
  const filteredItems = await filterEligibleSymbols(items, 'symbol');
  return {
    meta: { period: '24h', timezone: 'Asia/Shanghai' },
    items: filteredItems,
  };
}

async function handleTopByVolume(limit) {
  const tickers = await fetchTicker24hr();
  const sorted = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol: t.symbol,
      label: t.symbol.replace(/USDT$/, ''),
      price: parseFloat(t.lastPrice),
      volume: parseFloat(t.quoteVolume),
      change24h: parseFloat(t.priceChangePercent),
    }))
    .sort((a, b) => b.volume - a.volume);
  const filteredItems = (await filterEligibleSymbols(sorted, 'symbol')).slice(0, limit);
  return { items: filteredItems };
}

async function batchEnrichSmartTrendDigest(rows) {
  if (!rows.length) return rows;
  const symbols = rows.map(r => r.symbol);
  const symbolSet = new Set(symbols);
  const [mcMap, { prices: baselines }, tickers] = await Promise.all([
    batchFetchMarketCaps(symbols),
    load8amBaselinePrices(symbols),
    fetchTicker24hr().catch(() => []),
  ]);
  const change24hMap = {};
  const priceMap = {};
  const volume24hMap = {};
  for (const t of (Array.isArray(tickers) ? tickers : [])) {
    if (!t?.symbol || !symbolSet.has(t.symbol)) continue;
    priceMap[t.symbol] = parseFloat(t.lastPrice);
    change24hMap[t.symbol] = parseFloat(t.priceChangePercent);
    volume24hMap[t.symbol] = parseFloat(t.quoteVolume);
  }

  const fundingMap = {};
  await pmap(symbols, async (sym) => {
    try {
      const p = await proxyBinance(`/fapi/v1/premiumIndex?symbol=${sym}`);
      fundingMap[sym] = parseFloat(p?.lastFundingRate) || 0;
    } catch {
      fundingMap[sym] = 0;
    }
  }, 5);

  return rows.map(r => {
    const fr = fundingMap[r.symbol] ?? 0;
    const price = r.price > 0 ? r.price : (priceMap[r.symbol] || 0);
    const base = baselines[r.symbol];
    const change8am = base && base > 0 && price > 0 ? ((price - base) / base) * 100 : null;
    return {
      ...r,
      price,
      price8am: base && base > 0 ? base : null,
      change8am,
      change24h: change24hMap[r.symbol] ?? r.change24h ?? null,
      volume24h: volume24hMap[r.symbol] ?? r.volume24h ?? r.volumeRank ?? null,
      fundingRate: fr,
      priceLabel: fmtPrice(price),
      marketCap: mcMap[r.symbol],
      marketCapLabel: fmtMarketCap(mcMap[r.symbol]),
      fundingRateLabel: `${(fr * 100).toFixed(4)}%`,
    };
  });
}

async function fetchSmartTrendContext(symbol, priceHint = null) {
  const sym = symbol.toUpperCase();
  const [premiumRes, topPosRes, takerRes, klinesRes, mcMap] = await Promise.all([
    proxyBinance(`/fapi/v1/premiumIndex?symbol=${sym}`).catch(() => null),
    proxyBinance(`/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=5`).catch(() => []),
    proxyBinance(`/futures/data/takerlongshortRatio?symbol=${sym}&period=5m&limit=6`).catch(() => []),
    proxyBinance(`/fapi/v1/klines?symbol=${sym}&interval=1h&limit=30`).catch(() => []),
    batchFetchMarketCaps([sym]).catch(() => ({})),
  ]);

  let price = parseFloat(priceHint) || 0;
  if (!price) {
    try {
      const p = await proxyBinance(`/fapi/v2/ticker/price?symbol=${sym}`);
      price = parseFloat(p?.price) || 0;
    } catch {}
  }

  const change8amInfo = price > 0 ? await getChangeSince8am(sym, price).catch(() => null) : null;
  const fundingRate = parseFloat(premiumRes?.lastFundingRate) || 0;

  const topPos = Array.isArray(topPosRes) ? topPosRes : [];
  let topPosTrend = 0;
  if (topPos.length >= 2) {
    topPosTrend = parseFloat(topPos[topPos.length - 1].longShortRatio) - parseFloat(topPos[0].longShortRatio);
  }

  const taker = Array.isArray(takerRes) ? takerRes : [];
  let takerTrend = 0;
  if (taker.length >= 2) {
    takerTrend = parseFloat(taker[taker.length - 1].buySellRatio) - parseFloat(taker[0].buySellRatio);
  }

  let maTrend = 'neutral';
  const klines = Array.isArray(klinesRes) ? klinesRes : [];
  if (klines.length >= 20) {
    const closes = klines.map(k => parseFloat(k[4]));
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const ma60 = closes.length >= 60
      ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60
      : closes.reduce((a, b) => a + b, 0) / closes.length;
    const last = closes[closes.length - 1];
    if (last > ma20 && ma20 >= ma60 * 0.998) maTrend = 'bull';
    else if (last < ma20 && ma20 <= ma60 * 1.002) maTrend = 'bear';
  }

  const marketCap = mcMap[sym] || 0;

  return {
    price,
    priceLabel: fmtPrice(price),
    marketCap,
    marketCapLabel: fmtMarketCap(marketCap),
    fundingRate,
    fundingRateLabel: `${(fundingRate * 100).toFixed(4)}%`,
    change8am: change8amInfo?.change ?? null,
    maTrend,
    topPosTrend,
    takerTrend,
  };
}

async function fetchCurrentPrices(symbols) {
  if (!symbols.length) return {};
  const tickers = await fetchTicker24hr();
  const map = {};
  for (const t of tickers) {
    if (symbols.includes(t.symbol)) map[t.symbol] = parseFloat(t.lastPrice);
  }
  return map;
}

async function build8amChangeMaps() {
  const [gainers, losers] = await Promise.all([
    handleGainersSince8am(50),
    handleLosersSince8am(50),
  ]);
  return {
    gainMap: Object.fromEntries(gainers.items.map(i => [i.symbol, i.change])),
    declineMap: Object.fromEntries(losers.items.map(i => [i.symbol, i.change])),
    gainerItems: gainers.items,
  };
}

async function getChangeSince8am(symbol, currentPrice) {
  const { dateKey, openTime, label } = getBaseline8amInfo();
  const cur = parseFloat(currentPrice);
  if (!cur || cur <= 0) return null;

  let basePrice = baseline8amCache.dateKey === dateKey ? baseline8amCache.prices[symbol] : null;
  if (!basePrice) {
    const klines = await proxyBinance(`/fapi/v1/klines?symbol=${symbol}&interval=1h&startTime=${openTime}&limit=1`);
    if (Array.isArray(klines) && klines.length > 0) {
      const open = parseFloat(klines[0][1]);
      if (open > 0) {
        basePrice = open;
        if (baseline8amCache.dateKey !== dateKey) {
          baseline8amCache = { dateKey, prices: {} };
        }
        baseline8amCache.prices[symbol] = basePrice;
      }
    }
  }
  if (!basePrice || basePrice <= 0) return null;
  return {
    change: ((cur - basePrice) / basePrice) * 100,
    basePrice,
    baselineLabel: label,
  };
}

async function filterItemsByMarketCap(items, symbolKey = 'symbol') {
  if (!MAX_MARKET_CAP_USD || MAX_MARKET_CAP_USD <= 0 || !items.length) return items;
  const symbols = [...new Set(items.map((i) => i[symbolKey]))];
  const marketCaps = await batchFetchMarketCaps(symbols);
  const filtered = items.filter((item) => isEligibleMarketCap(marketCaps[item[symbolKey]] || 0));
  const removed = items.length - filtered.length;
  if (removed > 0) {
    console.log(`  [市值过滤] 排除 ${removed} 个大市值币种 (>${formatMaxMarketCapLabel()})`);
  }
  return filtered;
}

async function filterEligibleSymbols(items, symbolKey = 'symbol') {
  let result = await filterTradFiItems(items, symbolKey);
  result = await filterItemsByMarketCap(result, symbolKey);
  return result;
}

async function rejectIfTradFiSymbol(symbol, res) {
  if (!EXCLUDE_TRADFI_SYMBOLS) return false;
  await loadTradFiExclusions();
  if (isTradFiSymbol(symbol)) {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    res.writeHead(403, headers);
    res.end(JSON.stringify({ error: '该币种为股票/TradFi 合约，不在监控范围', symbol }));
    return true;
  }
  return false;
}

async function rejectIfMarketCapTooLarge(symbol, res) {
  if (!MAX_MARKET_CAP_USD || MAX_MARKET_CAP_USD <= 0) return false;
  const mc = await fetchMcForSymbol(symbol);
  if (mc > 0 && !isEligibleMarketCap(mc)) {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    res.writeHead(403, headers);
    res.end(JSON.stringify({ error: `该币种市值超过 ${formatMaxMarketCapLabel()}，不在监控范围`, market_cap: mc }));
    return true;
  }
  return false;
}

async function handleAPI(symbol, { ratioLimit = 72, oiLimit = 42, takerLimit = 48 } = {}) {
  const rl = Math.min(500, Math.max(1, parseInt(ratioLimit, 10)));
  const ol = Math.min(500, Math.max(1, parseInt(oiLimit, 10)));
  const tl = Math.min(500, Math.max(1, parseInt(takerLimit, 10)));
  const keys = ['price', 'ticker24h', 'topAccounts', 'topPositions', 'globalRatio', 'oi', 'oiHist', 'takerVol', 'fundingRate', 'fundingRateHist'];
  const tasks = [
    proxyBinance(`/fapi/v2/ticker/price?symbol=${symbol}`),
    proxyBinance(`/fapi/v1/ticker/24hr?symbol=${symbol}`),
    proxyBinance(`/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=${rl}`),
    proxyBinance(`/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=${rl}`),
    proxyBinance(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=${rl}`),
    proxyBinance(`/fapi/v1/openInterest?symbol=${symbol}`),
    proxyBinance(`/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=${ol}`),
    proxyBinance(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=${tl}`),
    proxyBinance(`/fapi/v1/premiumIndex?symbol=${symbol}`),
    proxyBinance(`/fapi/v1/fundingRate?symbol=${symbol}&limit=100`),
  ];
  const settled = await Promise.allSettled(tasks);
  const data = {};
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') data[keys[i]] = r.value;
    else errors.push(`${keys[i]}: ${r.reason?.message || r.reason}`);
  });
  if (!data.price) {
    throw new Error(errors[0] || '无法获取价格数据，请检查代理或稍后重试');
  }
  const changeSince8am = await getChangeSince8am(symbol, data.price.price).catch(() => null);
  if (errors.length) data.warnings = errors;
  return { ...data, changeSince8am };
}

let FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || '';
const STABLE_PUSH_HOURS = parseFloat(process.env.STABLE_PUSH_HOURS || '4', 10);
const STABLE_PUSH_ENABLED = process.env.STABLE_PUSH_ENABLED !== 'false' && !!FEISHU_WEBHOOK;
const STABLE_SCAN_LIMIT = parseInt(process.env.STABLE_SCAN_LIMIT || '200', 10);
const STABLE_MAX_DRAWDOWN = parseFloat(process.env.STABLE_MAX_DRAWDOWN || '0.30', 10);
const DUMP_PUSH_HOURS = parseFloat(process.env.DUMP_PUSH_HOURS || process.env.COMBINED_PUSH_HOURS || '4', 10);
const DUMP_PUSH_ENABLED = process.env.DUMP_PUSH_ENABLED !== 'false' && !!FEISHU_WEBHOOK;
const DUMP_SCAN_LIMIT = parseInt(process.env.DUMP_SCAN_LIMIT || '200', 10);
const DUMP_MIN_RISK = parseInt(process.env.DUMP_MIN_RISK || '4', 10);
const LONG_PUSH_HOURS = parseFloat(process.env.LONG_PUSH_HOURS || process.env.COMBINED_PUSH_HOURS || '4', 10);
const COMBINED_PUSH_HOURS = parseFloat(process.env.COMBINED_PUSH_HOURS || process.env.STABLE_PUSH_HOURS || '4', 10);
const LONG_PUSH_ENABLED = process.env.LONG_PUSH_ENABLED !== 'false' && !!FEISHU_WEBHOOK;
const LONG_SCAN_LIMIT = parseInt(process.env.LONG_SCAN_LIMIT || '200', 10);
const LONG_MIN_SCORE = parseInt(process.env.LONG_MIN_SCORE || '3', 10);
const PUMP_SMART_ENABLED = process.env.PUMP_SMART_ALERT_ENABLED !== 'false' && !!FEISHU_WEBHOOK;

const PUMP_GAINER_ENABLED = process.env.PUMP_GAINER_ALERT_ENABLED === 'true' && !!FEISHU_WEBHOOK;

const POSITION_HEALTH_ENABLED = process.env.POSITION_HEALTH_ENABLED !== 'false' && !!FEISHU_WEBHOOK;
const POSITION_HEALTH_PUSH_HOURS = parseFloat(process.env.POSITION_HEALTH_PUSH_HOURS || '2', 10);
const POSITION_HEALTH_URGENT_CHECK_MIN = parseInt(process.env.POSITION_HEALTH_URGENT_CHECK_MIN || '30', 10);
const POSITION_HEALTH_URGENT_COOLDOWN_MIN = parseInt(process.env.POSITION_HEALTH_URGENT_COOLDOWN_MIN || '60', 10);
const POSITION_HEALTH_WATCH_SYMBOLS = new Set(
  (process.env.POSITION_HEALTH_WATCH_SYMBOLS || 'LABUSDT')
    .split(/[,，\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(s => (s.endsWith('USDT') ? s : `${s}USDT`)),
);

const SMART_TREND_DECISION_WEBHOOK = process.env.SMART_TREND_DECISION_WEBHOOK || FEISHU_WEBHOOK;
const SMART_TREND_DECISION_ENABLED = process.env.SMART_TREND_DECISION_ENABLED !== 'false' && !!SMART_TREND_DECISION_WEBHOOK;
const SMART_TREND_ENABLED = process.env.SMART_TREND_ENABLED !== 'false' && (!!FEISHU_WEBHOOK || SMART_TREND_DECISION_ENABLED);
const SMART_TREND_INTERVAL_MIN = parseInt(process.env.SMART_TREND_INTERVAL_MIN || '60', 10);
const SMART_TREND_COOLDOWN_MIN = parseInt(process.env.SMART_TREND_COOLDOWN_MIN || '60', 10);
const SMART_TREND_RATIO_CHANGE_PCT = parseFloat(process.env.SMART_TREND_RATIO_CHANGE_PCT || '10', 10);
const SMART_TREND_DIGEST_PAGE_SIZE = parseInt(process.env.SMART_TREND_DIGEST_PAGE_SIZE || '10', 10);
const SMART_TREND_DYNAMIC_WATCH = process.env.SMART_TREND_DYNAMIC_WATCH !== 'false';
const SMART_TREND_BOARD_TOP_N = parseInt(process.env.SMART_TREND_BOARD_TOP_N || '20', 10);
const SMART_TREND_VOLUME_TOP_N = parseInt(process.env.SMART_TREND_VOLUME_TOP_N || '50', 10);
const SMART_TREND_MERGE_CARDS = process.env.SMART_TREND_MERGE_CARDS !== 'false';
const SMART_TREND_MIN_RANKING_VOLUME_24H = Math.max(0, parseInt(process.env.SMART_TREND_MIN_RANKING_VOLUME_24H || '10000000', 10) || 0);
const SMART_TREND_WATCHLIST_REFRESH_MIN = parseInt(process.env.SMART_TREND_WATCHLIST_REFRESH_MIN || '60', 10);
const SMART_TREND_WATCH_SYMBOLS = new Set(
  (process.env.SMART_TREND_WATCH_SYMBOLS || process.env.POSITION_HEALTH_WATCH_SYMBOLS || '')
    .split(/[,，\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(s => (s.endsWith('USDT') ? s : `${s}USDT`)),
);
const SMART_TREND_DIVERGENCE_THRESHOLD = parseFloat(process.env.SMART_TREND_DIVERGENCE_THRESHOLD || '0.25', 10);
const REBOUND_HIGHLIGHT_CHANGE_PCT = parseFloat(process.env.REBOUND_HIGHLIGHT_CHANGE_PCT || '15', 10);
/** 现货持仓列表（逗号分隔），有现货的币不推荐做多 */
const SPOT_HOLDINGS = new Set(
  (process.env.SPOT_HOLDINGS || '')
    .split(/[,，\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(s => (s.endsWith('USDT') ? s : `${s}USDT`)),
);

let pumpSmartRunning = false;
let dumpAlertRunning = false;
let pumpGainerRunning = false;
/** @type {Map<string, { since: number, count: number, lastScore: number, lastPushedAt: number }>} */
const pumpSmartActive = new Map();
const pumpGainerActive = new Map();
const dumpAlertActive = new Map();

async function sendFeishu(title, content) {
  if (!FEISHU_WEBHOOK) throw new Error('FEISHU_WEBHOOK 未配置');
  const body = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
      elements: [{ tag: 'markdown', content }],
    },
  };
  const res = await fetch(FEISHU_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendFeishuCardV2(title, elements, template = 'blue', webhook = FEISHU_WEBHOOK) {
  if (!webhook) throw new Error('飞书 webhook 未配置');
  const body = {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: title }, template },
      body: { elements },
    },
  };
  const payload = JSON.stringify(body);
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(3000 * attempt);
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const data = await res.json();
    if (data.code === 0) return data;
    lastErr = new Error(`飞书卡片发送失败: ${data.msg || JSON.stringify(data)}`);
    const msg = String(data.msg || '');
    if (!/frequency|rate|limit|频控|限流/i.test(msg)) throw lastErr;
  }
  throw lastErr;
}

function formatStablePushContent(results) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  if (!results.length) {
    return `**扫描时间:** ${now}\n\n暂无符合「右侧稳趋势」条件的币种\n\n_回撤≤${(STABLE_MAX_DRAWDOWN * 100).toFixed(0)}% · 1H+1D双周期 · Top${STABLE_SCAN_LIMIT}_`;
  }
  const lines = results.map((c, i) => {
    const chg = c.change >= 0 ? `+${c.change.toFixed(1)}%` : `${c.change.toFixed(1)}%`;
    return `${i + 1}. **${c.label}** ${chg} · 评分 ${c.score}/5 · 回撤 ${c.drawdown.toFixed(1)}%`;
  });
  return `**扫描时间:** ${now}\n**共 ${results.length} 个币种**\n\n${lines.join('\n')}\n\n_回撤≤${(STABLE_MAX_DRAWDOWN * 100).toFixed(0)}% · 1H+1D双周期 · Top${STABLE_SCAN_LIMIT}_`;
}

let stablePushRunning = false;
let stablePushHistory = [];

function fmtPrice(p) {
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(4);
}

async function runStableTrendPush() {
  if (!STABLE_PUSH_ENABLED || stablePushRunning) return;
  stablePushRunning = true;
  try {
    console.log(`\n  📤 开始稳趋势扫描推送...`);
    await waitForNetworkReady('币安 API', { maxAttempts: 6, initialDelayMs: 10000 });
    const results = await filterItemsByMarketCap(await scanRightStable({
      limit: STABLE_SCAN_LIMIT,
      maxDrawdownPct: STABLE_MAX_DRAWDOWN,
      dualTFConfirm: true,
      filterTF: '1h',
      concurrency: 3,
    }));

    if (!results.length) {
      console.log(`  ✓ 稳趋势扫描完成，无符合市值条件的币种`);
      return;
    }

    const resultSymbols = results.map(r => r.symbol);

    const { prices: baselines } = await load8amBaselinePrices(resultSymbols);
    for (const r of results) {
      const base = baselines[r.symbol];
      r.changeSince8am = base && base > 0 ? ((r.price - base) / base) * 100 : r.change;
    }

    const symbolMap = new Map(results.map(r => [r.symbol, r]));
    await pmap(resultSymbols, async (sym) => {
      const [topAccounts, globalRatio] = await Promise.all([
        proxyBinance(`/futures/data/topLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
        proxyBinance(`/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
      ]);
      const r = symbolMap.get(sym);
      if (r) {
        r.topRatio = parseFloat(topAccounts[0]?.longShortRatio) || 0;
        r.globalRatio = parseFloat(globalRatio[0]?.longShortRatio) || 0;
        r.topVsGlobal = r.globalRatio > 0 ? r.topRatio / r.globalRatio : null;
      }
    }, 10);

    for (const r of results) {
      let count = 1;
      for (let i = stablePushHistory.length - 1; i >= 0; i--) {
        if (stablePushHistory[i].has(r.symbol)) count++;
        else break;
      }
      r.streak = count;
    }
    stablePushHistory.push(new Set(resultSymbols));
    if (stablePushHistory.length > 100) stablePushHistory = stablePushHistory.slice(-100);

    results.sort((a, b) => b.streak - a.streak || b.score - a.score || b.change - a.change);

    const allSymbols = results.map(r => r.symbol);
    const marketCaps = await batchFetchMarketCaps(allSymbols);

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const elements = [];
    elements.push({ tag: 'markdown', content: `**扫描时间:** ${now}  **共 ${results.length} 个币种**` });
    elements.push({
      tag: 'table',
      page_size: 10,
      row_height: 'low',
      freeze_first_column: true,
      columns: [
        { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
        { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
        { name: 'chg8am', display_name: '8am', data_type: 'lark_md', width: 'auto' },
        { name: 'chg24h', display_name: '24h', data_type: 'lark_md', width: 'auto' },
        { name: 'score', display_name: '评分', data_type: 'lark_md', width: 'auto' },
        { name: 'dd', display_name: '回撤', data_type: 'text', width: 'auto' },
        { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
        { name: 'whale', display_name: '大户比', data_type: 'text', width: 'auto' },
        { name: 'streak', display_name: '连续', data_type: 'lark_md', width: 'auto' },
      ],
      rows: results.map(c => {
        const chg8amVal = c.changeSince8am;
        const chg8amColor = chg8amVal >= 5 ? 'green' : chg8amVal >= 0 ? 'turquoise' : 'red';
        const chg8amIcon = chg8amVal >= 5 ? '🚀' : '';
        const chg8amArrow = chg8amVal >= 5 ? '' : chg8amVal >= 0 ? '▲' : '▼';
        const chg24hVal = c.change;
        const chg24hColor = chg24hVal >= 5 ? 'green' : chg24hVal >= 0 ? 'turquoise' : 'red';
        const chg24hIcon = chg24hVal >= 5 ? '🚀' : '';
        const chg24hArrow = chg24hVal >= 5 ? '' : chg24hVal >= 0 ? '▲' : '▼';
        const scoreIcon = c.score >= 5 ? '🔥' : c.score >= 4 ? '⭐' : '✦';
        const scoreColor = c.score >= 5 ? 'green' : c.score >= 4 ? 'blue' : 'grey';
        const streakIcon = c.streak >= 5 ? '🔥' : c.streak >= 3 ? '🔄' : '·';
        const streakColor = c.streak >= 5 ? 'violet' : c.streak >= 3 ? 'blue' : 'grey';
        return {
          coin: c.label,
          price: `$${fmtPrice(c.price)}`,
          chg8am: `${chg8amIcon}<font color='${chg8amColor}'>${chg8amArrow}${chg8amVal >= 0 ? '+' : ''}${chg8amVal.toFixed(1)}%</font>`,
          chg24h: `${chg24hIcon}<font color='${chg24hColor}'>${chg24hArrow}${chg24hVal >= 0 ? '+' : ''}${chg24hVal.toFixed(1)}%</font>`,
          score: `${scoreIcon}<font color='${scoreColor}'>${c.score}/5</font>`,
          dd: `${c.drawdown.toFixed(1)}%`,
          mc: fmtMarketCap(marketCaps[c.symbol]),
          whale: c.topVsGlobal != null ? c.topVsGlobal.toFixed(2) : '-',
          streak: c.streak > 1 ? `${streakIcon}<font color='${streakColor}'>${c.streak}次</font>` : '-',
        };
      }),
    });
    elements.push({ tag: 'markdown', content: `_回撤≤${(STABLE_MAX_DRAWDOWN * 100).toFixed(0)}% · 1H+1D双周期 · Top${STABLE_SCAN_LIMIT} · 每${STABLE_PUSH_HOURS}h_` });

    await sendFeishuCardV2(`右侧稳趋势 · ${results.length} 个币种`, elements, 'turquoise');
    console.log(`  ✓ 稳趋势推送完成 (${results.length} 个币种)`);

    savePredictionSnapshot({ stable: results, source: 'stable' }).catch(() => {});
  } catch (e) {
    console.warn(`  ⚠ 稳趋势推送失败: ${e.message}`);
  } finally {
    stablePushRunning = false;
  }
}

function getStablePushHours(stepHours = 4) {
  const hours = [];
  for (let h = 0; h < 24; h += stepHours) hours.push(h);
  return hours;
}

function getNextStablePushTime(now = new Date(), stepHours = 4) {
  const pushHours = getStablePushHours(stepHours);
  const p = getShanghaiParts(now);
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  for (const h of pushHours) {
    const slot = new Date(`${dateKey}T${String(h).padStart(2, '0')}:50:00+08:00`);
    if (slot.getTime() > now.getTime() + 500) return slot;
  }
  const nextDay = new Date(`${dateKey}T00:50:00+08:00`);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay;
}

function startStablePushScheduler() {
  if (!STABLE_PUSH_ENABLED) {
    console.log(`  ⏸ 稳趋势推送未启用（需配置 FEISHU_WEBHOOK）`);
    return;
  }
  const slots = getStablePushHours(STABLE_PUSH_HOURS).map(h => `${String(h).padStart(2, '0')}:50`).join(' / ');
  console.log(`  🔔 稳趋势推送: 上海时间 ${slots}（每 ${STABLE_PUSH_HOURS}h）→ 飞书`);

  const scheduleNext = () => {
    const next = getNextStablePushTime(new Date(), STABLE_PUSH_HOURS);
    const delay = Math.max(0, next.getTime() - Date.now());
    const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  ⏭ 下次推送: ${label}（${Math.round(delay / 60000)} 分钟后）`);
    setTimeout(async () => {
      await runStableTrendPush();
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

function fmtMarketCap(mc) {
  if (!mc || mc <= 0) return '?';
  if (mc >= 1e12) return `${(mc / 1e12).toFixed(2)}万亿`;
  if (mc >= 1e8) return `${(mc / 1e8).toFixed(1)}亿`;
  if (mc >= 1e4) return `${(mc / 1e4).toFixed(0)}万`;
  return `${mc.toFixed(0)}`;
}

async function refreshMcCacheCMC() {
  if (Date.now() - mcCache.ts < mcCache.TTL && mcCache.data.size > 0) return;
  const json = await fetchJson(`${CMC_BASE}/v1/cryptocurrency/listings/latest?limit=${MC_CACHE_LIMIT}&convert=USD`, {
    headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' },
    timeoutMs: 20000,
  });
  const m = new Map();
  for (const c of json.data || []) {
    m.set(c.symbol.toUpperCase(), c.quote?.USD?.market_cap || 0);
  }
  mcCache.data = m;
  mcCache.ts = Date.now();
  console.log(`[CMC] 缓存已刷新, ${m.size} 个币种`);
}

async function refreshMcCacheGecko() {
  if (Date.now() - mcCache.ts < mcCache.TTL && mcCache.data.size > 0) return;
  const m = new Map();
  const data = await fetchJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${MC_CACHE_LIMIT}&page=1&sparkline=false`, { timeoutMs: 20000 });
  if (data.length) {
    for (const c of data) {
      if (c.market_cap > 0) m.set(c.symbol.toUpperCase(), c.market_cap);
    }
  }
  if (m.size > 0) {
    mcCache.data = m;
    mcCache.ts = Date.now();
    console.log(`[CoinGecko] 缓存已刷新, ${m.size} 个币种`);
  }
}

async function refreshMcCache() {
  if (Date.now() - mcCache.ts < mcCache.TTL && mcCache.data.size > 0) return;
  if (CMC_API_KEY) {
    try { await refreshMcCacheCMC(); return; } catch (e) { console.warn(`[CMC] 刷新失败, 回退 CoinGecko: ${e.message}`); }
  }
  try { await refreshMcCacheGecko(); } catch (e) { console.warn(`[CoinGecko] 刷新失败: ${e.message}`); }
}

function normSymbol(sym) {
  return sym.replace('USDT', '').replace(/^1000/, '').toUpperCase();
}

async function fetchMcForSymbolGecko(sym) {
  const lower = sym.replace('USDT', '').replace(/^1000/, '').toLowerCase();
  try {
    const sr = await fetchJson(`https://api.coingecko.com/api/v3/search?query=${lower}`, { timeoutMs: 15000 });
    const sd = sr;
    const coin = sd.coins?.find(c => c.symbol?.toLowerCase() === lower) || sd.coins?.[0];
    if (!coin) return 0;
    const pd = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_market_cap=true`, { timeoutMs: 15000 });
    return pd[coin.id]?.usd_market_cap || 0;
  } catch { return 0; }
}

async function fetchMcForSymbol(sym) {
  const upper = normSymbol(sym);
  await refreshMcCache();
  if (mcCache.data.has(upper)) return mcCache.data.get(upper);
  if (CMC_API_KEY) {
    try {
      const json = await fetchJson(`${CMC_BASE}/v1/cryptocurrency/quotes/latest?symbol=${upper}&convert=USD`, {
        headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' },
        timeoutMs: 15000,
      });
      const entry = Object.values(json.data || {})[0];
      const arr = Array.isArray(entry) ? entry : [entry];
      const mc = arr[0]?.quote?.USD?.market_cap || 0;
      if (mc > 0) { mcCache.data.set(upper, mc); return mc; }
    } catch {}
  }
  const mc = await fetchMcForSymbolGecko(sym);
  if (mc > 0) mcCache.data.set(upper, mc);
  return mc;
}

async function batchFetchMarketCaps(symbols) {
  const result = {};
  await refreshMcCache();
  const missing = [];
  for (const s of symbols) {
    const upper = normSymbol(s);
    const cached = mcCache.data.get(upper);
    if (cached && cached > 0) {
      result[s] = cached;
    } else {
      missing.push(s);
    }
  }
  if (missing.length > 0 && CMC_API_KEY) {
    const slugs = [...new Set(missing.map(s => normSymbol(s)))];
    const chunks = [];
    for (let i = 0; i < slugs.length; i += 100) chunks.push(slugs.slice(i, i + 100));
    for (const chunk of chunks) {
      try {
        const json = await fetchJson(`${CMC_BASE}/v1/cryptocurrency/quotes/latest?symbol=${chunk.join(',')}&convert=USD`, {
          headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' },
          timeoutMs: 20000,
        });
        for (const [, v] of Object.entries(json.data || {})) {
          const arr = Array.isArray(v) ? v : [v];
          for (const coin of arr) {
            const mc = coin?.quote?.USD?.market_cap || 0;
            if (mc > 0) mcCache.data.set(coin.symbol.toUpperCase(), mc);
          }
        }
      } catch (e) { console.warn(`[CMC] batch 查询失败: ${e.message}`); }
    }
  }
  for (const s of missing) {
    const upper = normSymbol(s);
    result[s] = mcCache.data.get(upper) || 0;
  }
  return result;
}

let combinedPushRunning = false;
let longPushHistory = [];
const COMBINED_TOP_N = 20;

async function collectPredictionSnapshot() {
  try {
    await waitForNetworkReady('币安 API', { maxAttempts: 3, initialDelayMs: 5000 });
    const { gainMap, declineMap, gainerItems } = await build8amChangeMaps();
    const [longAll, shortAll, dumpAll, stableAll, momentumAll] = await Promise.all([
      filterItemsByMarketCap(await scanRightStable({
        limit: LONG_SCAN_LIMIT, maxDrawdownPct: 0.20, dualTFConfirm: true, filterTF: '1h', concurrency: 3, strictTrend: true,
      })).then(r => r.filter(x => x.score >= LONG_MIN_SCORE).slice(0, COMBINED_TOP_N)).catch(() => []),
      filterItemsByMarketCap(await scanShortSignals({
        limit: 100, minScore: 4, concurrency: 3, declineMap, gainMap,
      })).then(r => r.slice(0, COMBINED_TOP_N)).catch(() => []),
      filterItemsByMarketCap(await scanDumpCoins({ limit: DUMP_SCAN_LIMIT, minRiskScore: DUMP_MIN_RISK, concurrency: 3 })).then(r => r.slice(0, COMBINED_TOP_N)).catch(() => []),
      filterItemsByMarketCap(await scanRightStable({
        limit: STABLE_SCAN_LIMIT, maxDrawdownPct: STABLE_MAX_DRAWDOWN, dualTFConfirm: true, filterTF: '1h', concurrency: 3,
      })).catch(() => []),
      filterItemsByMarketCap(await scanMomentumLong({ candidates: gainerItems, minScore: 3, concurrency: 3 })).catch(() => []),
    ]);
    const longMerged = mergeLongWithMomentum(longAll, momentumAll);
    await savePredictionSnapshot({ long: longMerged, short: shortAll, dump: dumpAll, stable: stableAll, source: 'snapshot' });
    console.log(`  📸 预测快照已保存 (多${longMerged.length} 空${shortAll.length} 暴跌${dumpAll.length} 稳${stableAll.length} 动量${momentumAll.length})`);
  } catch (e) {
    console.warn(`  ⚠ 预测快照采集失败: ${e.message}`);
  }
}

function mergeLongWithMomentum(stableLong, momentum) {
  const seen = new Set(stableLong.map(r => r.symbol));
  const merged = [...stableLong];
  for (const m of momentum) {
    if (!seen.has(m.symbol)) {
      merged.push({
        symbol: m.symbol,
        label: m.label,
        score: m.score,
        price: m.price,
        change: m.changeSince8am,
        changeSince8am: m.changeSince8am,
        detail: m.detail,
        type: 'momentum',
      });
      seen.add(m.symbol);
    }
  }
  merged.sort((a, b) => (b.changeSince8am ?? b.change ?? 0) - (a.changeSince8am ?? a.change ?? 0));
  return merged.slice(0, COMBINED_TOP_N);
}

function startPredictionSnapshotScheduler() {
  if (process.env.STRATEGY_REVIEW_ENABLED === 'false') return;
  console.log(`  📸 预测快照: 每小时50分采集（供策略复盘对比）`);
  const scheduleNext = () => {
    const next = getNextStablePushTime(new Date(), 1);
    const delay = Math.max(0, next.getTime() - Date.now());
    setTimeout(async () => {
      await collectPredictionSnapshot();
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

async function runCombinedPush() {
  if (combinedPushRunning) return;
  const longEnabled = LONG_PUSH_ENABLED;
  if (!longEnabled) return;
  combinedPushRunning = true;
  try {
    console.log(`\n  📤 开始做多+做空扫描（每 ${COMBINED_PUSH_HOURS}h）...`);
    await waitForNetworkReady('币安 API', { maxAttempts: 6, initialDelayMs: 10000 });

    let longResults = [];
    let shortResults = [];
    let momentumResults = [];

    const { gainMap, declineMap, gainerItems } = await build8amChangeMaps();

    const tasks = [];
    if (longEnabled) tasks.push((async () => {
      const allResults = await scanRightStable({
        limit: LONG_SCAN_LIMIT,
        maxDrawdownPct: 0.20,
        dualTFConfirm: true,
        filterTF: '1h',
        concurrency: 3,
        strictTrend: true,
      });
      const filtered = (await filterItemsByMarketCap(allResults))
        .filter(r => r.score >= LONG_MIN_SCORE)
        .filter(r => (r.change ?? 0) >= -3);
      const resultSymbols = filtered.map(r => r.symbol);

      const { prices: baselines } = await load8amBaselinePrices(resultSymbols);
      for (const r of filtered) {
        const base = baselines[r.symbol];
        r.changeSince8am = base && base > 0 ? ((r.price - base) / base) * 100 : r.change;
      }

      const longEligible = filtered.filter(r => (r.changeSince8am ?? 0) >= 0);
      const dropped = filtered.length - longEligible.length;
      if (dropped > 0) {
        console.log(`  ⏭ 做多过滤: 剔除 ${dropped} 个8点以来下跌币种`);
      }

      const symbolMap = new Map(longEligible.map(r => [r.symbol, r]));
      await pmap(longEligible.map(r => r.symbol), async (sym) => {
        const [topAccounts, globalRatio] = await Promise.all([
          proxyBinance(`/futures/data/topLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
          proxyBinance(`/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
        ]);
        const r = symbolMap.get(sym);
        if (r) {
          r.topRatio = parseFloat(topAccounts[0]?.longShortRatio) || 0;
          r.globalRatio = parseFloat(globalRatio[0]?.longShortRatio) || 0;
          r.topVsGlobal = r.globalRatio > 0 ? r.topRatio / r.globalRatio : null;
        }
      }, 10);

      for (const r of longEligible) {
        let count = 1;
        for (let i = longPushHistory.length - 1; i >= 0; i--) {
          if (longPushHistory[i].has(r.symbol)) count++;
          else break;
        }
        r.streak = count;
      }
      longPushHistory.push(new Set(longEligible.map(r => r.symbol)));
      if (longPushHistory.length > 100) longPushHistory = longPushHistory.slice(-100);

      longEligible.sort((a, b) => b.score - a.score || b.changeSince8am - a.changeSince8am || b.streak - a.streak);
      longResults = longEligible.slice(0, COMBINED_TOP_N);

      const momentum = await filterItemsByMarketCap(await scanMomentumLong({ candidates: gainerItems, minScore: 3, concurrency: 3 }));
      momentumResults = momentum;
      longResults = mergeLongWithMomentum(longResults, momentum);
    })());

    tasks.push((async () => {
      try {
        const results = await filterItemsByMarketCap(await scanShortSignals({
          limit: 100, minScore: 4, concurrency: 3, declineMap, gainMap,
        }));
        shortResults = results.slice(0, COMBINED_TOP_N);
      } catch (e) {
        console.warn(`  ⚠ 做空扫描异常: ${e.message}`);
      }
    })());

    await Promise.all(tasks);

    if (!longResults.length && !shortResults.length) {
      console.log(`  ✓ 做多+做空扫描完成，当前无信号`);
      return;
    }

    const allSymbols = [
      ...longResults.map(r => r.symbol),
      ...shortResults.map(r => r.symbol),
    ];
    const marketCaps = await batchFetchMarketCaps(allSymbols);

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const elements = [];

    elements.push({ tag: 'markdown', content: `**扫描时间:** ${now}` });

    if (longResults.length) {
      const momCount = momentumResults.length;
      elements.push({ tag: 'markdown', content: `**📈 做多推荐 · ${longResults.length} 个** (评分≥${LONG_MIN_SCORE}/5 · 回撤≤20%${momCount ? ` · 含${momCount}个8点追涨` : ''})` });
      elements.push({
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        freeze_first_column: true,
        columns: [
          { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
          { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
          { name: 'chg8am', display_name: '8am', data_type: 'lark_md', width: 'auto' },
          { name: 'chg24h', display_name: '24h', data_type: 'lark_md', width: 'auto' },
          { name: 'score', display_name: '评分', data_type: 'lark_md', width: 'auto' },
          { name: 'dd', display_name: '回撤', data_type: 'text', width: 'auto' },
          { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
          { name: 'whale', display_name: '大户比', data_type: 'text', width: 'auto' },
          { name: 'streak', display_name: '连续', data_type: 'lark_md', width: 'auto' },
        ],
        rows: longResults.map(c => {
          const chg8amVal = c.changeSince8am;
          const chg8amColor = chg8amVal >= 5 ? 'green' : chg8amVal >= 0 ? 'turquoise' : 'red';
          const chg8amIcon = chg8amVal >= 5 ? '🚀' : '';
          const chg8amArrow = chg8amVal >= 5 ? '' : chg8amVal >= 0 ? '▲' : '▼';
          const chg24hVal = c.change;
          const chg24hColor = chg24hVal >= 5 ? 'green' : chg24hVal >= 0 ? 'turquoise' : 'red';
          const chg24hIcon = chg24hVal >= 5 ? '🚀' : '';
          const chg24hArrow = chg24hVal >= 5 ? '' : chg24hVal >= 0 ? '▲' : '▼';
          const scoreIcon = c.score >= 5 ? '🔥' : c.score >= 4 ? '⭐' : '✦';
          const scoreColor = c.score >= 5 ? 'green' : c.score >= 4 ? 'blue' : 'grey';
          const streakIcon = c.streak >= 5 ? '🔥' : c.streak >= 3 ? '🔄' : '·';
          const streakColor = c.streak >= 5 ? 'violet' : c.streak >= 3 ? 'blue' : 'grey';
          return {
            coin: c.type === 'momentum' ? `${c.label}🚀` : c.label,
            price: `$${fmtPrice(c.price)}`,
            chg8am: `${chg8amIcon}<font color='${chg8amColor}'>${chg8amArrow}${chg8amVal >= 0 ? '+' : ''}${(chg8amVal ?? 0).toFixed(1)}%</font>`,
            chg24h: chg24hVal != null ? `${chg24hIcon}<font color='${chg24hColor}'>${chg24hArrow}${chg24hVal >= 0 ? '+' : ''}${chg24hVal.toFixed(1)}%</font>` : '-',
            score: `${scoreIcon}<font color='${scoreColor}'>${c.score}/5</font>`,
            dd: c.drawdown != null ? `${c.drawdown.toFixed(1)}%` : '-',
            mc: fmtMarketCap(marketCaps[c.symbol]),
            whale: c.topVsGlobal != null ? c.topVsGlobal.toFixed(2) : '-',
            streak: c.streak > 1 ? `${streakIcon}<font color='${streakColor}'>${c.streak}次</font>` : '-',
          };
        }),
      });
    }

    if (shortResults.length) {
      elements.push({ tag: 'markdown', content: `**📉 做空推荐 · ${shortResults.length} 个** (暴涨回落/高位横盘)` });
      elements.push({
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        freeze_first_column: true,
        columns: [
          { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
          { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
          { name: 'chg24h', display_name: '24h', data_type: 'lark_md', width: 'auto' },
          { name: 'dd', display_name: '峰值跌', data_type: 'lark_md', width: 'auto' },
          { name: 'score', display_name: '做空分', data_type: 'lark_md', width: 'auto' },
          { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
          { name: 'tags', display_name: '信号', data_type: 'text', width: 'auto' },
        ],
        rows: shortResults.map(r => {
          const chg24hColor = r.chg24h > 50 ? 'green' : r.chg24h > 0 ? 'turquoise' : 'red';
          const chg24hIcon = r.chg24h > 50 ? '🚀' : r.chg24h > 0 ? '▲' : '▼';
          const ddColor = r.ddFromPeak > 20 ? 'red' : 'orange';
          const scoreColor = r.shortScore >= 7 ? 'red' : r.shortScore >= 5 ? 'orange' : 'grey';
          return {
            coin: r.label,
            price: `$${fmtPrice(r.price)}`,
            chg24h: `${chg24hIcon}<font color='${chg24hColor}'>${r.chg24h >= 0 ? '+' : ''}${r.chg24h.toFixed(0)}%</font>`,
            dd: `<font color='${ddColor}'>▼${r.ddFromPeak.toFixed(0)}%</font>`,
            score: `<font color='${scoreColor}'>${r.shortScore}分</font>`,
            mc: fmtMarketCap(marketCaps[r.symbol]),
            tags: r.signals.slice(0, 3).map(s => s.tag).join(' '),
          };
        }),
      });
    }

    elements.push({ tag: 'markdown', content: `_每 ${COMBINED_PUSH_HOURS}h · Top${LONG_SCAN_LIMIT} · 各取前${COMBINED_TOP_N}_` });

    const titleParts = [];
    if (longResults.length) titleParts.push(`📈${longResults.length}做多`);
    if (shortResults.length) titleParts.push(`📉${shortResults.length}做空`);
    const title = `${COMBINED_PUSH_HOURS}h扫描 · ${titleParts.join(' · ')}`;

    await sendFeishuCardV2(title, elements);
    console.log(`  ✓ 做多+做空推送完成 (做多 ${longResults.length} + 做空 ${shortResults.length})`);

    savePredictionSnapshot({ long: longResults, short: shortResults, source: 'combined' }).catch(() => {});
  } catch (e) {
    console.warn(`  ⚠ 联合推送失败: ${e.message}`);
  } finally {
    combinedPushRunning = false;
  }
}

async function runDumpAlertPush() {
  if (!DUMP_PUSH_ENABLED || dumpAlertRunning) return;
  dumpAlertRunning = true;
  try {
    await waitForNetworkReady('币安 API', { maxAttempts: 3, initialDelayMs: 5000 });
    const dumpResults = (await filterItemsByMarketCap(await scanDumpCoins({
      limit: DUMP_SCAN_LIMIT,
      minRiskScore: DUMP_MIN_RISK,
      concurrency: 3,
    }))).slice(0, COMBINED_TOP_N);

    const activeSymbols = new Set(dumpResults.map(r => r.symbol));
    for (const sym of [...dumpAlertActive.keys()]) {
      if (!activeSymbols.has(sym)) dumpAlertActive.delete(sym);
    }
    if (!dumpResults.length) {
      console.log(`  ✓ 暴跌实时扫描: 无触发 (风险≥${DUMP_MIN_RISK})`);
      return;
    }

    const dumpSymbols = dumpResults.map(r => r.symbol);
    const { prices: dumpBaselines } = await load8amBaselinePrices(dumpSymbols);
    for (const r of dumpResults) {
      const base = dumpBaselines[r.symbol];
      r.changeSince8am = base && base > 0 ? ((r.price - base) / base) * 100 : r.change24h;
    }

    const marketCaps = await batchFetchMarketCaps(dumpSymbols);
    const pushCounts = {};
    for (const r of dumpResults) {
      const prev = dumpAlertActive.get(r.symbol);
      pushCounts[r.symbol] = prev ? prev.count + 1 : 1;
      dumpAlertActive.set(r.symbol, { since: prev?.since ?? Date.now(), count: pushCounts[r.symbol] });
    }

    const highRisk = dumpResults.filter(r => r.riskLevel === 'high');
    const warnRisk = dumpResults.filter(r => r.riskLevel === 'warn');
    const reboundHighCount = dumpResults.filter(r => r.reboundLevel === 'high').length;
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const elements = [
      { tag: 'markdown', content: `**⏰ ${now}**\n**暴跌预警** · 每 ${DUMP_PUSH_HOURS}h 50分 · 风险≥${DUMP_MIN_RISK}` },
      { tag: 'markdown', content: `**🚨 ${highRisk.length} 高危 · ⚠️ ${warnRisk.length} 警告${reboundHighCount > 0 ? ` · ⚡ ${reboundHighCount} 个高反弹潜力` : ''}**` },
      {
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        freeze_first_column: true,
        columns: [
          { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
          { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
          { name: 'chg8am', display_name: '8am', data_type: 'lark_md', width: 'auto' },
          { name: 'chg24h', display_name: '24h', data_type: 'lark_md', width: 'auto' },
          { name: 'risk', display_name: '风险', data_type: 'lark_md', width: 'auto' },
          { name: 'rebound', display_name: '反弹', data_type: 'lark_md', width: 'auto' },
          { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
          { name: 'tags', display_name: '风险标签', data_type: 'text', width: 'auto' },
        ],
        rows: [...highRisk, ...warnRisk].map(r => {
          const chg8amColor = r.changeSince8am >= 0 ? 'turquoise' : r.changeSince8am <= -10 ? 'red' : 'orange';
          const chg24hColor = r.change24h >= 0 ? 'turquoise' : r.change24h <= -10 ? 'red' : 'orange';
          const riskColor = r.riskLevel === 'high' ? 'red' : 'orange';
          const reboundColor = r.reboundLevel === 'high' ? 'green' : r.reboundLevel === 'medium' ? 'orange' : 'grey';
          return {
            coin: r.label,
            price: `$${fmtPrice(r.price)}`,
            chg8am: `<font color='${chg8amColor}'>${r.changeSince8am >= 0 ? '+' : ''}${r.changeSince8am.toFixed(1)}%</font>`,
            chg24h: `<font color='${chg24hColor}'>${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(1)}%</font>`,
            risk: `<font color='${riskColor}'>${r.riskScore}</font>`,
            rebound: `<font color='${reboundColor}'>${r.reboundScore ?? '-'}${r.reboundLabel || ''}</font>`,
            mc: fmtMarketCap(marketCaps[r.symbol]),
            tags: r.risks.slice(0, 3).map(x => `${x.level}${x.tag}`).join(' '),
          };
        }),
      },
    ];

    const title = `🚨 暴跌预警 · ${dumpResults.length} 个${reboundHighCount > 0 ? ` · ⚡ ${reboundHighCount} 个高反弹潜力` : ''}${pushCounts[dumpResults[0]?.symbol] > 1 ? ' (持续)' : ''}`;
    await sendFeishuCardV2(title, elements, 'red');
    console.log(`  ✓ 暴跌实时推送 (${dumpResults.length} 个: ${dumpResults.map(r => r.label).join(', ')})`);
    savePredictionSnapshot({ dump: dumpResults, source: 'dump-realtime' }).catch(() => {});
  } catch (e) {
    console.warn(`  ⚠ 暴跌实时推送失败: ${e.message}`);
  } finally {
    dumpAlertRunning = false;
  }
}

async function runPumpGainerAlertPush() {
  if (!PUMP_GAINER_ENABLED || pumpGainerRunning) return;
  pumpGainerRunning = true;
  try {
    await waitForNetworkReady('币安 API', { maxAttempts: 3, initialDelayMs: 5000 });
    const { items } = await handleGainersSince8am(PUMP_SMART_SCAN_LIMIT);
    const gainers = items.filter(i => i.change >= PUMP_SMART_MIN_CHANGE);
    if (!gainers.length) {
      console.log(`  ✓ 暴涨实时扫描: 无 ≥${PUMP_SMART_MIN_CHANGE}%`);
      for (const sym of [...pumpGainerActive.keys()]) pumpGainerActive.delete(sym);
      return;
    }

    const activeSymbols = new Set(gainers.map(g => g.symbol));
    for (const sym of [...pumpGainerActive.keys()]) {
      if (!activeSymbols.has(sym)) pumpGainerActive.delete(sym);
    }

    const pushCounts = {};
    for (const g of gainers) {
      const prev = pumpGainerActive.get(g.symbol);
      pushCounts[g.symbol] = prev ? prev.count + 1 : 1;
      pumpGainerActive.set(g.symbol, { since: prev?.since ?? Date.now(), count: pushCounts[g.symbol] });
    }

    const elements = buildPumpGainerAlertElements(gainers, { fmtPrice, pushCounts, minChange: PUMP_SMART_MIN_CHANGE });
    const top = gainers[0];
    const title = gainers.length === 1
      ? `🚀 暴涨提醒 · ${top.label} +${top.change.toFixed(0)}%`
      : `🚀 暴涨提醒 · ${gainers.slice(0, 3).map(g => g.label).join('/')} 等${gainers.length}个`;

    await sendFeishuCardV2(title, elements, 'orange');
    console.log(`  ✓ 暴涨实时推送 (${gainers.length} 个: ${gainers.slice(0, 5).map(g => g.label).join(', ')})`);
  } catch (e) {
    console.warn(`  ⚠ 暴涨实时推送失败: ${e.message}`);
  } finally {
    pumpGainerRunning = false;
  }
}


async function runPumpSmartAlertPush({ force = false } = {}) {
  if (!PUMP_SMART_ENABLED || pumpSmartRunning) return;
  pumpSmartRunning = true;
  try {
    await waitForNetworkReady('币安 API', { maxAttempts: 3, initialDelayMs: 5000 });
    const { items } = await handleGainersSince8am(PUMP_SMART_SCAN_LIMIT);
    const alerts = await scanPumpSmartAlerts({
      candidates: items,
      proxyBinance,
      minChange: PUMP_SMART_MIN_CHANGE,
      concurrency: 3,
    });

    const activeSymbols = new Set(alerts.map(a => a.symbol));
    for (const sym of [...pumpSmartActive.keys()]) {
      if (!activeSymbols.has(sym)) pumpSmartActive.delete(sym);
    }

    if (!alerts.length) {
      console.log(`  ✓ 暴涨+聪明钱扫描: 无触发 (阈值≥${PUMP_SMART_MIN_CHANGE}%)`);
      return;
    }

    const minIntervalMs = PUMP_SMART_INTERVAL_MIN * 60 * 1000;
    const pushCounts = {};
    const toPush = [];

    for (const a of alerts) {
      const prev = pumpSmartActive.get(a.symbol);
      if (force) {
        toPush.push(a);
        pushCounts[a.symbol] = prev ? prev.count + 1 : 1;
        pumpSmartActive.set(a.symbol, {
          since: prev?.since ?? Date.now(),
          count: pushCounts[a.symbol],
          lastScore: a.smartScore,
          lastPushedAt: Date.now(),
        });
        continue;
      }

      if (!prev) {
        toPush.push(a);
        pushCounts[a.symbol] = 1;
        pumpSmartActive.set(a.symbol, {
          since: Date.now(),
          count: 1,
          lastScore: a.smartScore,
          lastPushedAt: Date.now(),
        });
        continue;
      }

      if (a.smartScore > prev.lastScore && Date.now() - prev.lastPushedAt >= minIntervalMs) {
        toPush.push(a);
        pushCounts[a.symbol] = prev.count + 1;
        pumpSmartActive.set(a.symbol, {
          since: prev.since,
          count: pushCounts[a.symbol],
          lastScore: a.smartScore,
          lastPushedAt: Date.now(),
        });
      } else {
        pumpSmartActive.set(a.symbol, {
          ...prev,
          lastScore: Math.max(prev.lastScore, a.smartScore),
        });
      }
    }

    if (!toPush.length) {
      console.log(`  ✓ 暴涨+聪明钱扫描: ${alerts.length} 个符合条件，无新增连续加仓`);
      return;
    }

    const elements = buildPumpSmartAlertElements(toPush, { fmtPrice, pushCounts });
    const labels = toPush.slice(0, 3).map(a => a.label).join('/');
    const title = toPush.length === 1
      ? `🚀 暴涨+聪明钱加仓 · ${toPush[0].label}${pushCounts[toPush[0].symbol] > 1 ? ` (第${pushCounts[toPush[0].symbol]}次)` : ''}`
      : `🚀 暴涨+聪明钱加仓 · ${labels}${toPush.length > 3 ? '…' : ''}`;

    await sendFeishuCardV2(title, elements, 'orange');
    console.log(`  ✓ 暴涨+聪明钱推送 (${toPush.length} 个: ${toPush.map(a => a.label).join(', ')})`);
  } catch (e) {
    console.warn(`  ⚠ 暴涨+聪明钱推送失败: ${e.message}`);
  } finally {
    pumpSmartRunning = false;
  }
}

function startDumpPushScheduler() {
  if (!DUMP_PUSH_ENABLED) {
    console.log(`  ⏸ 暴跌推送未启用`);
    return;
  }
  const slots = getStablePushHours(DUMP_PUSH_HOURS).map(h => `${String(h).padStart(2, '0')}:50`).join(' / ');
  console.log(`  🚨 暴跌预警推送: 上海时间 ${slots}（每 ${DUMP_PUSH_HOURS}h）→ 飞书`);

  const scheduleNext = () => {
    const next = getNextStablePushTime(new Date(), DUMP_PUSH_HOURS);
    const delay = Math.max(0, next.getTime() - Date.now());
    const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  ⏭ 暴跌下次推送: ${label}（${Math.round(delay / 60000)} 分钟后）`);
    setTimeout(async () => {
      await runDumpAlertPush();
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

function startPumpSmartAlertScheduler() {
  if (!PUMP_SMART_ENABLED) {
    console.log(`  ⏸ 暴涨+聪明钱推送未启用`);
    return;
  }
  const ms = PUMP_SMART_INTERVAL_MIN * 60 * 1000;
  console.log(`  🚀 暴涨+聪明钱推送: 每 ${PUMP_SMART_INTERVAL_MIN} 分钟扫描 · 聪明钱连续加仓时提醒 → 飞书`);
  setInterval(() => runPumpSmartAlertPush(), ms);
  setTimeout(() => runPumpSmartAlertPush(), 90_000);
}

function startPumpGainerAlertScheduler() {
  if (!PUMP_GAINER_ENABLED) return;
  const ms = REALTIME_ALERT_INTERVAL_MIN * 60 * 1000;
  console.log(`  🚀 暴涨提醒: 每 ${REALTIME_ALERT_INTERVAL_MIN} 分钟 → 飞书`);
  setInterval(() => runPumpGainerAlertPush(), ms);
  setTimeout(() => runPumpGainerAlertPush(), 60_000);
}

function startCombinedPushScheduler() {
  if (!LONG_PUSH_ENABLED) {
    console.log(`  ⏸ 做多+做空推送未启用（需配置 FEISHU_WEBHOOK）`);
    return;
  }
  const slots = getStablePushHours(COMBINED_PUSH_HOURS).map(h => `${String(h).padStart(2, '0')}:50`).join(' / ');
  console.log(`  🔔 做多+做空推送: 上海时间 ${slots}（每 ${COMBINED_PUSH_HOURS}h）→ 飞书`);

  const scheduleNext = () => {
    const next = getNextStablePushTime(new Date(), COMBINED_PUSH_HOURS);
    const delay = Math.max(0, next.getTime() - Date.now());
    const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  ⏭ 做多+做空下次: ${label}（${Math.round(delay / 60000)} 分钟后）`);
    setTimeout(async () => {
      await runCombinedPush();
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/feishu-alert' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { title, content } = JSON.parse(body);
        const result = await sendFeishu(title, content);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/feishu-alert' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/trigger-stable-push' && req.method === 'POST') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (stablePushRunning) {
      res.writeHead(409, headers);
      res.end(JSON.stringify({ ok: false, error: '推送正在进行中，请稍后再试' }));
      return;
    }
    if (!FEISHU_WEBHOOK) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'FEISHU_WEBHOOK 未配置' }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, message: '已触发稳趋势推送' }));
    runStableTrendPush();
    return;
  }

  if (url.pathname === '/api/trigger-stable-push' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/top-symbols') {
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10));
    const sort = url.searchParams.get('sort') === 'change' ? 'change' : 'volume';
    const minChange = parseFloat(url.searchParams.get('minChange') || '0');
    try {
      const tickers = await fetchTicker24hr();
      let usdt = tickers
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({ symbol: t.symbol, volume: parseFloat(t.quoteVolume), price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent) }));
      if (minChange > 0) usdt = usdt.filter(t => t.change >= minChange);
      usdt = usdt
        .sort((a, b) => sort === 'change' ? b.change - a.change : b.volume - a.volume)
        .slice(0, limit);
      usdt = await filterEligibleSymbols(usdt, 'symbol');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(usdt));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/gainers-since-8am') {
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10));
    try {
      const data = await handleGainersSince8am(limit);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/losers-since-8am') {
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10));
    try {
      const data = await handleLosersSince8am(limit);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/strategy-review') {
    const hours = parseInt(url.searchParams.get('hours') || '48', 10);
    try {
      const data = await getStrategyReviews(hours);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/strategy-predictions') {
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);
    try {
      const data = await getLatestPredictions(hours);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/trigger-strategy-review' && req.method === 'POST') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, message: '已触发策略复盘' }));
    runStrategyReview().catch(e => console.warn(`  ⚠ 手动复盘失败: ${e.message}`));
    return;
  }

  if (url.pathname === '/api/trigger-strategy-review' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      maxMarketCapUsd: MAX_MARKET_CAP_USD,
      maxMarketCapLabel: formatMaxMarketCapLabel(),
    }));
    return;
  }

  if (url.pathname === '/api/position-health') {
    const symbol = url.searchParams.get('symbol');
    const direction = url.searchParams.get('direction') || 'long';
    const entry = url.searchParams.get('entry');
    const stopLoss = url.searchParams.get('stopLoss');
    const takeProfit = url.searchParams.get('takeProfit');
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const data = await evaluatePositionHealth({
        symbol,
        direction,
        entryPrice: entry,
        stopLoss,
        takeProfit,
      });
      res.writeHead(200, headers);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/position-health/batch' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const { positions } = JSON.parse(body || '{}');
        if (!Array.isArray(positions)) throw new Error('positions 须为数组');
        const data = await evaluatePositionsBatch(positions);
        res.writeHead(200, headers);
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/position-health/batch' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/user-positions' && req.method === 'GET') {
    try {
      const data = await getUserPositions();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/user-positions' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      try {
        const data = await addUserPosition(JSON.parse(body || '{}'));
        res.writeHead(200, headers);
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/user-positions' && req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    try {
      const data = await deleteUserPosition(id);
      res.writeHead(200, headers);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/user-positions' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/marketcap') {
    const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    try {
      const mc = await fetchMcForSymbol(symbol);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ market_cap: mc }));
    } catch (e) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ market_cap: 0 }));
    }
    return;
  }

  if (url.pathname === '/api/klines') {
    const symbol = url.searchParams.get('symbol') || 'SLXUSDT';
    const interval = url.searchParams.get('interval') || '1h';
    const limit = url.searchParams.get('limit') || '100';
    try {
      const data = await proxyBinance(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/data') {
    const symbol = url.searchParams.get('symbol') || 'SLXUSDT';
    if (await rejectIfTradFiSymbol(symbol, res)) return;
    if (await rejectIfMarketCapTooLarge(symbol, res)) return;
    registerActiveSymbol(symbol);
    const ratioLimit = url.searchParams.get('ratioLimit') || 72;
    const oiLimit = url.searchParams.get('oiLimit') || 42;
    const takerLimit = url.searchParams.get('takerLimit') || 48;
    try {
      const data = await handleAPI(symbol, { ratioLimit, oiLimit, takerLimit });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/smart-signal') {
    const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
    if (await rejectIfTradFiSymbol(symbol, res)) return;
    if (await rejectIfMarketCapTooLarge(symbol, res)) return;
    const priceParam = parseFloat(url.searchParams.get('price') || '0');
    const price = priceParam > 0 ? priceParam : null;
    try {
      const raw = await fetchSmartSignal(symbol);
      const analysis = analyzeSmartSignal(raw, price);
      registerActiveSymbol(symbol);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ symbol, raw, ...analysis }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/whale-history') {
    const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
    const hours = url.searchParams.get('hours') || '72';
    registerActiveSymbol(symbol);
    try {
      const data = await getWhaleHistory(symbol, hours);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/check-risk') {
    const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
    if (!symbol || !symbol.endsWith('USDT')) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: '请提供 symbol 参数，如 ?symbol=VELVETUSDT' }));
      return;
    }
    try {
      const risk = await checkDumpRisk(symbol);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(risk));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/scan-dump') {
    const limit = Math.min(300, parseInt(url.searchParams.get('limit') || '200', 10));
    const minRisk = parseInt(url.searchParams.get('minRisk') || '4', 10);
    try {
      const results = await filterItemsByMarketCap(await scanDumpCoins({ limit, minRiskScore: minRisk, concurrency: 3 }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(results));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/scan-pump-smart') {
    const limit = Math.min(50, parseInt(url.searchParams.get('limit') || String(PUMP_SMART_SCAN_LIMIT), 10));
    const minChange = parseFloat(url.searchParams.get('minChange') || String(PUMP_SMART_MIN_CHANGE));
    try {
      const { items } = await handleGainersSince8am(limit);
      const results = await scanPumpSmartAlerts({
        candidates: items,
        proxyBinance,
        minChange,
        concurrency: 3,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(results));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/trigger-pump-smart-push' && req.method === 'POST') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (pumpSmartRunning) {
      res.writeHead(409, headers);
      res.end(JSON.stringify({ ok: false, error: '推送正在进行中' }));
      return;
    }
    if (!FEISHU_WEBHOOK) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'FEISHU_WEBHOOK 未配置' }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, message: '已触发暴涨+聪明钱推送' }));
    runPumpSmartAlertPush({ force: true }).catch(() => {});
    return;
  }

  if (url.pathname === '/api/trigger-pump-smart-push' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/trigger-combined-push' && req.method === 'POST') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (combinedPushRunning) {
      res.writeHead(409, headers);
      res.end(JSON.stringify({ ok: false, error: '联合推送正在进行中，请稍后再试' }));
      return;
    }
    if (!FEISHU_WEBHOOK) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'FEISHU_WEBHOOK 未配置' }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, message: '已触发做多+暴跌联合推送' }));
    runCombinedPush();
    return;
  }

  if (url.pathname === '/api/trigger-combined-push' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/trigger-position-health-push' && req.method === 'POST') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (!FEISHU_WEBHOOK) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'FEISHU_WEBHOOK 未配置' }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, message: '已触发持仓健康推送' }));
    runPositionHealthPush({ force: true }).catch(e => console.warn(`  ⚠ 持仓健康推送失败: ${e.message}`));
    return;
  }

  if (url.pathname === '/api/trigger-position-health-push' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/smart-trend-watchlist') {
    try {
      const data = getWatchlistInfo();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/trigger-smart-trend-push' && req.method === 'POST') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    if (!FEISHU_WEBHOOK) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ ok: false, error: 'FEISHU_WEBHOOK 未配置' }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, message: '已触发聪明钱趋势推送' }));
    runSmartTrendPush({ force: true }).catch(e => console.warn(`  ⚠ 聪明钱趋势推送失败: ${e.message}`));
    return;
  }

  if (url.pathname === '/api/trigger-smart-trend-push' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/refresh-watchlist' && req.method === 'POST') {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, message: '已触发监控池刷新' }));
    refreshSmartTrendWatchlist({ force: true })
      .then(r => console.log(`  📋 监控池手动刷新完成: ${r.symbols?.length || 0} 个`))
      .catch(e => console.warn(`  ⚠ 监控池刷新失败: ${e.message}`));
    return;
  }

  if (url.pathname === '/api/refresh-watchlist' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/scan-momentum') {
    const limit = Math.min(50, parseInt(url.searchParams.get('limit') || '30', 10));
    const minScore = parseInt(url.searchParams.get('minScore') || '3', 10);
    try {
      const { gainerItems } = await build8amChangeMaps();
      const results = await filterItemsByMarketCap(await scanMomentumLong({
        candidates: gainerItems.slice(0, limit * 2),
        minScore,
        concurrency: 3,
      }));
      const { label } = getBaseline8amInfo();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ meta: { baselineLabel: label }, items: results }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/scan-smart-signal') {
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10));
    const direction = ['long', 'short', 'all'].includes(url.searchParams.get('direction'))
      ? url.searchParams.get('direction') : 'long';
    try {
      const results = await filterItemsByMarketCap(await scanSmartSignal({ limit, direction, concurrency: 2 }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(results));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  try {
    const content = await readFile(join(__dirname, filePath));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function bootstrapServices() {
  if (proxyInfo.enabled) {
    console.log(`  🌐 代理已启用: ${proxyInfo.url}（Smart Signal bapi）`);
  } else {
    console.log(`  ⚠ 未配置 HTTPS_PROXY，Smart Signal 若超时请在 .env 中设置代理`);
  }
  console.log(`  📊 默认监控: SLXUSDT`);
  if (MAX_MARKET_CAP_USD > 0) {
    console.log(`  💰 市值过滤: 仅监控 ≤ ${formatMaxMarketCapLabel()}`);
  }
  if (EXCLUDE_TRADFI_SYMBOLS) {
    warmupTradFiExclusions()
      .then((n) => console.log(`  🏦 TradFi 过滤: 排除股票/TradFi/商品合约 (${n} 个)`))
      .catch((e) => console.warn(`  ⚠ TradFi 过滤加载失败: ${e.message}`));
  }
  warmupSpotSymbols()
    .then((n) => console.log(`  💱 现货检查: 已加载 ${n} 个现货交易对${FILTER_SPOT_ONLY ? '（仅保留有现货的合约）' : '（用于标记删除线）'}`))
    .catch((e) => console.warn(`  ⚠ 现货检查加载失败: ${e.message}`));
  console.log(`  ⏹  Ctrl+C 退出\n`);
  // 预热8点基准价缓存，避免首次打开涨幅榜等待过久（开机时等待网络就绪）
  waitForNetworkReady('币安 API')
    .then(() => handleGainersSince8am(10))
    .then(() => {
      console.log(`  ✓ 8点涨幅基准价缓存已预热`);
      if (process.env.STRATEGY_REVIEW_ENABLED !== 'false') {
        return collectPredictionSnapshot();
      }
    })
    .catch(e => {
      console.warn(`  ⚠ 8点基准价预热失败: ${e.message}`);
    });
  initStrategyReview({
    getGainersSince8am: handleGainersSince8am,
    getLosersSince8am: handleLosersSince8am,
    getPrices: fetchCurrentPrices,
    sendFeishuCard: sendFeishuCardV2,
    getNextReviewTime: getNextStablePushTime,
    fmtPrice,
    feishuEnabled: !!FEISHU_WEBHOOK,
  });

  startStablePushScheduler();
  startCombinedPushScheduler();
  startDumpPushScheduler();
  startPumpSmartAlertScheduler();
  startPumpGainerAlertScheduler();
  startPredictionSnapshotScheduler();
  startStrategyReviewScheduler();
  initPositionHealthMonitor({
    enabled: POSITION_HEALTH_ENABLED,
    feishuEnabled: !!FEISHU_WEBHOOK,
    pushHours: POSITION_HEALTH_PUSH_HOURS,
    urgentCheckMin: POSITION_HEALTH_URGENT_CHECK_MIN,
    urgentCooldownMin: POSITION_HEALTH_URGENT_COOLDOWN_MIN,
    watchSymbols: POSITION_HEALTH_WATCH_SYMBOLS,
    getNextPushTime: getNextStablePushTime,
    sendFeishu,
  });
  startPositionHealthScheduler();
  initSmartTrendWatchlist({
    enabled: SMART_TREND_ENABLED && SMART_TREND_DYNAMIC_WATCH,
    topN: SMART_TREND_BOARD_TOP_N,
    volumeTopN: SMART_TREND_VOLUME_TOP_N,
    refreshTtlMs: SMART_TREND_WATCHLIST_REFRESH_MIN * 60 * 1000,
    boardPeriod: '24h',
    getGainers24h: handleGainers24h,
    getLosers24h: handleLosers24h,
    getTopByVolume: handleTopByVolume,
    registerActiveSymbol,
    onWatchlistUpdated,
    onDaily8am: (symbols) => captureDaily8amRatioBaseline(symbols),
    extraSymbols: SMART_TREND_WATCH_SYMBOLS,
    fallbackSymbols: SMART_TREND_WATCH_SYMBOLS,
    scanRightSide,
    rightSideScanLimit: STABLE_SCAN_LIMIT,
  });
  startSmartTrendWatchlistScheduler().then(() => initSmartTrendMonitor({
    enabled: SMART_TREND_ENABLED,
    feishuEnabled: !!FEISHU_WEBHOOK,
    intervalMin: SMART_TREND_INTERVAL_MIN,
    cooldownMin: SMART_TREND_COOLDOWN_MIN,
    ratioChangePct: SMART_TREND_RATIO_CHANGE_PCT,
    digestPageSize: SMART_TREND_DIGEST_PAGE_SIZE,
    mergeCards: SMART_TREND_MERGE_CARDS,
    minRankingVolume24h: SMART_TREND_MIN_RANKING_VOLUME_24H,
    divergenceThreshold: SMART_TREND_DIVERGENCE_THRESHOLD,
    reboundHighlightPct: REBOUND_HIGHLIGHT_CHANGE_PCT,
    watchSymbols: SMART_TREND_DYNAMIC_WATCH ? undefined : SMART_TREND_WATCH_SYMBOLS,
    getWatchSymbols: SMART_TREND_DYNAMIC_WATCH ? getWatchSymbols : undefined,
    getWatchlistGroups: SMART_TREND_DYNAMIC_WATCH ? getWatchlistGroups : undefined,
    refreshWatchlist: SMART_TREND_DYNAMIC_WATCH
      ? () => refreshSmartTrendWatchlist({ force: false })
      : undefined,
    sendFeishuCard: sendFeishuCardV2,
    decisionEnabled: SMART_TREND_DECISION_ENABLED,
    sendDecisionCard: (title, elements, template) => sendFeishuCardV2(title, elements, template, SMART_TREND_DECISION_WEBHOOK),
    getWhaleHistory,
    getWhaleHistoryBulk,
    batchEnrichDigest: batchEnrichSmartTrendDigest,
    getHeldSymbols: async () => {
      try {
        const positions = await getUserPositions();
        // 合约持仓 + 现货持仓（SPOT_HOLDINGS）均视为持有，不推荐做多
        const held = new Set(positions.map(p => p.symbol.toUpperCase()));
        for (const s of SPOT_HOLDINGS) held.add(s);
        return held;
      } catch { return new Set(SPOT_HOLDINGS); }
    },
  })).then(() => startSmartTrendScheduler()).catch(e => {
    console.warn(`  ⚠ 聪明钱趋势监控初始化失败: ${e.message}`);
  });
  startWhaleCollector().catch(e => {
    console.warn(`  ⚠ 鲸鱼历史采集启动失败: ${e.message}`);
  });
}

if (WEB_PANEL_ENABLED) {
  server.listen(PORT, () => {
    console.log(`\n  🚀 聪明钱监控面板已启动: http://localhost:${PORT}`);
    bootstrapServices();
  });
} else {
  console.log('\n  📡 飞书推送服务已启动（Web 面板已关闭）');
  bootstrapServices();
}
