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

/** 综合聪明钱变化 + 价格趋势 + 资金费率 + 大户/主动买卖 给出做多/做空/观望 */
export function evaluateTradeDecision({ trend, analysis, ctx, ratioDeltaPct = 0 }) {
  let longPts = 0;
  let shortPts = 0;
  const reasons = [];

  const ratioLabel = ratioDeltaPct >= 0 ? `+${ratioDeltaPct.toFixed(1)}%` : `${ratioDeltaPct.toFixed(1)}%`;
  if (trend === 'increase' || trend === 'flip_long') {
    longPts += 3;
    reasons.push(`净多空比${ratioLabel}`);
  } else if (trend === 'decrease' || trend === 'flip_short') {
    shortPts += 3;
    reasons.push(`净多空比${ratioLabel}`);
  }

  if (ctx?.change8am != null) {
    if (ctx.change8am > 1) {
      longPts += 2;
      reasons.push(`8点来+${ctx.change8am.toFixed(1)}%`);
    } else if (ctx.change8am < -1) {
      shortPts += 2;
      reasons.push(`8点来${ctx.change8am.toFixed(1)}%`);
    }
  }

  if (ctx?.maTrend === 'bull') {
    longPts += 2;
    reasons.push('1H均线多头');
  } else if (ctx?.maTrend === 'bear') {
    shortPts += 2;
    reasons.push('1H均线空头');
  }

  if (ctx?.fundingRate != null) {
    if (ctx.fundingRate < -0.0003) {
      longPts += 1;
      reasons.push(`负费率${(ctx.fundingRate * 100).toFixed(3)}%`);
    } else if (ctx.fundingRate > 0.0008) {
      shortPts += 1;
      reasons.push(`高费率${(ctx.fundingRate * 100).toFixed(3)}%`);
    }
  }

  if (ctx?.topPosTrend > 0.03) {
    longPts += 1;
    reasons.push('大户持仓比↑');
  } else if (ctx?.topPosTrend < -0.03) {
    shortPts += 1;
    reasons.push('大户持仓比↓');
  }

  if (ctx?.takerTrend > 0.05) {
    longPts += 1;
    reasons.push('主动买入↑');
  } else if (ctx?.takerTrend < -0.05) {
    shortPts += 1;
    reasons.push('主动卖出↑');
  }

  if (analysis?.direction === 'long') longPts += 1;
  else if (analysis?.direction === 'short') shortPts += 1;

  const diff = longPts - shortPts;
  if (diff >= 2) {
    return {
      action: 'long',
      label: '建议做多',
      emoji: '📈',
      confidence: diff >= 5 ? '高' : '中',
      reasons,
      longPts,
      shortPts,
    };
  }
  if (diff <= -2) {
    return {
      action: 'short',
      label: '建议做空',
      emoji: '📉',
      confidence: diff <= -5 ? '高' : '中',
      reasons,
      longPts,
      shortPts,
    };
  }
  return {
    action: 'hold',
    label: '观望',
    emoji: '⏸',
    confidence: '低',
    reasons,
    longPts,
    shortPts,
  };
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

  const ratioThresholdPct = deps?.ratioChangePct ?? 10;

  // 方向翻转：净多空比由空转多 / 由多转空
  if (
    prev.direction !== curr.direction
    && curr.direction !== 'neutral'
    && prev.direction !== 'neutral'
  ) {
    return curr.direction === 'long' ? 'flip_long' : 'flip_short';
  }

  // 严格按净多空比变化判定
  if (prev.ratio > 0) {
    const ratioDeltaPct = ((curr.ratio - prev.ratio) / prev.ratio) * 100;
    if (ratioDeltaPct >= ratioThresholdPct) return 'increase';
    if (ratioDeltaPct <= -ratioThresholdPct) return 'decrease';
  }

  return null;
}

function canPush(symbol, action, { force = false } = {}) {
  if (force) return true;
  const key = `${symbol}:${action}`;
  const last = lastPushedAt.get(key) ?? 0;
  return Date.now() - last >= cooldownMs();
}

function markPushed(symbol, action) {
  lastPushedAt.set(`${symbol}:${action}`, Date.now());
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

  if (!trend) return null;

  const ratioDeltaPct = prev?.ratio > 0
    ? ((analysis.ratio - prev.ratio) / prev.ratio) * 100
    : 0;

  const ctx = deps?.fetchMarketContext
    ? await deps.fetchMarketContext(sym, price).catch(() => ({}))
    : {};

  const decision = evaluateTradeDecision({ trend, analysis, ctx, ratioDeltaPct });

  if (decision.action === 'hold') {
    console.log(`  · ${sym.replace(/USDT$/, '')} 净多空比${ratioLabel(ratioDeltaPct)}但综合信号冲突→观望，不推送`);
    return null;
  }

  if (!canPush(sym, decision.action, { force })) return null;

  markPushed(sym, decision.action);

  const displayPrice = ctx.price ?? price;
  return {
    symbol: sym,
    label: sym.replace(/USDT$/, ''),
    trend,
    trendLabel: TREND_LABELS[trend],
    recommendation: decision.label,
    recommendationAction: decision.action,
    recommendationEmoji: decision.emoji,
    confidence: decision.confidence,
    reasons: decision.reasons,
    prevScore: prev?.score,
    score: analysis.score,
    prevDirection: prev?.direction,
    direction: analysis.direction,
    badge: analysis.badge,
    ratio: analysis.ratio,
    prevRatio: prev?.ratio,
    ratioDeltaPct,
    price: displayPrice,
    priceLabel: ctx.priceLabel ?? (displayPrice ? String(displayPrice) : '-'),
    marketCap: ctx.marketCap ?? 0,
    marketCapLabel: ctx.marketCapLabel ?? '-',
    fundingRate: ctx.fundingRate ?? null,
    fundingRateLabel: ctx.fundingRateLabel ?? '-',
    change8am: ctx.change8am ?? null,
    maTrend: ctx.maTrend ?? 'neutral',
    signals: analysis.signals.slice(0, 3),
    detail: analysis.detail,
  };
}

