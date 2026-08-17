/**
 * 自动交易系统（P1 骨架：dry-run 模式，仅日志不下单）
 * 调度：上海时间每小时 :50 触发（与聪明钱榜单推送对齐），复用 getNextHourShanghai()
 * 数据来源：smart-trend-decision-state.json（最新 action 列表）+ 币安公开行情
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { emaLast, closesOf } from './ema.mjs';
import { getNextHourShanghai } from './smart-trend-monitor.mjs';
import {
  configureBinanceClient, getKlines, getMarkPrice,
  placeLimitOrder, cancelOrder, getOpenOrders, isDryRun,
} from './binance-client.mjs';
import {
  insertAutoOrder, updateAutoOrder, queryActiveAutoOrders, queryAutoOrders,
  insertAutoPosition, updateAutoPosition, queryOpenPositions,
  logAutoTrade, queryLatestSnapshot,
} from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const DECISION_STATE_FILE = join(DATA_DIR, 'smart-trend-decision-state.json');

// 默认配置
const DEFAULTS = {
  enabled: false,
  dryRun: true,
  apiKey: '',
  apiSecret: '',
  market: 'spot',
  maxPositions: 5,
  orderUsdt: 50,
  leverage: 5,
  pullbackLowPct: 20,
  pullbackHighPct: 30,
  orderTtlMin: 180,
  tpPct: 15,
  slPct: 10,
  tickEveryMin: 50,
  klineInterval: '1h',
  klineLimit: 30,
};

let cfg = { ...DEFAULTS };
let tickTimer = null;
let logger = console;
let running = false;
/** @type {() => object|null} 由外部注入的最新决策对象 */
let getDecisionGetter = null;

// ==================== 配置与启动 ====================

/**
 * 初始化并启动自动交易
 * @param {object} opts
 * @param {() => object|null} [opts.getLatestDecision] 返回最新 decisionPush 对象
 * @param {string} [opts.apiKey]
 * @param {string} [opts.apiSecret]
 * @param {object} [opts.feishu] 飞书推送（{ sendCard, sendText }）
 */
export async function startAutoTrader(opts = {}) {
  cfg = {
    ...DEFAULTS,
    enabled: opts.enabled ?? cfg.enabled,
    dryRun: opts.dryRun ?? cfg.dryRun,
    apiKey: opts.apiKey || cfg.apiKey,
    apiSecret: opts.apiSecret || cfg.apiSecret,
    market: (opts.market || cfg.market),
    maxPositions: Number(opts.maxPositions ?? cfg.maxPositions),
    orderUsdt: Number(opts.orderUsdt ?? cfg.orderUsdt),
    leverage: Number(opts.leverage ?? cfg.leverage),
    pullbackLowPct: Number(opts.pullbackLowPct ?? cfg.pullbackLowPct),
    pullbackHighPct: Number(opts.pullbackHighPct ?? cfg.pullbackHighPct),
    orderTtlMin: Number(opts.orderTtlMin ?? cfg.orderTtlMin),
    tpPct: Number(opts.tpPct ?? cfg.tpPct),
    slPct: Number(opts.slPct ?? cfg.slPct),
  };
  if (typeof opts.getLatestDecision === 'function') getDecisionGetter = opts.getLatestDecision;
  logger = opts.logger || logger;

  if (!cfg.enabled) {
    logger.log?.('  🚫 自动交易未启用（AUTO_TRADER_ENABLED=false）');
    return;
  }

  configureBinanceClient({
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    market: cfg.market,
    dryRun: cfg.dryRun,
    logger,
  });

  const mode = cfg.dryRun ? '🧪 DRY-RUN（只记录不下单）' : '🔴 LIVE';
  logger.log?.(`  🤖 自动交易启动: ${mode} · ${cfg.market} · 每 ${cfg.tickEveryMin} 分钟 · 最多 ${cfg.maxPositions} 仓 · 单笔 ${cfg.orderUsdt}U · 回踩 -${cfg.pullbackLowPct}% ~ -${cfg.pullbackHighPct}%`);

  scheduleTick();
}

export function stopAutoTrader() {
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = null;
  logger.log?.('  🤖 自动交易已停止');
}

function scheduleTick() {
  if (tickTimer) clearTimeout(tickTimer);
  // 对齐到下一个 :50
  const next = getNextHourShanghai(new Date());
  const delay = Math.max(30_000, next.getTime() - Date.now());
  const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  logger.log?.(`  ⏰ 下次自动交易 tick: ${label}（${Math.round(delay / 60000)} 分钟后）`);
  tickTimer = setTimeout(async () => {
    try { await runTick(); } catch (e) { logger.warn?.(`  ⚠ 自动交易 tick 失败: ${e.message}`); }
    scheduleTick();
  }, delay);
}

