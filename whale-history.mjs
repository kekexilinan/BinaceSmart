import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSmartSignal } from './scan-smart-signal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const HISTORY_FILE = join(DATA_DIR, 'whale-history.json');

const INTERVAL_MS = parseInt(process.env.WHALE_HISTORY_INTERVAL_MIN || '5', 10) * 60 * 1000;
const MAX_POINTS = parseInt(process.env.WHALE_HISTORY_MAX_POINTS || '2016', 10);
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

function queueSave() {
  saveQueue = saveQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(HISTORY_FILE, JSON.stringify(history), 'utf8');
  }).catch(() => {});
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

export async function startWhaleCollector() {
  if (collectorTimer) return;
  await ensureHistoryLoaded();

  async function tick() {
    await ensureHistoryLoaded();
    for (const sym of [...activeSymbols]) {
      try {
        const raw = await fetchSmartSignal(sym);
        await recordWhaleSnapshot(sym, raw);
      } catch (e) {
        console.warn(`  ⚠ 鲸鱼历史采集 ${sym} 失败: ${e.message}`);
      }
    }
    await saveQueue;
  }

  setTimeout(tick, 15000);
  collectorTimer = setInterval(tick, INTERVAL_MS);
  console.log(`  📈 鲸鱼 Smart Signal 历史采集已启动 (${INTERVAL_MS / 60000}min/次, ${activeSymbols.size} 币种)`);
}
