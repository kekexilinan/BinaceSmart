/**
 * backfill-all.mjs - 为所有币种补全 price 和 global_ratio
 * 从 Binance API 批量获取历史 klines 和 globalLongShortAccountRatio
 */
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DB_PATH = '/opt/BinaceSmart/data/smart-money.db';
const DELAY_MS = 300; // API 调用间隔

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  try {
    const out = execFileSync("curl", ["-s", "--max-time", "10", url], {timeout: 15000}).toString();
    return JSON.parse(out);
  } catch(e) { return null; }
}

const SQL = await initSqlJs();
const buf = readFileSync(DB_PATH);
const db = new SQL.Database(buf);

// Get all symbols that need price or global_ratio
const symbolsResult = db.exec(`
  SELECT symbol, MIN(timestamp) as min_ts, MAX(timestamp) as max_ts, COUNT(*) as cnt
  FROM symbol_snapshot
  WHERE price IS NULL OR global_ratio IS NULL
  GROUP BY symbol
  ORDER BY cnt DESC
`);

if (!symbolsResult.length) {
  console.log("No records need filling.");
  process.exit(0);
}

const symbols = symbolsResult[0].values.map(v => ({
  symbol: v[0], minTs: v[1], maxTs: v[2], count: v[3]
}));

console.log(`Processing ${symbols.length} symbols, ${symbols.reduce((s,x) => s+x.count, 0)} total records`);

const updStmt = db.prepare("UPDATE symbol_snapshot SET price = COALESCE(price, ?), global_ratio = COALESCE(global_ratio, ?) WHERE id = ?");

let totalUpdated = 0;
let successSymbols = 0;
let failedSymbols = [];

for (let i = 0; i < symbols.length; i++) {
  const { symbol, minTs, maxTs, count } = symbols[i];
  
  // Skip invalid symbols
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
    failedSymbols.push(symbol + " (invalid)");
    continue;
  }

  process.stdout.write(`\r[${i+1}/${symbols.length}] ${symbol} (${count} records)...`);

  // Get records for this symbol
  const recsResult = db.exec(
    "SELECT id, timestamp FROM symbol_snapshot WHERE symbol = ? AND (price IS NULL OR global_ratio IS NULL) ORDER BY timestamp ASC",
    [symbol]
  );
  if (!recsResult.length) continue;
  const recs = recsResult[0].values.map(v => ({ id: v[0], ts: v[1] }));

  // Fetch klines
  const klines = fetchJSON(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&startTime=${minTs}&endTime=${maxTs}&limit=500`
  );
  await sleep(DELAY_MS);

  // Fetch global ratio
  const globalData = fetchJSON(
    `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=15m&startTime=${minTs}&endTime=${maxTs}&limit=500`
  );
  await sleep(DELAY_MS);

  // Build lookup maps
  const priceMap = new Map();
  if (klines && Array.isArray(klines)) {
    for (const k of klines) { priceMap.set(k[0], parseFloat(k[4])); }
  }
  const globalMap = new Map();
  if (globalData && Array.isArray(globalData)) {
    for (const g of globalData) { globalMap.set(g.timestamp, parseFloat(g.longShortRatio)); }
  }

  if (priceMap.size === 0 && globalMap.size === 0) {
    failedSymbols.push(symbol);
    continue;
  }

  // Update records
  let symUpdated = 0;
  for (const rec of recs) {
    let closestPrice = null, closestGlobal = null, minDiff;

    // Find closest price (within 15 min)
    minDiff = Infinity;
    for (const [t, p] of priceMap) {
      const d = Math.abs(rec.ts - t);
      if (d < minDiff && d < 15 * 60000) { minDiff = d; closestPrice = p; }
    }

    // Find closest global ratio (within 15 min)
    minDiff = Infinity;
    for (const [t, r] of globalMap) {
      const d = Math.abs(rec.ts - t);
      if (d < minDiff && d < 15 * 60000) { minDiff = d; closestGlobal = r; }
    }

    if (closestPrice !== null || closestGlobal !== null) {
      updStmt.bind([closestPrice, closestGlobal, rec.id]);
      updStmt.step();
      updStmt.reset();
      symUpdated++;
    }
  }

  totalUpdated += symUpdated;
  if (symUpdated > 0) successSymbols++;
}

updStmt.free();
console.log(`\n\nDone! Updated ${totalUpdated} records across ${successSymbols} symbols`);
if (failedSymbols.length > 0) {
  console.log(`Failed/skipped (${failedSymbols.length}):`, failedSymbols.slice(0, 10).join(", "), failedSymbols.length > 10 ? "..." : "");
}

// Save
const exported = db.export();
writeFileSync(DB_PATH, Buffer.from(exported));
console.log("DB saved. Size:", statSync(DB_PATH).size);

// Verify
const verify = db.exec("SELECT COUNT(*) FROM symbol_snapshot WHERE price IS NOT NULL AND global_ratio IS NOT NULL");
console.log("Records with both price+global:", verify[0].values[0][0]);
const still = db.exec("SELECT COUNT(*) FROM symbol_snapshot WHERE price IS NULL AND global_ratio IS NULL");
console.log("Records still missing both:", still[0].values[0][0]);
