const DECISION_STATE_MAX_AGE_MS = 48 * 3600 * 1000;

const VIEW_META = {
  trend_long: { label: '趋势做多候选', side: 'long', group: 'action' },
  rebound_watch: { label: '超跌反弹观察', side: 'long', group: 'action' },
  accumulation: { label: '聪明钱吸筹观察', side: 'long', group: 'watch' },
  pump_risk: { label: '冲高风险观察', side: 'short', group: 'action' },
  downtrend_risk: { label: '下跌延续风险', side: 'short', group: 'action' },
  distribution: { label: '聪明钱派发风险', side: 'short', group: 'watch' },
  neutral_watch: { label: '观望', side: 'neutral', group: 'watch' },
};

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fmtPct(v, digits = 1) {
  const n = num(v);
  if (n == null) return '-';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function fmtRatio(v) {
  const n = num(v);
  if (n == null) return '-';
  return n.toFixed(2);
}

function fmtVolume(v) {
  const n = num(v);
  if (n == null) return '-';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function boardSourceLabel(key, rank) {
  if (key === 'gainer') return `涨幅#${rank}`;
  if (key === 'loser') return `跌幅#${rank}`;
  if (key === 'volumeTop') return `额#${rank}`;
  if (key === 'rightSide') return '右侧';
  if (key === 'pinned') return '固定';
  return key;
}

function sourceRank(sources, key) {
  const s = sources.find(x => x.key === key);
  return s?.rank ?? null;
}

function hasSource(sources, key) {
  return sources.some(s => s.key === key);
}

function mergeRowsBySymbol(boards) {
  const map = new Map();
  let rawRows = 0;

  for (const board of boards || []) {
    const rows = board?.rows || [];
    rows.forEach((row, idx) => {
      if (!row?.symbol) return;
      rawRows += 1;
      const symbol = row.symbol.toUpperCase();
      const prev = map.get(symbol) || {
        symbol,
        label: row.label || symbol.replace(/USDT$/, ''),
        sources: [],
      };

      const merged = { ...prev };
      for (const field of [
        'badge',
        'direction',
        'ratio',
        'prevRatio',
        'ratioDeltaPct',
        'ratio8am',
        'ratio8amDeltaPct',
        'change24h',
        'change8am',
        'price',
        'prevPrice',
        'fundingRate',
        'prevFundingRate',
        'fundingDeltaPct',
        'hints8amLabel',
        'marketCapLabel',
        'volumeRank',
      ]) {
        if (merged[field] == null && row[field] != null) merged[field] = row[field];
      }

      if (row.volumeRank != null) merged.volumeRank = row.volumeRank;
      if (row.change24h != null) merged.change24h = row.change24h;
      if (row.change8am != null) merged.change8am = row.change8am;
      merged.sources = [
        ...prev.sources,
        {
          key: board.key,
          rank: idx + 1,
          label: boardSourceLabel(board.key, idx + 1),
        },
      ];
      map.set(symbol, merged);
    });
  }

  return {
    rows: [...map.values()],
    rawRows,
    uniqueRows: map.size,
  };
}

function classifyView(row, sources) {
  const change = num(row.change24h) ?? num(row.change8am);
  const direction = row.direction || (num(row.ratio) != null && row.ratio >= 1 ? 'long' : 'short');
  const longBias = direction === 'long';
  const d1 = num(row.ratioDeltaPct);
  const d8 = num(row.ratio8amDeltaPct);

  if (change != null && change >= 15 && longBias) return 'trend_long';
  if (change != null && change >= 15 && !longBias) return 'pump_risk';
  if (change != null && change <= -10 && longBias) return 'rebound_watch';
  if (change != null && change <= -10 && !longBias) return 'downtrend_risk';
  if (longBias && (d1 >= 5 || d8 >= 5 || row.ratio >= 1.25 || hasSource(sources, 'rightSide'))) return 'accumulation';
  if (!longBias && (d1 <= -5 || d8 <= -5 || row.ratio <= 0.8 || hasSource(sources, 'rightSide'))) return 'distribution';
  return 'neutral_watch';
}

function calcScore(row, sources, highlightPct) {
  let score = 35;
  const change = Math.abs(num(row.change24h) ?? num(row.change8am) ?? 0);
  const ratio = num(row.ratio);
  const d1 = Math.abs(num(row.ratioDeltaPct) ?? 0);
  const d8 = Math.abs(num(row.ratio8amDeltaPct) ?? 0);
  const gainerRank = sourceRank(sources, 'gainer');
  const loserRank = sourceRank(sources, 'loser');
  const volumeRank = sourceRank(sources, 'volumeTop');

  score += Math.min(18, Math.max(0, sources.length - 1) * 7);
  if (hasSource(sources, 'rightSide')) score += 8;
  if (gainerRank && gainerRank <= 5) score += 12;
  else if (gainerRank && gainerRank <= 15) score += 7;
  if (loserRank && loserRank <= 5) score += 12;
  else if (loserRank && loserRank <= 15) score += 7;
  if (volumeRank && volumeRank <= 5) score += 14;
  else if (volumeRank && volumeRank <= 15) score += 10;
  else if (volumeRank && volumeRank <= 30) score += 5;

  if (change >= 30) score += 16;
  else if (change >= 15) score += 11;
  else if (change >= 8) score += 6;

  if (row.direction === 'long' && ratio != null && ratio >= 1.5) score += 10;
  if (row.direction === 'short' && ratio != null && ratio <= 0.5) score += 10;
  if (Math.max(d1, d8) >= highlightPct) score += 12;
  else if (Math.max(d1, d8) >= 5) score += 6;

  if (sources.length === 1 && hasSource(sources, 'volumeTop') && change < 3) score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function confidenceFrom(score, sources) {
  if (score >= 78 && sources.length >= 2) return '高';
  if (score >= 62) return '中';
  return '低';
}

function buildReasons(row, sources, viewKey) {
  const reasons = [];
  const change = num(row.change24h) ?? num(row.change8am);
  const volumeRank = sourceRank(sources, 'volumeTop');

  if (sources.length >= 2) reasons.push('多榜共振');
  if (change != null && Math.abs(change) >= 8) reasons.push(`24h ${fmtPct(change)}`);
  if (volumeRank && volumeRank <= 10) reasons.push(`成交额#${volumeRank}`);
  if (hasSource(sources, 'rightSide')) reasons.push('右侧形态');
  if (row.direction === 'long') reasons.push(`聪明钱偏多 ${fmtRatio(row.ratio)}`);
  if (row.direction === 'short') reasons.push(`聪明钱偏空 ${fmtRatio(row.ratio)}`);
  if (num(row.ratioDeltaPct) != null && Math.abs(row.ratioDeltaPct) >= 5) reasons.push(`1hΔ ${fmtPct(row.ratioDeltaPct)}`);
  if (num(row.ratio8amDeltaPct) != null && Math.abs(row.ratio8amDeltaPct) >= 5) reasons.push(`8amΔ ${fmtPct(row.ratio8amDeltaPct)}`);

  if (viewKey === 'pump_risk') reasons.push('暴涨不直接追多');
  if (viewKey === 'rebound_watch') reasons.push('先等价格确认');
  return [...new Set(reasons)].slice(0, 4);
}

function resolveContinuity(item, prev, now) {
  if (!prev || !prev.lastSeenAt || now - prev.lastSeenAt > DECISION_STATE_MAX_AGE_MS) {
    return {
      status: 'new',
      statusLabel: '新出现',
      streak: 1,
      pendingSide: null,
      pendingStreak: 0,
      stateSide: item.side,
      groupOverride: null,
      firstSeenAt: now,
    };
  }

  const prevSide = prev.side || 'neutral';
  const opposite = prevSide !== 'neutral' && item.side !== 'neutral' && prevSide !== item.side;
  if (opposite) {
    const pendingStreak = prev.pendingSide === item.side ? (prev.pendingStreak || 0) + 1 : 1;
    if (item.score < 80 && pendingStreak < 2) {
      return {
        status: 'reversal_watch',
        statusLabel: `反向待确认${pendingStreak}/2`,
        streak: 1,
        pendingSide: item.side,
        pendingStreak,
        stateSide: prevSide,
        groupOverride: 'watch',
        firstSeenAt: prev.firstSeenAt || now,
      };
    }
    return {
      status: 'reversed',
      statusLabel: '反转确认',
      streak: 1,
      pendingSide: null,
      pendingStreak: 0,
      stateSide: item.side,
      groupOverride: null,
      firstSeenAt: now,
    };
  }

  const streak = prevSide === item.side ? (prev.streak || 0) + 1 : 1;
  const scoreDelta = item.score - (prev.score || 0);
  let status = 'continued';
  let statusLabel = `延续${streak}h`;
  if (scoreDelta >= 8) {
    status = 'strengthened';
    statusLabel = `加强${streak}h`;
  } else if (scoreDelta <= -12) {
    status = 'weakened';
    statusLabel = `减弱${streak}h`;
  }
  return {
    status,
    statusLabel,
    streak,
    pendingSide: null,
    pendingStreak: 0,
    stateSide: item.side,
    groupOverride: null,
    firstSeenAt: prev.firstSeenAt || now,
  };
}

function makeStateEntry(item, continuity, now, group) {
  return {
    symbol: item.symbol,
    label: item.label,
    side: continuity.stateSide,
    tradeView: item.tradeView,
    tradeViewLabel: item.tradeViewLabel,
    score: item.score,
    confidence: item.confidence,
    status: item.status,
    group,
    streak: item.streak,
    pendingSide: continuity.pendingSide,
    pendingStreak: continuity.pendingStreak,
    firstSeenAt: continuity.firstSeenAt,
    lastSeenAt: now,
  };
}

function buildItem(row, highlightPct, previousState, now) {
  const sources = row.sources || [];
  const tradeView = classifyView(row, sources);
  const meta = VIEW_META[tradeView] || VIEW_META.neutral_watch;
  const score = calcScore(row, sources, highlightPct);
  const item = {
    symbol: row.symbol,
    label: row.label || row.symbol.replace(/USDT$/, ''),
    tradeView,
    tradeViewLabel: meta.label,
    side: meta.side,
    baseGroup: meta.group,
    score,
    confidence: confidenceFrom(score, sources),
    sourceTags: sources.map(s => s.label),
    sourceKeys: sources.map(s => s.key),
    change24h: num(row.change24h),
    change8am: num(row.change8am),
    ratio: num(row.ratio),
    ratioDeltaPct: num(row.ratioDeltaPct),
    ratio8amDeltaPct: num(row.ratio8amDeltaPct),
    fundingRate: num(row.fundingRate),
    volume: num(row.volumeRank),
    reasons: buildReasons(row, sources, tradeView),
  };

  const continuity = resolveContinuity(item, previousState?.[item.symbol], now);
  item.status = continuity.status;
  item.statusLabel = continuity.statusLabel;
  item.streak = continuity.streak;
  item.group = continuity.groupOverride || item.baseGroup;
  item.firstSeenAt = continuity.firstSeenAt;
  item.lastSeenAt = now;
  item.stateSide = continuity.stateSide;
  item.pendingSide = continuity.pendingSide;
  item.pendingStreak = continuity.pendingStreak;
  return { item, continuity };
}

function sortDecisionItems(a, b) {
  if (a.status === 'reversal_watch' && b.status !== 'reversal_watch') return -1;
  if (a.status !== 'reversal_watch' && b.status === 'reversal_watch') return 1;
  return b.score - a.score;
}

function buildSummary(action, watch, invalidated, stats, outlook) {
  const longCount = action.filter(i => i.side === 'long').length;
  const shortCount = action.filter(i => i.side === 'short').length;
  const reversalCount = watch.filter(i => i.status === 'reversal_watch').length;
  let verdict = '观望';
  let template = 'blue';
  if (longCount > shortCount + 1) {
    verdict = '机会偏多';
    template = 'green';
  } else if (shortCount > longCount + 1) {
    verdict = '风险偏空';
    template = 'red';
  } else if (action.length) {
    verdict = '多空分歧';
    template = 'orange';
  }

  const oldVerdict = outlook?.verdict ? `旧研判: ${outlook.verdict}` : '';
  const advice = action.length
    ? `重点看 ${action.length} 个，观察 ${watch.length} 个；反向信号先要求连续确认，避免小时级来回反手。`
    : `暂无足够强的可行动候选，先观察聪明钱连续性。`;

  return {
    verdict,
    template,
    advice,
    actionCount: action.length,
    watchCount: watch.length,
    invalidatedCount: invalidated.length,
    longCount,
    shortCount,
    reversalCount,
    oldVerdict,
    dedupe: {
      rawRows: stats.rawRows,
      uniqueRows: stats.uniqueRows,
      savedRows: Math.max(0, stats.rawRows - stats.uniqueRows),
    },
  };
}

function serializeItem(item) {
  return {
    symbol: item.symbol,
    label: item.label,
    tradeView: item.tradeView,
    tradeViewLabel: item.tradeViewLabel,
    side: item.side,
    score: item.score,
    confidence: item.confidence,
    status: item.status,
    statusLabel: item.statusLabel,
    streak: item.streak,
    sourceTags: item.sourceTags,
    change24h: item.change24h,
    change8am: item.change8am,
    ratio: item.ratio,
    ratioDeltaPct: item.ratioDeltaPct,
    ratio8amDeltaPct: item.ratio8amDeltaPct,
    fundingRate: item.fundingRate,
    volume: item.volume,
    reasons: item.reasons,
  };
}

export function serializeSmartTrendDecision(decision) {
  return {
    capturedAt: decision.capturedAt,
    summary: decision.summary,
    action: decision.action.map(serializeItem),
    watch: decision.watch.map(serializeItem),
    invalidated: decision.invalidated,
    stats: decision.stats,
  };
}

export function buildSmartTrendDecision({
  boards,
  outlook = null,
  highlightPct = 10,
  previousState = {},
  now = Date.now(),
  limits = {},
} = {}) {
  const merged = mergeRowsBySymbol(boards);
  const nextState = {};
  const items = [];

  for (const row of merged.rows) {
    const { item, continuity } = buildItem(row, highlightPct, previousState, now);
    item._stateEntry = makeStateEntry(item, continuity, now, item.group);
    items.push(item);
  }

  const seen = new Set(items.map(i => i.symbol));
  const invalidated = [];
  for (const prev of Object.values(previousState || {})) {
    if (!prev?.symbol || seen.has(prev.symbol)) continue;
    if (!prev.lastSeenAt || now - prev.lastSeenAt > DECISION_STATE_MAX_AGE_MS) continue;
    if (prev.status === 'invalidated') continue;
    if (prev.group !== 'action' && (prev.score || 0) < 70) continue;
    invalidated.push({
      symbol: prev.symbol,
      label: prev.label || prev.symbol.replace(/USDT$/, ''),
      previousView: prev.tradeViewLabel || prev.tradeView || '-',
      previousScore: prev.score || 0,
      reason: '本小时未进入重点候选',
      lastSeenAt: prev.lastSeenAt,
    });
    nextState[prev.symbol] = {
      ...prev,
      status: 'invalidated',
      group: 'watch',
      lastInvalidatedAt: now,
    };
  }

  const sorted = items.sort(sortDecisionItems);
  const actionLimit = limits.action ?? 5;
  const watchLimit = limits.watch ?? 4;
  const invalidatedLimit = limits.invalidated ?? 3;
  const action = sorted
    .filter(i => i.group === 'action' && i.status !== 'reversal_watch' && i.score >= 58)
    .slice(0, actionLimit);
  const actionSymbols = new Set(action.map(i => i.symbol));
  const watch = sorted
    .filter(i => !actionSymbols.has(i.symbol))
    .slice(0, watchLimit);
  const invalidatedTop = invalidated
    .sort((a, b) => (b.previousScore || 0) - (a.previousScore || 0))
    .slice(0, invalidatedLimit);

  const trackedSymbols = new Set([
    ...action.map(i => i.symbol),
    ...watch.map(i => i.symbol),
    ...sorted.filter(i => i.score >= 70).map(i => i.symbol),
  ]);
  for (const item of sorted) {
    if (trackedSymbols.has(item.symbol) && item._stateEntry) {
      nextState[item.symbol] = item._stateEntry;
    }
  }

  const stats = {
    rawRows: merged.rawRows,
    uniqueRows: merged.uniqueRows,
    savedRows: Math.max(0, merged.rawRows - merged.uniqueRows),
    totalCandidates: items.length,
  };

  return {
    capturedAt: now,
    summary: buildSummary(action, watch, invalidatedTop, stats, outlook),
    action,
    watch,
    invalidated: invalidatedTop,
    all: sorted,
    stats,
    nextState,
  };
}

function decisionRows(items) {
  return items.map(i => ({
    coin: `**${i.label}**`,
    view: i.tradeViewLabel,
    state: i.statusLabel,
    score: `${i.score}/100 ${i.confidence}`,
    source: i.sourceTags.join(' / '),
    change: fmtPct(i.change24h ?? i.change8am),
    smart: `${i.side === 'long' ? '偏多' : i.side === 'short' ? '偏空' : '中性'} ${fmtRatio(i.ratio)}`,
    reason: i.reasons.join('、') || '-',
  }));
}

function decisionTable(title, items, pageSize = 5) {
  if (!items.length) {
    return [{ tag: 'markdown', content: `**${title}**\n暂无` }];
  }
  return [
    { tag: 'markdown', content: `**${title}**` },
    {
      tag: 'table',
      page_size: pageSize,
      row_height: 'low',
      freeze_first_column: true,
      columns: [
        { name: 'coin', display_name: '币种', data_type: 'lark_md', width: '80px' },
        { name: 'view', display_name: '视图', data_type: 'text', width: 'auto' },
        { name: 'state', display_name: '连续性', data_type: 'text', width: 'auto' },
        { name: 'score', display_name: '评分', data_type: 'text', width: 'auto' },
        { name: 'source', display_name: '来源', data_type: 'text', width: 'auto' },
        { name: 'change', display_name: '24h', data_type: 'text', width: 'auto' },
        { name: 'smart', display_name: '聪明钱', data_type: 'text', width: 'auto' },
        { name: 'reason', display_name: '原因', data_type: 'text', width: 'auto' },
      ],
      rows: decisionRows(items),
    },
  ];
}

function invalidatedElements(items) {
  if (!items.length) return [];
  return [
    { tag: 'markdown', content: '**降级/失效**' },
    {
      tag: 'table',
      page_size: 3,
      row_height: 'low',
      columns: [
        { name: 'coin', display_name: '币种', data_type: 'lark_md', width: '80px' },
        { name: 'prev', display_name: '原视图', data_type: 'text', width: 'auto' },
        { name: 'score', display_name: '原评分', data_type: 'text', width: 'auto' },
        { name: 'reason', display_name: '原因', data_type: 'text', width: 'auto' },
      ],
      rows: items.map(i => ({
        coin: `**${i.label}**`,
        prev: i.previousView,
        score: `${i.previousScore}/100`,
        reason: i.reason,
      })),
    },
  ];
}

export function buildSmartTrendDecisionElements(decision) {
  const now = new Date(decision.capturedAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  const { summary } = decision;
  const lines = [
    `**⏰ ${now}** · 聪明钱决策摘要`,
    `**结论:** ${summary.verdict}`,
    summary.advice,
    '',
    `去重: ${summary.dedupe.rawRows} 行 -> ${summary.dedupe.uniqueRows} 币，少看 ${summary.dedupe.savedRows} 行重复信息`,
    `重点: 多 ${summary.longCount} / 空险 ${summary.shortCount} · 观察 ${summary.watchCount} · 反向待确认 ${summary.reversalCount}`,
  ];
  if (summary.oldVerdict) lines.push(summary.oldVerdict);

  return [
    { tag: 'markdown', content: lines.join('\n') },
    ...decisionTable('重点候选', decision.action, 5),
    ...decisionTable('观察名单', decision.watch, 4),
    ...invalidatedElements(decision.invalidated),
    { tag: 'markdown', content: '_方向反转默认需要连续确认；这里是决策线索，不是自动下单指令。_' },
  ];
}
