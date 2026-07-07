/**
 * 聪明钱监控 · 每 30 分钟整点推送全池变化摘要（含变化幅度排序与做多/做空参考）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSmartSignal, analyzeSmartSignal } from './scan-smart-signal.mjs';
import { registerActiveSymbol } from './whale-history.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const STATE_FILE = join(DATA_DIR, 'smart-trend-state.json');

let deps = null;
let running = false;
let digestTimer = null;
/** @type {Map<string, { score: number, direction: string, ratio: number, initialized: boolean }>} */
const lastState = new Map();
let saveQueue = Promise.resolve();

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

export function getNextHalfHourShanghai(now = new Date()) {
  const p = getShanghaiParts(now);
  const dateKey = `${p.year}-${p.month}-${p.day}`;
  const hour = parseInt(p.hour, 10);
  const minute = parseInt(p.minute, 10);

  if (minute < 30) {
    return new Date(`${dateKey}T${String(hour).padStart(2, '0')}:30:00+08:00`);
  }
  const nextHour = hour + 1;
  if (nextHour < 24) {
    return new Date(`${dateKey}T${String(nextHour).padStart(2, '0')}:00:00+08:00`);
  }
  const nextDay = new Date(`${dateKey}T00:00:00+08:00`);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay;
}

const RATIO_WARN_PCT = 5;

function ratioDeltaLabel(pct) {
  if (pct == null || Number.isNaN(pct)) return '-';
  return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}

function ratioDeltaDisplay(pct, strongPct = 10) {
  if (pct == null || Number.isNaN(pct)) return '-';
  const abs = Math.abs(pct);
  const text = ratioDeltaLabel(pct);
  if (abs >= strongPct) return pct > 0 ? `🔥📈 ${text}` : `🔥📉 ${text}`;
  if (abs >= RATIO_WARN_PCT) return pct > 0 ? `⚡📈 ${text}` : `⚡📉 ${text}`;
  return text;
}

function changeTrendLabel(row, strongPct = 10) {
  if (row.ratioDeltaPct == null) return '— 首次';
  const d = row.ratioDeltaPct;
  if (d >= strongPct) return '🔥 变多';
  if (d <= -strongPct) return '🔥 变少';
  if (d >= RATIO_WARN_PCT) return '⚡ 变多';
  if (d <= -RATIO_WARN_PCT) return '⚡ 变少';
  if (Math.abs(d) < 0.05) return '持平';
  return d > 0 ? '微增' : '微减';
}

