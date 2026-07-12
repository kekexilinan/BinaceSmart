import { setupProxyFromEnv, fetchJson as fetchJSON } from './proxy-setup.mjs';

setupProxyFromEnv();
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

setupProxyFromEnv();

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 15000;

const BAPI_SMART_SIGNAL =
  'https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview';
const FAPI_BASE = 'https://fapi.binance.com';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 600;
const cache = new Map();

let lastRequestAt = 0;
let circuitOpenUntil = 0;
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJsonViaCurl(url) {
  const args = ['-s', '--max-time', '15'];
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const { stdout } = await execFileAsync('curl.exe', args, { maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout.trim());
}

async function fetchSmartSignalJson(url) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; BinaceSmart/1.0)',
  };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 418 || res.status === 429 || res.status === 403) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '3600', 10);
      circuitOpenUntil = Date.now() + retryAfter * 1000;
      throw new Error(`Smart Signal API ${res.status}，已熔断 ${retryAfter}s`);
    }
    if (!res.ok) throw new Error(`Smart Signal API ${res.status}`);
    return res.json();
  } catch (e) {
    if (String(e.message || e).includes('熔断')) throw e;
    return fetchJsonViaCurl(url);
  }
}

async function throttleFetch(url) {
  if (Date.now() < circuitOpenUntil) {
    throw new Error(`Smart Signal 限流熔断中，请 ${Math.ceil((circuitOpenUntil - Date.now()) / 60000)} 分钟后重试`);
  }

  const run = async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const json = await fetchSmartSignalJson(url);
    if (!json.success || !json.data) throw new Error(json.message || 'Smart Signal 数据无效');
    return json.data;
  };

  requestQueue = requestQueue.then(run, run);
  return requestQueue;
}

export async function fetchSmartSignal(symbol) {
  const sym = symbol.toUpperCase();
  const cached = cache.get(sym);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const data = await throttleFetch(`${BAPI_SMART_SIGNAL}?symbol=${sym}`);
  cache.set(sym, { ts: Date.now(), data });
  return data;
}

