/**
 * 聪明钱变多/变少 飞书推送（含做多/做空建议）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSmartSignal, analyzeSmartSignal } from './scan-smart-signal.mjs';
import { registerActiveSymbol } from './whale-history.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const STATE_FILE = join(DATA_DIR, 'smart-trend-state.json');

const TREND_LABELS = {
  increase: '聪明钱变多',
  decrease: '聪明钱变少',
  flip_long: '聪明钱转多',
  flip_short: '聪明钱转空',
};

let deps = null;
let running = false;
/** @type {Map<string, { score: number, direction: string, ratio: number, initialized: boolean }>} */
const lastState = new Map();
/** @type {Map<string, number>} key: `${symbol}:${trend}` */
const lastPushedAt = new Map();
let saveQueue = Promise.resolve();

export function getTradeRecommendation(trend) {
  if (trend === 'increase' || trend === 'flip_long') {
    return { action: 'long', label: '建议做多', emoji: '📈' };
  }
  if (trend === 'decrease' || trend === 'flip_short') {
    return { action: 'short', label: '建议做空', emoji: '📉' };
  }
  return { action: 'hold', label: '观望', emoji: '⏸' };
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
    // 首次运行无状态文件
  }
}

function queueSaveState() {
  saveQueue = saveQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(lastState);
    await writeFile(STATE_FILE, JSON.stringify(obj), 'utf8');
  }).catch(() => {});
}

async function seedFromWhaleHistory(symbol) {
  if (!deps?.getWhaleHistory) return;
  const sym = symbol.toUpperCase();
  const existing = lastState.get(sym);
  if (existing?.initialized) return;

  try {
    const hist = await deps.getWhaleHistory(sym, 72);
    const points = hist?.points || [];
    if (!points.length) return;

    const last = points[points.length - 1];
    const ratio = parseFloat(last.longShortRatio) || 0;
    const direction = ratio > 1 ? 'long' : ratio < 1 ? 'short' : 'neutral';
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
  } catch {
    // 历史种子失败不影响后续扫描
  }
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
  if (typeof deps?.getWatchSymbols === 'function') {
    return deps.getWatchSymbols();
  }
  return deps?.watchSymbols;
}

export async function initSmartTrendMonitor(dependencies) {
  deps = dependencies;
  await loadPersistedState();

  const symbols = resolveWatchSymbols();
  for (const sym of symbols || []) {
    registerActiveSymbol(sym);
    if (!lastState.has(sym.toUpperCase())) {
      await seedFromWhaleHistory(sym);
    }
  }
}

function cooldownMs() {
  return (deps?.cooldownMin ?? 60) * 60 * 1000;
}

function detectTrend(prev, curr) {
  if (!prev?.initialized) return null;

  // 方向翻转：净多空比由空转多 / 由多转空
  if (
    prev.direction !== curr.direction
    && curr.direction !== 'neutral'
    && prev.direction !== 'neutral'
  ) {
    return curr.direction === 'long' ? 'flip_long' : 'flip_short';
  }

  // 严格按净多空比变化判定（阈值 3%）
  if (prev.ratio > 0) {
    const ratioDeltaPct = ((curr.ratio - prev.ratio) / prev.ratio) * 100;
    if (ratioDeltaPct >= 3) return 'increase';
    if (ratioDeltaPct <= -3) return 'decrease';
  }

  return null;
}

function canPush(symbol, trend, { force = false } = {}) {
  if (force) return true;
  const key = `${symbol}:${trend}`;
  const last = lastPushedAt.get(key) ?? 0;
  return Date.now() - last >= cooldownMs();
}

function markPushed(symbol, trend) {
  lastPushedAt.set(`${symbol}:${trend}`, Date.now());
}

async function scanSymbol(symbol, { force = false } = {}) {
  const sym = symbol.toUpperCase();
  registerActiveSymbol(sym);
  const raw = await fetchSmartSignal(sym);
  const price = parseFloat(raw?.lastPrice) || null;
  const analysis = analyzeSmartSignal(raw, price);
  const prev = lastState.get(sym);
  const trend = detectTrend(prev, analysis);

  lastState.set(sym, {
    score: analysis.score,
    direction: analysis.direction,
    ratio: analysis.ratio,
    initialized: true,
  });
  queueSaveState();

  if (!trend || !canPush(sym, trend, { force })) return null;

  markPushed(sym, trend);
  const rec = getTradeRecommendation(trend);
  return {
    symbol: sym,
    label: sym.replace(/USDT$/, ''),
    trend,
    trendLabel: TREND_LABELS[trend],
    recommendation: rec.label,
    recommendationAction: rec.action,
    recommendationEmoji: rec.emoji,
    prevScore: prev.score,
    score: analysis.score,
    prevDirection: prev.direction,
    direction: analysis.direction,
    badge: analysis.badge,
    ratio: analysis.ratio,
    prevRatio: prev.ratio,
    price,
    signals: analysis.signals.slice(0, 4),
    detail: analysis.detail,
  };
}

