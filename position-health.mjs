import { setupProxyFromEnv, fetchJson as fetchJSON } from './proxy-setup.mjs';
import { checkCoinRightStable } from './scan-stable.mjs';
import { checkShortSignal } from './scan-short-signal.mjs';
import { checkDumpRisk } from './scan-dump-risk.mjs';
import { fetchSmartSignal, analyzeSmartSignal } from './scan-smart-signal.mjs';

setupProxyFromEnv();

const FAPI_BASE = 'https://fapi.binance.com';

function calcSuggestedLevels(klines, direction, entryPrice) {
  if (!Array.isArray(klines) || klines.length < 20) {
    return { stopLoss: null, takeProfit: null };
  }
  const lows = klines.map(k => parseFloat(k[3]));
  const highs = klines.map(k => parseFloat(k[2]));
  const support = Math.min(...lows.slice(-20));
  const resistance = Math.max(...highs.slice(-10));
  if (direction === 'long') {
    return {
      stopLoss: Math.min(support * 0.97, entryPrice * 0.95),
      takeProfit: Math.max(resistance, entryPrice * 1.1),
    };
  }
  return {
    stopLoss: Math.max(resistance * 1.03, entryPrice * 1.05),
    takeProfit: Math.min(support, entryPrice * 0.9),
  };
}

function resolveAction(health, pnlPct, direction, currentPrice, stopLoss, takeProfit) {
  if (health === 'critical') return 'stop_loss';
  if (takeProfit && direction === 'long' && currentPrice >= takeProfit) return 'take_profit';
  if (takeProfit && direction === 'short' && currentPrice <= takeProfit) return 'take_profit';
  if (stopLoss && direction === 'long' && currentPrice <= stopLoss) return 'stop_loss';
  if (stopLoss && direction === 'short' && currentPrice >= stopLoss) return 'stop_loss';
  if (health === 'warning' && pnlPct >= 5) return 'take_profit';
  if (health === 'warning' && pnlPct > 0) return 'tighten_sl';
  if (health === 'warning' && pnlPct < -5) return 'stop_loss';
  return 'hold';
}

const ACTION_LABELS = {
  hold: '继续持有',
  tighten_sl: '收紧止损',
  take_profit: '考虑止盈',
  stop_loss: '建议止损',
};

const HEALTH_LABELS = {
  healthy: '健康',
  warning: '警告',
  critical: '危险',
};

