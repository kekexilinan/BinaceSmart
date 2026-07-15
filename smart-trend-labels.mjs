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

/** 大户持仓多空比 / 全网多空人数比：1h 变化 | 8am 变化，如 2.58→2.95 🔥📈 (+14.3%) | 8am2.10→2.58 🔥📈 (+22.9%) */
export function whaleRatioCellDisplay(row, highlightPct = 10) {
  if (row.whaleGlobalRatio == null) return '-';
  const ratio = row.prevWhaleGlobalRatio != null
    ? `${row.prevWhaleGlobalRatio.toFixed(2)}→${Number(row.whaleGlobalRatio).toFixed(2)}`
    : Number(row.whaleGlobalRatio).toFixed(2);
  const h1 = ratioChangeSuffix(row.whaleGlobalRatioDeltaPct, highlightPct);
  let result = h1 ? `${ratio} ${h1}` : ratio;
  // 8am 变化部分
  if (row.whaleGlobalRatio8am != null && row.whaleGlobalRatio > 0) {
    const arrow = `${Number(row.whaleGlobalRatio8am).toFixed(2)}→${Number(row.whaleGlobalRatio).toFixed(2)}`;
    const suffix = ratioChangeSuffix(row.whaleGlobalRatio8amDeltaPct, highlightPct);
    const part8 = suffix ? `${arrow} ${suffix}` : arrow;
    result = `${result} | 8am${part8}`;
  }
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

/** 8am推累计计分：当日每轮按 1h 净多空比变化分档(≥5%→1分,≥15%→2分,≥35%→3分)，多空分别累计后显示净分 */
export function formatHints8amScore(longC = 0, shortC = 0) {
  const longN = longC || 0;
  const shortN = shortC || 0;
  if (!longN && !shortN) return '-';
  const total = longN - shortN;
  if (total > 0) return `+${total}`;
  if (total < 0) return `${total}`;
  return '0';
}

function fmtVolume(v) {
  if (v == null || Number.isNaN(v) || v <= 0) return '-';
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return v.toFixed(0);
}

function fmtMcVolume(mcLabel, volume24h) {
  const vPart = fmtVolume(volume24h);
  if (!mcLabel || mcLabel === '?') return vPart;
  if (vPart === '-') return mcLabel;
  return `${mcLabel} ${vPart}`;
}

export function currentRatioShort(ratio) {
  if (ratio == null || Number.isNaN(ratio)) return '-';
  return Number(ratio).toFixed(2);
}

export function tradeHintLabel(pct, strongPct = 10, { ratio } = {}) {
  if (pct == null || Number.isNaN(pct)) return '-';
  if (pct >= strongPct) {
    if (ratio != null && !Number.isNaN(ratio) && ratio <= 0.75) return '⚠️ 不宜追多';
    return '📈 考虑做多';
  }
  if (pct >= RATIO_WARN_PCT) {
    if (ratio != null && !Number.isNaN(ratio) && ratio <= 0.75) return '⚠️ 不宜追多';
    return '📈 偏做多';
  }
  if (pct <= -strongPct) return '📉 考虑做空';
  if (pct <= -RATIO_WARN_PCT) return '📉 偏做空';
  return '—';
}

/** 变多/变少最显著列表单行：净多空比 + 1h 变化 + 参考 */
export function formatDivergence(row) {
  const d = row.divergence;
  if (d == null || Number.isNaN(d)) return '-';
  const label = d >= 0 ? `+${d.toFixed(2)}` : `${d.toFixed(2)}`;
  if (d >= 0.25) return `<font color='red'>${label}</font>`;
  return label;
}

/**
 * 构建急跌反弹观察高亮区块元素
 */
export function buildReboundHighlightElements(items) {
  if (!items || !items.length) return [];

  const lines = [
    `**⚡ 急跌反弹观察 · ${items.length} 个**`,
    '',
    ...items.map((item, i) => {
      const priceStr = item.price != null && item.price > 0 ? fmtDigestPrice(item.price) : '';
      const changeStr = item.change24h != null ? `${Math.abs(item.change24h).toFixed(1)}%` : '';
      const ratioStr = item.ratio != null && item.ratio > 0 ? `聪明钱偏多(${item.ratio.toFixed(2)})` : '';
      const divergenceStr = item.divergence != null && !Number.isNaN(item.divergence) && item.divergence >= 0.25
        ? `大户抄底背离+${item.divergence.toFixed(2)}` : '';
      const parts = [
        `**${item.label}**`,
        changeStr ? `跌${changeStr}` : '',
        priceStr ? `→ 反弹中(\$${priceStr})` : '',
        ratioStr,
        divergenceStr,
        '_先等价格确认_',
      ].filter(Boolean);
      return `${i + 1}. ${parts.join(' · ')}`;
    }),
    '',
  ];

  return [{ tag: 'markdown', content: lines.join('\n') }];
}

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
  { name: 'coin', display_name: '币种', data_type: 'lark_md', width: '80px' },
  { name: 'ratio', display_name: '净多空比', data_type: 'text', width: '180px' },
  { name: 'whaleRatio', display_name: '大户/全网多空比', data_type: 'text', width: '220px' },
  { name: 'price', display_name: '价格', data_type: 'text', width: '200px' },
  { name: 'hints8am', display_name: '8am推', data_type: 'text', width: '80px' },
  { name: 'mc', display_name: '市值/成交额', data_type: 'text', width: '120px' },
  { name: 'divergence', display_name: '背离', data_type: 'lark_md', width: '90px' },
  { name: 'funding', display_name: '资金费变化', data_type: 'text', width: 'auto' },
];

