import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function fetchJSON(url) {
  try {
    const out = execFileSync("curl", ["-s", url], {timeout: 10000}).toString();
    return JSON.parse(out);
  } catch(e) { return null; }
}

const DB_PATH = '/opt/BinaceSmart/data/smart-money.db';
const WHALE_PATH = '/opt/BinaceSmart/data/whale-history.json';

const SQL = await initSqlJs();

// Start fresh from current DB
const buf = readFileSync(DB_PATH);
console.log("Current DB size:", buf.length);
const db = new SQL.Database(buf);

// Ensure tables exist
db.run(`CREATE TABLE IF NOT EXISTS market_sentiment (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, verdict TEXT NOT NULL, n_long_1h INTEGER DEFAULT 0, n_short_1h INTEGER DEFAULT 0, n_long_8am INTEGER DEFAULT 0, n_short_8am INTEGER DEFAULT 0, cur_long INTEGER DEFAULT 0, cur_short INTEGER DEFAULT 0, cur_neutral INTEGER DEFAULT 0, divergence_count INTEGER DEFAULT 0, pool_size INTEGER DEFAULT 0, shift_long_1h REAL DEFAULT 0, shift_short_1h REAL DEFAULT 0)`);
db.run(`CREATE TABLE IF NOT EXISTS symbol_snapshot (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, symbol TEXT NOT NULL, price REAL, change_24h REAL, change_since_8am REAL, top_ratio REAL, global_ratio REAL, top_vs_global REAL, ratio_delta_1h REAL, ratio_delta_8am REAL, direction TEXT, whale_ratio REAL, score REAL, market_cap REAL, source TEXT)`);
db.run(`CREATE TABLE IF NOT EXISTS decision_snapshot (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, verdict TEXT, action_json TEXT, watch_json TEXT, invalidated_json TEXT, rebound_json TEXT)`);
db.run('CREATE INDEX IF NOT EXISTS idx_sentiment_ts ON market_sentiment(timestamp)');
db.run('CREATE INDEX IF NOT EXISTS idx_symbol_ts ON symbol_snapshot(timestamp)');
db.run('CREATE INDEX IF NOT EXISTS idx_symbol_sym_ts ON symbol_snapshot(symbol, timestamp)');

// Check current state
const cnt = db.exec("SELECT COUNT(*) FROM symbol_snapshot");
console.log("Current snapshot count:", cnt[0]?.values[0][0]);

// Load whale history and insert missing records
const whaleData = JSON.parse(readFileSync(WHALE_PATH, "utf8"));
const symbols = Object.keys(whaleData);
console.log("Whale history symbols:", symbols.length);

// Get existing timestamps
const existingTs = new Set();
const stmtE = db.prepare("SELECT DISTINCT timestamp FROM symbol_snapshot");
while(stmtE.step()) { existingTs.add(stmtE.get()[0]); }
stmtE.free();
console.log("Existing distinct timestamps:", existingTs.size);

// Insert whale history data
const insStmt = db.prepare("INSERT INTO symbol_snapshot (timestamp, symbol, price, change_24h, change_since_8am, top_ratio, global_ratio, top_vs_global, ratio_delta_1h, ratio_delta_8am, direction, whale_ratio, score, market_cap, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
let inserted = 0;
for (const sym of symbols) {
  const points = whaleData[sym] || [];
  for (const p of points) {
    if (existingTs.has(p.ts)) continue;
    const ratio = p.longShortRatio || 0;
    const direction = ratio > 1 ? "long" : ratio < 1 ? "short" : "neutral";
    insStmt.bind([p.ts, sym, p.price||null, null, null, ratio, null, null, null, null, direction, ratio, null, null, "whale-history"]);
    insStmt.step();
    insStmt.reset();
    inserted++;
  }
}
insStmt.free();
console.log("Inserted from whale-history:", inserted);

// Now update BANKUSDT with price and global ratio from Binance
const bankStmt = db.prepare("SELECT id, timestamp FROM symbol_snapshot WHERE symbol = 'BANKUSDT' AND (price IS NULL OR global_ratio IS NULL) ORDER BY timestamp ASC");
const bankRecs = [];
while(bankStmt.step()) { bankRecs.push(bankStmt.getAsObject()); }
bankStmt.free();
console.log("BANK records needing price/global:", bankRecs.length);

if (bankRecs.length > 0) {
  const startTs = bankRecs[0].timestamp;
  const endTs = bankRecs[bankRecs.length-1].timestamp;
  
  const klines = fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=BANKUSDT&interval=15m&startTime=${startTs}&endTime=${endTs}&limit=500`);
  const globalData = fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BANKUSDT&period=15m&startTime=${startTs}&endTime=${endTs}&limit=500`);
  
  console.log("BANK klines:", klines?.length||0, "globalRatio:", globalData?.length||0);
  
  const priceMap = new Map();
  if (klines && Array.isArray(klines)) {
    for (const k of klines) { priceMap.set(k[0], parseFloat(k[4])); }
  }
  const globalMap = new Map();
  if (globalData && Array.isArray(globalData)) {
    for (const g of globalData) { globalMap.set(g.timestamp, parseFloat(g.longShortRatio)); }
  }

  const updStmt = db.prepare("UPDATE symbol_snapshot SET price = ?, global_ratio = ? WHERE id = ?");
  let bankUpdated = 0;
  for (const rec of bankRecs) {
    let closestPrice = null, closestGlobal = null, minDiff;
    minDiff = Infinity;
    for (const [t, p] of priceMap) { const d = Math.abs(rec.timestamp - t); if (d < minDiff && d < 15*60000) { minDiff = d; closestPrice = p; } }
    minDiff = Infinity;
    for (const [t, r] of globalMap) { const d = Math.abs(rec.timestamp - t); if (d < minDiff && d < 15*60000) { minDiff = d; closestGlobal = r; } }
    if (closestPrice || closestGlobal) {
      updStmt.bind([closestPrice, closestGlobal, rec.id]);
      updStmt.step();
      updStmt.reset();
      bankUpdated++;
    }
  }
  updStmt.free();
  console.log("BANK records updated:", bankUpdated);
}

// Save
const exported = db.export();
writeFileSync(DB_PATH, Buffer.from(exported));
console.log("DB saved. Size:", statSync(DB_PATH).size);

// Final verify
const finalCnt = db.exec("SELECT COUNT(*) FROM symbol_snapshot");
console.log("Final snapshot count:", finalCnt[0]?.values[0][0]);
const bankFinal = db.prepare("SELECT timestamp, top_ratio, global_ratio, price FROM symbol_snapshot WHERE symbol = 'BANKUSDT' ORDER BY timestamp DESC LIMIT 3");
while(bankFinal.step()) {
  const r = bankFinal.getAsObject();
  console.log(new Date(r.timestamp).toISOString().slice(11,16), "ratio:", r.top_ratio, "global:", r.global_ratio, "price:", r.price);
}
bankFinal.free();
