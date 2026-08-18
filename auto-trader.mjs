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
  placeLimitOrder, placeMarketOrder, cancelOrder, getOrder, getPositionMode, isDryRun,
  getExchangeInfo, getBalance, getAccountPositions,
} from './binance-client.mjs';
import {
  insertAutoOrder, updateAutoOrder, queryActiveAutoOrders, queryAutoOrders,
  insertAutoPosition, updateAutoPosition, queryOpenPositions,
  logAutoTrade, queryLatestSnapshot, queryLatestDecision, queryAutoTradeLogs,
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
/** 双向持仓模式（Hedge Mode）标记，启动时探测；null=未知（仅影响 LIVE 合约下单参数） */
let dualSidePosition = null;
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

  // LIVE 合约模式：探测持仓模式（双向持仓需 positionSide，否则下单报 -4061）
  if (!cfg.dryRun && cfg.market === 'futures') {
    try {
      const m = await getPositionMode();
      dualSidePosition = !!m?.dualSidePosition;
      logger.log?.(`  🔍 持仓模式: ${dualSidePosition ? '双向持仓(Hedge Mode)' : '单向持仓(One-way)'}`);
    } catch (e) {
      logger.warn?.(`  ⚠ 持仓模式探测失败（默认按双向处理）: ${e.message}`);
      dualSidePosition = true;
    }
  }

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
    // Step 1: 等待本小时新决策生成（tick 与决策推送同点对齐，决策扫描耗时会导致读到旧决策漏单）
    const decision = await waitForFreshDecision();
    const actionItems = decision?.action || [];
    const ageSec = decision?.timestamp ? Math.round((now - decision.timestamp) / 1000) : -1;
    logger.log?.(`  📋 决策清单: action=${actionItems.length} · 时间 ${decision?.timestamp ? new Date(decision.timestamp).toISOString() : 'N/A'}（${ageSec}s 前）`);

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

/** 等待本小时新决策生成（最多 120s）；tick 与决策推送同在 :50 触发，决策扫描需要数百毫秒~数十秒 */
async function waitForFreshDecision(maxWaitMs = 120_000) {
  const tickMinuteStart = Math.floor(Date.now() / 60_000) * 60_000;
  const deadline = Date.now() + maxWaitMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await loadLatestDecision();
    // 回退重建的候选 timestamp=Date.now() 会伪装成新鲜决策，不参与新鲜度判断
    if (last?.timestamp >= tickMinuteStart && last.source !== 'snapshot') return last;
    await new Promise(r => setTimeout(r, 3_000));
  }
  logger.warn?.(`  ⚠ 等待新决策超时（${Math.round(maxWaitMs / 1000)}s），使用旧决策/回退候选`);
  return last;
}

async function loadLatestDecision() {
  // 优先用内存 getter（由 server 注入）
  if (typeof getDecisionGetter === 'function') {
    try {
      const d = getDecisionGetter();
      // 字段归一：buildSmartTrendDecision 返回 capturedAt，统一成 timestamp 供新鲜度判断
      if (d && d.timestamp == null && d.capturedAt != null) d.timestamp = d.capturedAt;
      if (d && (d.action?.length || d.watch?.length)) return d;
    } catch (e) { logger.warn?.(`  ⚠ getLatestDecision 失败: ${e.message}`); }
  }
  // 回退 1：从 decision_snapshot 表读最新决策（PM2 重启后内存丢失时可用，含 status/score）
  try {
    const snap = queryLatestDecision();
    if (snap?.action?.length) {
      logger.log?.(`  ↩ 从 decision_snapshot 回退: ${snap.action.length} 个 action`);
      return { action: snap.action, watch: snap.watch || [], rebound: snap.rebound || [], timestamp: snap.timestamp, source: 'decision_db' };
    }
  } catch (e) { logger.warn?.(`  ⚠ 回退读 decision_snapshot 失败: ${e.message}`); }
  // 回退 2：从 symbol_snapshot 表取最新一批，重建“做多 high”候选
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
  // status 缺失时（旧快照）从 statusLabel 反推：延续/加强/新出现/反转确认 → continued
  let status = item.status || '';
  if (!status && item.statusLabel) {
    if (/延续|加强|新出现|反转确认/.test(item.statusLabel)) status = 'continued';
  }
  if (!['strengthened', 'continued', 'new'].includes(status)) return false;
  const score = Number(item.score ?? 0);
  if (score < 60) return false;
  // 不再要求 1h 大户比仍在增加（ratioDeltaPct>0）：side/score/status 三重筛选已足够严格，
  // 避免把 CLO 这类“延续中但 1h 微降”的强信号全部排除（持仓阶段仍由止盈止损/剔出候选管理风险）
  return true;
}

