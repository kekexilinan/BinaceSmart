/**
 * 聪明钱监控 · 每 30 分钟整点推送全池变化摘要（不含做多/做空建议）
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

function ratioDeltaLabel(pct) {
  if (pct == null || Number.isNaN(pct)) return '-';
  return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}

function changeTrendLabel(row, highlightPct = 10) {
  if (row.ratioDeltaPct == null) return '首次';
  const d = row.ratioDeltaPct;
  if (d >= highlightPct) return '变多';
  if (d <= -highlightPct) return '变少';
  if (Math.abs(d) < 0.05) return '持平';
  return d > 0 ? '微增' : '微减';
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

export function buildSmartTrendDigestElements(rows, { intervalMin = 30, highlightPct = 10, totalCount = 0 } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const bigMoves = rows.filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).length;

  const elements = [
    {
      tag: 'markdown',
      content: `**⏰ ${now}**\n**聪明钱全池快照** · 共 ${totalCount || rows.length} 个币种\n_每 ${intervalMin} 分钟整点推送 · 30min 净多空比变化 · ≥${highlightPct}% 标为变多/变少 · 不含买卖建议_`,
    },
  ];

  if (bigMoves > 0) {
    elements.push({
      tag: 'markdown',
      content: `**⚡ 显著变化（≥${highlightPct}%）:** ${rows.filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).map(r => `${r.label} ${ratioDeltaLabel(r.ratioDeltaPct)}`).join(' · ')}`,
    });
  }

  elements.push({
    tag: 'table',
    page_size: 20,
    row_height: 'low',
    freeze_first_column: true,
    header_style: { bold: true, lines: 1, background_style: 'grey', text_size: 'normal', text_align: 'left' },
    columns: [
      { name: 'coin', display_name: '币种', data_type: 'text', width: '70px' },
      { name: 'trend', display_name: '30min变化', data_type: 'lark_md', width: 'auto' },
      { name: 'ratio', display_name: '净多空比', data_type: 'text', width: 'auto' },
      { name: 'delta', display_name: 'Δ%', data_type: 'text', width: 'auto' },
      { name: 'price', display_name: '价格', data_type: 'text', width: 'auto' },
      { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
      { name: 'funding', display_name: '资金费率', data_type: 'text', width: 'auto' },
    ],
    rows: rows.map(r => {
      const trend = changeTrendLabel(r, highlightPct);
      const trendColor = trend === '变少' || trend === '微减' ? 'red' : trend === '变多' || trend === '微增' ? 'green' : 'grey';
      const ratioText = r.prevRatio != null
        ? `${r.prevRatio.toFixed(2)}→${r.ratio.toFixed(2)}`
        : r.ratio.toFixed(2);
      return {
        coin: `[${r.badge}] ${r.label}`,
        trend: `<font color='${trendColor}'>${trend}</font>`,
        ratio: ratioText,
        delta: ratioDeltaLabel(r.ratioDeltaPct),
        price: r.priceLabel ? `$${r.priceLabel}` : '-',
        mc: r.marketCapLabel || '-',
        funding: r.fundingRateLabel || '-',
      };
    }),
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

  try {
    console.log(`\n  📤 聪明钱全池扫描 (${watchSymbols.size} 个)...`);
    const rows = [];
    let failed = 0;

    for (const sym of watchSymbols) {
      try {
        rows.push(await scanSymbolForDigest(sym));
      } catch (e) {
        failed += 1;
        console.warn(`  ⚠ 聪明钱扫描 ${sym} 失败: ${e.message}`);
      }
    }

    if (!rows.length) {
      console.warn(`  ⚠ 聪明钱全池扫描: 全部失败，跳过推送`);
      return;
    }

    const enriched = deps.batchEnrichDigest
      ? await deps.batchEnrichDigest(rows).catch(() => rows)
      : rows;

    enriched.sort((a, b) => {
      const da = Math.abs(a.ratioDeltaPct ?? 0);
      const db = Math.abs(b.ratioDeltaPct ?? 0);
      return db - da || (b.ratio ?? 0) - (a.ratio ?? 0);
    });

    const bigCount = enriched.filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).length;
    const elements = buildSmartTrendDigestElements(enriched, {
      intervalMin,
      highlightPct,
      totalCount: watchSymbols.size,
    });

    const title = bigCount > 0
      ? `📊 聪明钱快照 · ${watchSymbols.size}币 · ${bigCount}个显著变化`
      : `📊 聪明钱快照 · ${watchSymbols.size}币 · 全池一览`;

    await deps.sendFeishuCard(title, elements, bigCount > 0 ? 'blue' : 'grey');
    console.log(`  ✓ 聪明钱全池推送: ${enriched.length} 个币种 · ${bigCount} 个≥${highlightPct}%变化${failed ? ` · ${failed} 失败` : ''}`);
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

  console.log(`  📊 聪明钱全池推送: 上海时间每整点/半点 · ${intervalMin}min · 监控 ${watchLabel || '（池为空）'} · 仅展示变化不含买卖建议`);

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
