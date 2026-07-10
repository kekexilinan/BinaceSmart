export const RATIO_WARN_PCT = 5;

export function ratioDeltaLabel(pct) {
  if (pct == null || Number.isNaN(pct)) return '-';
  return pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}

export function ratioDeltaDisplay(pct, strongPct = 10) {
  if (pct == null || Number.isNaN(pct)) return '-';
  const abs = Math.abs(pct);
  const text = ratioDeltaLabel(pct);
  if (abs >= strongPct) return pct > 0 ? `🔥📈 ${text}` : `🔥📉 ${text}`;
  if (abs >= RATIO_WARN_PCT) return pct > 0 ? `⚡📈 ${text}` : `⚡📉 ${text}`;
  return text;
}

export function changeTrendLabel(row, strongPct = 10) {
  if (row.ratioDeltaPct == null) return '— 首次';
  const d = row.ratioDeltaPct;
  if (d >= strongPct) return '🔥 变多';
  if (d <= -strongPct) return '🔥 变少';
  if (d >= RATIO_WARN_PCT) return '⚡ 变多';
  if (d <= -RATIO_WARN_PCT) return '⚡ 变少';
  if (Math.abs(d) < 0.05) return '持平';
  return d > 0 ? '微增' : '微减';
}

function ratioChangeSuffix(pct, highlightPct, tag = '') {
  if (pct == null || Number.isNaN(pct)) return '';
  const abs = Math.abs(pct);
  const pctInParen = `(${ratioDeltaLabel(pct)})`;
  let icon = '';
  if (abs >= highlightPct) {
    icon = pct > 0 ? '🔥📈' : '🔥📉';
  } else if (abs >= RATIO_WARN_PCT) {
    icon = pct > 0 ? '⚡📈' : '⚡📉';
  }
  if (icon) return `${tag}${icon} ${pctInParen}`;
  if (tag) return `${tag}${pctInParen}`;
  return pctInParen;
}

function ratio8amPart(row, highlightPct) {
  if (row.ratio8amDeltaPct == null && row.ratio8am == null) return '';
  const arrow = row.ratio8am != null && row.ratio != null
    ? `${Number(row.ratio8am).toFixed(2)}→${Number(row.ratio).toFixed(2)}`
    : (row.ratio != null ? Number(row.ratio).toFixed(2) : '');
  const suffix = ratioChangeSuffix(row.ratio8amDeltaPct, highlightPct);
  if (!arrow && !suffix) return '';
  const body = suffix ? `${arrow} ${suffix}`.trim() : arrow;
  return `8am ${body}`;
}

/** 净多空比列：1h 变化 | 8am 比例变化，如 0.58→0.46 🔥📉 (-19.6%) | 8am0.75→0.60 🔥📈 (+67.1%) */
export function ratioCellDisplay(row, highlightPct = 10, ratioText = null) {
  const ratio = ratioText ?? (
    row.prevRatio != null
      ? `${row.prevRatio.toFixed(2)}→${row.ratio.toFixed(2)}`
      : (row.ratio != null ? Number(row.ratio).toFixed(2) : '-')
  );
  const h1 = ratioChangeSuffix(row.ratioDeltaPct, highlightPct);
  let result = h1 ? `${ratio} ${h1}` : ratio;
  const part8 = ratio8amPart(row, highlightPct);
  if (part8) result = `${result} | ${part8}`;
  return result;
}

export function priceChangeSuffix(pct) {
  if (pct == null || Number.isNaN(pct)) return '-';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/** 24h/8am 合并列：价格涨跌幅，如 +58.4% / +18.2% */
export function fmtDigestPrice(p) {
  if (!p || p <= 0) return '-';
  if (p >= 1000) return p.toFixed(1);
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(3);
}

function priceArrow(prev, cur) {
  if (!cur || cur <= 0) return '-';
  if (prev != null && prev > 0) return `${fmtDigestPrice(prev)}→${fmtDigestPrice(cur)}`;
  return fmtDigestPrice(cur);
}

function priceChangeCompact(pct, tag, highlightPct) {
  if (pct == null || Number.isNaN(pct)) return '';
  const abs = Math.abs(pct);
  const label = ratioDeltaLabel(pct);
  let icon = '';
  if (abs >= highlightPct) icon = pct > 0 ? '🔥📈' : '🔥📉';
  else if (abs >= RATIO_WARN_PCT) icon = pct > 0 ? '⚡📈' : '⚡📉';
  return `${tag}${icon}(${label})`;
}

function resolvePrice8am(row) {
  if (row.price8am > 0) return row.price8am;
  if (row.price > 0 && row.change8am != null && !Number.isNaN(row.change8am)) {
    return row.price / (1 + row.change8am / 100);
  }
  return null;
}

function resolvePrice24h(row) {
  if (row.price24h > 0) return row.price24h;
  if (row.price > 0 && row.change24h != null && !Number.isNaN(row.change24h)) {
    return row.price / (1 + row.change24h / 100);
  }
  return null;
}

function priceDetailParts(row) {
  const parts = [];
  const arrow1h = priceArrow(row.prevPrice, row.price);
  if (arrow1h !== '-') parts.push(arrow1h);

  const price8am = resolvePrice8am(row);
  if (price8am > 0 && row.price > 0) {
    parts.push(`8am ${fmtDigestPrice(price8am)}→${fmtDigestPrice(row.price)}`);
  }

  const price24h = resolvePrice24h(row);
  if (price24h > 0 && row.price > 0) {
    parts.push(`24h ${fmtDigestPrice(price24h)}→${fmtDigestPrice(row.price)}`);
  }
  return parts;
}

const PRICE_CELL_DETAIL_SEP = ' · ';

/** 价格列：先展示变化比例，详情（价位变化）放后面；列宽截断后悬停可看全文 */
export function priceCellDisplay(row, highlightPct = 10) {
  const pct1h = row.priceDeltaPct ?? (
    row.prevPrice > 0 && row.price > 0
      ? ((row.price - row.prevPrice) / row.prevPrice) * 100
      : null
  );
  const compact = [
    priceChangeCompact(pct1h, '1h', highlightPct),
    priceChangeCompact(row.change8am, '8am', highlightPct),
    priceChangeCompact(row.change24h, '24h', highlightPct),
  ].filter(Boolean).join(' ');

  const detail = priceDetailParts(row).join(' | ');
  if (!compact && !detail) return '-';
  if (!detail) return compact;
  if (!compact) return detail;
  return `${compact}${PRICE_CELL_DETAIL_SEP}${detail}`;
}

export function tradeHintLabel(pct, strongPct = 10) {
  if (pct == null || Number.isNaN(pct)) return '-';
  if (pct >= strongPct) return '📈 考虑做多';
  if (pct >= RATIO_WARN_PCT) return '📈 偏做多';
  if (pct <= -strongPct) return '📉 考虑做空';
  if (pct <= -RATIO_WARN_PCT) return '📉 偏做空';
  return '—';
}
