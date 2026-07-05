export const MAX_MARKET_CAP_USD = parseFloat(process.env.MAX_MARKET_CAP_USD || '5000000000');

export function isEligibleMarketCap(mc) {
  if (!MAX_MARKET_CAP_USD || MAX_MARKET_CAP_USD <= 0) return true;
  if (!mc || mc <= 0) return true;
  return mc <= MAX_MARKET_CAP_USD;
}

export function formatMaxMarketCapLabel(max = MAX_MARKET_CAP_USD) {
  if (!max || max <= 0) return '无限制';
  if (max >= 1e8) return `$${(max / 1e8).toFixed(0)}亿`;
  if (max >= 1e4) return `$${(max / 1e4).toFixed(0)}万`;
  return `$${max}`;
}
