/**
 * 检查 Binance 现货（Spot）交易对是否存在
 * 依据 /api/v3/exchangeInfo 的 symbols + status + isSpotTradingAllowed
 * 与 tradfi-symbol-filter.mjs 同模式：异步加载 + 缓存 + 同步判断
 */
import { fetchJson } from './proxy-setup.mjs';

const SPOT_EXCHANGE_INFO = 'https://api.binance.com/api/v3/exchangeInfo';
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 小时缓存

/** 是否启用现货过滤（默认关闭，需显式开启） */
export const FILTER_SPOT_ONLY = process.env.FILTER_SPOT_ONLY === 'true';

let cache = {
  loadedAt: 0,
  spotSymbols: new Set(),       // 所有现货 TRADING 交易对，如 BTCUSDT
  spotBaseAssets: new Set(),   // 所有有现货交易的基础资产，如 BTC
};

/**
 * 异步加载现货交易对列表并缓存
 * @param {{ force?: boolean }} opts
 */
export async function loadSpotSymbols({ force = false } = {}) {
  if (!force && cache.loadedAt && Date.now() - cache.loadedAt < CACHE_MS) {
    return cache;
  }

  const data = await fetchJson(SPOT_EXCHANGE_INFO, {
    timeoutMs: 30000,
    preferCurl: process.platform === 'win32',
  });

  const spotSymbols = new Set();
  const spotBaseAssets = new Set();

  for (const s of data.symbols || []) {
    if (s.status !== 'TRADING') continue;
    if (!s.isSpotTradingAllowed) continue;
    spotSymbols.add(s.symbol);
    spotBaseAssets.add(s.baseAsset);
  }

  cache = {
    loadedAt: Date.now(),
    spotSymbols,
    spotBaseAssets,
  };

  console.log(`  [现货检查] 已加载 ${spotSymbols.size} 个现货交易对，${spotBaseAssets.size} 个基础资产`);
  return cache;
}

/**
 * 同步判断某个交易对是否有现货交易（需先 loadSpotSymbols）
 * @param {string} symbol - 交易对，如 BTCUSDT
 * @returns {boolean}
 */
export function hasSpotTrading(symbol) {
  const sym = symbol.toUpperCase();
  return cache.spotSymbols.has(sym);
}

/**
 * 同步判断某个币是否有现货交易（按基础资产匹配）
 * 例如传入 BTCUSDT → 检查 BTC 是否在现货基础资产中
 * @param {string} symbol - 合约交易对，如 BTCUSDT
 * @returns {boolean}
 */
export function hasSpotAsset(symbol) {
  const sym = symbol.toUpperCase();
  const base = sym.replace(/USDT$/, '').replace(/BUSD$/, '').replace(/USDC$/, '');
  if (!base) return false;
  return cache.spotBaseAssets.has(base);
}

/**
 * 过滤掉没有现货交易对的标的（异步，自动加载缓存）
 * @param {Array} items - 待过滤数组
 * @param {string} symbolKey - symbol 字段名
 * @param {{ useAssetMatch?: boolean }} opts - useAssetMatch=true 时按基础资产匹配
 * @returns {Promise<Array>}
 */
export async function filterSpotItems(items, symbolKey = 'symbol', { useAssetMatch = false } = {}) {
  if (!FILTER_SPOT_ONLY) return items;

  await loadSpotSymbols();
  const checkFn = useAssetMatch ? hasSpotAsset : hasSpotTrading;

  const filtered = items.filter((item) => checkFn(item[symbolKey]));
  const removed = items.length - filtered.length;
  if (removed > 0) {
    console.log(`  [现货过滤] 排除 ${removed} 个无现货交易对的合约`);
  }
  return filtered;
}

/**
 * 预热缓存，返回现货交易对数量
 * 始终加载（FILTER_SPOT_ONLY=false 时也需用于标记删除线）
 */
export async function warmupSpotSymbols() {
  await loadSpotSymbols({ force: true }).catch(() => {});
  return cache.spotSymbols.size;
}
