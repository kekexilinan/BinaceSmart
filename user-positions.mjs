import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const POSITIONS_FILE = join(DATA_DIR, 'user-positions.json');

let saveQueue = Promise.resolve();

async function readAll() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const raw = await readFile(POSITIONS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function queueSave(list) {
  saveQueue = saveQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(POSITIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
  }).catch(() => {});
}

export async function getUserPositions() {
  return readAll();
}

export async function addUserPosition({ symbol, direction, entryPrice, stopLoss, takeProfit, note }) {
  const sym = String(symbol || '').toUpperCase();
  const entry = parseFloat(entryPrice);
  if (!sym.endsWith('USDT')) throw new Error('symbol 需为 USDT 合约，如 BTCUSDT');
  if (!Number.isFinite(entry) || entry <= 0) throw new Error('entryPrice 无效');
  const dir = direction === 'short' ? 'short' : 'long';

  const list = await readAll();
  const pos = {
    id: randomUUID(),
    symbol: sym,
    direction: dir,
    entryPrice: entry,
    stopLoss: stopLoss != null && stopLoss !== '' ? parseFloat(stopLoss) : null,
    takeProfit: takeProfit != null && takeProfit !== '' ? parseFloat(takeProfit) : null,
    note: note || '',
    createdAt: Date.now(),
  };
  list.push(pos);
  queueSave(list);
  return pos;
}

export async function deleteUserPosition(id) {
  const list = await readAll();
  const next = list.filter(p => p.id !== id);
  if (next.length === list.length) throw new Error('持仓不存在');
  queueSave(next);
  return { ok: true };
}
