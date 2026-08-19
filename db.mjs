/**
 * SQLite 数据持久化模块 (sql.js - 纯 JS 实现)
 * 存储聪明钱监控数据，支持趋势查询
 */
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'data', 'smart-money.db');

let db = null;
let saveTimer = null;
const SAVE_INTERVAL_MS = 30_000; // 每30秒持久化一次

/** 初始化数据库 */
export async function initDB() {
  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 建表
  db.run(`
    CREATE TABLE IF NOT EXISTS market_sentiment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      n_long_1h INTEGER DEFAULT 0,
      n_short_1h INTEGER DEFAULT 0,
      n_long_8am INTEGER DEFAULT 0,
      n_short_8am INTEGER DEFAULT 0,
      cur_long INTEGER DEFAULT 0,
      cur_short INTEGER DEFAULT 0,
      cur_neutral INTEGER DEFAULT 0,
      divergence_count INTEGER DEFAULT 0,
      pool_size INTEGER DEFAULT 0,
      shift_long_1h REAL DEFAULT 0,
      shift_short_1h REAL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS symbol_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      price REAL,
      change_24h REAL,
      change_since_8am REAL,
      top_ratio REAL,
      global_ratio REAL,
      top_vs_global REAL,
      ratio_delta_1h REAL,
      ratio_delta_8am REAL,
      direction TEXT,
      whale_ratio REAL,
      score REAL,
      market_cap REAL,
      source TEXT,
      volume REAL,
      funding_rate REAL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS decision_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      verdict TEXT,
      action_json TEXT,
      watch_json TEXT,
      invalidated_json TEXT,
      rebound_json TEXT
    )
  `);

  // ===== 自动交易 =====
  db.run(`
    CREATE TABLE IF NOT EXISTS auto_orders (
      id              TEXT PRIMARY KEY,
      symbol          TEXT NOT NULL,
      side            TEXT NOT NULL,
      order_type      TEXT DEFAULT 'LIMIT',
      price           REAL NOT NULL,
      qty             REAL NOT NULL,
      binance_id      TEXT,
      ema_used        TEXT,
      pullback_pct    REAL,
      status          TEXT DEFAULT 'pending',
      smart_money_increased INTEGER DEFAULT 1,
      in_watchlist    INTEGER DEFAULT 1,
      created_at      INTEGER NOT NULL,
      filled_at       INTEGER,
      cancelled_at    INTEGER,
      ttl_min         INTEGER DEFAULT 180,
      meta_json       TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS auto_positions (
      id              TEXT PRIMARY KEY,
      symbol          TEXT NOT NULL,
      entry_price     REAL NOT NULL,
      qty             REAL NOT NULL,
      entry_order_id  TEXT,
      tp_price        REAL,
      sl_price        REAL,
      status          TEXT DEFAULT 'open',
      opened_at       INTEGER NOT NULL,
      closed_at       INTEGER,
      close_reason    TEXT,
      exit_price      REAL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS auto_trades_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      symbol          TEXT,
      action          TEXT,
      detail          TEXT
    )
  `);

  // 币况追踪：每个 tick 记录决策清单币种表现（供管理台“币况追踪”表 + 撤单宽限期判断）
  db.run(`
    CREATE TABLE IF NOT EXISTS tick_symbol_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_ts         INTEGER NOT NULL,
      symbol          TEXT NOT NULL,
      side            TEXT DEFAULT 'long',
      score           REAL,
      status          TEXT,
      status_label    TEXT,
      is_candidate    INTEGER DEFAULT 0
    )
  `);

  // 索引
  db.run('CREATE INDEX IF NOT EXISTS idx_sentiment_ts ON market_sentiment(timestamp)');
  // 存量 DB 迁移：auto_orders 补 drop_miss 列（剔出候选的连续缺席 tick 数，撤单宽限期用）
  try { db.run('ALTER TABLE auto_orders ADD COLUMN drop_miss INTEGER DEFAULT 0'); } catch { /* 列已存在 */ }
  db.run('CREATE INDEX IF NOT EXISTS idx_symbol_ts ON symbol_snapshot(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_symbol_sym_ts ON symbol_snapshot(symbol, timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_decision_ts ON decision_snapshot(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_auto_orders_status ON auto_orders(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_auto_positions_status ON auto_positions(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_auto_trades_ts ON auto_trades_log(ts)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tick_symbol_ts ON tick_symbol_log(tick_ts)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tick_symbol_sym ON tick_symbol_log(symbol, tick_ts)');

  // 定期持久化
  saveTimer = setInterval(() => persistDB(), SAVE_INTERVAL_MS);

  console.log(`  📦 数据库已初始化: ${DB_PATH}`);
  return db;
}

