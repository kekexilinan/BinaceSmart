/**
 * 聪明钱监控币种池：24h 涨幅榜 TopN + 24h 跌幅榜 TopN + 24h 交易额 TopN（排除超市值上限），每日 08:00 上海时间刷新
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
/** @type {{ symbol: string, change: number }[]} */
let gainerList = [];
/** @type {{ symbol: string, change: number }[]} */
let loserList = [];
/** @type {{ symbol: string, change: number }[]} */
let rightSideList = [];
/** @type {{ symbol: string, volume: number }[]} */
let volumeTopList = [];
let lastRefreshDateKey = null;
let lastRefreshAt = 0;
let refreshTimer = null;
/** @type {Set<string>} */
let pinnedSymbols = new Set();

function resolvePinnedSet() {
  const raw = deps?.extraSymbols;
  if (!raw) return new Set();
  if (raw instanceof Set) return new Set([...raw].map(s => s.toUpperCase()));
  return new Set(raw.map(s => String(s).toUpperCase()));
}

function applyPinnedToWatch() {
  pinnedSymbols = resolvePinnedSet();
  for (const sym of pinnedSymbols) {
    watchSymbols.add(sym);
    deps?.registerActiveSymbol?.(sym);
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
  applyPinnedToWatch();
  return watchSymbols;
}

export function getWatchlistInfo() {
  return {
    symbols: [...watchSymbols],
    count: watchSymbols.size,
    dateKey: lastRefreshDateKey,
    source: deps?.boardPeriod === '24h' ? '24h_gainer_loser_board' : '8am_gainer_loser_board',
    topN: deps?.topN ?? 20,
    gainers: gainerList,
    losers: loserList,
    rightSide: rightSideList,
    volumeTop: volumeTopList,
    volumeTopN: deps?.volumeTopN ?? 50,
  };
}

export function getWatchlistGroups() {
  applyPinnedToWatch();
  return {
    dateKey: lastRefreshDateKey,
    topN: deps?.topN ?? 20,
    volumeTopN: deps?.volumeTopN ?? 50,
    gainers: gainerList,
    losers: loserList,
    pinned: [...pinnedSymbols],
    rightSide: rightSideList,
    volumeTop: volumeTopList,
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
    rightSide: meta.rightSide || [],
    volumeTop: meta.volumeTop || [],
    volumeTopN: deps?.volumeTopN ?? 50,
  }), 'utf8');
}

async function loadPersistedWatchlist() {
  try {
    const raw = await readFile(WATCHLIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.symbols?.length) {
      watchSymbols = new Set(data.symbols.map(s => s.toUpperCase()));
      lastRefreshDateKey = data.dateKey || null;
      gainerList = (data.gainers || []).map(g => ({
        symbol: g.symbol.toUpperCase(),
        change: g.change,
      }));
      loserList = (data.losers || []).map(l => ({
        symbol: l.symbol.toUpperCase(),
        change: l.change,
      }));
      rightSideList = (data.rightSide || []).map(r => ({
        symbol: r.symbol.toUpperCase(),
        change: r.change,
      }));
      volumeTopList = (data.volumeTop || []).map(v => ({
        symbol: v.symbol.toUpperCase(),
        volume: v.volume,
      }));
      for (const sym of watchSymbols) {
        deps?.registerActiveSymbol?.(sym);
      }
      if (data.updatedAt) lastRefreshAt = data.updatedAt;
      const expectedVolumeTopN = deps?.volumeTopN ?? 50;
      if (
        data.topN == null || data.topN !== (deps?.topN ?? 20)
        || data.volumeTopN == null || data.volumeTopN !== expectedVolumeTopN
      ) {
        lastRefreshDateKey = null;
      }
    }
  } catch {
    // 首次运行
  }
}