// ==================== 维护：撤单 ====================

/** 从交易所同步单个挂单的成交状态；已成交则开仓并返回 true */
// 历史脏数据兼容：sql.js 曾把 number 型 orderId 存成 "2471958212.0"，币安拒收该格式
function cleanBinanceId(id) {
  const s = String(id ?? '').trim();
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
}

async function syncOrderFill(order) {
  if (!order.binance_id || isDryRun()) return false;
  let ex;
  try {
    ex = await getOrder(order.symbol, cleanBinanceId(order.binance_id));
  } catch (e) {
    logger.warn?.(`  ⚠ 查询订单状态失败 ${order.symbol}: ${e.message}`);
    return false;
  }
  if (ex?.status === 'FILLED') {
    const fillPrice = parseFloat(ex.avgPrice) || order.price;
    openPositionFromOrder(order, fillPrice);
    logger.log?.(`  ✅ 检测到成交 ${order.symbol} id=${order.id} price=${fillPrice}`);
    return true;
  }
  if (ex?.status === 'CANCELED' || ex?.status === 'EXPIRED' || ex?.status === 'REJECTED') {
    // 交易所侧已不在（手动撤单/资金费结算等），同步本地状态避免永远 pending
    updateAutoOrder(order.id, { status: 'cancelled', cancelledAt: Date.now() });
    logAutoTrade(order.symbol, 'sync_cancel', { orderId: order.id, exStatus: ex.status });
    return false;
  }
  return false;
}

function openPositionFromOrder(order, fillPrice) {
  insertAutoPosition({
    id: randomUUID(),
    symbol: order.symbol,
    entryPrice: fillPrice,
    qty: order.qty,
    entryOrderId: order.id,
    tpPrice: fillPrice * (1 + cfg.tpPct / 100),
    slPrice: fillPrice * (1 - cfg.slPct / 100),
    status: 'open',
    openedAt: Date.now(),
  });
  updateAutoOrder(order.id, { status: 'filled', filledAt: Date.now() });
  logAutoTrade(order.symbol, 'fill', { orderId: order.id, price: fillPrice, qty: order.qty });
}