function tradeHintLabel(pct, strongPct = 10) {
  if (pct == null || Number.isNaN(pct)) return '-';
  if (pct >= strongPct) return '📈 考虑做多';
  if (pct >= RATIO_WARN_PCT) return '📈 偏做多';
  if (pct <= -strongPct) return '📉 考虑做空';
  if (pct <= -RATIO_WARN_PCT) return '📉 偏做空';
  return '—';
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
    for (const [sym, state] of Object.entries(obj)) {
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
    await writeFile(STATE_FILE, JSON.stringify(Object.fromEntries(lastState)), 'utf8');
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
  for (const sym of resolveWatchSymbols() || []) {
    registerActiveSymbol(sym);
    if (!lastState.has(sym.toUpperCase())) {
      await seedFromWhaleHistory(sym);
    }
  }
}

async function scanSymbolForDigest(symbol) {
  const sym = symbol.toUpperCase();
  registerActiveSymbol(sym);
  const raw = await fetchSmartSignal(sym);
  const price = parseFloat(raw?.lastPrice) || 0;
  const analysis = analyzeSmartSignal(raw, price);
  const prev = lastState.get(sym);

  const ratioDeltaPct = prev?.initialized && prev.ratio > 0
    ? ((analysis.ratio - prev.ratio) / prev.ratio) * 100
    : null;

  lastState.set(sym, {
    score: analysis.score,
    direction: analysis.direction,
    ratio: analysis.ratio,
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
  };
}

function buildDigestTableRows(rows, highlightPct) {
  return rows.map(r => {
    const trend = changeTrendLabel(r, highlightPct);
    const ratioText = r.prevRatio != null
      ? `${r.prevRatio.toFixed(2)}→${r.ratio.toFixed(2)}`
      : r.ratio.toFixed(2);
    const chg8 = r.change8am != null
      ? `${r.change8am >= 0 ? '+' : ''}${r.change8am.toFixed(1)}%`
      : '-';
    return {
      coin: `[${r.badge}] ${r.label}`,
      chg8am: chg8,
      chg30m: trend,
      ratio: ratioText,
      delta: ratioDeltaDisplay(r.ratioDeltaPct, highlightPct),
      hint: tradeHintLabel(r.ratioDeltaPct, highlightPct),
      price: r.priceLabel ? `$${r.priceLabel}` : '-',
      mc: r.marketCapLabel || '-',
      funding: r.fundingRateLabel || '-',
    };
  });
}

const DIGEST_TABLE_COLUMNS = [
  { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
  { name: 'chg8am', display_name: '8点来', data_type: 'text', width: 'auto' },
  { name: 'chg30m', display_name: '30min', data_type: 'text', width: 'auto' },
  { name: 'ratio', display_name: '净多空比', data_type: 'text', width: 'auto' },
  { name: 'delta', display_name: '变化%', data_type: 'text', width: 'auto' },
  { name: 'hint', display_name: '参考', data_type: 'text', width: 'auto' },
  { name: 'price', display_name: '价格', data_type: 'text', width: 'auto' },
  { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
  { name: 'funding', display_name: '费率', data_type: 'text', width: 'auto' },
];

/** 涨幅榜 / 跌幅榜 单张卡片（表格内置分页） */
export function buildBoardDigestElements(rows, {
  boardLabel = '涨幅榜',
  intervalMin = 30,
  highlightPct = 10,
  pageSize = 10,
  dateKey = '',
  topN = 30,
} = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const bigMoves = rows
    .filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= RATIO_WARN_PCT)
    .sort((a, b) => Math.abs(b.ratioDeltaPct) - Math.abs(a.ratioDeltaPct));

  const elements = [
    {
      tag: 'markdown',
      content: `**⏰ ${now}**\n**${boardLabel}** · Top${topN} · ${rows.length} 个币种${dateKey ? ` · ${dateKey} 8点基准` : ''}\n_按聪明钱变化幅度排序 · ⚡≥5% · 🔥≥${highlightPct}% · 表格可翻页 · 参考列仅供研判_`,
    },
  ];

  if (bigMoves.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `**⚡ 聪明钱显著变化:** ${bigMoves.map(r => `${r.label} ${ratioDeltaDisplay(r.ratioDeltaPct, highlightPct)} ${tradeHintLabel(r.ratioDeltaPct, highlightPct)}`).join(' · ')}`,
    });
  }

  elements.push({
    tag: 'table',
    page_size: Math.max(5, Math.min(20, pageSize)),
    row_height: 'low',
    freeze_first_column: true,
    columns: DIGEST_TABLE_COLUMNS,
    rows: buildDigestTableRows(rows, highlightPct),
  });

  return elements;
}

export async function runSmartTrendPush({ force = false } = {}) {
  if (!deps?.enabled || !deps?.feishuEnabled || running) return;
  const watchSymbols = resolveWatchSymbols();
  if (!watchSymbols?.size) return;

  running = true;
  const intervalMin = deps.intervalMin ?? 30;
  const highlightPct = deps.ratioChangePct ?? 10;
  const pageSize = deps.digestPageSize ?? 10;
  const groups = deps.getWatchlistGroups?.() || { gainers: [], losers: [], dateKey: '', topN: 30 };
  const gainerMap = new Map((groups.gainers || []).map(g => [g.symbol.toUpperCase(), g.change]));
  const loserMap = new Map((groups.losers || []).map(l => [l.symbol.toUpperCase(), l.change]));

  try {
    console.log(`\n  📤 聪明钱全池扫描 (${watchSymbols.size} 个)...`);
    const rowMap = new Map();
    let failed = 0;

    for (const sym of watchSymbols) {
      try {
        const row = await scanSymbolForDigest(sym);
        rowMap.set(sym.toUpperCase(), row);
      } catch (e) {
        failed += 1;
        console.warn(`  ⚠ 聪明钱扫描 ${sym} 失败: ${e.message}`);
      }
    }

    if (!rowMap.size) {
      console.warn(`  ⚠ 聪明钱全池扫描: 全部失败，跳过推送`);
      return;
    }

    const allRows = [...rowMap.values()];
    const enriched = deps.batchEnrichDigest
      ? await deps.batchEnrichDigest(allRows).catch(() => allRows)
      : allRows;
    const enrichedMap = new Map(enriched.map(r => [r.symbol, r]));

    const buildBoardRows = (boardList, tieBreakFn) => sortByRatioChange(
      boardList
        .map(({ symbol, change }) => {
          const row = enrichedMap.get(symbol.toUpperCase());
          if (!row) return null;
          return { ...row, change8am: row.change8am ?? change };
        })
        .filter(Boolean),
      tieBreakFn,
    );

    const gainerRows = buildBoardRows(
      groups.gainers || [],
      (a, b) => (b.change8am ?? 0) - (a.change8am ?? 0),
    );
    const loserRows = buildBoardRows(
      groups.losers || [],
      (a, b) => (a.change8am ?? 0) - (b.change8am ?? 0),
    );

    const boards = [
      { key: 'gainer', label: '📈 8点涨幅榜', rows: gainerRows, template: 'green' },
      { key: 'loser', label: '📉 8点跌幅榜', rows: loserRows, template: 'red' },
    ];

    let sent = 0;
    for (const board of boards) {
      if (!board.rows.length) {
        console.warn(`  ⚠ ${board.label}: 无可用数据，跳过`);
        continue;
      }
      const bigCount = board.rows.filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).length;
      const elements = buildBoardDigestElements(board.rows, {
        boardLabel: board.label,
        intervalMin,
        highlightPct,
        pageSize,
        dateKey: groups.dateKey,
        topN: groups.topN ?? 30,
      });
      const title = bigCount > 0
        ? `${board.label} · Top${groups.topN ?? 30} · ${bigCount}个聪明钱显著变化`
        : `${board.label} · Top${groups.topN ?? 30}`;
      await deps.sendFeishuCard(title, elements, board.template);
      sent += 1;
    }

    const totalBig = [...gainerRows, ...loserRows].filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).length;
    console.log(`  ✓ 聪明钱榜单推送: 涨幅 ${gainerRows.length} + 跌幅 ${loserRows.length} · ${sent} 张卡片 · ${totalBig} 个≥${highlightPct}%变化${failed ? ` · ${failed} 扫描失败` : ''}`);
  } catch (e) {
    console.warn(`  ⚠ 聪明钱全池推送失败: ${e.message}`);
  } finally {
    running = false;
  }
}

export function startSmartTrendScheduler() {
  if (!deps?.enabled) return;
  if (digestTimer) clearTimeout(digestTimer);

  const intervalMin = deps.intervalMin ?? 30;
  const syms = [...(resolveWatchSymbols() || [])];
  const watchLabel = syms.length > 10
    ? `${syms.slice(0, 10).map(s => s.replace(/USDT$/, '')).join(', ')} 等 ${syms.length} 个`
    : syms.map(s => s.replace(/USDT$/, '')).join(', ');

  console.log(`  📊 聪明钱榜单推送: 上海时间每整点/半点 · 涨幅榜+跌幅榜各1张卡片(表格分页) · 监控 ${watchLabel || '（池为空）'}`);

  const scheduleNext = () => {
    const next = getNextHalfHourShanghai();
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