export function analyzeSmartSignal(raw, price = null) {
  if (!raw) return { direction: 'neutral', score: 0, signals: [], detail: '无数据', isLong: false, isShort: false };

  const ratio = parseFloat(raw.longShortRatio);
  const longProfit = parseInt(raw.longProfitTraders, 10) || 0;
  const shortProfit = parseInt(raw.shortProfitTraders, 10) || 0;
  const longWhalesQty = parseFloat(raw.longWhalesQty) || 0;
  const shortWhalesQty = parseFloat(raw.shortWhalesQty) || 0;
  const longProfitWhales = parseInt(raw.longProfitWhales, 10) || 0;
  const shortProfitWhales = parseInt(raw.shortProfitWhales, 10) || 0;
  const longAvg = parseFloat(raw.longWhalesAvgEntryPrice) || 0;
  const shortAvg = parseFloat(raw.shortWhalesAvgEntryPrice) || 0;

  const isLong = ratio > 0.75;
  const isShort = ratio < 0.75;
  const direction = isLong ? 'long' : isShort ? 'short' : 'neutral';
  const badge = isLong ? 'B' : isShort ? 'S' : '─';

  const signals = [];
  let score = 0;

  if (isLong) {
    score += 2;
    signals.push(`✓ 净多 [B] 比值 ${ratio.toFixed(2)}`);
    if (ratio > 1.2) { score += 1; signals.push(`✓ 多头优势明显 (${ratio.toFixed(2)})`); }
  } else if (isShort) {
    score += 2;
    signals.push(`✓ 净空 [S] 比值 ${ratio.toFixed(2)}`);
    if (ratio < 0.8) { score += 1; signals.push(`✓ 空头优势明显 (${ratio.toFixed(2)})`); }
  } else {
    signals.push(`─ 多空均衡 (${ratio.toFixed(2)})`);
  }

  if (longProfit > shortProfit) {
    if (isLong) { score += 1; signals.push(`✓ 盈利多头 ${longProfit} > 空头 ${shortProfit}`); }
    else signals.push(`◐ 盈利多头 ${longProfit} > 空头 ${shortProfit}`);
  } else if (shortProfit > longProfit) {
    if (isShort) { score += 1; signals.push(`✓ 盈利空头 ${shortProfit} > 多头 ${longProfit}`); }
    else signals.push(`◐ 盈利空头 ${shortProfit} > 多头 ${longProfit}`);
  }

  if (longWhalesQty > shortWhalesQty) {
    if (isLong) { score += 1; signals.push(`✓ 鲸鱼仓位偏多`); }
    else signals.push(`◐ 鲸鱼仓位偏多`);
  } else if (shortWhalesQty > longWhalesQty) {
    if (isShort) { score += 1; signals.push(`✓ 鲸鱼仓位偏空`); }
    else signals.push(`◐ 鲸鱼仓位偏空`);
  }

  if (longProfitWhales > shortProfitWhales) {
    if (isLong) { score += 1; signals.push(`✓ 盈利鲸鱼多头 ${longProfitWhales} > ${shortProfitWhales}`); }
  } else if (shortProfitWhales > longProfitWhales) {
    if (isShort) { score += 1; signals.push(`✓ 盈利鲸鱼空头 ${shortProfitWhales} > ${longProfitWhales}`); }
  }

  if (price != null && price > 0 && longAvg > 0 && isLong) {
    const vsLong = ((price - longAvg) / longAvg) * 100;
    if (vsLong < -2) signals.push(`◐ 现价低于多头鲸鱼均价 ${vsLong.toFixed(1)}%`);
    else if (vsLong > 2) signals.push(`⚠ 现价高于多头鲸鱼均价 +${vsLong.toFixed(1)}%`);
  }

  const detail = `[${badge}] ${signals.map(s => s.replace(/^[✓✗◐⚠─]\s*/, '')).join(' · ')}`;
  return {
    direction,
    badge,
    ratio,
    score,
    signals,
    detail,
    isLong,
    isShort,
    longAvg,
    shortAvg,
    longProfit,
    shortProfit,
    longWhalesQty,
    shortWhalesQty,
    totalTraders: raw.totalTraders,
    totalPositions: parseFloat(raw.totalPositions) || 0,
    updateTime: raw.updateTime,
  };
}

async function pmap(items, fn, concurrency = 2) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); } catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function scanSmartSignal({
  limit = 100,
  direction = 'long',
  concurrency = 2,
  onProgress,
} = {}) {
  const tickers = await fetchJSON(`${FAPI_BASE}/fapi/v1/ticker/24hr`);
  const symbols = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol: t.symbol,
      volume: parseFloat(t.quoteVolume),
      change: parseFloat(t.priceChangePercent),
      price: parseFloat(t.lastPrice),
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);

  const results = [];
  let done = 0;

  await pmap(symbols, async (item) => {
    try {
      const raw = await fetchSmartSignal(item.symbol);
      const analysis = analyzeSmartSignal(raw, item.price);
      const pass =
        direction === 'all' ||
        (direction === 'long' && analysis.isLong) ||
        (direction === 'short' && analysis.isShort);

      if (pass && analysis.score >= 2) {
        results.push({
          symbol: item.symbol,
          label: item.symbol.replace('USDT', ''),
          ...analysis,
          volume: item.volume,
          change: item.change,
          price: item.price,
          ts: Date.now(),
        });
      }
    } catch {}
    done++;
    if (onProgress) onProgress(done, symbols.length);
  }, concurrency);

  if (direction === 'long') {
    results.sort((a, b) => b.ratio - a.ratio || b.score - a.score);
  } else if (direction === 'short') {
    results.sort((a, b) => a.ratio - b.ratio || b.score - a.score);
  } else {
    results.sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
  }

  return results;
}
