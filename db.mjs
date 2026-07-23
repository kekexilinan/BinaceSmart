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
      source TEXT
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

  // 索引
  db.run('CREATE INDEX IF NOT EXISTS idx_sentiment_ts ON market_sentiment(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_symbol_ts ON symbol_snapshot(timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_symbol_sym_ts ON symbol_snapshot(symbol, timestamp)');
  db.run('CREATE INDEX IF NOT EXISTS idx_decision_ts ON decision_snapshot(timestamp)');

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
    INSERT INTO symbol_snapshot (timestamp, symbol, price, change_24h, change_since_8am, top_ratio, global_ratio, top_vs_global, ratio_delta_1h, ratio_delta_8am, direction, whale_ratio, score, market_cap, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    JSON.stringify((decision.action || []).map(i => ({ symbol: i.symbol, label: i.label, tradeView: i.tradeViewLabel, score: i.score, side: i.side }))),
    JSON.stringify((decision.watch || []).map(i => ({ symbol: i.symbol, label: i.label, tradeView: i.tradeViewLabel, score: i.score }))),
    JSON.stringify((decision.invalidated || []).map(i => ({ symbol: i.symbol, label: i.label, reason: i.reason }))),
    JSON.stringify((decision.reboundHighlights || []).map(i => ({ symbol: i.symbol, label: i.label, change24h: i.change24h }))),
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
           direction, whale_ratio, score, market_cap
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

/** 关闭数据库 */
export function closeDB() {
  if (saveTimer) clearInterval(saveTimer);
  persistDB();
  if (db) db.close();
  db = null;
}
