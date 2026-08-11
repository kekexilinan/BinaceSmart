/**
 * 聪明钱监控 · 每小时50分推送全池变化摘要（推送全部币种，≥10% 仅用于显著变化高亮，含资金费变化）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSmartSignal, analyzeSmartSignal } from './scan-smart-signal.mjs';
import { registerActiveSymbol } from './whale-history.mjs';
import {
  buildSmartTrendDecision,
  buildSmartTrendDecisionElements,
  serializeSmartTrendDecision,
} from './smart-trend-decision.mjs';
import {
  RATIO_WARN_PCT,
  changeTrendLabel,
  tradeHintLabel,
  formatTopMoveItem,
  formatHints8amScore,
  ratioDeltaLabel,
  ratioDeltaDisplay,
  DIGEST_TABLE_COLUMNS,
  buildDigestTableRows,
  RANKING_TABLE_COLUMNS,
  buildRankingTableRows,
  buildReboundHighlightElements,
} from './smart-trend-labels.mjs';
import { fetchJson } from './proxy-setup.mjs';
import { loadSpotSymbols, hasSpotTrading } from './spot-symbol-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const STATE_FILE = join(DATA_DIR, 'smart-trend-state.json');
const DECISION_STATE_FILE = join(DATA_DIR, 'smart-trend-decision-state.json');
const MOCK_PUSH_FILE = join(DATA_DIR, 'smart-trend-push-mock.json');

let deps = null;
let running = false;
let digestTimer = null;
/** 已推送的50分 slot（ms），防止同一 slot 重复推送 */
let lastDigestPushSlotMs = 0;
/** @type {Map<string, object>} */
const lastState = new Map();
/** @type {{ last8amCaptureDateKey?: string }} */
let stateMeta = {};
/** @type {Record<string, object>} */
let decisionState = {};
let saveQueue = Promise.resolve();
let decisionSaveQueue = Promise.resolve();

function getShanghaiParts(date = new Date()) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)) {
    parts[type] = value;
  }
  return parts;
}

/** ICU h24 在部分 Linux 环境会将 00:xx 显示为 hour=24，需归一化为 0-23 */
function getShanghaiHour(date = new Date()) {
  const hour = parseInt(getShanghaiParts(date).hour, 10);
  return hour === 24 ? 0 : hour;
}

export function getNextHourShanghai(now = new Date()) {
  const p = getShanghaiParts(now);
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  const hour = getShanghaiHour(now);

  const currentSlot = new Date(`${dateKey}T${String(hour).padStart(2, '0')}:50:00+08:00`);
  if (currentSlot.getTime() > now.getTime() + 500) return currentSlot;

  const nextHour = hour + 1;
  if (nextHour < 24) {
    return new Date(`${dateKey}T${String(nextHour).padStart(2, '0')}:50:00+08:00`);
  }
  const nextDay = new Date(`${dateKey}T00:50:00+08:00`);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay;
}

export function getCurrentHourSlotShanghai(now = new Date()) {
  const p = getShanghaiParts(now);
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  const hour = getShanghaiHour(now);
  return new Date(`${dateKey}T${String(hour).padStart(2, '0')}:50:00+08:00`).getTime();
}

function sortByRatioChange(rows, tieBreakFn) {
  return rows.sort((a, b) => {
    const hasA = a.ratioDeltaPct != null;
    const hasB = b.ratioDeltaPct != null;
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    const absDiff = Math.abs(b.ratioDeltaPct ?? 0) - Math.abs(a.ratioDeltaPct ?? 0);
    if (absDiff !== 0) return absDiff;
    return tieBreakFn(a, b);
  });
}

async function loadPersistedState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj._meta && typeof obj._meta === 'object') {
      stateMeta = obj._meta;
    }
    for (const [sym, state] of Object.entries(obj)) {
      if (sym === '_meta') continue;
      if (state && typeof state === 'object') {
        lastState.set(sym.toUpperCase(), state);
      }
    }
  } catch {
    // 首次运行
  }
}

function queueSaveState() {
  saveQueue = saveQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ _meta: stateMeta, ...Object.fromEntries(lastState) }), 'utf8');
  }).catch(() => {});
}

async function loadDecisionState() {
  try {
    const raw = await readFile(DECISION_STATE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    decisionState = obj?.symbols && typeof obj.symbols === 'object' ? obj.symbols : obj;
  } catch {
    decisionState = {};
  }
}

function queueSaveDecisionState(nextState) {
  decisionState = nextState || {};
  decisionSaveQueue = decisionSaveQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(DECISION_STATE_FILE, JSON.stringify({
      updatedAt: Date.now(),
      symbols: decisionState,
    }), 'utf8');
  }).catch(() => {});
}

async function seedFromWhaleHistory(symbol) {
  if (!deps?.getWhaleHistory) return;
  const sym = symbol.toUpperCase();
  if (lastState.get(sym)?.initialized) return;

  try {
    const hist = await deps.getWhaleHistory(sym, 72);
    const points = hist?.points || [];
    if (!points.length) return;
    const last = points[points.length - 1];
    const ratio = parseFloat(last.longShortRatio) || 0;
    const rawLike = {
      longShortRatio: ratio,
      longProfitTraders: last.longTraders || 0,
      shortProfitTraders: last.shortTraders || 0,
      longWhalesQty: last.longWhalesQty || 0,
      shortWhalesQty: last.shortWhalesQty || 0,
      longProfitWhales: last.longProfitWhales || 0,
      shortProfitWhales: last.shortProfitWhales || 0,
      longWhalesAvgEntryPrice: last.longWhalesAvgEntryPrice || 0,
      shortWhalesAvgEntryPrice: last.shortWhalesAvgEntryPrice || 0,
    };
    const analysis = analyzeSmartSignal(rawLike, last.price || null);
    lastState.set(sym, {
      score: analysis.score,
      direction: analysis.direction,
      ratio: analysis.ratio,
      initialized: true,
    });
    queueSaveState();
  } catch {}
}

export function onWatchlistUpdated(newSymbols, prevSymbols) {
  const newSet = new Set(newSymbols.map(s => s.toUpperCase()));
  const prevSet = new Set((prevSymbols || []).map(s => s.toUpperCase()));
  for (const sym of [...lastState.keys()]) {
    if (!newSet.has(sym)) lastState.delete(sym);
  }
  for (const sym of newSet) {
    if (!prevSet.has(sym)) lastState.delete(sym);
  }
  queueSaveState();
}

function resolveWatchSymbols() {
  if (typeof deps?.getWatchSymbols === 'function') return deps.getWatchSymbols();
  return deps?.watchSymbols;
}