export async function evaluatePositionHealth({
  symbol,
  direction,
  entryPrice,
  stopLoss = null,
  takeProfit = null,
}) {
  const sym = String(symbol || '').toUpperCase();
  const dir = direction === 'short' ? 'short' : 'long';
  const entry = parseFloat(entryPrice);
  if (!sym || !Number.isFinite(entry) || entry <= 0) {
    throw new Error('symbol 与 entryPrice 必填且有效');
  }

  const [ticker, klines1h] = await Promise.all([
    fetchJSON(`${FAPI_BASE}/fapi/v1/ticker/24hr?symbol=${sym}`),
    fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=100`),
  ]);

  const currentPrice = parseFloat(ticker.lastPrice);
  const pnlPct = dir === 'long'
    ? ((currentPrice - entry) / entry) * 100
    : ((entry - currentPrice) / entry) * 100;

  const suggested = calcSuggestedLevels(klines1h, dir, entry);
  const effectiveSL = stopLoss != null && stopLoss !== '' ? parseFloat(stopLoss) : suggested.stopLoss;
  const effectiveTP = takeProfit != null && takeProfit !== '' ? parseFloat(takeProfit) : suggested.takeProfit;

  let healthScore = 70;
  const reasons = [];
  let signalValid = true;

  if (dir === 'long') {
    const stable = await checkCoinRightStable(sym, { maxDrawdownPct: 0.30, dualTFConfirm: true });
    if (stable?.isRightStable) {
      healthScore += 20;
      reasons.push(`做多信号仍有效：${stable.detail}`);
    } else if (stable?.isRightSide) {
      healthScore -= 15;
      signalValid = false;
      reasons.push(`趋势走弱：${stable.detail}`);
    } else {
      healthScore -= 35;
      signalValid = false;
      reasons.push(`做多逻辑失效：${stable?.detail || '评分不足'}`);
    }

    try {
      const dump = await checkDumpRisk(sym);
      if (dump.riskScore >= 6) {
        healthScore -= 30;
        reasons.push(`暴跌风险 ${dump.riskScore} 分：${dump.risks.slice(0, 2).map(r => r.tag).join('、')}`);
      } else if (dump.riskScore >= 4) {
        healthScore -= 15;
        reasons.push(`下跌风险 ${dump.riskScore} 分`);
      }
    } catch {
      /* optional */
    }
  } else {
    const shortSig = await checkShortSignal(sym);
    if (!shortSig) {
      healthScore -= 40;
      signalValid = false;
      reasons.push('续涨模式，做空逻辑失效（不宜持有空单）');
    } else if (shortSig.shortScore >= 4) {
      healthScore += 15;
      reasons.push(`做空信号仍有效 [${shortSig.shortScore}分]：${shortSig.signals?.slice(0, 2).map(s => s.tag).join('、') || ''}`);
    } else if (shortSig.shortScore >= 2) {
      healthScore -= 10;
      signalValid = false;
      reasons.push(`做空信号减弱 [${shortSig.shortScore}分]`);
    } else {
      healthScore -= 25;
      signalValid = false;
      reasons.push('做空评分过低，趋势可能反转');
    }
  }

  try {
    const raw = await fetchSmartSignal(sym);
    const smart = analyzeSmartSignal(raw, currentPrice);
    if (smart) {
      if (dir === 'long' && smart.direction === 'short' && smart.score >= 2) {
        healthScore -= 20;
        reasons.push(`聪明钱转空 (${smart.score}分)`);
      } else if (dir === 'short' && smart.direction === 'long' && smart.score >= 2) {
        healthScore -= 20;
        reasons.push(`聪明钱转多 (${smart.score}分)`);
      } else if (smart.direction === dir && smart.score >= 2) {
        healthScore += 10;
        reasons.push(`聪明钱支持${dir === 'long' ? '做多' : '做空'}`);
      }
    }
  } catch {
    /* smart signal optional */
  }

  if (pnlPct >= 8) {
    healthScore += 5;
    reasons.push(`浮盈 ${pnlPct.toFixed(1)}%，可考虑止盈`);
  } else if (pnlPct <= -5) {
    healthScore -= 15;
    reasons.push(`浮亏 ${pnlPct.toFixed(1)}%，注意风控`);
  }

  healthScore = Math.max(0, Math.min(100, healthScore));
  let health = 'healthy';
  if (healthScore < 45 || (healthScore < 55 && !signalValid)) health = 'critical';
  else if (healthScore < 65 || !signalValid) health = 'warning';

  const action = resolveAction(health, pnlPct, dir, currentPrice, effectiveSL, effectiveTP);

  return {
    symbol: sym,
    label: sym.replace(/USDT$/, ''),
    direction: dir,
    entryPrice: entry,
    currentPrice,
    pnlPct: Math.round(pnlPct * 100) / 100,
    health,
    healthLabel: HEALTH_LABELS[health],
    healthScore,
    signalValid,
    reasons,
    action,
    actionLabel: ACTION_LABELS[action],
    stopLoss: effectiveSL,
    takeProfit: effectiveTP,
    suggestedSL: suggested.stopLoss,
    suggestedTP: suggested.takeProfit,
    distanceToSLPct: effectiveSL
      ? Math.round(Math.abs((currentPrice - effectiveSL) / currentPrice) * 10000) / 100
      : null,
    distanceToTPPct: effectiveTP
      ? Math.round(Math.abs((effectiveTP - currentPrice) / currentPrice) * 10000) / 100
      : null,
    checkedAt: Date.now(),
  };
}

export async function evaluatePositionsBatch(positions) {
  const results = [];
  for (const pos of positions) {
    try {
      results.push(await evaluatePositionHealth(pos));
    } catch (e) {
      results.push({
        ...pos,
        error: e.message,
        health: 'warning',
        healthLabel: '警告',
      });
    }
  }
  return results;
}