function ratioLabel(pct) {
  return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}

export function buildSmartTrendAlertElements(alerts, { intervalMin = 30, cooldownMin = 30, ratioChangePct = 10 } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const watchLabel = alerts.map(a => a.label).join(', ');
  const elements = [
    {
      tag: 'markdown',
      content: `**⏰ ${now}**\n**聪明钱变化通知** · ${watchLabel}\n_净多空比≥${ratioChangePct}% + 趋势/费率/大户综合判定 · 每 ${intervalMin} 分钟 · 同方向 ${cooldownMin} 分钟去重_`,
    },
  ];

  elements.push({
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    freeze_first_column: true,
    columns: [
      { name: 'coin', display_name: '币种', data_type: 'text', width: '70px' },
      { name: 'action', display_name: '建议', data_type: 'lark_md', width: 'auto' },
      { name: 'price', display_name: '价格', data_type: 'text', width: 'auto' },
      { name: 'mc', display_name: '市值', data_type: 'text', width: 'auto' },
      { name: 'funding', display_name: '资金费率', data_type: 'text', width: 'auto' },
      { name: 'ratio', display_name: '净多空比', data_type: 'text', width: 'auto' },
      { name: 'chg8', display_name: '8点来', data_type: 'text', width: 'auto' },
      { name: 'reasons', display_name: '依据', data_type: 'text', width: 'auto' },
    ],
    rows: alerts.map(a => {
      const actionColor = a.recommendationAction === 'short' ? 'red' : 'green';
      const ratioText = a.prevRatio != null
        ? `${a.prevRatio.toFixed(2)}→${a.ratio.toFixed(2)}`
        : a.ratio.toFixed(2);
      const chg8 = a.change8am != null
        ? `${a.change8am >= 0 ? '+' : ''}${a.change8am.toFixed(1)}%`
        : '-';
      return {
        coin: `[${a.badge}] ${a.label}`,
        action: `<font color='${actionColor}'>**${a.recommendationEmoji} ${a.recommendation}** (${a.confidence})</font>`,
        price: `$${a.priceLabel}`,
        mc: a.marketCapLabel,
        funding: a.fundingRateLabel,
        ratio: ratioText,
        chg8,
        reasons: (a.reasons || []).join(' · '),
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
    const cooldownMin = deps.cooldownMin ?? 30;
    const ratioChangePct = deps.ratioChangePct ?? 10;
    const elements = buildSmartTrendAlertElements(alerts, { intervalMin, cooldownMin, ratioChangePct });
    const labels = alerts.map(a => a.label).join('/');
    const title = alerts.length === 1
      ? `${alerts[0].recommendationEmoji} ${alerts[0].trendLabel} · ${alerts[0].label} · ${alerts[0].recommendation}`
      : `📊 聪明钱变化 · ${labels}`;

    const template = alerts.some(a => a.recommendationAction === 'short') ? 'red' : 'green';
    await deps.sendFeishuCard(title, elements, template);
    console.log(`  ✓ 聪明钱趋势推送 (${alerts.map(a => `${a.label}:${a.recommendation}[${a.confidence}]`).join(', ')})`);
  } catch (e) {
    console.warn(`  ⚠ 聪明钱趋势推送失败: ${e.message}`);
  } finally {
    running = false;
  }
}

export function startSmartTrendScheduler() {
  if (!deps?.enabled) return;

  const intervalMin = deps.intervalMin ?? 30;
  const cooldownMin = deps.cooldownMin ?? 30;
  const ratioChangePct = deps.ratioChangePct ?? 10;
  const syms = [...(resolveWatchSymbols() || [])];
  const watchLabel = syms.length > 10
    ? `${syms.slice(0, 10).map(s => s.replace(/USDT$/, '')).join(', ')} 等 ${syms.length} 个`
    : syms.map(s => s.replace(/USDT$/, '')).join(', ');

  console.log(`  📊 聪明钱变化推送（唯一启用）: 每 ${intervalMin} 分钟 · 净多空比≥${ratioChangePct}% + 趋势/费率综合判定 · 监控 ${watchLabel || '（池为空）'}（${cooldownMin}min 去重）`);

  const ms = intervalMin * 60 * 1000;
  setInterval(() => runSmartTrendPush(), ms);
  setTimeout(() => runSmartTrendPush(), 120_000);
}