export function buildDigestTableRows(rows, highlightPct, { showPinIcon = true, heldSymbols = new Set() } = {}) {
  return rows.map(r => {
    const isHeld = heldSymbols.has(r.symbol?.toUpperCase());
    const hasSpot = r.hasSpot === true;
    const coinLabel = (isHeld || hasSpot) ? `~~${r.label}~~` : r.label;
    return {
      coin: `${showPinIcon && r.pinned ? '📌 ' : ''}${coinLabel}`,
      ratio: ratioCellDisplay(r, highlightPct),
      whaleRatio: whaleRatioCellDisplay(r, highlightPct),
      divergence: formatDivergence(r),
      price: priceCellDisplay(r, highlightPct),
      hints8am: r.hints8amLabel || '-',
      mc: fmtMcVolume(r.marketCapLabel, r.volume24h),
      funding: fundingChangeLabel(r.prevFundingRate, r.fundingRate, r.fundingDeltaPct),
    };
  });
}

const BOARD_SOURCE_LABELS = {
  pinned: '固定',
  gainer: '涨幅',
  loser: '跌幅',
  rightSide: '右侧',
  volumeTop: '成交额',
};

/** 将币种来源榜单 key 数组格式化为显示标签，如 "涨幅|成交额" */
export function formatBoardSources(sources) {
  if (!Array.isArray(sources) || !sources.length) return '-';
  return [...new Set(sources)].map(s => BOARD_SOURCE_LABELS[s] || s).join('|');
}

/** 榜单汇总专用列定义：末尾增加「标签」列，标识收录来源 */
export const RANKING_TABLE_COLUMNS = [
  { name: 'coin', display_name: '币种', data_type: 'lark_md', width: '80px' },
  { name: 'ratio', display_name: '净多空比', data_type: 'text', width: '180px' },
  { name: 'whaleRatio', display_name: '大户/全网多空比', data_type: 'text', width: '220px' },
  { name: 'price', display_name: '价格', data_type: 'text', width: '200px' },
  { name: 'hints8am', display_name: '8am推', data_type: 'text', width: '80px' },
  { name: 'mc', display_name: '市值/成交额', data_type: 'text', width: '120px' },
  { name: 'divergence', display_name: '背离', data_type: 'lark_md', width: '90px' },
  { name: 'funding', display_name: '资金费变化', data_type: 'text', width: 'auto' },
  { name: 'sources', display_name: '标签', data_type: 'text', width: '100px' },
];

/** 榜单汇总专用行构建：比 buildDigestTableRows 多输出 sources（标签）列 */
export function buildRankingTableRows(rows, highlightPct, { showPinIcon = true } = {}) {
  return rows.map(r => {
    const hasSpot = r.hasSpot === true;
    const coinLabel = hasSpot ? `~~${r.label}~~` : r.label;
    return {
      coin: `${showPinIcon && r.pinned ? '📌 ' : ''}${coinLabel}`,
      ratio: ratioCellDisplay(r, highlightPct),
      whaleRatio: whaleRatioCellDisplay(r, highlightPct),
      divergence: formatDivergence(r),
      price: priceCellDisplay(r, highlightPct),
      hints8am: r.hints8amLabel || '-',
      mc: fmtMcVolume(r.marketCapLabel, r.volume24h),
      funding: fundingChangeLabel(r.prevFundingRate, r.fundingRate, r.fundingDeltaPct),
      sources: formatBoardSources(r.sources),
    };
  });
}