async function maintainPendingOrders(candidates, now) {
  const active = queryActiveAutoOrders();
  if (!active.length) return;
  const candSet = new Set(candidates.map(c => c.symbol?.toUpperCase()));

  for (const order of active) {
    // 先同步成交状态（避免对已成交订单误撤单/重复挂单）
    if (await syncOrderFill(order)) continue;
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
  if (order.binance_id && !isDryRun()) {
    try {
      await cancelOrder(order.symbol, cleanBinanceId(order.binance_id));
    } catch (e) {
      // 竞态保护：撤单失败可能是挂单刚成交，先确认状态再决定是否标 cancelled
      logger.warn?.(`  ⚠ 交易所撤单失败 ${order.symbol}: ${e.message}`);
      if (await syncOrderFill(order)) {
        logger.log?.(`  ℹ ${order.symbol} 撤单前已成交，转为持仓管理`);
        return;
      }
    }
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
      // 市价单保证立即离场；双向持仓需 positionSide=LONG，单向用 reduceOnly 防反向开仓
      await placeMarketOrder({
        symbol: pos.symbol,
        side: 'SELL',
        quantity: pos.qty,
        ...(dualSidePosition ? { positionSide: 'LONG' } : { reduceOnly: true }),
      });
    } else {
      logger.log?.(`  [DRY-RUN] SELL MARKET ${pos.symbol} qty=${pos.qty}`);
    }
  } catch (e) {
    // 平仓失败不标 closed，保留持仓下轮 tick 重试（避免孤儿仓失忆）
    logger.warn?.(`  ⚠ 平仓失败 ${pos.symbol}（保留持仓下轮重试）: ${e.message}`);
    logAutoTrade(pos.symbol, 'close_fail', { posId: pos.id, reason, error: e.message });
    return;
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
      const { price: rawEntry, ema } = pickEntryPrice({ e7, e25, curPrice });
      const rules = await getSymbolRules(sym);
      const entryPrice = alignNum(rawEntry, rules.tickSize);
      const qty = calcQty(cfg.orderUsdt, entryPrice, rules);
      const pullback = ((curPrice - entryPrice) / curPrice) * 100;
      if (!qty) {
        logger.warn?.(`  ⚠ ${sym} 数量不满足交易规则（最小名义值/步长），跳过`);
        continue;
      }

      logger.log?.(`  📥 ${sym} 计划挂单: price=${entryPrice} (${ema}) · qty=${qty} · pullback=${pullback.toFixed(1)}% · cur=${curPrice}`);

      const result = await placeLimitOrder({
        symbol: sym,
        side: 'BUY',
        quantity: qty,
        price: entryPrice,
        // 双向持仓模式必须指定 positionSide，否则报 -4061
        ...(dualSidePosition ? { positionSide: 'LONG' } : {}),
      });

      const orderId = randomUUID();
      insertAutoOrder({
        id: orderId,
        symbol: sym,
        side: 'BUY',
        orderType: 'LIMIT',
        price: entryPrice,
        qty,
        binanceId: result?.orderId != null ? String(result.orderId) : null,
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

      // dry-run 下直接模拟成交开仓；LIVE 下保持 pending，由后续 tick 的 syncOrderFill 检测真实成交
      if (isDryRun()) {
        openPositionFromOrder(
          { id: orderId, symbol: sym, qty, price: entryPrice },
          entryPrice,
        );
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

/** 根据 USDT 金额 + 价格算出数量，并按交易所 stepSize/最小名义值对齐（否则报 -1111/-4164） */
function calcQty(usdt, price, rules = {}) {
  if (!price || price <= 0) return 0;
  let qty = alignNum(usdt / price, rules.stepSize);
  if (rules.minNotional > 0 && qty * price < rules.minNotional) {
    // 不满足最小名义值：向上补一个步长
    if (rules.stepSize > 0) qty = alignNum(qty + rules.stepSize, rules.stepSize);
    if (qty * price < rules.minNotional) return 0;
  }
  return qty;
}

/** 按精度步长向下截断数值（避免浮点尾差） */
function alignNum(v, step) {
  if (!step || !(step > 0) || !Number.isFinite(v)) return v;
  const decimals = step >= 1 ? 0 : Math.min(8, Math.round(-Math.log10(step)));
  return Number((Math.floor(v / step + 1e-9) * step).toFixed(decimals));
}

// ==================== 交易规则缓存（exchangeInfo） ====================

let symbolRulesCache = { map: new Map(), ts: 0 };

/** 拉取并缓存交易对精度规则（stepSize / tickSize / 最小名义值），1 小时过期 */
async function getSymbolRules(symbol) {
  const now = Date.now();
  if (now - symbolRulesCache.ts > 3600 * 1000) symbolRulesCache = { map: new Map(), ts: now };
  const hit = symbolRulesCache.map.get(symbol);
  if (hit) return hit;
  try {
    const info = await getExchangeInfo();
    for (const s of info?.symbols || []) {
      const f = s.filters || [];
      const lot = f.find(x => x.filterType === 'LOT_SIZE');
      const price = f.find(x => x.filterType === 'PRICE_FILTER');
      const notional = f.find(x => x.filterType === 'MIN_NOTIONAL');
      symbolRulesCache.map.set(s.symbol, {
        stepSize: parseFloat(lot?.stepSize || 0),
        tickSize: parseFloat(price?.tickSize || 0),
        minNotional: parseFloat(notional?.notional || notional?.minNotional || 0),
      });
    }
    symbolRulesCache.ts = now;
  } catch (e) {
    logger.warn?.(`  ⚠ exchangeInfo 拉取失败（本次不做精度对齐）: ${e.message}`);
    return {};
  }
  return symbolRulesCache.map.get(symbol) || {};
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

export { queryActiveAutoOrders as getActiveOrders, queryOpenPositions as getOpenPositions, queryAutoOrders as getAllOrders, queryAutoTradeLogs as getTradeLogs };

// ==================== 管理台操作 API（供 trade-console 页面） ====================

/** 手动撤单：撤后回查交易所真实状态，已成交则转持仓管理 */
export async function apiCancelOrder(orderId) {
  const order = queryActiveAutoOrders().find(o => o.id === orderId);
  if (!order) return { ok: false, reason: '未找到该活动挂单（可能已成交/已撤销）' };
  if (order.binance_id && !isDryRun()) {
    try {
      await cancelOrder(order.symbol, cleanBinanceId(order.binance_id));
    } catch (e) {
      if (await syncOrderFill(order)) {
        return { ok: true, result: 'filled', msg: `${order.symbol} 撤单前已成交，已转为持仓管理` };
      }
      return { ok: false, reason: `交易所撤单失败: ${e.message}` };
    }
    // 回查确认（防孤儿单）
    try {
      const ex = await getOrder(order.symbol, cleanBinanceId(order.binance_id));
      if (ex?.status === 'FILLED') {
        openPositionFromOrder(order, parseFloat(ex.avgPrice) || order.price);
        return { ok: true, result: 'filled', msg: `${order.symbol} 撤单时刚成交，已转为持仓管理` };
      }
    } catch { /* 回查失败不阻断，撤单已成功 */ }
  }
  updateAutoOrder(order.id, { status: 'cancelled', cancelledAt: Date.now() });
  logAutoTrade(order.symbol, 'cancel', { orderId: order.id, reason: 'manual', source: 'manual', binanceId: order.binance_id });
  logger.log?.(`  🖐 手动撤单 ${order.symbol} id=${order.id}`);
  return { ok: true, result: 'cancelled' };
}

/** 手动市价平仓 */
export async function apiClosePosition(posId) {
  const pos = queryOpenPositions().find(p => p.id === posId);
  if (!pos) return { ok: false, reason: '未找到该持仓' };
  let curPrice;
  try {
    const mp = await getMarkPrice(pos.symbol);
    curPrice = mp.lastPrice;
  } catch (e) {
    return { ok: false, reason: `获取现价失败: ${e.message}` };
  }
  await closeLocalPosition(pos, 'manual', curPrice);
  const stillOpen = queryOpenPositions().some(p => p.id === posId);
  if (stillOpen) return { ok: false, reason: '平仓失败（交易所拒单/超时），已保留持仓下轮重试' };
  logAutoTrade(pos.symbol, 'close_manual', { posId, source: 'manual', entry: pos.entry_price, exit: curPrice });
  return { ok: true, exitPrice: curPrice, pnlPct: +(((curPrice - pos.entry_price) / pos.entry_price) * 100).toFixed(2) };
}

/** 一键撤单（Kill Switch）：撤销全部活动挂单 */
export async function apiPanicCancel() {
  const active = queryActiveAutoOrders();
  let ok = 0, fail = 0;
  for (const order of active) {
    const r = await apiCancelOrder(order.id);
    r.ok ? ok++ : fail++;
  }
  logAutoTrade(null, 'panic_cancel', { source: 'manual', total: active.length, ok, fail });
  return { ok: true, total: active.length, cancelled: ok, failed: fail };
}

/** 管理台全局状态：引擎状态 + 账户余额 + 挂单/持仓实时价 */
export async function apiConsoleStatus() {
  const status = getAutoTraderStatus();
  let balance = null, exchangePositions = [];
  if (!isDryRun()) {
    try {
      const b = await getBalance();
      const usdt = (b.balances || []).find(x => x.asset === 'USDT');
      balance = usdt ? { total: +usdt.balance, available: +(usdt.availableBalance ?? usdt.balance) } : null;
    } catch (e) { logger.warn?.(`  ⚠ 查余额失败: ${e.message}`); }
    try { exchangePositions = await getAccountPositions(); } catch (e) { logger.warn?.(`  ⚠ 查交易所持仓失败: ${e.message}`); }
  }
  return { ...status, balance, exchangePositions };
}