export async function refreshSmartTrendWatchlist({ force = false } = {}) {
  const getGainers = deps?.getGainers24h || deps?.getGainersSince8am;
  const getLosers = deps?.getLosers24h || deps?.getLosersSince8am;
  if (!getGainers || !getLosers) {
    throw new Error('refreshSmartTrendWatchlist: 缺少 getGainers24h / getLosers24h');
  }

  const dateKey = getBaseline8amDateKey();
  const use24hBoard = deps?.boardPeriod === '24h';
  const refreshTtlMs = deps?.refreshTtlMs ?? 60 * 60 * 1000;

  if (!force && watchSymbols.size > 0) {
    if (!use24hBoard && lastRefreshDateKey === dateKey) {
      applyPinnedToWatch();
      return { symbols: [...watchSymbols], skipped: true, dateKey };
    }
    if (use24hBoard && lastRefreshAt && Date.now() - lastRefreshAt < refreshTtlMs) {
      applyPinnedToWatch();
      return { symbols: [...watchSymbols], skipped: true, dateKey: lastRefreshDateKey };
    }
  }

  const topN = deps.topN ?? 20;
  const prevSymbols = [...watchSymbols];

  const volumeTopN = deps.volumeTopN ?? 50;
  const fetchTasks = [
    getGainers(topN),
    getLosers(topN),
  ];
  if (volumeTopN > 0 && deps.getTopByVolume) {
    fetchTasks.push(deps.getTopByVolume(volumeTopN));
  }
  const results = await Promise.all(fetchTasks);
  const gainers = results[0];
  const losers = results[1];
  const volumeTop = volumeTopN > 0 && deps.getTopByVolume ? results[2] : { items: [] };

  const next = new Set([
    ...gainers.items.map(i => i.symbol.toUpperCase()),
    ...losers.items.map(i => i.symbol.toUpperCase()),
    ...volumeTop.items.map(i => i.symbol.toUpperCase()),
  ]);

  let rightSideItems = [];
  if (deps?.scanRightSide) {
    try {
      rightSideItems = await deps.scanRightSide({
        limit: deps.rightSideScanLimit ?? 200,
        filterTF: '1h',
        concurrency: 3,
      });
      for (const item of rightSideItems) {
        next.add(item.symbol.toUpperCase());
      }
    } catch (e) {
      console.warn(`  ⚠ 右侧交易扫描失败: ${e.message}`);
    }
  }

  watchSymbols = next;
  const boardLabel = use24hBoard ? '24h榜' : '8点榜';
  lastRefreshDateKey = use24hBoard
    ? (() => {
      const p = getShanghaiParts();
      return `${p.year}-${p.month}-${p.day}`;
    })()
    : (gainers.meta?.baselineDate || dateKey);
  gainerList = gainers.items.map(i => ({ symbol: i.symbol.toUpperCase(), change: i.change }));
  loserList = losers.items.map(i => ({ symbol: i.symbol.toUpperCase(), change: i.change }));
  rightSideList = rightSideItems.map(i => ({ symbol: i.symbol.toUpperCase(), change: i.change }));
  volumeTopList = volumeTop.items.map(i => ({ symbol: i.symbol.toUpperCase(), volume: i.volume }));
  applyPinnedToWatch();

  lastRefreshAt = Date.now();
  deps.onWatchlistUpdated?.([...watchSymbols], prevSymbols);

  await persistWatchlist({
    gainers: gainerList,
    losers: loserList,
    rightSide: rightSideList,
    volumeTop: volumeTopList,
  });

  const labels = [...watchSymbols].slice(0, 12).map(s => s.replace(/USDT$/, '')).join(', ');
  const suffix = watchSymbols.size > 12 ? ` 等 ${watchSymbols.size} 个` : '';
  const pinNote = pinnedSymbols.size ? ` · 固定 ${[...pinnedSymbols].map(s => s.replace(/USDT$/, '')).join(',')}` : '';
  const volumeNote = volumeTopN > 0 ? ` + 交易额 Top${volumeTopN}` : '';
  const boardNote = use24hBoard ? `24h榜 Top${topN}+Top${topN}` : `8点榜 Top${topN}+Top${topN}`;
  console.log(`  📋 聪明钱监控池已更新 (${lastRefreshDateKey} ${boardNote}${volumeNote}${pinNote}): ${labels}${suffix}`);

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
      await deps.onDaily8am?.([...watchSymbols]);
    } catch (e) {
      console.warn(`  ⚠ 监控池刷新失败: ${e.message}`);
    }
    scheduleNextRefresh();
  }, delay);
}

export async function startSmartTrendWatchlistScheduler() {
  if (!deps?.enabled) return;

  await loadPersistedWatchlist();
  applyPinnedToWatch();
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
  const volumeTopN = deps.volumeTopN ?? 50;
  const pinNote = pinnedSymbols.size ? ` + 固定 ${[...pinnedSymbols].map(s => s.replace(/USDT$/, '')).join(',')}` : '';
  const volumeNote = volumeTopN > 0 ? ` + 交易额 Top${volumeTopN}` : '';
  const boardNote = (deps?.boardPeriod === '24h')
    ? `24h涨幅榜 Top${topN} + 24h跌幅榜 Top${topN}`
    : `8点涨幅榜 Top${topN} + 跌幅榜 Top${topN}`;
  console.log(`  📋 聪明钱动态监控池: ${boardNote}${volumeNote}${pinNote} · 每日 08:00 上海刷新 · 当前 ${watchSymbols.size} 个`);
  scheduleNextRefresh();
}
