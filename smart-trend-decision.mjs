import { changeTrendLabel, tradeHintLabel, DIGEST_TABLE_COLUMNS, buildDigestTableRows } from './smart-trend-labels.mjs';

const DECISION_STATE_MAX_AGE_MS = 48 * 3600 * 1000;
const DECISION_TABLE_MAX_ROWS = 15;
/** 做空提示最低市值（USDT），低于此值不推荐做空 */
const MIN_MARKET_CAP_FOR_SHORT = 10_000_000;

const VIEW_META = {
  trend_long: { label: '趋势做多候选', side: 'long', group: 'action' },
  rebound_watch: { label: '超跌反弹观察', side: 'long', group: 'action' },
  accumulation: { label: '聪明钱吸筹观察', side: 'long', group: 'watch' },
  pump_risk: { label: '冲高风险观察', side: 'short', group: 'action' },
  downtrend_risk: { label: '下跌延续风险', side: 'short', group: 'action' },
  distribution: { label: '聪明钱派发风险', side: 'short', group: 'watch' },
  neutral_watch: { label: '观望', side: 'neutral', group: 'watch' },
};

const ACTION_PLAYBOOK = {
  trend_long: {
    scene: '顺势',
    action: '可轻仓顺势做多',
    avoid: '勿重仓追高',
    waitFor: '回踩不破 + 聪明钱继续偏多',
    urgency: 'high',
  },
  rebound_watch: {
    scene: '反转',
    action: '等价格止跌确认后再考虑入场',
    avoid: '下跌途中抄底',
    waitFor: '跌幅收窄 + 聪明钱由空转多',
    urgency: 'medium',
  },
  accumulation: {
    scene: '顺势',
    action: '观察吸筹，等待突破确认',
    avoid: '单次重仓',
    waitFor: '突破 + 量变',
    urgency: 'medium',
  },
  pump_risk: {
    scene: '反转',
    action: '禁止追多；等冲高回落再考虑做空',
    avoid: '暴涨中抄底或追多',
    waitFor: '量能萎缩 + 聪明钱持续偏空',
    urgency: 'high',
  },
  downtrend_risk: {
    scene: '顺势',
    action: '偏空看待，反弹做空',
    avoid: '勿抄底',
    waitFor: '反弹至阻力',
    urgency: 'high',
  },
  distribution: {
    scene: '反转',
    action: '聪明钱派发，减持多单',
    avoid: '勿加仓',
    waitFor: '跌破支撑',
    urgency: 'medium',
  },
  neutral_watch: {
    scene: '观望',
    action: '暂不操作',
    avoid: '-',
    waitFor: '方向明朗',
    urgency: 'low',
  },
};

const VERDICT_BULLETS = {
  机会偏多: '总体偏多：顺势品种可轻仓跟进，反转品种等确认',
  风险偏空: '总体偏空：禁止追多，关注冲高回落做空机会',
  多空分歧: '方向不明：只观察不新开仓，等信号延续',
  观望: '本小时无强信号，建议观望，继续跟踪聪明钱连续性',
};

function sceneTag(scene) {
  if (scene === '顺势') return '【顺势】';
  if (scene === '反转') return '【反转】';
  return '【观望】';
}

function sceneIcon(scene) {
  if (scene === '顺势') return '📈';
  if (scene === '反转') return '🔄';
  return '⏸';
}

const DECISION_SCENE_LEGEND = '_场景图标：📈 顺势 · 🔄 反转 · ⏸ 观望_';

function resolveActionGuide(item) {
  const playbook = ACTION_PLAYBOOK[item.tradeView] || ACTION_PLAYBOOK.neutral_watch;

  if (item.status === 'reversal_watch') {
    return {
      scene: playbook.scene,
      sceneTag: sceneTag(playbook.scene),
      sceneIcon: sceneIcon(playbook.scene),
      action: '勿反手，等连续2h确认',
      avoid: playbook.avoid,
      urgency: 'low',
    };
  }

  let action = playbook.action;
  if (item.status === 'strengthened') {
    action = `信号加强，${action}`;
  } else if (item.status === 'continued' && item.streak >= 3) {
    action = `${action}`;
  } else if (item.status === 'reversed') {
    action = `反转确认，${action}`;
  }
  if (item.status === 'weakened') {
    action = `${action}；信号减弱，减仓观望`;
  }

  return {
    scene: playbook.scene,
    sceneTag: sceneTag(playbook.scene),
    sceneIcon: sceneIcon(playbook.scene),
    action,
    avoid: playbook.avoid,
    urgency: playbook.urgency,
  };
}