export async function initSmartTrendMonitor(dependencies) {
  deps = dependencies;
  await loadPersistedState();
  await loadDecisionState();
  for (const sym of resolveWatchSymbols() || []) {
    registerActiveSymbol(sym);
    if (!lastState.has(sym.toUpperCase())) {
      await seedFromWhaleHistory(sym);
    }
  }
}

function getBaseline8amDateKey(now = new Date()) {
  const p = getShanghaiParts(now);
  const hour = parseInt(p.hour, 10);
  let base = new Date(`${p.year}-${p.month}-${p.day}T08:00:00+08:00`);
  if (hour < 8) base.setDate(base.getDate() - 1);
  const bp = getShanghaiParts(base);
  return `${bp.year}-${bp.month}-${bp.day}`;
}

function getRatio8amOpenTime(now = new Date()) {
  const p = getShanghaiParts(now);
  const hour = parseInt(p.hour, 10);
  let base = new Date(`${p.year}-${p.month}-${p.day}T08:00:00+08:00`);
  if (hour < 8) base.setDate(base.getDate() - 1);
  return base.getTime();
}

function findRatioNear8am(points, openTime) {
  const window = (points || []).filter(p => p.ts >= openTime - 45 * 60000 && p.ts <= openTime + 120 * 60000);
  if (!window.length) return null;
  const closest = window.reduce((a, b) => (Math.abs(a.ts - openTime) < Math.abs(b.ts - openTime) ? a : b));
  const ratio = closest.longShortRatio;
  return ratio > 0 ? ratio : null;
}

function ensureRatio8amBaseline(row, dateKey, whaleBulk, openTime) {
  const prev = lastState.get(row.symbol) || {};
  if (prev.ratio8amDateKey === dateKey && prev.ratio8am > 0) {
    return prev.ratio8am;
  }

  let ratio8am = null;
  let source = 'startup';

  if (stateMeta.last8amCaptureDateKey === dateKey) {
    ratio8am = findRatioNear8am(whaleBulk[row.symbol], openTime);
    if (ratio8am) source = 'whale';
  }

  if (!ratio8am && row.ratio > 0) {
    ratio8am = row.ratio;
    source = 'startup';
  }

  if (ratio8am) {
    lastState.set(row.symbol, {
      ...prev,
      ratio8am,
      ratio8amDateKey: dateKey,
      ratio8amSource: source,
      whaleGlobalRatio8am: row.whaleGlobalRatio ?? prev.whaleGlobalRatio ?? null,
      longHints8am: prev.hintCountDateKey === dateKey ? (prev.longHints8am || 0) : 0,
      shortHints8am: prev.hintCountDateKey === dateKey ? (prev.shortHints8am || 0) : 0,
      hintCountDateKey: dateKey,
    });
  }
  return ratio8am;
}

async function attachRatio8amDeltas(rows) {
  if (!rows.length) return rows;
  const dateKey = getBaseline8amDateKey();
  const openTime = getRatio8amOpenTime();
  const symbols = rows.map(r => r.symbol);
  const whaleBulk = deps?.getWhaleHistoryBulk
    ? await deps.getWhaleHistoryBulk(symbols, 24).catch(() => ({}))
    : {};

  for (const row of rows) {
    const ratio8am = ensureRatio8amBaseline(row, dateKey, whaleBulk, openTime);
    row.ratio8am = ratio8am;
    row.ratio8amDeltaPct = ratio8am && ratio8am > 0
      ? ((row.ratio - ratio8am) / ratio8am) * 100
      : null;
    // 大户/全网比值的 8am 基准与变化
    const prevState = lastState.get(row.symbol);
    if (row.whaleGlobalRatio != null && prevState?.whaleGlobalRatio8am != null && prevState.whaleGlobalRatio8am > 0) {
      row.whaleGlobalRatio8am = prevState.whaleGlobalRatio8am;
      row.whaleGlobalRatio8amDeltaPct = ((row.whaleGlobalRatio - prevState.whaleGlobalRatio8am) / prevState.whaleGlobalRatio8am) * 100;
    }
  }
  queueSaveState();
  return rows;
}

/** 分档计分阈值：≥35% → 3分，≥15% → 2分，≥5% → 1分 */
const HINTS_TIERS = [
  { min: 35, score: 3 },
  { min: 15, score: 2 },
  { min: 5,  score: 1 },
];

function hintTierScore(absPct) {
  for (const { min, score } of HINTS_TIERS) {
    if (absPct >= min) return score;
  }
  return 0;
}

function recordHints8amCounts(rows) {
  const dateKey = getBaseline8amDateKey();
  for (const row of rows) {
    const prev = lastState.get(row.symbol) || {};
    let longC = prev.hintCountDateKey === dateKey ? (prev.longHints8am || 0) : 0;
    let shortC = prev.hintCountDateKey === dateKey ? (prev.shortHints8am || 0) : 0;
    const pct = row.ratioDeltaPct;
    if (pct != null && !Number.isNaN(pct)) {
      const tier = hintTierScore(Math.abs(pct));
      if (tier > 0) {
        if (pct > 0) longC += tier;
        else shortC += tier;
      }
    }
    // 大户/全网多空比 变化也计入推荐计分
    const wgPct = row.whaleGlobalRatioDeltaPct;
    if (wgPct != null && !Number.isNaN(wgPct)) {
      const tier = hintTierScore(Math.abs(wgPct));
      if (tier > 0) {
        if (wgPct > 0) longC += tier;
        else shortC += tier;
      }
    }
    row.hints8amLabel = formatHints8amScore(longC, shortC);
    row.hints8amScore = longC - shortC;
    lastState.set(row.symbol, {
      ...lastState.get(row.symbol),
      longHints8am: longC,
      shortHints8am: shortC,
      hints8amScore: longC - shortC,
      hintCountDateKey: dateKey,
      hints8amUpdatedAt: Date.now(),
    });
  }
  queueSaveState();
}

/** 每日 08:00 上海：将当前聪明钱比值设为 8 点基准，并重置推荐计数 */
export async function captureDaily8amRatioBaseline(symbols) {
  const dateKey = getBaseline8amDateKey();
  let updated = 0;
  for (const sym of symbols) {
    const upper = sym.toUpperCase();
    try {
      const row = await scanSymbolForDigest(upper);
      lastState.set(upper, {
        ...(lastState.get(upper) || {}),
        ratio8am: row.ratio,
        ratio8amDateKey: dateKey,
        ratio8amSource: '8am',
        whaleGlobalRatio8am: row.whaleGlobalRatio ?? null,
        longHints8am: 0,
        shortHints8am: 0,
        hints8amScore: 0,
        hintCountDateKey: dateKey,
      });
      updated += 1;
    } catch {}
  }
  stateMeta.last8amCaptureDateKey = dateKey;
  queueSaveState();
  console.log(`  📸 8点聪明钱基准已更新: ${updated}/${symbols.length} 个 (${dateKey})`);
}

