/**
 * 聪明钱监控币种池：8点基准涨幅榜 TopN + 跌幅榜 TopN，每日 08:00 上海时间刷新
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const WATCHLIST_FILE = join(DATA_DIR, 'smart-trend-watchlist.json');

let deps = null;
/** @type {Set<string>} */
let watchSymbols = new Set();
let lastRefreshDateKey = null;
let refreshTimer = null;

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

function getBaseline8amDateKey(now = new Date()) {
  const p = getShanghaiParts(now);
  const hour = parseInt(p.hour, 10);
  let base = new Date(`${p.year}-${p.month}-${p.day}T08:00:00+08:00`);
  if (hour < 8) base.setDate(base.getDate() - 1);
  const bp = getShanghaiParts(base);
  return `${bp.year}-${bp.month}-${bp.day}`;
}

function getNext8amShanghai(now = new Date()) {
  const p = getShanghaiParts(now);
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  const slot = new Date(`${dateKey}T08:00:00+08:00`);
  if (slot.getTime() <= now.getTime() + 500) {
    slot.setDate(slot.getDate() + 1);
  }
  return slot;
}

export function getWatchSymbols() {
  return watchSymbols;
}

export function getWatchlistInfo() {
  return {
    symbols: [...watchSymbols],
    count: watchSymbols.size,
    dateKey: lastRefreshDateKey,
    source: '8am_gainer_loser_board',
    topN: deps?.topN ?? 20,
  };
}

async function persistWatchlist(meta = {}) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(WATCHLIST_FILE, JSON.stringify({
    dateKey: lastRefreshDateKey,
    topN: deps?.topN ?? 20,
    symbols: [...watchSymbols],
    updatedAt: Date.now(),
    gainers: meta.gainers || [],
    losers: meta.losers || [],
  }), 'utf8');
}

async function loadPersistedWatchlist() {
  try {
    const raw = await readFile(WATCHLIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.symbols?.length) {
      watchSymbols = new Set(data.symbols.map(s => s.toUpperCase()));
      lastRefreshDateKey = data.dateKey || null;
      for (const sym of watchSymbols) {
        deps?.registerActiveSymbol?.(sym);
      }
      // TopN 变更或旧缓存无 topN 字段时强制重新拉榜
      if (data.topN == null || data.topN !== (deps?.topN ?? 20)) {
        lastRefreshDateKey = null;
      }
    }
  } catch {
    // 首次运行
  }
}

export async function refreshSmartTrendWatchlist({ force = false } = {}) {
  if (!deps?.getGainersSince8am || !deps?.getLosersSince8am) {
    throw new Error('refreshSmartTrendWatchlist: 缺少 getGainersSince8am / getLosersSince8am');
  }

  const dateKey = getBaseline8amDateKey();
  if (!force && lastRefreshDateKey === dateKey && watchSymbols.size > 0) {
    return { symbols: [...watchSymbols], skipped: true, dateKey };
  }

  const topN = deps.topN ?? 20;
  const prevSymbols = [...watchSymbols];

  const [gainers, losers] = await Promise.all([
    deps.getGainersSince8am(topN),
    deps.getLosersSince8am(topN),
  ]);

  const next = new Set([
    ...gainers.items.map(i => i.symbol.toUpperCase()),
    ...losers.items.map(i => i.symbol.toUpperCase()),
  ]);

  watchSymbols = next;
  lastRefreshDateKey = gainers.meta?.baselineDate || dateKey;

  for (const sym of watchSymbols) {
    deps.registerActiveSymbol?.(sym);
  }

  deps.onWatchlistUpdated?.([...watchSymbols], prevSymbols);

  await persistWatchlist({
    gainers: gainers.items.map(i => ({ symbol: i.symbol, change: i.change })),
    losers: losers.items.map(i => ({ symbol: i.symbol, change: i.change })),
  });

  const labels = [...watchSymbols].slice(0, 12).map(s => s.replace(/USDT$/, '')).join(', ');
  const suffix = watchSymbols.size > 12 ? ` 等 ${watchSymbols.size} 个` : '';
  console.log(`  📋 聪明钱监控池已更新 (${lastRefreshDateKey} 8点榜 Top${topN}+Top${topN}): ${labels}${suffix}`);

  return {
    symbols: [...watchSymbols],
    skipped: false,
    dateKey: lastRefreshDateKey,
    gainers: gainers.items.length,
    losers: losers.items.length,
  };
}

export function initSmartTrendWatchlist(dependencies) {
  deps = dependencies;
}

function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const next = getNext8amShanghai();
  const delay = Math.max(0, next.getTime() - Date.now());
  const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  console.log(`  ⏭ 监控池下次刷新: ${label}（${Math.round(delay / 60000)} 分钟后）`);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshSmartTrendWatchlist({ force: true });
    } catch (e) {
      console.warn(`  ⚠ 监控池刷新失败: ${e.message}`);
    }
    scheduleNextRefresh();
  }, delay);
}

export async function startSmartTrendWatchlistScheduler() {
  if (!deps?.enabled) return;

  await loadPersistedWatchlist();
  try {
    await refreshSmartTrendWatchlist();
  } catch (e) {
    console.warn(`  ⚠ 监控池首次刷新失败: ${e.message}`);
    if (!watchSymbols.size && deps.fallbackSymbols?.size) {
      watchSymbols = new Set(deps.fallbackSymbols);
      for (const sym of watchSymbols) deps.registerActiveSymbol?.(sym);
      console.log(`  📋 使用备用监控币种 ${watchSymbols.size} 个`);
    }
  }

  const topN = deps.topN ?? 20;
  console.log(`  📋 聪明钱动态监控池: 8点涨幅榜 Top${topN} + 跌幅榜 Top${topN} · 每日 08:00 上海刷新 · 当前 ${watchSymbols.size} 个`);
  scheduleNextRefresh();
}
