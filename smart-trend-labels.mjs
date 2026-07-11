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

/** 8am 推送计分：多 +1、空 -1，显示总分 */
export function formatHints8amScore(longC = 0, shortC = 0) {
  const longN = longC || 0;
  const shortN = shortC || 0;
  if (!longN && !shortN) return '-';
  const total = longN - shortN;
  if (total > 0) return `+${total}`;
  if (total < 0) return `${total}`;
  return '0';
}

export function currentRatioShort(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return '-';
  return Number(ratio).toFixed(2);
}

export function tradeHintLabel(pct, strongPct = 10, { ratio } = {}) {
  if (pct == null || Number.isNaN(pct)) return '-';
  if (pct >= strongPct) {
    if (ratio != null && !Number.isNaN(ratio) && ratio <= 1) return '⚠️ 不宜追多';
    return '📈 考虑做多';
  }
  if (pct >= RATIO_WARN_PCT) {
    if (ratio != null && !Number.isNaN(ratio) && ratio <= 1) return '⚠️ 不宜追多';
    return '📈 偏做多';
  }
  if (pct <= -strongPct) return '📉 考虑做空';
  if (pct <= -RATIO_WARN_PCT) return '📉 偏做空';
  return '—';
}

/** 变多/变少最显著列表单行：净多空比 + 1h 变化 + 参考 */
export function formatTopMoveItem(row, highlightPct = 10) {
  const ratioPart = currentRatioShort(row.ratio);
  const deltaPart = ratioDeltaDisplay(row.ratioDeltaPct, highlightPct);
  const hintPart = tradeHintLabel(row.ratioDeltaPct, highlightPct, { ratio: row.ratio });
  return `**${row.label}** ${ratioPart} ${deltaPart} ${hintPart}`;
}

export function fundingChangeLabel(prev, cur, deltaPct) {
  const fmtRate = (v) => `${(v * 100).toFixed(4)}%`;
  if (cur == null || Number.isNaN(cur)) return '-';
  if (deltaPct != null && !Number.isNaN(deltaPct) && prev != null && !Number.isNaN(prev)) {
    const sign = deltaPct >= 0 ? '+' : '';
    return `${fmtRate(prev)}→${fmtRate(cur)} (${sign}${deltaPct.toFixed(1)}%)`;
  }
  if (prev != null && !Number.isNaN(prev)) return `${fmtRate(prev)}→${fmtRate(cur)}`;
  return fmtRate(cur);
}

export const DIGEST_TABLE_COLUMNS = [
  { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
  { name: 'ratio', display_name: '净多空比', data_type: 'text', width: '220px' },
  { name: 'price', display_name: '价格', data_type: 'text', width: '200px' },
  { name: 'hints8am', display_name: '8am推', data_type: 'text', width: '80px' },
  { name: 'hint', display_name: '参考', data_type: 'text', width: 'auto' },
  { name: 'mc', display_name: '市值', data_type: 'text', width: '80px' },
  { name: 'funding', display_name: '资金费变化', data_type: 'text', width: 'auto' },
];

export function buildDigestTableRows(rows, highlightPct, { showPinIcon = true } = {}) {
  return rows.map(r => ({
    coin: `${showPinIcon && r.pinned ? '📌 ' : ''}${r.label}`,
    ratio: ratioCellDisplay(r, highlightPct),
    price: priceCellDisplay(r, highlightPct),
    hints8am: r.hints8amLabel || '-',
    hint: tradeHintLabel(r.ratio8amDeltaPct, highlightPct),
    mc: r.marketCapLabel || '-',
    funding: fundingChangeLabel(r.prevFundingRate, r.fundingRate, r.fundingDeltaPct),
  }));
}