/** 持久化到磁盘 */
export function persistDB() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.warn(`  ⚠ DB持久化失败: ${e.message}`);
  }
}

/** 插入市场情绪数据 */
export function insertSentiment(outlook, poolSize = 0) {
  if (!db || !outlook) return;
  const now = Date.now();
  db.run(`
    INSERT INTO market_sentiment (timestamp, verdict, n_long_1h, n_short_1h, n_long_8am, n_short_8am, cur_long, cur_short, cur_neutral, divergence_count, pool_size, shift_long_1h, shift_short_1h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    now,
    outlook.verdict || '',
    outlook.nLong1h || 0,
    outlook.nShort1h || 0,
    outlook.nLong8am || 0,
    outlook.nShort8am || 0,
    outlook.curLong || 0,
    outlook.curShort || 0,
    outlook.curNeutral || 0,
    outlook.divergenceCount || 0,
    poolSize,
    outlook.shiftLong1h || 0,
    outlook.shiftShort1h || 0,
  ]);
}

/** 批量插入币种快照 */
export function insertSymbolSnapshots(rows, timestamp = Date.now()) {
  if (!db || !rows?.length) return;
  const stmt = db.prepare(`
    INSERT INTO symbol_snapshot (timestamp, symbol, price, change_24h, change_since_8am, top_ratio, global_ratio, top_vs_global, ratio_delta_1h, ratio_delta_8am, direction, whale_ratio, score, market_cap, source, volume, funding_rate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.bind([
      timestamp,
      r.symbol || '',
      r.price ?? null,
      r.change24h ?? r.change ?? null,
      r.changeSince8am ?? null,
      r.ratio ?? r.topRatio ?? r.whaleRatio ?? null,
      r.globalRatio ?? null,
      r.topVsGlobal ?? null,
      r.ratioDeltaPct ?? null,
      r.ratio8amDeltaPct ?? null,
      r.direction || null,
      r.whaleRatio ?? null,
      r.score ?? null,
      r.marketCap ?? null,
      Array.isArray(r.sources) ? r.sources.join(',') : (r.source || null),
      r.volume ?? null,
      r.fundingRate ?? null,
    ]);
    stmt.step();
    stmt.reset();
  }
  stmt.free();
}

/** 插入决策快照 */
export function insertDecisionSnapshot(decision) {
  if (!db || !decision) return;
  db.run(`
    INSERT INTO decision_snapshot (timestamp, verdict, action_json, watch_json, invalidated_json, rebound_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    decision.capturedAt || Date.now(),
    decision.summary?.verdict || '',
    JSON.stringify((decision.action || []).map(i => ({ symbol: i.symbol, label: i.label, tradeView: i.tradeViewLabel, score: i.score, side: i.side, status: i.status, statusLabel: i.statusLabel, ratioDeltaPct: i.ratioDeltaPct }))),
    JSON.stringify((decision.watch || []).map(i => ({ symbol: i.symbol, label: i.label, tradeView: i.tradeViewLabel, score: i.score, status: i.status, statusLabel: i.statusLabel, ratioDeltaPct: i.ratioDeltaPct }))),
    JSON.stringify((decision.invalidated || []).map(i => ({ symbol: i.symbol, label: i.label, reason: i.reason }))),
    JSON.stringify((decision.reboundHighlights || []).map(i => ({ symbol: i.symbol, label: i.label, change24h: i.change24h, statusLabel: i.statusLabel }))),
  ]);
}

// ==================== 查询接口 ====================

/** 查询市场情绪历史 */
export function querySentiment({ range = '24h', limit = 200 } = {}) {
  if (!db) return [];
  const since = Date.now() - parseRange(range);
  const results = db.exec(`
    SELECT timestamp, verdict, n_long_1h, n_short_1h, n_long_8am, n_short_8am,
           cur_long, cur_short, cur_neutral, divergence_count, pool_size
    FROM market_sentiment
    WHERE timestamp >= ?
    ORDER BY timestamp ASC
    LIMIT ?
  `, [since, limit]);
  return results.length ? rowsToObjects(results[0]) : [];
}

/** 查询单币种历史 */
export function querySymbolTrend({ symbol, range = '24h', limit = 200 } = {}) {
  if (!db || !symbol) return [];
  const since = Date.now() - parseRange(range);
  const results = db.exec(`
    SELECT timestamp, symbol, price, change_24h, change_since_8am,
           top_ratio, global_ratio, top_vs_global, ratio_delta_1h, ratio_delta_8am,
           direction, whale_ratio, score, market_cap, volume, funding_rate, top_vs_global
    FROM symbol_snapshot
    WHERE symbol = ? AND timestamp >= ?
    ORDER BY timestamp ASC
    LIMIT ?
  `, [symbol.toUpperCase(), since, limit]);
  return results.length ? rowsToObjects(results[0]) : [];
}

/** 查询最新一批快照的所有币种 */
export function queryLatestSnapshot() {
  if (!db) return [];
  const results = db.exec(`
    SELECT s.* FROM symbol_snapshot s
    INNER JOIN (
      SELECT symbol, MAX(timestamp) as max_ts
      FROM symbol_snapshot
      GROUP BY symbol
    ) m ON s.symbol = m.symbol AND s.timestamp = m.max_ts
    ORDER BY s.ratio_delta_1h DESC
  `);
  return results.length ? rowsToObjects(results[0]) : [];
}

/** 查询最新决策 */
export function queryLatestDecision() {
  if (!db) return null;
  const results = db.exec(`
    SELECT * FROM decision_snapshot ORDER BY timestamp DESC LIMIT 1
  `);
  if (!results.length || !results[0].values.length) return null;
  const row = rowsToObjects(results[0])[0];
  try {
    row.action = JSON.parse(row.action_json || '[]');
    row.watch = JSON.parse(row.watch_json || '[]');
    row.invalidated = JSON.parse(row.invalidated_json || '[]');
    row.rebound = JSON.parse(row.rebound_json || '[]');
  } catch {}
  return row;
}

/** 查询数据库统计 */
export function queryStats() {
  if (!db) return {};
  const sentiment = db.exec('SELECT COUNT(*) as cnt, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM market_sentiment');
  const symbols = db.exec('SELECT COUNT(*) as cnt, COUNT(DISTINCT symbol) as unique_symbols FROM symbol_snapshot');
  return {
    sentimentCount: sentiment[0]?.values[0]?.[0] || 0,
    sentimentRange: sentiment[0]?.values[0] ? [sentiment[0].values[0][1], sentiment[0].values[0][2]] : null,
    symbolSnapshotCount: symbols[0]?.values[0]?.[0] || 0,
    uniqueSymbols: symbols[0]?.values[0]?.[1] || 0,
  };
}

// ==================== 工具函数 ====================

function parseRange(range) {
  const match = range.match(/^(\d+)(h|d|w|m)$/);
  if (!match) return 24 * 3600 * 1000;
  const [, num, unit] = match;
  const ms = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
  return parseInt(num) * (ms[unit] || ms.h);
}

function rowsToObjects(result) {
  const { columns, values } = result;
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// ==================== 自动交易 CRUD ====================

/** 新增订单 */
export function insertAutoOrder(order) {
  if (!db || !order) return;
  db.run(`
    INSERT INTO auto_orders (id, symbol, side, order_type, price, qty, binance_id, ema_used, pullback_pct, status, smart_money_increased, in_watchlist, created_at, filled_at, cancelled_at, ttl_min, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    order.id, order.symbol, order.side, order.orderType || 'LIMIT',
    order.price, order.qty, order.binanceId || null,
    order.emaUsed || null, order.pullbackPct ?? null,
    order.status || 'pending',
    order.smartMoneyIncreased ? 1 : 0,
    order.inWatchlist ? 1 : 0,
    order.createdAt || Date.now(),
    order.filledAt ?? null, order.cancelledAt ?? null,
    order.ttlMin ?? 180,
    order.meta ? JSON.stringify(order.meta) : null,
  ]);
  persistDB();
}

/** 更新订单状态（status / binance_id / filled_at / cancelled_at / in_watchlist / smart_money_increased） */
export function updateAutoOrder(id, patch) {
  if (!db || !id || !patch) return;
  const keys = [];
  const vals = [];
  const allowed = [
    'status', 'binance_id', 'ema_used', 'pullback_pct',
    'smart_money_increased', 'in_watchlist', 'filled_at', 'cancelled_at',
    'price', 'qty', 'meta_json', 'drop_miss',
  ];
  for (const k of Object.keys(patch)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (!allowed.includes(col)) continue;
    let v = patch[k];
    if (col === 'meta_json' && typeof v === 'object') v = JSON.stringify(v);
    if (col === 'smart_money_increased' || col === 'in_watchlist') v = v ? 1 : 0;
    keys.push(`${col} = ?`);
    vals.push(v);
  }
  if (!keys.length) return;
  vals.push(id);
  db.run(`UPDATE auto_orders SET ${keys.join(', ')} WHERE id = ?`, vals);
  persistDB();
}

/** 查询订单（按状态过滤，默认 pending） */
export function queryAutoOrders({ status, symbol, limit = 200 } = {}) {
  if (!db) return [];
  const where = [];
  const params = [];
  if (status) {
    if (Array.isArray(status)) {
      where.push(`status IN (${status.map(() => '?').join(',')})`);
      params.push(...status);
    } else {
      where.push('status = ?');
      params.push(status);
    }
  }
  if (symbol) { where.push('symbol = ?'); params.push(symbol.toUpperCase()); }
  const sql = `SELECT * FROM auto_orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const results = db.exec(sql, params);
  return results.length ? rowsToObjects(results[0]) : [];
}

/** 查询所有活跃订单（pending + partial） */
export function queryActiveAutoOrders() {
  return queryAutoOrders({ status: ['pending', 'partial'] });
}

/** 新增持仓（买入成交后） */
export function insertAutoPosition(pos) {
  if (!db || !pos) return;
  db.run(`
    INSERT INTO auto_positions (id, symbol, entry_price, qty, entry_order_id, tp_price, sl_price, status, opened_at, closed_at, close_reason, exit_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    pos.id, pos.symbol, pos.entryPrice, pos.qty,
    pos.entryOrderId || null, pos.tpPrice ?? null, pos.slPrice ?? null,
    pos.status || 'open',
    pos.openedAt || Date.now(), pos.closedAt ?? null,
    pos.closeReason || null, pos.exitPrice ?? null,
  ]);
  persistDB();
}

