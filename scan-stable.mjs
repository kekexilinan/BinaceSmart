const FAPI_BASE = 'https://fapi.binance.com';

const STOCK_COINS = new Set([
  'COINUSDT',   // Coinbase  (NASDAQ: COIN)
  'MSTRUSDT',   // MicroStrategy (NASDAQ: MSTR)
  'HOODUSDT',   // Robinhood (NASDAQ: HOOD)
]);

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function calcMA(closes, period) {
  const r = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { r.push(null); continue; }
    r.push(closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return r;
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes) {
  const ema = (data, period) => {
    const k = 2 / (period + 1);
    const result = [data[0]];
    for (let i = 1; i < data.length; i++) result.push(data[i] * k + result[i - 1] * (1 - k));
    return result;
  };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = ema12.map((v, i) => v - ema26[i]);
  const dea = ema(dif, 9);
  return { dif, dea };
}

function calcDrawdownFromPeak(highs, closes, lookback = 48) {
  const slice = highs.slice(-lookback);
  if (!slice.length) return 1;
  const peak = Math.max(...slice);
  const cur = closes[closes.length - 1];
  return peak > 0 ? (peak - cur) / peak : 1;
}

function isTrendIntact(closes, lows, ma20, ma5) {
  const n = closes.length - 1;
  const lastClose = closes[n];
  const lastMA20 = ma20[n];
  const lastMA5 = ma5 ? ma5[n] : null;
  if (lastMA20 == null || lastClose <= lastMA20) return { ok: false, reason: '价破MA20' };
  const minLow5 = Math.min(...lows.slice(-5));
  if (minLow5 >= lastMA20 * 0.92) return { ok: true, reason: 'MA20支撑' };
  if (lastMA5 != null && lastMA5 >= lastMA20 && lastClose >= lastMA5 * 0.95) {
    return { ok: true, reason: '动量趋势' };
  }
  if (lows[n] >= lastMA20 * 0.90) return { ok: true, reason: '当前守MA20' };
  return { ok: false, reason: '趋势走坏' };
}

function checkRightSideFromKlines(raw, filterTF) {
  if (!Array.isArray(raw) || raw.length < 30) {
    return { isRightSide: false, score: 0, detail: '数据不足' };
  }
  const closes = raw.map(k => parseFloat(k[4]));
  const volumes = raw.map(k => parseFloat(k[5]));
  const lastPrice = closes[closes.length - 1];
  let score = 0;
  const signals = [];

  const ma5 = calcMA(closes, 5);
  const ma20 = calcMA(closes, 20);
  const lastMA5 = ma5[ma5.length - 1];
  const lastMA20 = ma20[ma20.length - 1];
  if (lastMA5 !== null && lastMA20 !== null) {
    if (lastPrice > lastMA20 && lastMA5 > lastMA20) { score += 2; signals.push('均线多排'); }
    else if (lastPrice > lastMA20) { score += 1; signals.push('价>MA20'); }
  }

  const rsi6 = calcRSI(closes, 6);
  const lastRSI = rsi6.filter(v => v !== null).pop();
  if (lastRSI > 50 && lastRSI < 80) { score += 1; signals.push(`RSI6=${lastRSI.toFixed(0)}`); }

  const { dif, dea } = calcMACD(closes);
  const lastDIF = dif[dif.length - 1];
  const lastDEA = dea[dea.length - 1];
  const prevDIF = dif[dif.length - 2];
  const prevDEA = dea[dea.length - 2];
  if (lastDIF > lastDEA) {
    score += prevDIF <= prevDEA ? 2 : 1;
    signals.push(prevDIF <= prevDEA ? 'MACD金叉' : 'MACD多头');
  }

  if (volumes.length >= 23) {
    const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const prevVol = volumes.slice(-23, -3).reduce((a, b) => a + b, 0) / 20;
    if (prevVol > 0 && recentVol > prevVol * 1.5) {
      score += 1;
      signals.push(`放量${(recentVol / prevVol).toFixed(1)}x`);
    }
  }

  return {
    isRightSide: score >= 3,
    score,
    detail: `[${score}/5] ${signals.join(' ')}`,
    filterTF,
  };
}

async function analyzeTfDrawdownTrend(symbol, interval, maxDD) {
  const lookback = interval === '1d' ? 30 : interval === '4h' ? 36 : 48;
  const raw = await fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=100`);
  if (!Array.isArray(raw) || raw.length < 25) return null;
  const highs = raw.map(k => parseFloat(k[2]));
  const lows = raw.map(k => parseFloat(k[3]));
  const closes = raw.map(k => parseFloat(k[4]));
  const ma20 = calcMA(closes, 20);
  const ma5 = calcMA(closes, 5);
  const dd = calcDrawdownFromPeak(highs, closes, lookback);
  const trend = isTrendIntact(closes, lows, ma20, ma5);
  return {
    interval,
    ddPct: dd * 100,
    ddOk: dd <= maxDD,
    trendOk: trend.ok,
    trendReason: trend.reason,
    pass: dd <= maxDD && trend.ok,
  };
}

async function checkCoinRightStable(symbol, {
  filterTF = '1h',
  maxDrawdownPct = 0.30,
  dualTFConfirm = true,
} = {}) {
  const raw = await fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${filterTF}&limit=100`);
  const base = checkRightSideFromKlines(raw, filterTF);
  if (!base.isRightSide) return { ...base, isRightStable: false, symbol };

  const tfs = dualTFConfirm ? ['1h', '1d'] : [filterTF];
  const tfResults = [];
  for (const tf of [...new Set(tfs)]) {
    const r = await analyzeTfDrawdownTrend(symbol, tf, maxDrawdownPct);
    if (!r) return { ...base, isRightStable: false, symbol, detail: base.detail + ` ${tf}数据不足` };
    tfResults.push(r);
  }

  const allPass = tfResults.every(r => r.pass);
  const drawdown = Math.max(...tfResults.map(r => r.ddPct));
  const trendSummary = tfResults.map(r => `${r.interval}:${r.trendReason}${r.ddPct.toFixed(1)}%`).join(' ');
  return {
    symbol,
    isRightStable: allPass,
    score: base.score,
    drawdown,
    detail: `${base.detail} | ${trendSummary}`,
    tfResults,
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

export async function scanRightStable({
  limit = 200,
  maxDrawdownPct = 0.30,
  dualTFConfirm = true,
  filterTF = '1h',
  concurrency = 3,
} = {}) {
  const tickers = await fetchJSON(`${FAPI_BASE}/fapi/v1/ticker/24hr`);
  const symbols = tickers
    .filter(t => t.symbol.endsWith('USDT') && !STOCK_COINS.has(t.symbol))
    .map(t => ({
      symbol: t.symbol,
      volume: parseFloat(t.quoteVolume),
      change: parseFloat(t.priceChangePercent),
      price: parseFloat(t.lastPrice),
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);

  const results = [];
  await pmap(symbols, async (item) => {
    const r = await checkCoinRightStable(item.symbol, { filterTF, maxDrawdownPct, dualTFConfirm });
    if (r?.isRightStable) {
      results.push({
        symbol: item.symbol,
        label: item.symbol.replace('USDT', ''),
        score: r.score,
        drawdown: r.drawdown,
        detail: r.detail,
        volume: item.volume,
        change: item.change,
        price: item.price,
      });
    }
  }, concurrency);

  results.sort((a, b) => b.score - a.score || b.change - a.change);
  return results;
}
