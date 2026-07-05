import { setupProxyFromEnv, fetchJson as fetchJSON } from './proxy-setup.mjs';

setupProxyFromEnv();

const FAPI_BASE = 'https://fapi.binance.com';

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d; else lossSum -= d;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * 检查单个币种的做空信号。
 * 返回 { symbol, label, shortScore, signals, ... } 或 null
 */
export async function checkShortSignal(symbol, { changeSince8am = null } = {}) {
  const [klines1h, klines4h] = await Promise.all([
    fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=48`),
    fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=30`),
  ]);

  if (!Array.isArray(klines1h) || klines1h.length < 24) return null;
  if (!Array.isArray(klines4h) || klines4h.length < 10) return null;

  const closes1h = klines1h.map(k => parseFloat(k[4]));
  const highs1h = klines1h.map(k => parseFloat(k[2]));
  const opens1h = klines1h.map(k => parseFloat(k[1]));
  const vols1h = klines1h.map(k => parseFloat(k[7]));

  const closes4h = klines4h.map(k => parseFloat(k[4]));
  const highs4h = klines4h.map(k => parseFloat(k[2]));
  const lows4h = klines4h.map(k => parseFloat(k[3]));
  const vols4h = klines4h.map(k => parseFloat(k[7]));

  const curPrice = closes1h[closes1h.length - 1];
  let shortScore = 0;
  const signals = [];

  // ① 短期暴涨后回落（最强信号）
  const price24hAgo = closes1h.length >= 24 ? closes1h[closes1h.length - 24] : closes1h[0];
  const chg24h = (curPrice - price24hAgo) / price24hAgo * 100;
  const peak24h = Math.max(...highs1h.slice(-24));
  const ddFromPeak = (peak24h - curPrice) / peak24h * 100;

  // 续涨模式：暴涨但几乎没回撤、近4根多阳线 → 不宜做空（LAB/TAC 类型）
  const recent4 = klines1h.slice(-4);
  const greenCount = recent4.filter(k => parseFloat(k[4]) > parseFloat(k[1])).length;
  if (chg24h > 80 && ddFromPeak < 15) return null;
  if (chg24h > 50 && ddFromPeak < 8 && greenCount >= 3) return null;
  if (changeSince8am != null && changeSince8am > 30 && ddFromPeak < 10 && greenCount >= 2) return null;
  if (changeSince8am != null && changeSince8am > 12 && ddFromPeak < 15) return null;

  if (chg24h > 100 && ddFromPeak > 10) {
    shortScore += 4;
    signals.push({ tag: '暴涨回落', detail: `24h+${chg24h.toFixed(0)}% 峰值跌${ddFromPeak.toFixed(0)}%`, score: 4 });
  } else if (chg24h > 50 && ddFromPeak > 10) {
    shortScore += 3;
    signals.push({ tag: '冲高回落', detail: `24h+${chg24h.toFixed(0)}% 峰值跌${ddFromPeak.toFixed(0)}%`, score: 3 });
  } else if (chg24h > 30 && ddFromPeak > 15) {
    shortScore += 2;
    signals.push({ tag: '涨后回调', detail: `24h+${chg24h.toFixed(0)}% 回调${ddFromPeak.toFixed(0)}%`, score: 2 });
  }

  // ② 成交量异常（暴增后萎缩 = 出货完成）
  const recentVol = vols1h.slice(-4).reduce((a, b) => a + b, 0) / 4;
  const prevVol = vols1h.slice(-24, -4).reduce((a, b) => a + b, 0) / 20;
  const volRatio = prevVol > 0 ? recentVol / prevVol : 1;
  const peakVol = Math.max(...vols1h.slice(-24));
  const peakVolRatio = prevVol > 0 ? peakVol / prevVol : 1;

  if (peakVolRatio > 5 && volRatio < 1.5) {
    shortScore += 2;
    signals.push({ tag: '天量后缩量', detail: `峰值${peakVolRatio.toFixed(0)}x 当前${volRatio.toFixed(1)}x`, score: 2 });
  } else if (peakVolRatio > 3) {
    shortScore += 1;
    signals.push({ tag: '放量冲高', detail: `峰值${peakVolRatio.toFixed(0)}x`, score: 1 });
  }

  // ③ RSI 超买
  const rsi6 = calcRSI(closes1h, 6);
  const rsi14 = calcRSI(closes1h, 14);
  if (rsi6 > 80 || rsi14 > 75) {
    shortScore += 2;
    signals.push({ tag: 'RSI超买', detail: `RSI6=${rsi6.toFixed(0)} RSI14=${rsi14.toFixed(0)}`, score: 2 });
  } else if (rsi6 > 70) {
    shortScore += 1;
    signals.push({ tag: 'RSI偏高', detail: `RSI6=${rsi6.toFixed(0)}`, score: 1 });
  }

  // ④ 偏离均线过远
  const ma20 = closes1h.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes1h.length);
  const deviation = (curPrice - ma20) / ma20 * 100;
  if (deviation > 80) {
    shortScore += 3;
    signals.push({ tag: '极度偏离MA', detail: `偏离+${deviation.toFixed(0)}%`, score: 3 });
  } else if (deviation > 40) {
    shortScore += 2;
    signals.push({ tag: '远离MA', detail: `偏离+${deviation.toFixed(0)}%`, score: 2 });
  } else if (deviation > 20) {
    shortScore += 1;
    signals.push({ tag: '偏离MA', detail: `偏离+${deviation.toFixed(0)}%`, score: 1 });
  }

  // ⑤ 连续阴线（冲高后下跌信号）
  const recent6 = klines1h.slice(-6);
  let bearCount = 0;
  let upperWickTotal = 0;
  for (const k of recent6) {
    const o = parseFloat(k[1]), h = parseFloat(k[2]), c = parseFloat(k[4]);
    if (c < o) bearCount++;
    const range = h - Math.min(parseFloat(k[3]), c);
    if (range > 0) upperWickTotal += (h - Math.max(o, c)) / range;
  }
  if (bearCount >= 5) {
    shortScore += 2;
    signals.push({ tag: '连续阴线', detail: `近6根有${bearCount}阴`, score: 2 });
  } else if (bearCount >= 4) {
    shortScore += 1;
    signals.push({ tag: '多阴线', detail: `近6根有${bearCount}阴`, score: 1 });
  }

  // ⑥ 高位长期横盘（适用于 VELVET 类型）
  const lookback4h = klines4h.slice(-15);
  const highsLB = lookback4h.map(k => parseFloat(k[2]));
  const lowsLB = lookback4h.map(k => parseFloat(k[3]));
  const histPeak = Math.max(...highsLB);
  const histLow = Math.min(...lowsLB);
  const totalGain4h = (histPeak - histLow) / histLow * 100;
  const curVsPeak4h = (histPeak - curPrice) / histPeak * 100;

  if (totalGain4h > 100 && curVsPeak4h < 20 && curVsPeak4h > 5) {
    shortScore += 2;
    signals.push({ tag: '高位盘整', detail: `历史涨${totalGain4h.toFixed(0)}% 距峰${curVsPeak4h.toFixed(0)}%`, score: 2 });
  }

  // ⑦ 持续阴跌趋势（GUA/SKYAI 类型）
  const closes4hRecent = klines4h.slice(-12).map(k => parseFloat(k[4]));
  const opens4hRecent = klines4h.slice(-12).map(k => parseFloat(k[1]));
  if (closes4hRecent.length >= 8) {
    let bearBars = 0;
    for (let i = 0; i < closes4hRecent.length; i++) {
      if (closes4hRecent[i] < opens4hRecent[i]) bearBars++;
    }
    const startP = closes4hRecent[0];
    const endP = closes4hRecent[closes4hRecent.length - 1];
    const totalDrop = (startP - endP) / startP * 100;
    const recentDrop = closes4hRecent.length >= 4
      ? (closes4hRecent[closes4hRecent.length - 4] - endP) / closes4hRecent[closes4hRecent.length - 4] * 100
      : 0;
    const bearRatio = bearBars / closes4hRecent.length;

    if (bearRatio >= 0.7 && totalDrop > 30) {
      shortScore += 3;
      signals.push({ tag: '持续阴跌', detail: `${closes4hRecent.length}根有${bearBars}阴 累跌${totalDrop.toFixed(0)}%`, score: 3 });
    } else if (bearRatio >= 0.6 && totalDrop > 15) {
      shortScore += 2;
      signals.push({ tag: '阴跌趋势', detail: `${closes4hRecent.length}根有${bearBars}阴 累跌${totalDrop.toFixed(0)}%`, score: 2 });
    }

    if (recentDrop > totalDrop * 0.5 && totalDrop > 15) {
      shortScore += 1;
      signals.push({ tag: '下跌加速', detail: `近期跌${recentDrop.toFixed(0)}%占总跌一半`, score: 1 });
    }
  }

  // ⑧ 8点来大跌（AKE 类型 — 8am基准跌幅大）
  if (changeSince8am != null && changeSince8am < -20) {
    shortScore += 4;
    signals.push({ tag: '8点大跌', detail: `8am来${changeSince8am.toFixed(1)}%`, score: 4 });
  } else if (changeSince8am != null && changeSince8am < -12) {
    shortScore += 3;
    signals.push({ tag: '8点下跌', detail: `8am来${changeSince8am.toFixed(1)}%`, score: 3 });
  } else if (changeSince8am != null && changeSince8am < -8) {
    shortScore += 2;
    signals.push({ tag: '8点走弱', detail: `8am来${changeSince8am.toFixed(1)}%`, score: 2 });
  }

  if (shortScore < 4) return null;

  return {
    symbol,
    label: symbol.replace('USDT', ''),
    shortScore,
    signals,
    price: curPrice,
    chg24h,
    ddFromPeak,
    peak24h,
    rsi6,
    volRatio,
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

export async function scanShortSignals({
  limit = 200,
  minScore = 4,
  concurrency = 3,
  declineMap = {},
  gainMap = {},
} = {}) {
  const tickers = await fetchJSON(`${FAPI_BASE}/fapi/v1/ticker/24hr`);

  const seen = new Set();
  const candidates = [];

  for (const t of tickers.filter(t => t.symbol.endsWith('USDT'))) {
    const change = parseFloat(t.priceChangePercent);
    const volume = parseFloat(t.quoteVolume);
    if (change > 20 || change < -15 || volume > 50_000_000) {
      candidates.push({
        symbol: t.symbol,
        change,
        volume,
        price: parseFloat(t.lastPrice),
        changeSince8am: gainMap[t.symbol] ?? declineMap[t.symbol] ?? null,
      });
      seen.add(t.symbol);
    }
  }

  for (const [sym, chg] of Object.entries(declineMap)) {
    if (chg < -8 && !seen.has(sym)) {
      const t = tickers.find(x => x.symbol === sym);
      candidates.push({
        symbol: sym,
        change: t ? parseFloat(t.priceChangePercent) : chg,
        volume: t ? parseFloat(t.quoteVolume) : 0,
        price: t ? parseFloat(t.lastPrice) : 0,
        changeSince8am: chg,
      });
      seen.add(sym);
    }
  }

  candidates.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  const toScan = candidates.slice(0, limit);

  const results = [];
  await pmap(toScan, async (item) => {
    try {
      const r = await checkShortSignal(item.symbol, { changeSince8am: item.changeSince8am });
      if (r && r.shortScore >= minScore) {
        results.push(r);
      }
    } catch {}
  }, concurrency);

  results.sort((a, b) => b.shortScore - a.shortScore || b.ddFromPeak - a.ddFromPeak);
  return results;
}