export function updateAutoPosition(id, patch) {
  if (!db || !id || !patch) return;
  const sets = [];
  const vals = [];
  const allowed = ['status', 'tp_price', 'sl_price', 'qty', 'closed_at', 'close_reason', 'exit_price'];
  for (const k of Object.keys(patch)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (!allowed.includes(col)) continue;
    sets.push(`${col} = ?`);
    vals.push(patch[k]);
  }
  if (!sets.length) return;
  vals.push(id);
  db.run(`UPDATE auto_positions SET ${sets.join(', ')} WHERE id = ?`, vals);
  persistDB();
}

export function queryOpenPositions() {
  if (!db) return [];
  const results = db.exec(`SELECT * FROM auto_positions WHERE status = 'open' ORDER BY opened_at DESC`);
  return results.length ? rowsToObjects(results[0]) : [];
}

export function queryAllPositions({ limit = 200 } = {}) {
  if (!db) return [];
  const results = db.exec(`SELECT * FROM auto_positions ORDER BY opened_at DESC LIMIT ${Number(limit) | 0}`);
  return results.length ? rowsToObjects(results[0]) : [];
}

/** 写入操作流水 */
export function logAutoTrade(symbol, action, detail) {
  if (!db) return;
  db.run(`INSERT INTO auto_trades_log (ts, symbol, action, detail) VALUES (?, ?, ?, ?)`, [
    Date.now(), symbol || null, action || '', typeof detail === 'object' ? JSON.stringify(detail) : (detail || ''),
  ]);
}

