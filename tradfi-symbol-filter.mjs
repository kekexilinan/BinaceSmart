/**
 * 排除 Binance USDT 合约中的股票 / TradFi / 商品（如 KORU、NVDA、XAU、PAXG）
 * 依据 /fapi/v1/exchangeInfo 的 contractType / underlyingType / underlyingSubType
 */
import { fetchJson } from './proxy-setup.mjs';

const FAPI_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const CACHE_MS = 6 * 60 * 60 * 1000;

/** 历史硬编码补充（非 TRADIFI 标记但属股票/商品概念） */
const LEGACY_STOCK_SYMBOLS = new Set([
  'COINUSDT',
  'MSTRUSDT',
  'HOODUSDT',
]);

/** RWA 黄金/白银等（PERPETUAL + RWA，非 TRADIFI 标记） */
const COMMODITY_SYMBOLS = new Set([
  'PAXGUSDT',
  'XAUTUSDT',
]);

const COMMODITY_BASE_PATTERN = /^(XAU|XAG|XPT|XPD|PAXG|XAUT|COPPER|NATGAS|GOLD|SILVER)/i;

function isCommodityLike(symbol, info) {
  const sym = symbol.toUpperCase();
  if (COMMODITY_SYMBOLS.has(sym)) return true;
  if (info?.underlyingType === 'COMMODITY') return true;
  return COMMODITY_BASE_PATTERN.test(sym.replace(/USDT$/, ''));
}

let cache = {
  loadedAt: 0,
  excluded: new Set([...LEGACY_STOCK_SYMBOLS, ...COMMODITY_SYMBOLS]),
  bySymbol: new Map(),
};

export const EXCLUDE_TRADFI_SYMBOLS = process.env.EXCLUDE_TRADFI_SYMBOLS !== 'false';

function parseExtraExcludeSet() {
  const raw = process.env.EXCLUDE_SYMBOLS || '';
  return new Set(
    raw.split(/[,，\s]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .map(s => (s.endsWith('USDT') ? s : `${s}USDT`)),
  );
}

function shouldExcludeSymbolInfo(info) {
  if (!info) return false;
  if (info.contractType === 'TRADIFI_PERPETUAL') return true;
  if (info.underlyingType === 'EQUITY') return true;
  if (isCommodityLike(info.symbol, info)) return true;
  const sub = info.underlyingSubType || [];
  return sub.some(t => t === 'TradFi' || t === 'ETF' || t === 'Pre-IPO');
}

export async function loadTradFiExclusions({ force = false } = {}) {
  if (!EXCLUDE_TRADFI_SYMBOLS && !parseExtraExcludeSet().size) {
    return cache;
  }
  if (!force && cache.loadedAt && Date.now() - cache.loadedAt < CACHE_MS) {
    return cache;
  }

  const extra = parseExtraExcludeSet();
  const excluded = new Set([...LEGACY_STOCK_SYMBOLS, ...COMMODITY_SYMBOLS, ...extra]);
  const bySymbol = new Map();

  const data = await fetchJson(FAPI_EXCHANGE_INFO);
  for (const info of data.symbols || []) {
    if (info.status !== 'TRADING') continue;
    bySymbol.set(info.symbol, info);
    if (shouldExcludeSymbolInfo(info) || extra.has(info.symbol)) {
      excluded.add(info.symbol);
    }
  }

  cache = { loadedAt: Date.now(), excluded, bySymbol };
  return cache;
}

export function isTradFiSymbol(symbol) {
  const sym = symbol.toUpperCase();
  if (!EXCLUDE_TRADFI_SYMBOLS) {
    return parseExtraExcludeSet().has(sym);
  }
  if (LEGACY_STOCK_SYMBOLS.has(sym) || COMMODITY_SYMBOLS.has(sym) || parseExtraExcludeSet().has(sym)) return true;
  if (COMMODITY_BASE_PATTERN.test(sym.replace(/USDT$/, ''))) return true;
  const info = cache.bySymbol.get(sym);
  return info ? shouldExcludeSymbolInfo(info) : false;
}

export async function filterTradFiItems(items, symbolKey = 'symbol') {
  const extra = parseExtraExcludeSet();
  if (!EXCLUDE_TRADFI_SYMBOLS && !extra.size) return items;

  await loadTradFiExclusions();
  const filtered = items.filter((item) => !cache.excluded.has(item[symbolKey]));
  const removed = items.length - filtered.length;
  if (removed > 0) {
    console.log(`  [TradFi过滤] 排除 ${removed} 个股票/TradFi/商品 合约`);
  }
  return filtered;
}

export async function warmupTradFiExclusions() {
  if (!EXCLUDE_TRADFI_SYMBOLS && !parseExtraExcludeSet().size) return 0;
  await loadTradFiExclusions({ force: true });
  return cache.excluded.size;
}
