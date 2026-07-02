#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanRightStable } from './scan-stable.mjs';
import { fetchSmartSignal, analyzeSmartSignal, scanSmartSignal } from './scan-smart-signal.mjs';
import { setupProxyFromEnv } from './proxy-setup.mjs';

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

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const header = `**扫描时间:** ${now}\n**共 ${results.length} 个币种**\n\n`;
    const footer = `\n\n_回撤≤${(STABLE_MAX_DRAWDOWN * 100).toFixed(0)}% · 1H+1D双周期 · Top${STABLE_SCAN_LIMIT}_`;
    const lineStrs = results.map((c, i) => {
      const chgEmoji = c.changeSince8am >= 5 ? '🚀' : c.changeSince8am >= 0 ? '🟢' : '🔴';
      const chg = c.changeSince8am >= 0 ? `+${c.changeSince8am.toFixed(1)}%` : `${c.changeSince8am.toFixed(1)}%`;
      const scoreEmoji = c.score >= 4 ? '🔥' : '⭐';
      const parts = [
        `${i + 1}. ${chgEmoji} **${c.label}** $${fmtPrice(c.price)} ${chg}(8am)`,
        `${scoreEmoji}${c.score}/5`,
        `📉${c.drawdown.toFixed(1)}%`,
      ];
      if (c.topVsGlobal != null) {
        const whaleEmoji = c.topVsGlobal > 1.2 ? '🐋' : c.topVsGlobal < 0.8 ? '🦐' : '🐟';
        parts.push(`${whaleEmoji}${c.topVsGlobal.toFixed(2)}`);
      }
      if (c.streak > 1) parts.push(`🔄${c.streak}次`);
      return parts.join(' · ');
    });
    const MAX_CHARS = 28000;
    const chunks = [];
    let buf = header;
    for (const line of lineStrs) {
      const next = buf + line + '\n';
      if (next.length > MAX_CHARS && buf.length > header.length) {
        chunks.push(buf.trimEnd());
        buf = header + line + '\n';
      } else {
        buf = next;
      }
    }
    if (buf.length > header.length) chunks.push(buf.trimEnd() + footer);

    if (chunks.length === 0) {
      await sendFeishu(`右侧稳趋势 · 0 个币种`, formatStablePushContent(results));
    } else if (chunks.length === 1) {
      await sendFeishu(`右侧稳趋势 · ${results.length} 个币种`, chunks[0]);
    } else {
      for (let i = 0; i < chunks.length; i++) {
        await sendFeishu(`右侧稳趋势 · ${results.length} 个 (${i + 1}/${chunks.length})`, chunks[i]);
      }
    }
    console.log(`  ✓ 稳趋势推送完成 (${results.length} 个币种${chunks.length > 1 ? `, ${chunks.length} 条消息` : ''})`);
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
  // 预热8点基准价缓存，避免首次打开涨幅榜等待过久
  handleGainersSince8am(10).then(() => {
    console.log(`  ✓ 8点涨幅基准价缓存已预热`);
  }).catch(e => {
    console.warn(`  ⚠ 8点基准价预热失败: ${e.message}`);
  });
  startStablePushScheduler();
});