// ==================== 主 tick 流程 ====================

async function runTick() {
  if (running) { logger.warn?.('  ⚠ 上一次 tick 未完成，跳过'); return; }
  running = true;
  const tickStart = Date.now();
  const now = Date.now();
  logger.log?.(`\n━━━ 🤖 自动交易 tick ${new Date(now).toISOString()} ━━━`);

  try {
    // Step 1: 读取最新决策
    const decision = await loadLatestDecision();
    const actionItems = decision?.action || [];
    logger.log?.(`  📋 决策清单: action=${actionItems.length} · 时间 ${decision?.timestamp ? new Date(decision.timestamp).toISOString() : 'N/A'}`);

    // Step 2: 立即关注的候选（urgency=high + side=long）
    const candidates = actionItems.filter(isValidSignal);
    logger.log?.(`  🎯 立刻关注(做多 high): ${candidates.length} 个 ${candidates.length ? candidates.map(c => c.symbol).join(',') : ''}`);

    // Step 3: 维护存量挂单（TTL + 是否还在关注列表）
    await maintainPendingOrders(candidates, now);

    // Step 4: 维护已成交持仓（止盈/止损/被剔除）
    await maintainOpenPositions(candidates, now);

    // Step 5: 新开单
    await placeNewOrders(candidates, now);

    logger.log?.(`  ✅ tick 完成（${Date.now() - tickStart}ms）`);
  } finally {
    running = false;
  }
}

// ==================== 决策数据 ====================

async function loadLatestDecision() {
  // 优先用内存 getter（由 server 注入）
  if (typeof getDecisionGetter === 'function') {
    try {
      const d = getDecisionGetter();
      if (d && (d.action?.length || d.watch?.length)) return d;
    } catch (e) { logger.warn?.(`  ⚠ getLatestDecision 失败: ${e.message}`); }
  }
  // 回退：从 symbol_snapshot 表取最新一批，重建"做多 high" 候选
  try {
    const snaps = queryLatestSnapshot();
    if (snaps?.length) {
      const action = snaps
        .filter(s => s.direction === 'long' && Number(s.score) >= 40)
        .map(s => ({
          symbol: s.symbol,
          label: s.symbol?.replace(/USDT$/, '') || s.symbol,
          side: 'long',
          status: 'continued',
          statusLabel: '延续',
          score: Number(s.score) || 0,
          ratioDeltaPct: Number(s.ratio_delta_1h) || 0,
          price: Number(s.price) || 0,
          tradeView: 'trend_long',
        }))
        .sort((a, b) => b.score - a.score);
      logger.log?.(`  ↩ 从 symbol_snapshot 回退: ${action.length} 个做多候选`);
      return { action, watch: [], rebound: [], timestamp: Date.now(), source: 'snapshot' };
    }
  } catch (e) { logger.warn?.(`  ⚠ 回退读 snapshot 失败: ${e.message}`); }
  return null;
}

// ==================== 信号校验 ====================

function isValidSignal(item) {
  if (!item) return false;
  if (item.side !== 'long') return false;
  // urgency 未直接存在 action item 上；用 status + score 替代：strengthened/continued/new + score≥60
  const status = item.status || '';
  if (!['strengthened', 'continued', 'new'].includes(status)) return false;
  const score = Number(item.score ?? 0);
  if (score < 60) return false;
  // 聪明钱仍在偏多（ratioDeltaPct 来自 enriched row；若缺失则放宽）
  const delta = Number(item.ratioDeltaPct ?? NaN);
  if (Number.isFinite(delta) && delta <= 0) return false;
  return true;
}

// ==================== 维护：撤单 ====================

async function maintainPendingOrders(candidates, now) {
  const active = queryActiveAutoOrders();
  if (!active.length) return;
  const candSet = new Set(candidates.map(c => c.symbol?.toUpperCase()));

  for (const order of active) {
    // TTL 到期
    if (now - order.created_at > (order.ttl_min || cfg.orderTtlMin) * 60_000) {
      await cancelLocalOrder(order, 'ttl_expired');
      continue;
    }
    // 聪明钱加仓趋势
    const match = candidates.find(c => c.symbol?.toUpperCase() === order.symbol);
    const stillIn = match && candSet.has(order.symbol);
    if (!stillIn) {
      await cancelLocalOrder(order, 'dropped_from_watchlist');
      continue;
    }
    // 更新"是否仍在加仓"标记
    const delta = Number(match?.ratioDeltaPct ?? NaN);
    const increased = !Number.isFinite(delta) || delta > 0;
    if (!!order.smart_money_increased !== increased) {
      updateAutoOrder(order.id, { smartMoneyIncreased: increased });
    }
  }
}