function buildKeyEvidence(item, highlightPct = 10) {
  const parts = [];
  const trend = changeTrendLabel(item, highlightPct);
  if (trend && trend !== '— 首次') parts.push(trend);
  const change = fmtPct(item.change24h ?? item.change8am);
  if (change !== '-') parts.push(`24h ${change}`);
  const smartSide = item.side === 'long' ? '偏多' : item.side === 'short' ? '偏空' : '中性';
  parts.push(`${smartSide}${fmtRatio(item.ratio)}`);
  const hint = tradeHintLabel(item.ratio8amDeltaPct, highlightPct);
  if (hint && hint !== '—' && hint !== '-') parts.push(hint);
  return parts.slice(0, 3).join(' · ') || '-';
}

function buildHourlyActionBullets(action, summary) {
  if (!action.length) {
    return [VERDICT_BULLETS.观望];
  }

  const bullets = [VERDICT_BULLETS[summary.verdict] || VERDICT_BULLETS.观望];
  const topItems = action
    .map(item => ({ item, guide: resolveActionGuide(item) }))
    .filter(({ guide }) => guide.urgency === 'high')
    .slice(0, 2);

  for (const { item, guide } of topItems) {
    bullets.push(`${item.label} · ${guide.scene} · ${guide.action}（${item.statusLabel}）`);
  }

  return bullets.slice(0, 3);
}

function filterWatchForDisplay(watch) {
  return watch.filter(i => i.score >= 70).slice(0, 3);
}

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
        'price8am',
        'priceDeltaPct',
        'fundingRate',
        'prevFundingRate',
        'fundingDeltaPct',
        'hints8amLabel',
        'marketCapLabel',
        'volumeRank',
        'volume24h',
        'marketCap',
        'pinned',
        'hasSpot',
        'whaleRatio',
        'prevWhaleRatio',
        'whaleRatioDeltaPct',
        'whaleGlobalRatio',
        'prevWhaleGlobalRatio',
        'whaleGlobalRatioDeltaPct',
        'whaleGlobalRatio8am',
        'whaleGlobalRatio8amDeltaPct',
        'divergence',
        'globalRatio',
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

function classifyView(row, sources, divergenceThreshold = 0.25) {
  const change = num(row.change24h) ?? num(row.change8am);
  const direction = row.direction || (num(row.ratio) != null && row.ratio >= 1 ? 'long' : 'short');
  const longBias = direction === 'long';
  const d1 = num(row.ratioDeltaPct);
  const d8 = num(row.ratio8amDeltaPct);

  // 大户 vs 散户背离信号
  const hasDivergence = row.divergence != null && !Number.isNaN(row.divergence) &&
    row.divergence >= divergenceThreshold &&
    row.whaleRatio != null && row.whaleRatio > 1.0 &&
    row.globalRatio != null && row.globalRatio < 0.9;

  if (change != null && change >= 15 && longBias) return 'trend_long';
  if (change != null && change >= 15 && !longBias) return 'pump_risk';
  // 有背离信号时，跌幅 -5% 即触发 rebound_watch（正常需 -10%）
  if (change != null && change <= -5 && longBias && hasDivergence) return 'rebound_watch';
  if (change != null && change <= -10 && longBias) return 'rebound_watch';
  if (change != null && change <= -10 && !longBias) return 'downtrend_risk';
  if (longBias && (d1 >= 5 || d8 >= 5 || row.ratio >= 1.25 || hasSource(sources, 'rightSide'))) return 'accumulation';
  if (!longBias && (d1 <= -5 || d8 <= -5 || row.ratio <= 0.8 || hasSource(sources, 'rightSide'))) return 'distribution';
  return 'neutral_watch';
}