export function buildSmartTrendAlertElements(alerts, { intervalMin = 30, cooldownMin = 60 } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const watchLabel = alerts.map(a => a.label).join(', ');
  const elements = [
    {
      tag: 'markdown',
      content: `**⏰ ${now}**\n**聪明钱变化通知** · ${watchLabel}\n_严格按净多空比变化推送 · 比值升≥3%→做多 · 降≥3%→做空 · 每 ${intervalMin} 分钟扫描 · 同币种同方向 ${cooldownMin} 分钟最多 1 次_`,
    },
  ];

  elements.push({
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    freeze_first_column: true,
    columns: [
      { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
      { name: 'trend', display_name: '变化', data_type: 'lark_md', width: 'auto' },
      { name: 'action', display_name: '操作建议', data_type: 'lark_md', width: 'auto' },
      { name: 'score', display_name: '分数', data_type: 'text', width: 'auto' },
      { name: 'ratio', display_name: '净多空比', data_type: 'text', width: 'auto' },
      { name: 'signals', display_name: '信号', data_type: 'text', width: 'auto' },
    ],
    rows: alerts.map(a => {
      const trendColor = a.trend === 'decrease' || a.trend === 'flip_short' ? 'red' : 'green';
      const actionColor = a.recommendationAction === 'short' ? 'red' : 'green';
      const scoreText = a.prevScore != null ? `${a.prevScore}→${a.score}` : `${a.score}`;
      const ratioText = a.prevRatio != null
        ? `${a.prevRatio.toFixed(2)}→${a.ratio.toFixed(2)}`
        : a.ratio.toFixed(2);
      return {
        coin: `[${a.badge}] ${a.label}`,
        trend: `<font color='${trendColor}'>${a.trendLabel}</font>`,
        action: `<font color='${actionColor}'>**${a.recommendationEmoji} ${a.recommendation}**</font>`,
        score: scoreText,
        ratio: ratioText,
        signals: a.signals.map(s => s.replace(/^[✓✗◐⚠─]\s*/, '')).join(' · '),
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
  try {
    const alerts = [];
    for (const sym of watchSymbols) {
      try {
        const r = await scanSymbol(sym, { force });
        if (r) alerts.push(r);
      } catch (e) {
        console.warn(`  ⚠ 聪明钱趋势扫描 ${sym} 失败: ${e.message}`);
      }
    }

    if (!alerts.length) {
      console.log(`  ✓ 聪明钱趋势扫描: ${watchSymbols.size} 个监控币种，无新变化`);
      return;
    }

    const intervalMin = deps.intervalMin ?? 30;
    const cooldownMin = deps.cooldownMin ?? 60;
    const elements = buildSmartTrendAlertElements(alerts, { intervalMin, cooldownMin });
    const labels = alerts.map(a => a.label).join('/');
    const title = alerts.length === 1
      ? `${alerts[0].recommendationEmoji} ${alerts[0].trendLabel} · ${alerts[0].label} · ${alerts[0].recommendation}`
      : `📊 聪明钱变化 · ${labels}`;

    const template = alerts.some(a => a.recommendationAction === 'short') ? 'red' : 'green';
    await deps.sendFeishuCard(title, elements, template);
    console.log(`  ✓ 聪明钱趋势推送 (${alerts.map(a => `${a.label}:${a.trendLabel}→${a.recommendation}`).join(', ')})`);
  } catch (e) {
    console.warn(`  ⚠ 聪明钱趋势推送失败: ${e.message}`);
  } finally {
    running = false;
  }
}

export function startSmartTrendScheduler() {
  if (!deps?.enabled) return;

  const intervalMin = deps.intervalMin ?? 30;
  const cooldownMin = deps.cooldownMin ?? 60;
  const syms = [...(resolveWatchSymbols() || [])];
  const watchLabel = syms.length > 10
    ? `${syms.slice(0, 10).map(s => s.replace(/USDT$/, '')).join(', ')} 等 ${syms.length} 个`
    : syms.map(s => s.replace(/USDT$/, '')).join(', ');

  console.log(`  📊 聪明钱变化推送（唯一启用）: 每 ${intervalMin} 分钟 · 净多空比升→做多 / 降→做空 · 监控 ${watchLabel || '（池为空）'}（${cooldownMin}min 去重）`);

  const ms = intervalMin * 60 * 1000;
  setInterval(() => runSmartTrendPush(), ms);
  setTimeout(() => runSmartTrendPush(), 120_000);
}