async function scanSymbolForDigest(symbol) {
  const sym = symbol.toUpperCase();
  registerActiveSymbol(sym);

  const [raw, topPosArr, globalRatioArr] = await Promise.all([
    fetchSmartSignal(sym),
    fetchJson(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=1`).catch(() => null),
    fetchJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`).catch(() => null),
  ]);

  const price = parseFloat(raw?.lastPrice) || 0;
  const analysis = analyzeSmartSignal(raw, price);
  const prev = lastState.get(sym);

  // 计算大户 vs 散户背离度
  const topPos = Array.isArray(topPosArr) && topPosArr.length > 0 ? topPosArr[topPosArr.length - 1] : null;
  const globalRatio = Array.isArray(globalRatioArr) && globalRatioArr.length > 0 ? globalRatioArr[globalRatioArr.length - 1] : null;
  const whaleRatio = topPos ? parseFloat(topPos.longShortRatio) : null;
  const globalRatioVal = globalRatio ? parseFloat(globalRatio.longShortRatio) : null;
  let divergence = null;
  if (whaleRatio != null && globalRatioVal != null &&
      !Number.isNaN(whaleRatio) && !Number.isNaN(globalRatioVal)) {
    divergence = whaleRatio - globalRatioVal;
  }

  // 计算大户持仓多空比 / 全网多空人数比
  const whaleGlobalRatio = whaleRatio != null && globalRatioVal != null && globalRatioVal > 0
    ? whaleRatio / globalRatioVal
    : null;

  const ratioDeltaPct = prev?.initialized && prev.ratio > 0
    ? ((analysis.ratio - prev.ratio) / prev.ratio) * 100
    : null;

  const whaleRatioDeltaPct = prev?.initialized && prev.whaleRatio != null && prev.whaleRatio > 0 && whaleRatio != null
    ? ((whaleRatio - prev.whaleRatio) / prev.whaleRatio) * 100
    : null;

  const whaleGlobalRatioDeltaPct = prev?.initialized && prev.whaleGlobalRatio != null && prev.whaleGlobalRatio > 0 && whaleGlobalRatio != null
    ? ((whaleGlobalRatio - prev.whaleGlobalRatio) / prev.whaleGlobalRatio) * 100
    : null;

  lastState.set(sym, {
    ...(prev || {}),
    score: analysis.score,
    direction: analysis.direction,
    prevRatio: prev?.initialized ? prev.ratio : null,
    ratio: analysis.ratio,
    prevWhaleRatio: prev?.initialized ? prev.whaleRatio ?? null : null,
    whaleRatio,
    globalRatio: globalRatioVal,
    divergence,
    whaleGlobalRatio,
    prevWhaleGlobalRatio: prev?.initialized ? prev.whaleGlobalRatio ?? null : null,
    initialized: true,
  });
  queueSaveState();

  return {
    symbol: sym,
    label: sym.replace(/USDT$/, ''),
    badge: analysis.badge,
    direction: analysis.direction,
    ratio: analysis.ratio,
    prevRatio: prev?.initialized ? prev.ratio : null,
    ratioDeltaPct,
    price,
    whaleRatio,
    prevWhaleRatio: prev?.initialized ? prev.whaleRatio ?? null : null,
    whaleRatioDeltaPct,
    globalRatio: globalRatioVal,
    whaleGlobalRatio,
    prevWhaleGlobalRatio: prev?.initialized ? prev.whaleGlobalRatio ?? null : null,
    whaleGlobalRatioDeltaPct,
    divergence,
  };
}

function fmtDigestPrice(p) {
  if (!p || p <= 0) return '-';
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(3);
}

function priceChangeLabel(prev, cur) {
  if (!cur || cur <= 0) return '-';
  const curStr = fmtDigestPrice(cur);
  if (prev != null && prev > 0) return `${fmtDigestPrice(prev)}→${curStr}`;
  return curStr;
}

function finalizeMarketState(rows) {
  for (const r of rows) {
    const cur = lastState.get(r.symbol) || {};
    r.prevPrice = cur.initialized && cur.price > 0 ? cur.price : null;
    r.prevFundingRate = cur.initialized && cur.fundingRate != null ? cur.fundingRate : null;
    if (r.prevPrice != null && r.prevPrice > 0 && r.price > 0) {
      r.priceDeltaPct = ((r.price - r.prevPrice) / r.prevPrice) * 100;
    } else {
      r.priceDeltaPct = null;
    }
    if (r.fundingRate != null && r.prevFundingRate != null) {
      const diff = r.fundingRate - r.prevFundingRate;
      r.fundingDeltaPct = r.prevFundingRate !== 0
        ? (diff / Math.abs(r.prevFundingRate)) * 100
        : (diff * 10000);
    }
    lastState.set(r.symbol, {
      ...cur,
      price: r.price > 0 ? r.price : cur.price ?? null,
      fundingRate: r.fundingRate ?? cur.fundingRate ?? null,
    });
  }
  queueSaveState();
  return rows;
}

function buildPinnedBoardRows(pinned, enrichedMap) {
  return (pinned || [])
    .map(sym => {
      const row = enrichedMap.get(sym.toUpperCase());
      if (!row) return null;
      return { ...row, change8am: row.change8am ?? 0, change24h: row.change24h ?? 0, pinned: true };
    })
    .filter(Boolean);
}