// ===== 币况追踪（tick_symbol_log） =====

/** 写入本 tick 的清单币种表现，并清理超过保留天数的旧记录 */
export function insertTickSymbols(tickTs, rows, keepDays = 3) {
  if (!db || !tickTs) return;
  for (const r of rows || []) {
    db.run(`INSERT INTO tick_symbol_log (tick_ts, symbol, side, score, status, status_label, is_candidate) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      tickTs, String(r.symbol || '').toUpperCase(), r.side || 'long',
      r.score ?? null, r.status || null, r.statusLabel || null, r.isCandidate ? 1 : 0,
    ]);
  }
  db.run(`DELETE FROM tick_symbol_log WHERE tick_ts < ?`, [tickTs - keepDays * 86400_000]);
  persistDB();
}

/** 每个 tick 的时间戳（去重降序），用于 JS 侧算连续出现/缺席 */
export function queryTickTimes({ days = 3, limit = 200 } = {}) {
  if (!db) return [];
  const results = db.exec(`SELECT DISTINCT tick_ts FROM tick_symbol_log WHERE tick_ts > ? ORDER BY tick_ts DESC LIMIT ?`, [Date.now() - days * 86400_000, Number(limit) | 0]);
  return results.length ? results[0].values.map(v => v[0]) : [];
}

/** 近 N 天币种汇总（总次数/候选次数/最后出现/最新得分状态），按最后出现时间倒序 */
export function querySymbolTickStats({ days = 3 } = {}) {
  if (!db) return [];
  const cutoff = Date.now() - days * 86400_000;
  const sql = `
    SELECT t.symbol,
           COUNT(*) AS appearances,
           SUM(t.is_candidate) AS candidate_count,
           MAX(t.tick_ts) AS last_seen,
           t.score AS last_score, t.status AS last_status, t.status_label AS last_status_label,
           t.side AS last_side, t.is_candidate AS last_is_candidate
    FROM tick_symbol_log t
    JOIN (SELECT symbol AS s, MAX(tick_ts) AS mts FROM tick_symbol_log WHERE tick_ts > ? GROUP BY symbol) l
      ON t.symbol = l.s AND t.tick_ts = l.mts
    WHERE t.tick_ts > ?
    GROUP BY t.symbol
    ORDER BY last_seen DESC
  `;
  const results = db.exec(sql, [cutoff, cutoff]);
  return results.length ? rowsToObjects(results[0]) : [];
}

/** 某币种近 N 天出现过的 tick 时间戳（降序） */
export function querySymbolSeenTicks(symbol, { days = 3 } = {}) {
  if (!db || !symbol) return [];
  const results = db.exec(`SELECT DISTINCT tick_ts FROM tick_symbol_log WHERE symbol = ? AND tick_ts > ? ORDER BY tick_ts DESC`, [String(symbol).toUpperCase(), Date.now() - days * 86400_000]);
  return results.length ? results[0].values.map(v => v[0]) : [];
}

export function queryAutoTradeLogs({ limit = 200, symbol } = {}) {
  if (!db) return [];
  const where = symbol ? `WHERE symbol = ?` : '';
  const params = symbol ? [symbol.toUpperCase(), limit] : [limit];
  const results = db.exec(`SELECT * FROM auto_trades_log ${where} ORDER BY ts DESC LIMIT ?`, params);
  return results.length ? rowsToObjects(results[0]) : [];
}

/** 关闭数据库 */
export function closeDB() {
  if (saveTimer) clearInterval(saveTimer);
  persistDB();
  if (db) db.close();
  db = null;
}