function calcScore(row, sources, highlightPct, divergenceThreshold = 0.25) {
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

  // 大户抄底/散户恐慌背离信号加分
  if (row.divergence != null && !Number.isNaN(row.divergence) &&
      row.divergence >= divergenceThreshold &&
      row.whaleRatio != null && row.whaleRatio > 1.0 &&
      row.globalRatio != null && row.globalRatio < 0.9) {
    score += 12;
  }

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

function buildItem(row, highlightPct, previousState, now, divergenceThreshold = 0.25) {
  const sources = row.sources || [];
  const tradeView = classifyView(row, sources, divergenceThreshold);
  const meta = VIEW_META[tradeView] || VIEW_META.neutral_watch;
  const score = calcScore(row, sources, highlightPct, divergenceThreshold);
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
    prevRatio: num(row.prevRatio),
    ratio8am: num(row.ratio8am),
    ratioDeltaPct: num(row.ratioDeltaPct),
    ratio8amDeltaPct: num(row.ratio8amDeltaPct),
    direction: row.direction,
    price: num(row.price),
    prevPrice: num(row.prevPrice),
    priceDeltaPct: num(row.priceDeltaPct),
    hints8amLabel: row.hints8amLabel,
    marketCapLabel: row.marketCapLabel,
    marketCap: num(row.marketCap),
    fundingRate: num(row.fundingRate),
    prevFundingRate: num(row.prevFundingRate),
    fundingDeltaPct: num(row.fundingDeltaPct),
    pinned: row.pinned ?? hasSource(sources, 'pinned'),
    volume: num(row.volumeRank),
    volume24h: num(row.volume24h),
    divergence: num(row.divergence),
    whaleRatio: num(row.whaleRatio),
    globalRatio: num(row.globalRatio),
    whaleGlobalRatio: num(row.whaleGlobalRatio),
    whaleGlobalRatioDeltaPct: num(row.whaleGlobalRatioDeltaPct),
    whaleGlobalRatio8am: num(row.whaleGlobalRatio8am),
    whaleGlobalRatio8amDeltaPct: num(row.whaleGlobalRatio8amDeltaPct),
    hasSpot: row.hasSpot === true,
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
    divergence: item.divergence,
    whaleRatio: item.whaleRatio,
    globalRatio: item.globalRatio,
    whaleGlobalRatio: item.whaleGlobalRatio,
    whaleGlobalRatioDeltaPct: item.whaleGlobalRatioDeltaPct,
    whaleGlobalRatio8am: item.whaleGlobalRatio8am,
    whaleGlobalRatio8amDeltaPct: item.whaleGlobalRatio8amDeltaPct,
    hasSpot: item.hasSpot,
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
    reboundHighlights: decision.reboundHighlights,
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
  divergenceThreshold = 0.25,
  reboundHighlightPct = 15,
  /** 已持仓币种符号集合（大写），trend_long 币种若在此集合中将被降级为观望 */
  heldSymbols = new Set(),
} = {}) {
  const merged = mergeRowsBySymbol(boards);
  const nextState = {};
  const items = [];

  for (const row of merged.rows) {
    const { item, continuity } = buildItem(row, highlightPct, previousState, now, divergenceThreshold);
    // 已持仓币种不推荐做多：将 trend_long 降级为 neutral_watch
    if (item.tradeView === 'trend_long' && heldSymbols.has(item.symbol.toUpperCase())) {
      item.tradeView = 'neutral_watch';
      item.tradeViewLabel = VIEW_META.neutral_watch.label;
      item.side = VIEW_META.neutral_watch.side;
      item.baseGroup = VIEW_META.neutral_watch.group;
    }
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
  // 市值低于 1000 万的币种不做空
  const excludeLowMcShort = (i) => !(i.side === 'short' && i.marketCap != null && i.marketCap < MIN_MARKET_CAP_FOR_SHORT);
  const action = sorted
    .filter(i => excludeLowMcShort(i) && i.group === 'action' && i.status !== 'reversal_watch' && i.score >= 58)
    .slice(0, actionLimit);
  const actionSymbols = new Set(action.map(i => i.symbol));
  const watch = sorted
    .filter(i => excludeLowMcShort(i) && !actionSymbols.has(i.symbol))
    .slice(0, watchLimit);
  const invalidatedTop = invalidated
    .sort((a, b) => (b.previousScore || 0) - (a.previousScore || 0))
    .slice(0, invalidatedLimit);

  const trackedSymbols = new Set([
    ...action.map(i => i.symbol),
    ...watch.map(i => i.symbol),
    ...sorted.filter(i => excludeLowMcShort(i) && i.score >= 70).map(i => i.symbol),
  ]);
  for (const item of sorted) {
    if (trackedSymbols.has(item.symbol) && item._stateEntry) {
      nextState[item.symbol] = item._stateEntry;
    }
  }

  // 收集急跌反弹观察高亮数据
  const reboundHighlights = sorted
    .filter(i => i.tradeView === 'rebound_watch' && Math.abs(num(i.change24h) ?? 0) >= reboundHighlightPct)
    .slice(0, 5)
    .map(i => ({
      label: i.label,
      symbol: i.symbol,
      price: i.price,
      change24h: i.change24h,
      statusLabel: i.statusLabel,
      ratio: i.ratio,
      divergence: i.divergence,
      whaleRatio: i.whaleRatio,
      globalRatio: i.globalRatio,
    }));

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
    reboundHighlights,
    heldSymbols,
    stats,
    nextState,
  };
}

