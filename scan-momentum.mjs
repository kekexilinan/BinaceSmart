import { setupProxyFromEnv, fetchJson as fetchJSON } from './proxy-setup.mjs';
import { filterSpotItems } from './spot-symbol-check.mjs';

setupProxyFromEnv();

const FAPI_BASE = 'https://fapi.binance.com';

function calcMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 6) {
  if (closes.length < period + 1) return 50;
  let gainSum = 0, lossSum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }
  if (lossSum === 0) return 100;
  return 100 - 100 / (1 + gainSum / lossSum);
}

/**
 * 8点来暴涨 momentum 做多扫描
 * candidates: [{ symbol, change, price, volume, change24h }]
 */
export async function checkMomentumLong(symbol, changeSince8am = 0) {
  const raw = await fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=48`);
  if (!Array.isArray(raw) || raw.length < 24) return null;

  const closes = raw.map(k => parseFloat(k[4]));
  const volumes = raw.map(k => parseFloat(k[5]));
  const curPrice = closes[closes.length - 1];
  let score = 0;
  const signals = [];

  if (changeSince8am >= 50) { score += 2; signals.push(`8am+${changeSince8am.toFixed(0)}%`); }
  else if (changeSince8am >= 15) { score += 1; signals.push(`8am+${changeSince8am.toFixed(0)}%`); }
  else return null;

  const ma5 = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  if (ma5 && ma20 && curPrice > ma20) {
    score += 1;
    signals.push(ma5 > ma20 ? '均线多排' : '价>MA20');
  }

  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prevVol = volumes.slice(-23, -3).reduce((a, b) => a + b, 0) / 20;
  if (prevVol > 0 && recentVol > prevVol * 1.3) {
    score += 1;
    signals.push(`放量${(recentVol / prevVol).toFixed(1)}x`);
  }

  const rsi6 = calcRSI(closes, 6);
  if (rsi6 > 55 && rsi6 < 85) {
    score += 1;
    signals.push(`RSI6=${rsi6.toFixed(0)}`);
  }

  const green4 = raw.slice(-4).filter(k => parseFloat(k[4]) > parseFloat(k[1])).length;
  if (green4 >= 3) {
    score += 1;
    signals.push('近4阳');
  }

  if (score < 3) return null;

  return {
    symbol,
    label: symbol.replace('USDT', ''),
    score,
    signals,
    price: curPrice,
    changeSince8am,
    detail: `[${score}/5] ${signals.join(' ')}`,
    type: 'momentum',
  };
}

async function pmap(items, fn, concurrency = 3) {
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

export async function scanMomentumLong({ candidates = [], minScore = 3, concurrency = 3 } = {}) {
  const preFiltered = candidates.filter(c => c.change >= 15).slice(0, 30);
  const filtered = await filterSpotItems(preFiltered);
  const results = [];
  await pmap(filtered, async (item) => {
    const r = await checkMomentumLong(item.symbol, item.change);
    if (r && r.score >= minScore) results.push(r);
  }, concurrency);
  results.sort((a, b) => b.changeSince8am - a.changeSince8am || b.score - a.score);
  return results;
}
