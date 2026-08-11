import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSmartSignal } from './scan-smart-signal.mjs';
import { insertSymbolSnapshots } from './db.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const HISTORY_FILE = join(DATA_DIR, 'whale-history.json');

const INTERVAL_MS = parseInt(process.env.WHALE_HISTORY_INTERVAL_MIN || '5', 10) * 60 * 1000;
const MAX_POINTS = parseInt(process.env.WHALE_HISTORY_MAX_POINTS || '720', 10);
const SAVE_DEBOUNCE_MS = parseInt(process.env.WHALE_HISTORY_SAVE_DEBOUNCE_SEC || '30', 10) * 1000;
const MIN_RECORD_GAP_MS = parseInt(process.env.WHALE_HISTORY_MIN_GAP_MIN || '1', 10) * 60 * 1000;
const DEFAULT_SYMBOLS = (process.env.WHALE_HISTORY_SYMBOLS || 'SLXUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

let history = {};
let historyReady = false;
let saveQueue = Promise.resolve();
let activeSymbols = new Set(DEFAULT_SYMBOLS);
let collectorTimer = null;

async function ensureHistoryLoaded() {
  if (historyReady) return;
  history = await readHistoryFile();
  historyReady = true;
}

async function readHistoryFile() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const raw = await readFile(HISTORY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

let savePending = false;
let saveTimer = null;

function flushSave() {
  savePending = false;
  saveQueue = saveQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(HISTORY_FILE, JSON.stringify(history), 'utf8');
  }).catch(() => {});
}

/** 防抖保存：高频快照写入合并为一次全量写盘，避免反复序列化大 JSON 拖垮 CPU */
function queueSave() {
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (savePending) flushSave();
  }, SAVE_DEBOUNCE_MS);
}

export function extractWhaleSnapshot(raw, price = null) {
  const longWhalesQty = parseFloat(raw.longWhalesQty) || 0;
  const shortWhalesQty = parseFloat(raw.shortWhalesQty) || 0;
  return {
    ts: Date.now(),
    longShortRatio: parseFloat(raw.longShortRatio) || 0,
    longWhalesQty,
    shortWhalesQty,
    whaleRatio: shortWhalesQty > 0 ? longWhalesQty / shortWhalesQty : (longWhalesQty > 0 ? 99 : 1),
    longProfitWhales: parseInt(raw.longProfitWhales, 10) || 0,
    shortProfitWhales: parseInt(raw.shortProfitWhales, 10) || 0,
    longTraders: parseInt(raw.longTraders, 10) || 0,
    shortTraders: parseInt(raw.shortTraders, 10) || 0,
    longWhalesAvgEntryPrice: parseFloat(raw.longWhalesAvgEntryPrice) || 0,
    shortWhalesAvgEntryPrice: parseFloat(raw.shortWhalesAvgEntryPrice) || 0,
    price: price > 0 ? price : null,
  };
}

export function registerActiveSymbol(symbol) {
  if (symbol) activeSymbols.add(symbol.toUpperCase());
}

export async function recordWhaleSnapshot(symbol, raw, price = null) {
  if (!raw) return null;
  await ensureHistoryLoaded();

  const sym = symbol.toUpperCase();
  registerActiveSymbol(sym);
  const snap = extractWhaleSnapshot(raw, price);

  if (!history[sym]) history[sym] = [];
  const arr = history[sym];
  const last = arr[arr.length - 1];
  if (last && snap.ts - last.ts < MIN_RECORD_GAP_MS) {
    arr[arr.length - 1] = snap;
  } else {
    arr.push(snap);
  }
  if (arr.length > MAX_POINTS) history[sym] = arr.slice(-MAX_POINTS);

  queueSave();
  return snap;
}

export async function getWhaleHistory(symbol, hours = 72) {
  await saveQueue;
  await ensureHistoryLoaded();

  const sym = symbol.toUpperCase();
  const arr = history[sym] || [];
  const h = Math.max(1, parseInt(hours, 10) || 72);
  const cutoff = Date.now() - h * 3600 * 1000;
  return {
    symbol: sym,
    points: arr.filter(p => p.ts >= cutoff),
    totalPoints: arr.length,
    collectorIntervalMin: INTERVAL_MS / 60000,
  };
}

export async function getWhaleHistoryBulk(symbols, hours = 24) {
  await saveQueue;
  await ensureHistoryLoaded();
  const h = Math.max(1, parseInt(hours, 10) || 24);
  const cutoff = Date.now() - h * 3600 * 1000;
  const result = {};
  for (const sym of symbols) {
    const upper = sym.toUpperCase();
    result[upper] = (history[upper] || []).filter(p => p.ts >= cutoff);
  }
  return result;
}

