#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanRightStable } from './scan-stable.mjs';
import { fetchSmartSignal, analyzeSmartSignal, scanSmartSignal } from './scan-smart-signal.mjs';
import { setupProxyFromEnv } from './proxy-setup.mjs';
import { checkDumpRisk, scanDumpCoins, formatDumpPushContent } from './scan-dump-risk.mjs';
import { scanShortSignals } from './scan-short-signal.mjs';

// Load .env file
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envContent = await readFile(join(__dirname, '.env'), 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch {}

const proxyInfo = setupProxyFromEnv();

const PORT = parseInt(process.env.PORT || '3388', 10);
const FAPI_BASE = 'https://fapi.binance.com';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function proxyBinance(path) {
  const res = await fetch(`${FAPI_BASE}${path}`);
  if (!res.ok) throw new Error(`Binance API ${res.status}: ${path}`);
  return res.json();
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
  if (baseline8amCache.dateKey === dateKey && Object.keys(baseline8amCache.prices).length > 50) {
    return { dateKey, openTime, prices: baseline8amCache.prices };
  }
  const prices = await pmap(symbols, async (sym) => {
    const klines = await proxyBinance(`/fapi/v1/klines?symbol=${sym}&interval=1h&startTime=${openTime}&limit=1`);
    if (!Array.isArray(klines) || klines.length === 0) return null;
    const open = parseFloat(klines[0][1]);
    return open > 0 ? open : null;
  }, 20);
  const filtered = {};
  for (const [sym, price] of Object.entries(prices)) {
    if (price != null) filtered[sym] = price;
  }
  baseline8amCache = { dateKey, prices: filtered };
  return { dateKey, openTime, prices: filtered };
}

async function handleGainersSince8am(limit) {
  const tickers = await proxyBinance('/fapi/v1/ticker/24hr');
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
        price,
        basePrice,
        volume: parseFloat(t.quoteVolume),
        change,
        change24h: parseFloat(t.priceChangePercent),
      };
    })
    .sort((a, b) => b.change - a.change)
    .slice(0, limit);
  const { label } = getBaseline8amInfo();
  return {
    meta: { baselineDate: dateKey, baselineTime: '08:00', timezone: 'Asia/Shanghai', baselineLabel: label, openTime },
    items,
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

async function handleAPI(symbol, { ratioLimit = 72, oiLimit = 42, takerLimit = 48 } = {}) {
  const rl = Math.min(500, Math.max(1, parseInt(ratioLimit, 10)));
  const ol = Math.min(500, Math.max(1, parseInt(oiLimit, 10)));
  const tl = Math.min(500, Math.max(1, parseInt(takerLimit, 10)));
  const [price, ticker24h, topAccounts, topPositions, globalRatio, oi, oiHist, takerVol, fundingRate, fundingRateHist] =
    await Promise.all([
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
    ]);
  const changeSince8am = await getChangeSince8am(symbol, price.price);
  return { price, ticker24h, topAccounts, topPositions, globalRatio, oi, oiHist, takerVol, fundingRate, fundingRateHist, changeSince8am };
}

let FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || '';
const STABLE_PUSH_HOURS = parseFloat(process.env.STABLE_PUSH_HOURS || '4', 10);
const STABLE_PUSH_ENABLED = process.env.STABLE_PUSH_ENABLED !== 'false' && !!FEISHU_WEBHOOK;
const STABLE_SCAN_LIMIT = parseInt(process.env.STABLE_SCAN_LIMIT || '200', 10);
const STABLE_MAX_DRAWDOWN = parseFloat(process.env.STABLE_MAX_DRAWDOWN || '0.30', 10);
const DUMP_PUSH_HOURS = parseFloat(process.env.DUMP_PUSH_HOURS || '1');
const DUMP_PUSH_ENABLED = process.env.DUMP_PUSH_ENABLED !== 'false' && !!FEISHU_WEBHOOK;
const DUMP_SCAN_LIMIT = parseInt(process.env.DUMP_SCAN_LIMIT || '200', 10);
const DUMP_MIN_RISK = parseInt(process.env.DUMP_MIN_RISK || '4', 10);
const LONG_PUSH_HOURS = parseFloat(process.env.LONG_PUSH_HOURS || '1');
const LONG_PUSH_ENABLED = process.env.LONG_PUSH_ENABLED !== 'false' && !!FEISHU_WEBHOOK;
const LONG_SCAN_LIMIT = parseInt(process.env.LONG_SCAN_LIMIT || '200', 10);
const LONG_MIN_SCORE = parseInt(process.env.LONG_MIN_SCORE || '3', 10);

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

async function sendFeishuCardV2(title, elements, template = 'blue') {
  if (!FEISHU_WEBHOOK) throw new Error('FEISHU_WEBHOOK 未配置');
  const body = {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: title }, template },
      body: { elements },
    },
  };
  const res = await fetch(FEISHU_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
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
    const results = await scanRightStable({
      limit: STABLE_SCAN_LIMIT,
      maxDrawdownPct: STABLE_MAX_DRAWDOWN,
      dualTFConfirm: true,
      filterTF: '1h',
      concurrency: 3,
    });

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
        { name: 'coin', display_name: '币种', data_type: 'text', width: 'auto' },
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
    const slot = new Date(`${dateKey}T${String(h).padStart(2, '0')}:00:00+08:00`);
    if (slot.getTime() > now.getTime() + 500) return slot;
  }
  const nextDay = new Date(`${dateKey}T00:00:00+08:00`);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay;
}