function decisionRows(items, highlightPct = 10, heldSymbols = new Set()) {
  return items.map(i => {
    const guide = resolveActionGuide(i);
    const isHeld = heldSymbols.has(i.symbol.toUpperCase());
    const hasSpot = i.hasSpot === true;
    const coinText = (isHeld || hasSpot) ? `**~~${i.label}~~**` : `**${i.label}**`;
    return {
      coin: coinText,
      action: `${guide.sceneIcon} ${guide.action}`,
      state: i.statusLabel,
      evidence: buildKeyEvidence(i, highlightPct),
    };
  });
}

function decisionTable(title, items, highlightPct = 10, heldSymbols = new Set()) {
  if (!items.length) {
    return [{ tag: 'markdown', content: `**${title}**\n暂无` }];
  }
  const displayItems = items.slice(0, DECISION_TABLE_MAX_ROWS);
  const rows = decisionRows(displayItems, highlightPct, heldSymbols);
  return [
    { tag: 'markdown', content: `**${title}**` },
    {
      tag: 'table',
      page_size: rows.length,
      row_height: 'low',
      freeze_first_column: true,
      columns: [
        { name: 'coin', display_name: '币种', data_type: 'lark_md', width: '80px' },
        { name: 'action', display_name: '建议操作', data_type: 'text', width: '200px' },
        { name: 'state', display_name: '连续性', data_type: 'text', width: '88px' },
        { name: 'evidence', display_name: '关键依据', data_type: 'text', width: 'auto' },
      ],
      rows,
    },
  ];
}

function changeDataTable(title, items, highlightPct = 10, heldSymbols = new Set()) {
  if (!items.length) return [];
  const displayItems = items.slice(0, DECISION_TABLE_MAX_ROWS);
  const rows = buildDigestTableRows(displayItems, highlightPct, { heldSymbols });
  return [
    {
      tag: 'markdown',
      content: `**${title}**\n_净多空比含 1h|8am 聪明钱变化 · 8am推=当日1h净多空比±5%累计计分 · 价格先显示变化比例、悬停看价位详情 · 参考=基于8amΔ_`,
    },
    {
      tag: 'table',
      page_size: rows.length,
      row_height: 'low',
      freeze_first_column: true,
      columns: DIGEST_TABLE_COLUMNS,
      rows,
    },
  ];
}

function invalidatedElements(items) {
  if (!items.length) return [];
  const rows = items.map(i => ({
    coin: `**${i.label}**`,
    action: '减仓或退出观望',
    reason: i.reason,
  }));
  return [
    { tag: 'markdown', content: '**已失效 · 上一小时重点退出**' },
    {
      tag: 'table',
      page_size: rows.length,
      row_height: 'low',
      columns: [
        { name: 'coin', display_name: '币种', data_type: 'lark_md', width: '80px' },
        { name: 'action', display_name: '建议', data_type: 'text', width: 'auto' },
        { name: 'reason', display_name: '原因', data_type: 'text', width: 'auto' },
      ],
      rows,
    },
  ];
}

export function buildSmartTrendDecisionElements(decision, { highlightPct = 10, heldSymbols = new Set() } = {}) {
  const now = new Date(decision.capturedAt).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  const { summary } = decision;
  const watchDisplay = filterWatchForDisplay(decision.watch);
  const bullets = buildHourlyActionBullets(decision.action, summary);
  const dataItems = [...decision.action, ...watchDisplay];
  const showDecisionLegend = decision.action.length > 0 || watchDisplay.length > 0;

  const lines = [
    `**⏰ ${now}** · 聪明钱操作清单`,
    '',
    '**【本小时怎么做】**',
    ...bullets.map((b, i) => `${i + 1}. ${b}`),
    '',
    `重点 ${summary.actionCount} 个（多 ${summary.longCount} / 空 ${summary.shortCount}）· 观察 ${watchDisplay.length} 个`,
  ];

  return [
    { tag: 'markdown', content: lines.join('\n') },
    ...(showDecisionLegend ? [{ tag: 'markdown', content: DECISION_SCENE_LEGEND }] : []),
    ...decisionTable('立刻关注', decision.action, highlightPct, heldSymbols),
    ...decisionTable('继续观察', watchDisplay, highlightPct, heldSymbols),
    ...changeDataTable('变化数据', dataItems, highlightPct, heldSymbols),
    ...invalidatedElements(decision.invalidated),
    { tag: 'markdown', content: '_非自动下单；方向反转需连续2h确认，避免小时级来回反手。_' },
  ];
}