async function cancelLocalOrder(order, reason) {
  logger.log?.(`  ❌ 撤单 ${order.symbol} id=${order.id} reason=${reason} price=${order.price}`);
  try {
    if (order.binance_id && !isDryRun()) {
      await cancelOrder(order.symbol, order.binance_id);
    }
  } catch (e) {
    logger.warn?.(`  ⚠ 交易所撤单失败 ${order.symbol}: ${e.message}`);
  }
  updateAutoOrder(order.id, { status: 'cancelled', cancelledAt: Date.now() });
  logAutoTrade(order.symbol, 'cancel', { orderId: order.id, reason, binanceId: order.binance_id });
}

// ==================== 维护：持仓 ====================

async function maintainOpenPositions(candidates, now) {
  const positions = queryOpenPositions();
  if (!positions.length) return;
  const candSet = new Set(candidates.map(c => c.symbol?.toUpperCase()));

  for (const pos of positions) {
    let curPrice;
    try {
      const mp = await getMarkPrice(pos.symbol);
      curPrice = mp.lastPrice;
    } catch (e) {
      logger.warn?.(`  ⚠ 获取 ${pos.symbol} 价格失败: ${e.message}`);
      continue;
    }
    // 止盈 / 止损
    if (pos.tp_price && curPrice >= pos.tp_price) {
      await closeLocalPosition(pos, 'take_profit', curPrice);
      continue;
    }
    if (pos.sl_price && curPrice <= pos.sl_price) {
      await closeLocalPosition(pos, 'stop_loss', curPrice);
      continue;
    }
    // 被剔除出立刻关注 且 浮亏 → 平仓（保守策略）
    if (!candSet.has(pos.symbol) && curPrice < pos.entry_price) {
      await closeLocalPosition(pos, 'out_of_watchlist', curPrice);
    }
  }
}

async function closeLocalPosition(pos, reason, curPrice) {
  logger.log?.(`  📤 平仓 ${pos.symbol} reason=${reason} entry=${pos.entry_price} cur=${curPrice?.toFixed(6)}`);
  try {
    if (!isDryRun()) {
      await placeLimitOrder({
        symbol: pos.symbol,
        side: 'SELL',
        quantity: pos.qty,
        price: curPrice,
      });
    } else {
      logger.log?.(`  [DRY-RUN] SELL ${pos.symbol} qty=${pos.qty} price=${curPrice}`);
    }
  } catch (e) {
    logger.warn?.(`  ⚠ 平仓下单失败 ${pos.symbol}: ${e.message}`);
  }
  updateAutoPosition(pos.id, {
    status: 'closed',
    closedAt: Date.now(),
    closeReason: reason,
    exitPrice: curPrice,
  });
  const pnlPct = ((curPrice - pos.entry_price) / pos.entry_price * 100).toFixed(2);
  logAutoTrade(pos.symbol, 'close', { posId: pos.id, reason, entry: pos.entry_price, exit: curPrice, pnlPct });
}

// ==================== 新开单 ====================