function startStablePushScheduler() {
  if (!STABLE_PUSH_ENABLED) {
    console.log(`  ⏸ 稳趋势推送未启用（需配置 FEISHU_WEBHOOK）`);
    return;
  }
  const slots = getStablePushHours(STABLE_PUSH_HOURS).map(h => `${String(h).padStart(2, '0')}:00`).join(' / ');
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

async function batchFetchMarketCaps(symbols) {
  const result = {};
  const syms = [...new Set(symbols.map(s => s.replace('USDT', '').toLowerCase()))];
  try {
    const searchRes = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`);
    if (!searchRes.ok) return result;
    const data = await searchRes.json();
    const lookup = new Map(data.map(c => [c.symbol.toLowerCase(), c.market_cap || 0]));
    for (const s of syms) {
      result[s.toUpperCase() + 'USDT'] = lookup.get(s) || 0;
    }
  } catch {}
  return result;
}

let combinedPushRunning = false;
let longPushHistory = [];
const COMBINED_TOP_N = 20;

async function runCombinedPush() {
  if (combinedPushRunning) return;
  const longEnabled = LONG_PUSH_ENABLED;
  const dumpEnabled = DUMP_PUSH_ENABLED;
  if (!longEnabled && !dumpEnabled) return;
  combinedPushRunning = true;
  try {
    console.log(`\n  📤 开始做多+做空+暴跌联合扫描...`);
    await waitForNetworkReady('币安 API', { maxAttempts: 6, initialDelayMs: 10000 });

    let longResults = [];
    let shortResults = [];
    let dumpResults = [];

    const tasks = [];
    if (longEnabled) tasks.push((async () => {
      const allResults = await scanRightStable({
        limit: LONG_SCAN_LIMIT,
        maxDrawdownPct: 0.20,
        dualTFConfirm: true,
        filterTF: '1h',
        concurrency: 3,
      });
      const filtered = allResults.filter(r => r.score >= LONG_MIN_SCORE);
      const resultSymbols = filtered.map(r => r.symbol);

      const { prices: baselines } = await load8amBaselinePrices(resultSymbols);
      for (const r of filtered) {
        const base = baselines[r.symbol];
        r.changeSince8am = base && base > 0 ? ((r.price - base) / base) * 100 : r.change;
      }

      const symbolMap = new Map(filtered.map(r => [r.symbol, r]));
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

      for (const r of filtered) {
        let count = 1;
        for (let i = longPushHistory.length - 1; i >= 0; i--) {
          if (longPushHistory[i].has(r.symbol)) count++;
          else break;
        }
        r.streak = count;
      }
      longPushHistory.push(new Set(resultSymbols));
      if (longPushHistory.length > 100) longPushHistory = longPushHistory.slice(-100);

      filtered.sort((a, b) => b.streak - a.streak || b.score - a.score || b.changeSince8am - a.changeSince8am);
      longResults = filtered.slice(0, COMBINED_TOP_N);
    })());

    if (dumpEnabled) tasks.push((async () => {
      const results = await scanDumpCoins({
        limit: DUMP_SCAN_LIMIT,
        minRiskScore: DUMP_MIN_RISK,
        concurrency: 3,
      });
      dumpResults = results.slice(0, COMBINED_TOP_N);
    })());

    tasks.push((async () => {
      try {
        const results = await scanShortSignals({ limit: 100, minScore: 4, concurrency: 3 });
        shortResults = results.slice(0, COMBINED_TOP_N);
      } catch (e) {
        console.warn(`  ⚠ 做空扫描异常: ${e.message}`);
      }
    })());

    await Promise.all(tasks);

    if (!longResults.length && !shortResults.length && !dumpResults.length) {
      console.log(`  ✓ 联合扫描完成，当前无做多/做空/暴跌信号`);
      return;
    }

    const allSymbols = [
      ...longResults.map(r => r.symbol),
      ...shortResults.map(r => r.symbol),
      ...dumpResults.map(r => r.symbol),
    ];
    const marketCaps = await batchFetchMarketCaps(allSymbols);

    const dumpSymbols = dumpResults.map(r => r.symbol);
    const { prices: dumpBaselines } = await load8amBaselinePrices(dumpSymbols);
    for (const r of dumpResults) {
      const base = dumpBaselines[r.symbol];
      r.changeSince8am = base && base > 0 ? ((r.price - base) / base) * 100 : r.change24h;
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const elements = [];

    elements.push({ tag: 'markdown', content: `**扫描时间:** ${now}` });

    if (longResults.length) {
      elements.push({ tag: 'markdown', content: `**📈 做多推荐 · ${longResults.length} 个** (评分≥${LONG_MIN_SCORE}/5 · 回撤≤20%)` });
      elements.push({
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        freeze_first_column: true,
        columns: [
          { name: 'coin', display_name: '币种', data_type: 'text', width: 'auto' },
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
    }

    if (shortResults.length) {
      elements.push({ tag: 'markdown', content: `**📉 做空推荐 · ${shortResults.length} 个** (暴涨回落/高位横盘)` });
      elements.push({
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        freeze_first_column: true,
        columns: [
          { name: 'coin', display_name: '币种', data_type: 'text', width: 'auto' },
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

    if (dumpResults.length) {
      const highRisk = dumpResults.filter(r => r.riskLevel === 'high');
      const warnRisk = dumpResults.filter(r => r.riskLevel === 'warn');
      elements.push({ tag: 'markdown', content: `**🚨 暴跌预警 · ${highRisk.length} 高危 ${warnRisk.length} 警告**` });
      elements.push({
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        freeze_first_column: true,
        columns: [
          { name: 'coin', display_name: '币种', data_type: 'text', width: 'auto' },
          { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
          { name: 'chg8am', display_name: '8am', data_type: 'lark_md', width: 'auto' },
          { name: 'chg24h', display_name: '24h', data_type: 'lark_md', width: 'auto' },
          { name: 'risk', display_name: '风险分', data_type: 'lark_md', width: 'auto' },
          { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
          { name: 'tags', display_name: '风险标签', data_type: 'text', width: 'auto' },
        ],
        rows: [...highRisk, ...warnRisk].map(r => {
          const chg8amColor = r.changeSince8am >= 0 ? 'turquoise' : r.changeSince8am <= -10 ? 'red' : 'orange';
          const chg8amIcon = r.changeSince8am <= -10 ? '💀' : '';
          const chg8amArrow = r.changeSince8am <= -10 ? '' : r.changeSince8am >= 0 ? '▲' : '▼';
          const chg24hColor = r.change24h >= 0 ? 'turquoise' : r.change24h <= -10 ? 'red' : 'orange';
          const chg24hIcon = r.change24h <= -10 ? '💀' : '';
          const chg24hArrow = r.change24h <= -10 ? '' : r.change24h >= 0 ? '▲' : '▼';
          const riskColor = r.riskLevel === 'high' ? 'red' : 'orange';
          const riskIcon = r.riskLevel === 'high' ? '🚨' : '⚠️';
          return {
            coin: r.label,
            price: `$${fmtPrice(r.price)}`,
            chg8am: `${chg8amIcon}<font color='${chg8amColor}'>${chg8amArrow}${r.changeSince8am >= 0 ? '+' : ''}${r.changeSince8am.toFixed(1)}%</font>`,
            chg24h: `${chg24hIcon}<font color='${chg24hColor}'>${chg24hArrow}${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(1)}%</font>`,
            risk: `${riskIcon}<font color='${riskColor}'>${r.riskScore}</font>`,
            mc: fmtMarketCap(marketCaps[r.symbol]),
            tags: r.risks.slice(0, 3).map(x => `${x.level}${x.tag}`).join(' '),
          };
        }),
      });
    }

    elements.push({ tag: 'markdown', content: `_每小时整点 · Top${LONG_SCAN_LIMIT} · 各取前${COMBINED_TOP_N}_` });

    const titleParts = [];
    if (longResults.length) titleParts.push(`📈${longResults.length}做多`);
    if (shortResults.length) titleParts.push(`📉${shortResults.length}做空`);
    if (dumpResults.length) titleParts.push(`🚨${dumpResults.length}预警`);
    const title = `整点扫描 · ${titleParts.join(' · ')}`;

    await sendFeishuCardV2(title, elements);
    console.log(`  ✓ 联合推送完成 (做多 ${longResults.length} + 做空 ${shortResults.length} + 暴跌 ${dumpResults.length})`);
  } catch (e) {
    console.warn(`  ⚠ 联合推送失败: ${e.message}`);
  } finally {
    combinedPushRunning = false;
  }
}

function startCombinedPushScheduler() {
  if (!LONG_PUSH_ENABLED && !DUMP_PUSH_ENABLED) {
    console.log(`  ⏸ 做多+暴跌推送均未启用（需配置 FEISHU_WEBHOOK）`);
    return;
  }
  console.log(`  🔔 做多+暴跌联合推送: 上海时间每小时整点 → 飞书`);

  const scheduleNext = () => {
    const next = getNextStablePushTime(new Date(), 1);
    const delay = Math.max(0, next.getTime() - Date.now());
    const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  ⏭ 联合推送下次: ${label}（${Math.round(delay / 60000)} 分钟后）`);
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
      const tickers = await proxyBinance('/fapi/v1/ticker/24hr');
      let usdt = tickers
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => ({ symbol: t.symbol, volume: parseFloat(t.quoteVolume), price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent) }));
      if (minChange > 0) usdt = usdt.filter(t => t.change >= minChange);
      usdt = usdt
        .sort((a, b) => sort === 'change' ? b.change - a.change : b.volume - a.volume)
        .slice(0, limit);
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

  if (url.pathname === '/api/marketcap') {
    const sym = (url.searchParams.get('symbol') || 'BTCUSDT').replace('USDT', '').toLowerCase();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    try {
      const searchRes = await fetch(`https://api.coingecko.com/api/v3/search?query=${sym}`);
      if (!searchRes.ok) { res.writeHead(200, headers); res.end(JSON.stringify({ market_cap: 0 })); return; }
      const searchData = await searchRes.json();
      const coin = searchData.coins?.find(c => c.symbol?.toLowerCase() === sym) || searchData.coins?.[0];
      if (!coin) { res.writeHead(200, headers); res.end(JSON.stringify({ market_cap: 0 })); return; }
      const priceRes = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coin.id}&vs_currencies=usd&include_market_cap=true`);
      if (!priceRes.ok) { res.writeHead(200, headers); res.end(JSON.stringify({ market_cap: 0 })); return; }
      const priceData = await priceRes.json();
      const entry = priceData[coin.id];
      res.writeHead(200, headers);
      res.end(JSON.stringify({ market_cap: entry?.usd_market_cap || 0 }));
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
    const priceParam = parseFloat(url.searchParams.get('price') || '0');
    const price = priceParam > 0 ? priceParam : null;
    try {
      const raw = await fetchSmartSignal(symbol);
      const analysis = analyzeSmartSignal(raw, price);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ symbol, raw, ...analysis }));
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
      const results = await scanDumpCoins({ limit, minRiskScore: minRisk, concurrency: 3 });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(results));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message }));
    }
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

  if (url.pathname === '/api/scan-smart-signal') {
    const limit = Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10));
    const direction = ['long', 'short', 'all'].includes(url.searchParams.get('direction'))
      ? url.searchParams.get('direction') : 'long';
    try {
      const results = await scanSmartSignal({ limit, direction, concurrency: 2 });
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

server.listen(PORT, () => {
  console.log(`\n  🚀 聪明钱监控面板已启动: http://localhost:${PORT}`);
  if (proxyInfo.enabled) {
    console.log(`  🌐 代理已启用: ${proxyInfo.url}（Smart Signal bapi）`);
  } else {
    console.log(`  ⚠ 未配置 HTTPS_PROXY，Smart Signal 若超时请在 .env 中设置代理`);
  }
  console.log(`  📊 默认监控: SLXUSDT`);
  console.log(`  ⏹  Ctrl+C 退出\n`);
  // 预热8点基准价缓存，避免首次打开涨幅榜等待过久（开机时等待网络就绪）
  waitForNetworkReady('币安 API')
    .then(() => handleGainersSince8am(10))
    .then(() => {
      console.log(`  ✓ 8点涨幅基准价缓存已预热`);
    })
    .catch(e => {
      console.warn(`  ⚠ 8点基准价预热失败: ${e.message}`);
    });
  startStablePushScheduler();
  startCombinedPushScheduler();
});