function fmtPriceChangePct(v) {
  if (v == null || Number.isNaN(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

const DIGEST_TABLE_MAX_ROWS = 15;
const RANKING_TABLE_MAX_ROWS = 50;
const RANKING_TABLE_PAGE_SIZE = 20; // 50 行约 3 页
/** 榜单汇总最低 24h 成交额（USDT），0 表示不过滤 */
export const DEFAULT_MIN_RANKING_VOLUME_24H = 10_000_000;
/** 榜单汇总最高市值（USDT），超过此值不收录 */
export const MAX_RANKING_MARKET_CAP = 8_000_000_000;

function rowVolume24h(row) {
  const v = row?.volume24h ?? row?.volumeRank;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rowMarketCap(row) {
  if (row?.marketCap != null && Number.isFinite(row.marketCap)) return row.marketCap;
  return null;
}

function fmtVolumeThreshold(usd) {
  if (usd >= 1e8) return `${(usd / 1e8).toFixed(usd % 1e8 === 0 ? 0 : 1)}亿$`;
  if (usd >= 1e4) return `${Math.round(usd / 1e4)}万$`;
  return `${usd}$`;
}

function buildVolumeLookup(enriched, boards) {
  const map = new Map();
  for (const row of enriched || []) {
    const vol = rowVolume24h(row);
    if (vol != null) map.set(row.symbol.toUpperCase(), vol);
  }
  for (const board of boards || []) {
    for (const row of board.rows || []) {
      const vol = rowVolume24h(row);
      if (vol != null) map.set(row.symbol.toUpperCase(), vol);
    }
  }
  return map;
}

function buildMcLookup(enriched, boards) {
  const map = new Map();
  for (const row of enriched || []) {
    const mc = rowMarketCap(row);
    if (mc != null) map.set(row.symbol.toUpperCase(), mc);
  }
  for (const board of boards || []) {
    for (const row of board.rows || []) {
      const mc = rowMarketCap(row);
      if (mc != null) map.set(row.symbol.toUpperCase(), mc);
    }
  }
  return map;
}

function meetsRankingVolume(row, volumeLookup, minVolume) {
  if (!minVolume || minVolume <= 0) return true;
  const vol = rowVolume24h(row) ?? volumeLookup.get(row.symbol?.toUpperCase());
  return vol != null && vol >= minVolume;
}

function meetsRankingMc(row, mcLookup, maxMc) {
  if (!maxMc || maxMc <= 0) return true;
  const mc = rowMarketCap(row) ?? mcLookup.get(row.symbol?.toUpperCase());
  return mc == null || mc <= maxMc;
}

function dedupeRowsBySymbol(rows) {
  const map = new Map();
  for (const row of rows) {
    const sym = row.symbol?.toUpperCase();
    if (!sym) continue;
    const existing = map.get(sym);
    if (!existing) {
      map.set(sym, row);
    } else if (Array.isArray(row.sources)) {
      if (!Array.isArray(existing.sources)) existing.sources = [];
      for (const s of row.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
    }
  }
  return [...map.values()];
}

function buildDigestTableSection(rows, highlightPct, {
  title = '',
  subtitle = '',
  pageSize,
  maxRows,
  showPinIcon = true,
  columns = DIGEST_TABLE_COLUMNS,
  buildRows = buildDigestTableRows,
} = {}) {
  const displayRows = rows.slice(0, maxRows ?? rows.length);
  if (!displayRows.length) return [];

  const elements = [];
  const header = [title, subtitle].filter(Boolean).join('\n');
  if (header) {
    elements.push({ tag: 'markdown', content: header });
  }

  const tableRows = buildRows(displayRows, highlightPct, { showPinIcon });
  elements.push({
    tag: 'table',
    page_size: pageSize ?? tableRows.length,
    row_height: 'low',
    freeze_first_column: true,
    columns,
    rows: tableRows,
  });
  return elements;
}

export function computeMarketOutlook(rows, warnPct = RATIO_WARN_PCT, divergenceThreshold = 0.25) {
  let shiftLong1h = 0;
  let shiftShort1h = 0;
  let nLong1h = 0;
  let nShort1h = 0;
  let shiftLong8am = 0;
  let shiftShort8am = 0;
  let nLong8am = 0;
  let nShort8am = 0;
  let curLong = 0;
  let curShort = 0;
  let curNeutral = 0;
  let divergenceCount = 0;
  let maxDivergence = 0;
  let maxDivergenceSymbol = '';
  let maxDivergenceWhaleRatio = null;
  let maxDivergenceGlobalRatio = null;

  for (const r of rows) {
    if (r.direction === 'long') curLong += 1;
    else if (r.direction === 'short') curShort += 1;
    else curNeutral += 1;

    const d1 = r.ratioDeltaPct;
    if (d1 != null && !Number.isNaN(d1)) {
      if (d1 >= warnPct) {
        shiftLong1h += d1;
        nLong1h += 1;
      } else if (d1 <= -warnPct) {
        shiftShort1h += Math.abs(d1);
        nShort1h += 1;
      }
    }

    const d8 = r.ratio8amDeltaPct;
    if (d8 != null && !Number.isNaN(d8)) {
      if (d8 >= warnPct) {
        shiftLong8am += d8;
        nLong8am += 1;
      } else if (d8 <= -warnPct) {
        shiftShort8am += Math.abs(d8);
        nShort8am += 1;
      }
    }

    // 大户 vs 散户背离检测
    if (r.divergence != null && !Number.isNaN(r.divergence) &&
        r.divergence >= divergenceThreshold &&
        r.whaleRatio != null && r.whaleRatio > 1.0 &&
        r.globalRatio != null && r.globalRatio < 0.9) {
      divergenceCount++;
      if (r.divergence > maxDivergence) {
        maxDivergence = r.divergence;
        maxDivergenceSymbol = r.label;
        maxDivergenceWhaleRatio = r.whaleRatio;
        maxDivergenceGlobalRatio = r.globalRatio;
      }
    }
  }

  let verdict;
  let advice;
  let template;
  if (nLong1h > nShort1h) {
    verdict = '📈 当前总体偏做多';
    advice = `1h 内变多 ${nLong1h} 个 > 变少 ${nShort1h} 个，聪明钱整体在向多头转移。`;
    template = 'green';
  } else if (nLong1h < nShort1h) {
    verdict = '📉 当前总体偏做空';
    advice = `1h 内变少 ${nShort1h} 个 > 变多 ${nLong1h} 个，聪明钱整体在向空头转移。`;
    template = 'red';
  } else if (nLong8am > nShort8am) {
    verdict = '📈 当前总体偏做多';
    advice = `1h 变多/变少持平；8am 以来变多 ${nLong8am} 个 > 变少 ${nShort8am} 个。`;
    template = 'green';
  } else if (nLong8am < nShort8am) {
    verdict = '📉 当前总体偏做空';
    advice = `1h 变多/变少持平；8am 以来变少 ${nShort8am} 个 > 变多 ${nLong8am} 个。`;
    template = 'red';
  } else {
    verdict = '⚖️ 多空均衡 · 观望';
    advice = '变多/变少数量接近，方向尚不明朗。';
    template = 'blue';
  }

  const topLong = rows
    .filter(r => r.ratioDeltaPct != null && r.ratioDeltaPct >= warnPct)
    .sort((a, b) => b.ratioDeltaPct - a.ratioDeltaPct)
    .slice(0, 5);
  const topShort = rows
    .filter(r => r.ratioDeltaPct != null && r.ratioDeltaPct <= -warnPct)
    .sort((a, b) => a.ratioDeltaPct - b.ratioDeltaPct)
    .slice(0, 5);

  return {
    verdict,
    advice,
    template,
    nLong1h,
    nShort1h,
    nLong8am,
    nShort8am,
    curLong,
    curShort,
    curNeutral,
    shiftLong1h,
    shiftShort1h,
    shiftLong8am,
    shiftShort8am,
    topLong,
    topShort,
    divergenceCount,
    maxDivergence,
    maxDivergenceSymbol,
    maxDivergenceWhaleRatio,
    maxDivergenceGlobalRatio,
  };
}

function buildMarketOutlookElements(rows, outlook, { intervalMin = 60, highlightPct = 10, merged = false } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const flat1h = rows.length - outlook.nLong1h - outlook.nShort1h;
  const flat8am = rows.length - outlook.nLong8am - outlook.nShort8am;

  const lines = merged
    ? ['**🎯 总体行情研判**']
    : [`**⏰ ${now}** · 监控池 ${rows.length} 个 · 近 ${intervalMin}min 扫描`];
  lines.push(
    '',
    '_判断标准：比较多空比「变多」与「变少」的币种数量（≥5% 为有效变化）_',
    '',
    '**📊 1h 聪明钱变化（相对上次推送）**',
    `1. 变多 **${outlook.nLong1h}** 个 · 累计 ${ratioDeltaLabel(outlook.shiftLong1h)}`,
    `2. 变少 **${outlook.nShort1h}** 个 · 累计 ${ratioDeltaLabel(-outlook.shiftShort1h)}`,
    `3. 持平/微动 **${Math.max(0, flat1h)}** 个`,
    '',
    '**📊 8am 以来聪明钱变化**',
    `1. 变多 **${outlook.nLong8am}** 个 · 累计 ${ratioDeltaLabel(outlook.shiftLong8am)}`,
    `2. 变少 **${outlook.nShort8am}** 个 · 累计 ${ratioDeltaLabel(-outlook.shiftShort8am)}`,
    `3. 持平/微动 **${Math.max(0, flat8am)}** 个`,
    '',
    '**🧭 当前聪明钱持仓倾向（参考）**',
    `1. 偏多 **${outlook.curLong}** 个`,
    `2. 偏空 **${outlook.curShort}** 个`,
    `3. 中性 **${outlook.curNeutral}** 个`,
    '',
    `**🎯 综合判断:** ${outlook.verdict}`,
    `${outlook.advice}`,
  );

  if (outlook.topLong.length) {
    lines.push('', `**⚡ 变多最显著 Top${outlook.topLong.length}:**`, '_净多空比≤1 不宜追多_');
    outlook.topLong.forEach((r, i) => {
      lines.push(`${i + 1}. ${formatTopMoveItem(r, highlightPct)}`);
    });
  }
  if (outlook.topShort.length) {
    lines.push('', `**⚡ 变少最显著 Top${outlook.topShort.length}:**`);
    outlook.topShort.forEach((r, i) => {
      lines.push(`${i + 1}. ${formatTopMoveItem(r, highlightPct)}`);
    });
  }

  // 大户 vs 散户背离统计
  if (outlook.divergenceCount > 0) {
    lines.push('', '**📊 大户 vs 散户背离**');
    lines.push(`1. 背离信号 **${outlook.divergenceCount}** 个 · 大户偏多+散户偏空`);
    if (outlook.maxDivergenceSymbol) {
      const whaleStr = outlook.maxDivergenceWhaleRatio != null ? outlook.maxDivergenceWhaleRatio.toFixed(2) : '?';
      const globalStr = outlook.maxDivergenceGlobalRatio != null ? outlook.maxDivergenceGlobalRatio.toFixed(2) : '?';
      lines.push(`2. 最显著: ${outlook.maxDivergenceSymbol} 大户${whaleStr} vs 散户${globalStr} (背离${outlook.maxDivergence.toFixed(2)})`);
    }
  }

  return [{ tag: 'markdown', content: lines.join('\n') }];
}

/** 单板块元素（表格 + 显著变化列表） */
function buildBoardSectionElements(rows, {
  boardLabel = '涨幅榜',
  highlightPct = 10,
  topN = 30,
  merged = false,
  dateKey = '',
  showPinIcon = true,
  columns = DIGEST_TABLE_COLUMNS,
  buildRows = buildDigestTableRows,
} = {}) {
  const displayRows = rows.slice(0, DIGEST_TABLE_MAX_ROWS);
  const bigMoves = displayRows
    .filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct)
    .sort((a, b) => Math.abs(b.ratioDeltaPct) - Math.abs(a.ratioDeltaPct));

  const elements = [];
  if (merged) {
    const bigNote = bigMoves.length ? ` · ${bigMoves.length}个≥${highlightPct}%变化` : '';
    const topNote = topN ? `Top${Math.min(topN, DIGEST_TABLE_MAX_ROWS)}` : '';
    elements.push({
      tag: 'markdown',
      content: `**${boardLabel}** · ${displayRows.length} 个${topNote ? ` · ${topNote}` : ''}${bigNote}`,
    });
  } else {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    elements.push({
      tag: 'markdown',
      content: `**⏰ ${now}**\n**${boardLabel}** · ${displayRows.length} 个${dateKey ? ` · ${dateKey}` : ''}\n_净多空比含 1h|8am 聪明钱变化 · 8am推=当日1h净多空比分档累计(≥5%→1分,≥15%→2分,≥35%→3分) · 价格先显示变化比例、悬停看价位详情 · 参考=基于8amΔ_`,
    });
  }

  if (bigMoves.length > 0) {
    const listLines = bigMoves.map((r, i) =>
      `${i + 1}. **${r.label}** ${ratioDeltaDisplay(r.ratioDeltaPct, highlightPct)} ${tradeHintLabel(r.ratioDeltaPct, highlightPct)}`,
    ).join('\n');
    elements.push({
      tag: 'markdown',
      content: `**⚡ 聪明钱显著变化:**\n${listLines}`,
    });
  }

  const tableRows = buildRows(displayRows, highlightPct, { showPinIcon });
  elements.push({
    tag: 'table',
    page_size: tableRows.length,
    row_height: 'low',
    freeze_first_column: true,
    columns,
    rows: tableRows,
  });

  return elements;
}

export function buildMergedSmartTrendElements({
  boards,
  outlook,
  enriched,
  intervalMin,
  highlightPct,
  dateKey,
  minRankingVolume24h = DEFAULT_MIN_RANKING_VOLUME_24H,
  reboundHighlights = [],
} = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const pinnedBoard = boards.find(b => b.key === 'pinned');
  const rankingBoards = boards.filter(b => b.key !== 'pinned');
  const pinnedRows = pinnedBoard?.rows ?? [];
  const pinnedSet = new Set(pinnedRows.map(r => r.symbol.toUpperCase()));

  const volumeLookup = buildVolumeLookup(enriched, rankingBoards);
  const mcLookup = buildMcLookup(enriched, rankingBoards);
  const mergedAll = dedupeRowsBySymbol(
    rankingBoards.flatMap(b => (b.rows || []).map(r => ({
      ...r,
      sources: Array.isArray(r.sources) && r.sources.length ? r.sources : [b.key],
    })))
      .filter(r => !pinnedSet.has(r.symbol.toUpperCase())),
  );
  const mergedRanking = mergedAll.filter(r =>
    meetsRankingVolume(r, volumeLookup, minRankingVolume24h)
    && meetsRankingMc(r, mcLookup, MAX_RANKING_MARKET_CAP)
  );
  const rankingRows = [...mergedRanking].sort((a, b) => {
      const sa = Math.abs(a.hints8amScore ?? 0);
      const sb = Math.abs(b.hints8amScore ?? 0);
      if (sb !== sa) return sb - sa;
      return (b.ratio ?? 0) - (a.ratio ?? 0);
    });
  const rankingDisplay = rankingRows.slice(0, RANKING_TABLE_MAX_ROWS);
  const rankingPageSize = RANKING_TABLE_PAGE_SIZE;
  const pinLabels = pinnedRows.map(r => r.label).join(', ');
  const totalFiltered = mergedAll.length - mergedRanking.length;

  const elements = [{
    tag: 'markdown',
    content: `**⏰ ${now}** · 聪明钱全池摘要 · 近 ${intervalMin}min${dateKey ? ` · ${dateKey}` : ''}\n_净多空比含 1h|8am 聪明钱变化 · 8am推=当日1h净多空比分档累计(≥5%→1分,≥15%→2分,≥35%→3分) · 价格先显示变化比例、悬停看价位详情 · 参考=基于8amΔ_`,
  }];

  // ⚡ 急跌反弹观察高亮区块（放在固定监控之前）
  if (reboundHighlights.length) {
    elements.push(...buildReboundHighlightElements(reboundHighlights));
  }

  if (pinnedRows.length) {
    elements.push(...buildDigestTableSection(pinnedRows, highlightPct, {
      title: `**📌 固定监控** · ${pinnedRows.length} 个${pinLabels ? ` · ${pinLabels}` : ''}`,
      pageSize: pinnedRows.length,
      showPinIcon: false,
      columns: RANKING_TABLE_COLUMNS,
      buildRows: buildRankingTableRows,
    }));
  }

  if (rankingDisplay.length) {
    const volumeRule = minRankingVolume24h > 0
      ? ` · 24h成交额≥${fmtVolumeThreshold(minRankingVolume24h)}`
      : '';
    const mcRule = ` · 市值≤80亿$`;
    elements.push(...buildDigestTableSection(rankingDisplay, highlightPct, {
      title: `**📊 榜单汇总** · 去重 ${mergedRanking.length} 个 · Top${rankingDisplay.length} · 已排除 ${totalFiltered} 个`,
      subtitle: `_涨幅/跌幅/右侧/交易额榜合并去重${volumeRule}${mcRule} · 按8am推积分绝对值从高到低排序 · 同分按净多空比排序 · ${rankingPageSize} 行/页_`,
      pageSize: rankingPageSize,
      maxRows: RANKING_TABLE_MAX_ROWS,
      columns: RANKING_TABLE_COLUMNS,
      buildRows: buildRankingTableRows,
    }));
  }

  elements.push(...buildMarketOutlookElements(enriched, outlook, { intervalMin, highlightPct, merged: true }));
  return elements;
}

/** 涨幅榜 / 跌幅榜 单张卡片（表格内置分页） */
export function buildBoardDigestElements(rows, options = {}) {
  return buildBoardSectionElements(rows, options);
}

function serializePushRow(r) {
  return {
    symbol: r.symbol,
    label: r.label,
    badge: r.badge,
    direction: r.direction,
    ratio: r.ratio,
    prevRatio: r.prevRatio ?? null,
    ratioDeltaPct: r.ratioDeltaPct ?? null,
    ratio8am: r.ratio8am ?? null,
    ratio8amDeltaPct: r.ratio8amDeltaPct ?? null,
    change24h: r.change24h ?? null,
    change8am: r.change8am ?? null,
    price: r.price ?? null,
    prevPrice: r.prevPrice ?? null,
    price8am: r.price8am ?? null,
    priceDeltaPct: r.priceDeltaPct ?? null,
    fundingRate: r.fundingRate ?? null,
    prevFundingRate: r.prevFundingRate ?? null,
    fundingDeltaPct: r.fundingDeltaPct ?? null,
    hints8amLabel: r.hints8amLabel ?? null,
    hints8amScore: r.hints8amScore ?? null,
    marketCapLabel: r.marketCapLabel ?? null,
    pinned: r.pinned ?? false,
    volumeRank: r.volumeRank ?? null,
    volume24h: r.volume24h ?? rowVolume24h(r),
    whaleRatio: r.whaleRatio ?? null,
    prevWhaleRatio: r.prevWhaleRatio ?? null,
    whaleRatioDeltaPct: r.whaleRatioDeltaPct ?? null,
    whaleGlobalRatio: r.whaleGlobalRatio ?? null,
    prevWhaleGlobalRatio: r.prevWhaleGlobalRatio ?? null,
    whaleGlobalRatioDeltaPct: r.whaleGlobalRatioDeltaPct ?? null,
    whaleGlobalRatio8am: r.whaleGlobalRatio8am ?? null,
    whaleGlobalRatio8amDeltaPct: r.whaleGlobalRatio8amDeltaPct ?? null,
    globalRatio: r.globalRatio ?? null,
    divergence: r.divergence ?? null,
    hasSpot: r.hasSpot ?? null,
  };
}

async function savePushMock(snapshot) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MOCK_PUSH_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
}

export async function runSmartTrendPush({ force = false } = {}) {
  if (!deps?.enabled || !deps?.feishuEnabled || running) return;

  const slotMs = getCurrentHourSlotShanghai();
  if (!force && slotMs === lastDigestPushSlotMs) {
    console.log('  ⏭ 聪明钱50分推送跳过: 本小时已推送');
    return;
  }

  running = true;
  const intervalMin = deps.intervalMin ?? 60;
  const highlightPct = deps.ratioChangePct ?? 10;
  try {
    await deps.refreshWatchlist?.();
    const watchSymbolsAfterRefresh = resolveWatchSymbols();
    if (!watchSymbolsAfterRefresh?.size) return;

    const groups = deps.getWatchlistGroups?.() || { gainers: [], losers: [], dateKey: '', topN: 30 };
    console.log(`\n  📤 聪明钱全池扫描 (${watchSymbolsAfterRefresh.size} 个)...`);

    const rowMap = new Map();
    let failed = 0;

    // 限流并发扫描（Smart Signal 全局队列已自带 600ms 节流，这里并发主要重叠其它接口的网络等待）
    const scanStartAt = Date.now();
    const SCAN_CONCURRENCY = parseInt(process.env.SMART_TREND_SCAN_CONCURRENCY || '5', 10);
    const symList = [...watchSymbolsAfterRefresh];
    let scanIdx = 0;
    async function scanWorker() {
      while (scanIdx < symList.length) {
        const sym = symList[scanIdx++];
        try {
          const row = await scanSymbolForDigest(sym);
          rowMap.set(sym.toUpperCase(), row);
        } catch (e) {
          failed += 1;
          console.warn(`  ⚠ 聪明钱扫描 ${sym} 失败: ${e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, symList.length) }, () => scanWorker()));
    console.log(`  ✓ 全池扫描完成: ${rowMap.size} 成功 · ${failed} 失败 · 耗时 ${Math.round((Date.now() - scanStartAt) / 1000)}s`);

    if (!rowMap.size) {
      console.warn(`  ⚠ 聪明钱全池扫描: 全部失败，跳过推送`);
      return;
    }

    const allRows = [...rowMap.values()];
    await attachRatio8amDeltas(allRows);
    recordHints8amCounts(allRows);

    const enriched = deps.batchEnrichDigest
      ? await deps.batchEnrichDigest(allRows).catch(() => allRows)
      : allRows;
    finalizeMarketState(enriched);

    // 加载现货交易对信息，为每行标记是否有现货（在 enrichment 之后赋值，确保不被覆盖）
    await loadSpotSymbols().catch(() => {});
    for (const row of enriched) {
      row.hasSpot = hasSpotTrading(row.symbol);
    }

    const enrichedMap = new Map(enriched.map(r => [r.symbol, r]));

    const mapBoardList = (boardList) => boardList
      .map(({ symbol, change, pinned = false }) => {
        const row = enrichedMap.get(symbol.toUpperCase());
        if (!row) return null;
        return { ...row, change24h: row.change24h ?? change, change8am: row.change8am ?? change, pinned };
      })
      .filter(Boolean);

    const buildBoardRows = (boardList, tieBreakFn) => sortByRatioChange(
      mapBoardList(boardList),
      tieBreakFn,
    );

    /** 涨幅/跌幅榜：保持 watchlist 榜单位次，不按聪明钱变化重排 */
    const buildRankedBoardRows = (boardList) => mapBoardList(boardList);

    const pinnedSet = new Set((groups.pinned || []).map(s => s.toUpperCase()));
    const excludePinned = (list) => (list || []).filter(item => !pinnedSet.has(item.symbol.toUpperCase()));

    const gainerRows = buildRankedBoardRows(excludePinned(groups.gainers));
    const loserRows = buildRankedBoardRows(excludePinned(groups.losers));
    const pinnedRows = buildPinnedBoardRows(groups.pinned, enrichedMap);
    const pinLabels = (groups.pinned || []).map(s => s.replace(/USDT$/, '')).join(', ');

    const rightSideRows = buildBoardRows(
      (groups.rightSide || []).map(item => ({ symbol: item.symbol, change: item.change })),
      (a, b) => (b.change24h ?? b.change8am ?? 0) - (a.change24h ?? a.change8am ?? 0),
    );

    const volumeTopN = groups.volumeTopN ?? 50;
    const volumeRows = sortByRatioChange(
      (groups.volumeTop || [])
        .map(({ symbol, volume }) => {
          const row = enrichedMap.get(symbol.toUpperCase());
          if (!row) return null;
          return { ...row, volumeRank: volume, volume24h: volume };
        })
        .filter(Boolean),
      (a, b) => (b.volumeRank ?? 0) - (a.volumeRank ?? 0),
    );

    const boards = [];
    if (pinnedRows.length) {
      boards.push({
        key: 'pinned',
        label: `📌 固定监控${pinLabels ? ` · ${pinLabels}` : ''}`,
        rows: pinnedRows,
        template: 'blue',
      });
    }
    boards.push(
      { key: 'gainer', label: '📈 24h涨幅榜', rows: gainerRows, template: 'green' },
      { key: 'loser', label: '📉 24h跌幅榜', rows: loserRows, template: 'red' },
    );
    if (rightSideRows.length) {
      boards.push({
        key: 'rightSide',
        label: '📐 右侧交易',
        rows: rightSideRows,
        template: 'orange',
      });
    }
    if (volumeRows.length) {
      boards.push({
        key: 'volumeTop',
        label: `💰 24h交易额 Top${volumeTopN}`,
        rows: volumeRows,
        template: 'purple',
      });
    }

    // 收集每个币种在所有板块中的来源，回写到 row 上供标签列显示
    const symbolSources = new Map();
    for (const board of boards) {
      for (const row of board.rows) {
        const sym = row.symbol?.toUpperCase();
        if (!sym) continue;
        if (!symbolSources.has(sym)) symbolSources.set(sym, []);
        if (!symbolSources.get(sym).includes(board.key)) symbolSources.get(sym).push(board.key);
      }
    }
    for (const board of boards) {
      board.rows = board.rows.map(r => ({
        ...r,
        sources: symbolSources.get(r.symbol?.toUpperCase()) || [],
      }));
    }

    let sent = 0;
    const mergeCards = deps.mergeCards !== false;
    const outlook = computeMarketOutlook(enriched, undefined, deps.divergenceThreshold ?? 0.25);
    /** 加载已持仓币种，不推荐做多 */
    const heldSymbols = typeof deps.getHeldSymbols === 'function' ? await deps.getHeldSymbols() : new Set();
    const decisionPush = buildSmartTrendDecision({
      boards: boards.filter(b => b.rows.length),
      outlook,
      highlightPct,
      previousState: decisionState,
      divergenceThreshold: deps.divergenceThreshold ?? 0.25,
      reboundHighlightPct: deps.reboundHighlightPct ?? 15,
      heldSymbols,
    });
    queueSaveDecisionState(decisionPush.nextState);

    const totalCoins = gainerRows.length + loserRows.length + pinnedRows.length + rightSideRows.length + volumeRows.length;
    const totalBig = [...gainerRows, ...loserRows, ...pinnedRows, ...rightSideRows, ...volumeRows]
      .filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).length;

    await savePushMock({
      capturedAt: Date.now(),
      dateKey: groups.dateKey,
      mergeCards,
      highlightPct,
      intervalMin,
      watchlist: {
        gainers: groups.gainers,
        losers: groups.losers,
        pinned: groups.pinned,
        rightSide: groups.rightSide,
        volumeTop: groups.volumeTop,
        volumeTopN: groups.volumeTopN,
        topN: groups.topN,
      },
      boards: boards.map(b => ({
        key: b.key,
        label: b.label,
        template: b.template,
        rowCount: b.rows.length,
        rows: b.rows.map(serializePushRow),
      })),
      outlook,
      decisionPush: serializeSmartTrendDecision(decisionPush),
      stats: {
        totalCoins,
        totalBig,
        failed,
        symbolCount: watchSymbolsAfterRefresh.size,
      },
    });

    // === DB 存储 ===
    if (typeof deps.onDataReady === "function") {
      try {
        deps.onDataReady({ outlook, enrichedRows: enriched, decisionPush, poolSize: watchSymbolsAfterRefresh.size });
      } catch (e) { console.warn("  DB callback error:", e.message); }
    }

    if (deps.decisionEnabled && deps.sendDecisionCard) {
      try {
        const elements = buildSmartTrendDecisionElements(decisionPush, { highlightPct, heldSymbols });
        await deps.sendDecisionCard(
          `🎯 聪明钱操作清单 · ${decisionPush.summary.verdict}`,
          elements,
          decisionPush.summary.template,
        );
        console.log(`  ✓ 聪明钱操作清单已推送: 重点 ${decisionPush.action.length} · 观察 ${decisionPush.watch.length}`);
      } catch (e) {
        console.warn(`  ⚠ 聪明钱决策摘要推送失败: ${e.message}`);
      }
    }

    if (!deps.feishuEnabled) {
      console.log('  ⏭ 旧聪明钱榜单推送跳过: FEISHU_WEBHOOK 未配置');
    } else if (mergeCards) {
      const mergedElements = buildMergedSmartTrendElements({
        boards: boards.filter(b => b.rows.length),
        outlook,
        enriched,
        intervalMin,
        highlightPct,
        dateKey: groups.dateKey,
        minRankingVolume24h: deps.minRankingVolume24h ?? DEFAULT_MIN_RANKING_VOLUME_24H,
        reboundHighlights: decisionPush.reboundHighlights || [],
      });
      const verdictShort = outlook.verdict.replace(/^[^\s]+\s/, '');
      await deps.sendFeishuCard(`📊 聪明钱监控全览 · ${verdictShort}`, mergedElements, outlook.template);
      sent = 1;
    } else {
      for (const board of boards) {
        if (!board.rows.length) {
          console.warn(`  ⚠ ${board.label}: 无可用数据，跳过`);
          continue;
        }
        const bigCount = board.rows.filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).length;
        const elements = buildBoardDigestElements(board.rows, {
          boardLabel: board.label,
          highlightPct,
          dateKey: groups.dateKey,
          topN: groups.topN ?? 30,
          showPinIcon: board.key !== 'pinned',
          columns: RANKING_TABLE_COLUMNS,
          buildRows: buildRankingTableRows,
        });
        const title = (board.key === 'pinned' || board.key === 'rightSide' || board.key === 'volumeTop')
          ? (bigCount > 0 ? `${board.label} · ${bigCount}个聪明钱显著变化` : board.label)
          : (bigCount > 0
            ? `${board.label} · Top${groups.topN ?? 30} · ${bigCount}个聪明钱显著变化`
            : `${board.label} · Top${groups.topN ?? 30}`);
        await deps.sendFeishuCard(title, elements, board.template);
        sent += 1;
        await new Promise(r => setTimeout(r, 2500));
      }
      const outlookElements = buildMarketOutlookElements(enriched, outlook, { intervalMin, highlightPct });
      await deps.sendFeishuCard(`🎯 总体行情研判 · ${outlook.verdict.replace(/^[^\s]+\s/, '')}`, outlookElements, outlook.template);
      sent += 1;
    }

    const pinPart = pinnedRows.length ? ` + 固定 ${pinnedRows.length}` : '';
    const rightSidePart = rightSideRows.length ? ` + 右侧 ${rightSideRows.length}` : '';
    const volumePart = volumeRows.length ? ` + 交易额 ${volumeRows.length}` : '';
    const boardPart = `涨幅 ${gainerRows.length} + 跌幅 ${loserRows.length}${pinPart}${rightSidePart}${volumePart}`;
    const cardPart = mergeCards ? '1 张合并卡片' : `${sent} 张卡片(含研判)`;
    console.log(`  ✓ 聪明钱榜单推送: ${boardPart} · ${cardPart} · 共 ${totalCoins} 个 · ${totalBig} 个≥${highlightPct}%显著变化${failed ? ` · ${failed} 扫描失败` : ''} · ${outlook.verdict}`);
    lastDigestPushSlotMs = slotMs;
  } catch (e) {
    console.warn(`  ⚠ 聪明钱全池推送失败: ${e.message}`);
  } finally {
    running = false;
  }
}

export function startSmartTrendScheduler() {
  if (!deps?.enabled) return;
  if (digestTimer) clearTimeout(digestTimer);

  const intervalMin = deps.intervalMin ?? 60;
  const highlightPct = deps.ratioChangePct ?? 10;
  const syms = [...(resolveWatchSymbols() || [])];
  const watchLabel = syms.length > 10
    ? `${syms.slice(0, 10).map(s => s.replace(/USDT$/, '')).join(', ')} 等 ${syms.length} 个`
    : syms.map(s => s.replace(/USDT$/, '')).join(', ');

  const decisionNote = deps.decisionEnabled ? ' + 新决策摘要' : '';
  console.log(`  📊 聪明钱榜单推送: 上海时间每小时50分 · ${deps.mergeCards !== false ? '单卡合并(固定表+榜单表)' : '分卡推送'}${decisionNote} · 24h涨跌幅榜+交易额Top+固定+右侧+总体研判 · 监控 ${watchLabel || '（池为空）'}`);

  const scheduleNext = () => {
    const next = getNextHourShanghai();
    const delay = Math.max(0, next.getTime() - Date.now());
    const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  ⏭ 聪明钱下次推送: ${label}（${Math.round(delay / 60000)} 分钟后）`);
    digestTimer = setTimeout(async () => {
      await runSmartTrendPush();
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}