async function placeNewOrders(candidates, now) {
  if (!candidates.length) return;
  const active = queryActiveAutoOrders();
  const openPos = queryOpenPositions();
  const existing = new Set([
    ...active.map(o => o.symbol?.toUpperCase()),
    ...openPos.map(p => p.symbol?.toUpperCase()),
  ]);
  const freeSlots = cfg.maxPositions - existing.size;
  if (freeSlots <= 0) { logger.log?.(`  ℹ 已满仓（${existing.size}/${cfg.maxPositions}），不再开新单`); return; }

  // 按 score 降序
  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  let placed = 0;

  for (const item of sorted) {
    if (placed >= freeSlots) break;
    const sym = item.symbol?.toUpperCase();
    if (!sym) continue;
    if (existing.has(sym)) continue;

    try {
      const klines = await getKlines(sym, cfg.klineInterval, cfg.klineLimit);
      if (!klines?.length || klines.length < 10) {
        logger.warn?.(`  ⚠ ${sym} K 线数据不足`);
        continue;
      }
      const mark = await getMarkPrice(sym);
      const curPrice = mark.lastPrice;
      const closes = closesOf(klines);
      const e7 = emaLast(closes, 7);
      const e25 = emaLast(closes, 25);
      const { price: entryPrice, ema } = pickEntryPrice({ e7, e25, curPrice });
      const qty = calcQty(cfg.orderUsdt, entryPrice);
      const pullback = ((curPrice - entryPrice) / curPrice) * 100;

      logger.log?.(`  📥 ${sym} 计划挂单: price=${entryPrice} (${ema}) · qty=${qty} · pullback=${pullback.toFixed(1)}% · cur=${curPrice}`);

      const result = await placeLimitOrder({
        symbol: sym,
        side: 'BUY',
        quantity: qty,
        price: entryPrice,
      });

      const orderId = randomUUID();
      insertAutoOrder({
        id: orderId,
        symbol: sym,
        side: 'BUY',
        orderType: 'LIMIT',
        price: entryPrice,
        qty,
        binanceId: result?.orderId || null,
        emaUsed: ema,
        pullbackPct: pullback,
        status: 'pending',
        smartMoneyIncreased: true,
        inWatchlist: true,
        createdAt: Date.now(),
        ttlMin: cfg.orderTtlMin,
        meta: { score: item.score, status: item.status, tradeView: item.tradeView, curPrice },
      });
      logAutoTrade(sym, 'place', {
        orderId, price: entryPrice, qty, ema, pullback: pullback.toFixed(2),
        score: item.score, status: item.status,
      });

      // 预写入持仓占位（真正成交由下一 tick 检测；dry-run 下直接记为 open）
      if (isDryRun()) {
        insertAutoPosition({
          id: randomUUID(),
          symbol: sym,
          entryPrice,
          qty,
          entryOrderId: orderId,
          tpPrice: entryPrice * (1 + cfg.tpPct / 100),
          slPrice: entryPrice * (1 - cfg.slPct / 100),
          status: 'open',
          openedAt: Date.now(),
        });
        updateAutoOrder(orderId, { status: 'filled', filledAt: Date.now() });
        logAutoTrade(sym, 'fill_sim', { orderId, price: entryPrice, qty });
      }

      existing.add(sym);
      placed += 1;
    } catch (e) {
      logger.warn?.(`  ⚠ ${item.symbol} 下单失败: ${e.message}`);
    }
  }
  logger.log?.(`  ➕ 新增挂单: ${placed}/${freeSlots}`);
}

function pickEntryPrice({ e7, e25, curPrice }) {
  const low = curPrice * (1 - cfg.pullbackLowPct / 100);
  const high = curPrice * (1 - cfg.pullbackHighPct / 100);
  const inRange = (v) => Number.isFinite(v) && v >= low && v <= high;
  if (inRange(e25)) return { price: e25, ema: 'ema25' };
  if (inRange(e7)) return { price: e7, ema: 'ema7' };
  return { price: (low + high) / 2, ema: 'mid' };
}

/** 根据 USDT 金额 + 价格算出数量（现货：按名义；合约：同）并做精度处理 */
function calcQty(usdt, price) {
  if (!price || price <= 0) return 0;
  const raw = usdt / price;
  // 保留 6 位小数；实际下单前应根据 exchangeInfo.stepSize 进一步裁剪（P2 做）
  return Math.floor(raw * 1_000_000) / 1_000_000;
}

// ==================== 对外查询（供 API/面板） ====================

export function getAutoTraderStatus() {
  return {
    enabled: cfg.enabled,
    dryRun: isDryRun(),
    market: cfg.market,
    maxPositions: cfg.maxPositions,
    orderUsdt: cfg.orderUsdt,
    pullback: { low: cfg.pullbackLowPct, high: cfg.pullbackHighPct },
    ttlMin: cfg.orderTtlMin,
    tpPct: cfg.tpPct,
    slPct: cfg.slPct,
    activeOrders: queryActiveAutoOrders().length,
    openPositions: queryOpenPositions().length,
    running,
  };
}

/** 手动触发一次 tick（调试用） */
export async function runTickNow() {
  if (running) return { ok: false, reason: 'tick 正在运行' };
  const startedAt = Date.now();
  try {
    await runTick();
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (e) {
    return { ok: false, reason: e.message, durationMs: Date.now() - startedAt };
  }
}

export { queryActiveAutoOrders as getActiveOrders, queryOpenPositions as getOpenPositions };