export async function startWhaleCollector() {
  if (collectorTimer) return;
  await ensureHistoryLoaded();

  async function tick() {
    await ensureHistoryLoaded();
    const dbRows = [];
    for (const sym of [...activeSymbols]) {
      try {
        const raw = await fetchSmartSignal(sym);
        const snap = await recordWhaleSnapshot(sym, raw);
        if (snap) {
          dbRows.push({
            symbol: sym,
            ratio: snap.longShortRatio,
            price: snap.price || null,
            whaleRatio: snap.whaleRatio,
            direction: snap.longShortRatio > 1 ? 'long' : snap.longShortRatio < 1 ? 'short' : 'neutral',
          });
        }
      } catch (e) {
        console.warn(`  ⚠ 鲸鱼历史采集 ${sym} 失败: ${e.message}`);
      }
    }
    if (savePending) flushSave();
    await saveQueue;
    // Fetch batch prices and write to SQLite DB
    if (dbRows.length > 0) {
      try {
        const { stdout: tickerJson } = await execFileAsync("curl", ["-s", "--max-time", "8", "https://fapi.binance.com/fapi/v1/ticker/24hr"], { timeout: 12000, maxBuffer: 64 * 1024 * 1024 });
        const tickers = JSON.parse(tickerJson);
        const tickerMap = new Map(tickers.map(t => [t.symbol, { price: parseFloat(t.lastPrice), change24h: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume) || 0 }]));
        for (const row of dbRows) {
          const t = tickerMap.get(row.symbol);
          if (t) {
            row.price = row.price || t.price;
            row.change24h = t.change24h;
            row.volume = t.volume;
          }
        }
      } catch (e) { /* ticker fetch failed, continue without */ }

      // Fetch funding rates from premiumIndex
      try {
        const { stdout: fundingJson } = await execFileAsync("curl", ["-s", "--max-time", "8", "https://fapi.binance.com/fapi/v1/premiumIndex"], { timeout: 12000, maxBuffer: 64 * 1024 * 1024 });
        const fundingArr = JSON.parse(fundingJson);
        const fundingMap = new Map(fundingArr.map(f => [f.symbol, parseFloat(f.lastFundingRate) * 100]));
        for (const row of dbRows) {
          const fr = fundingMap.get(row.symbol);
          if (fr != null) row.fundingRate = fr;
        }
      } catch (e) { /* funding rate fetch failed */ }

      // Batch fetch global long/short ratio (5 at a time with 200ms delay)
      try {
        const batchSize = 10;
        for (let i = 0; i < dbRows.length; i += batchSize) {
          const batch = dbRows.slice(i, i + batchSize);
          await Promise.all(batch.map(async (row) => {
            try {
              const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${row.symbol}&period=15m&limit=1`;
              const { stdout: res } = await execFileAsync("curl", ["-s", "--max-time", "5", url], { timeout: 8000 });
              const arr = JSON.parse(res);
              if (arr && arr.length > 0) {
                row.globalRatio = parseFloat(arr[0].longShortRatio);
              }
            } catch {}
          }));
          if (i + batchSize < dbRows.length) await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) { console.warn("  [whale-db] global ratio fetch error:", e.message); }
      // Batch fetch topLongShortPositionRatio (correct whale_ratio)
      try {
        const batchSize2 = 10;
        for (let i = 0; i < dbRows.length; i += batchSize2) {
          const batch = dbRows.slice(i, i + batchSize2);
          await Promise.all(batch.map(async (row) => {
            try {
              const url = `https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${row.symbol}&period=15m&limit=1`;
              const { stdout: res } = await execFileAsync("curl", ["-s", "--max-time", "5", url], { timeout: 8000 });
              const arr = JSON.parse(res);
              if (arr && arr.length > 0) {
                row.whaleRatio = parseFloat(arr[0].longShortRatio);
              }
            } catch {}
          }));
          if (i + batchSize2 < dbRows.length) await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) { console.warn("  [whale-db] position ratio fetch error:", e.message); }

      try { insertSymbolSnapshots(dbRows); console.log("  [whale-db] wrote " + dbRows.length + " rows"); } catch (e) { console.warn("  [whale-db] error:", e.message); }
    }
  }

  setTimeout(tick, 15000);
  collectorTimer = setInterval(tick, INTERVAL_MS);
  console.log(`  📈 鲸鱼 Smart Signal 历史采集已启动 (${INTERVAL_MS / 60000}min/次, ${activeSymbols.size} 币种)`);
}
