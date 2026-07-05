import { setupProxyFromEnv, fetchJson as fetchJSON } from './proxy-setup.mjs';

setupProxyFromEnv();

const FAPI_BASE = 'https://fapi.binance.com';

function calcDrawdownFromPeak(highs, closes, lookback = 48) {
  const slice = highs.slice(-lookback);
  if (!slice.length) return 0;
  const peak = Math.max(...slice);
  const cur = closes[closes.length - 1];
  return peak > 0 ? ((peak - cur) / peak) * 100 : 0;
}

/**
 * 对单个币做暴跌风险评估，返回风险分和明细。
 * riskScore >= 6 → 高危（强烈建议不碰）
 * riskScore 3-5 → 警告（谨慎对待）
 * riskScore < 3 → 相对安全
 */
export async function checkDumpRisk(symbol) {
  const sym = symbol.toUpperCase();
  const risks = [];
  let riskScore = 0;

  const [ticker, klines1h, klines4h, oiHist, takerVol, fundingRate, topPos, globalRatio] =
    await Promise.all([
      fetchJSON(`${FAPI_BASE}/fapi/v1/ticker/24hr?symbol=${sym}`),
      fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${sym}&interval=1h&limit=48`),
      fetchJSON(`${FAPI_BASE}/fapi/v1/klines?symbol=${sym}&interval=4h&limit=12`),
      fetchJSON(`${FAPI_BASE}/futures/data/openInterestHist?symbol=${sym}&period=4h&limit=6`).catch(() => []),
      fetchJSON(`${FAPI_BASE}/futures/data/takerlongshortRatio?symbol=${sym}&period=5m&limit=12`).catch(() => []),
      fetchJSON(`${FAPI_BASE}/fapi/v1/premiumIndex?symbol=${sym}`).catch(() => null),
      fetchJSON(`${FAPI_BASE}/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=3`).catch(() => []),
      fetchJSON(`${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=3`).catch(() => []),
    ]);

  const price = parseFloat(ticker.lastPrice);
  const change24h = parseFloat(ticker.priceChangePercent);

  // ① 24h 跌幅检查
  if (change24h <= -30) {
    riskScore += 4;
    risks.push({ level: '🔴', tag: '24h暴跌', detail: `${change24h.toFixed(1)}%`, score: 4 });
  } else if (change24h <= -20) {
    riskScore += 3;
    risks.push({ level: '🔴', tag: '24h大跌', detail: `${change24h.toFixed(1)}%`, score: 3 });
  } else if (change24h <= -10) {
    riskScore += 2;
    risks.push({ level: '🟡', tag: '24h下跌', detail: `${change24h.toFixed(1)}%`, score: 2 });
  }

  // ② 近4h 加速下跌检查（用 1h K 线最近 4 根）
  if (Array.isArray(klines1h) && klines1h.length >= 4) {
    const recent4 = klines1h.slice(-4);
    const open4h = parseFloat(recent4[0][1]);
    const close4h = parseFloat(recent4[recent4.length - 1][4]);
    const change4h = ((close4h - open4h) / open4h) * 100;
    if (change4h <= -15) {
      riskScore += 3;
      risks.push({ level: '🔴', tag: '4h急跌', detail: `${change4h.toFixed(1)}%`, score: 3 });
    } else if (change4h <= -8) {
      riskScore += 2;
      risks.push({ level: '🟡', tag: '4h下跌', detail: `${change4h.toFixed(1)}%`, score: 2 });
    }
  }

  // ③ 从高点回撤检查
  if (Array.isArray(klines4h) && klines4h.length >= 6) {
    const highs = klines4h.map(k => parseFloat(k[2]));
    const closes = klines4h.map(k => parseFloat(k[4]));
    const dd = calcDrawdownFromPeak(highs, closes, 12);
    if (dd >= 40) {
      riskScore += 3;
      risks.push({ level: '🔴', tag: '高点回撤', detail: `${dd.toFixed(1)}%`, score: 3 });
    } else if (dd >= 25) {
      riskScore += 2;
      risks.push({ level: '🟡', tag: '高点回撤', detail: `${dd.toFixed(1)}%`, score: 2 });
    }
  }

  // ④ 持仓量（OI）萎缩检查
  if (Array.isArray(oiHist) && oiHist.length >= 2) {
    const oldest = parseFloat(oiHist[0].sumOpenInterestValue);
    const latest = parseFloat(oiHist[oiHist.length - 1].sumOpenInterestValue);
    if (oldest > 0) {
      const oiChange = ((latest - oldest) / oldest) * 100;
      if (oiChange <= -25) {
        riskScore += 2;
        risks.push({ level: '🔴', tag: 'OI大幅萎缩', detail: `${oiChange.toFixed(1)}%`, score: 2 });
      } else if (oiChange <= -15) {
        riskScore += 1;
        risks.push({ level: '🟡', tag: 'OI萎缩', detail: `${oiChange.toFixed(1)}%`, score: 1 });
      }
    }
  }

  // ⑤ 主动卖出压力检查
  if (Array.isArray(takerVol) && takerVol.length >= 3) {
    const recentRatios = takerVol.slice(-6).map(t => parseFloat(t.buySellRatio));
    const avgRatio = recentRatios.reduce((a, b) => a + b, 0) / recentRatios.length;
    if (avgRatio < 0.5) {
      riskScore += 3;
      risks.push({ level: '🔴', tag: '卖压极重', detail: `买卖比 ${avgRatio.toFixed(2)}`, score: 3 });
    } else if (avgRatio < 0.7) {
      riskScore += 2;
      risks.push({ level: '🟡', tag: '卖压偏重', detail: `买卖比 ${avgRatio.toFixed(2)}`, score: 2 });
    }
  }

  // ⑥ 大户做空检查
  if (Array.isArray(topPos) && topPos.length > 0) {
    const latest = topPos[topPos.length - 1];
    const ratio = parseFloat(latest.longShortRatio);
    if (ratio < 0.6) {
      riskScore += 2;
      risks.push({ level: '🔴', tag: '大户偏空', detail: `多空比 ${ratio.toFixed(2)}`, score: 2 });
    } else if (ratio < 0.85) {
      riskScore += 1;
      risks.push({ level: '🟡', tag: '大户略空', detail: `多空比 ${ratio.toFixed(2)}`, score: 1 });
    }
  }

  // ⑦ 全网散户做多 + 大户做空 = 典型韭菜坑
  if (Array.isArray(globalRatio) && globalRatio.length > 0 && Array.isArray(topPos) && topPos.length > 0) {
    const gRatio = parseFloat(globalRatio[globalRatio.length - 1].longShortRatio);
    const tRatio = parseFloat(topPos[topPos.length - 1].longShortRatio);
    if (gRatio > 1.2 && tRatio < 0.9) {
      riskScore += 2;
      risks.push({ level: '🔴', tag: '散多大空', detail: `全网 ${gRatio.toFixed(2)} vs 大户 ${tRatio.toFixed(2)}`, score: 2 });
    }
  }

  // ⑧ 资金费率异常
  if (fundingRate) {
    const fr = parseFloat(fundingRate.lastFundingRate);
    if (fr < -0.005) {
      riskScore += 2;
      risks.push({ level: '🔴', tag: '负费率极端', detail: `${(fr * 100).toFixed(3)}%`, score: 2 });
    } else if (fr < -0.001) {
      riskScore += 1;
      risks.push({ level: '🟡', tag: '负费率', detail: `${(fr * 100).toFixed(3)}%`, score: 1 });
    } else if (fr > 0.003) {
      riskScore += 1;
      risks.push({ level: '🟡', tag: '费率过高', detail: `${(fr * 100).toFixed(3)}%（多头拥挤）`, score: 1 });
    }
  }

  // ⑨ 连续阴线检查（1h K 线最近 6 根）
  if (Array.isArray(klines1h) && klines1h.length >= 6) {
    const recent = klines1h.slice(-6);
    let bearCount = 0;
    for (const k of recent) {
      if (parseFloat(k[4]) < parseFloat(k[1])) bearCount++;
    }
    if (bearCount >= 5) {
      riskScore += 2;
      risks.push({ level: '🔴', tag: '连续阴线', detail: `近6根有${bearCount}根阴线`, score: 2 });
    }
  }

  // ⑩ 成交量萎缩+下跌 = 无人接盘
  if (Array.isArray(klines1h) && klines1h.length >= 20) {
    const recentVol = klines1h.slice(-4).reduce((s, k) => s + parseFloat(k[7]), 0) / 4;
    const prevVol = klines1h.slice(-20, -4).reduce((s, k) => s + parseFloat(k[7]), 0) / 16;
    if (prevVol > 0 && recentVol < prevVol * 0.3 && change24h < -5) {
      riskScore += 1;
      risks.push({ level: '🟡', tag: '缩量下跌', detail: `量比 ${(recentVol / prevVol).toFixed(2)}`, score: 1 });
    }
  }

  const riskLevel =
    riskScore >= 6 ? 'high' :
    riskScore >= 3 ? 'warn' : 'low';

  const riskEmoji =
    riskLevel === 'high' ? '🚨' :
    riskLevel === 'warn' ? '⚠️' : '✅';

  return {
    symbol: sym,
    label: sym.replace('USDT', ''),
    price,
    change24h,
    riskScore,
    riskLevel,
    riskEmoji,
    risks,
    summary: `${riskEmoji} ${sym.replace('USDT', '')} 风险评分 ${riskScore} — ${risks.map(r => `${r.level}${r.tag}`).join(' ') || '未发现明显风险'}`,
  };
}

async function pmap(items, fn, concurrency = 3) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); } catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * 扫描全市场，找出正在暴跌的高危币种。
 */
export async function scanDumpCoins({
  limit = 200,
  minRiskScore = 4,
  concurrency = 3,
  onProgress,
} = {}) {
  const tickers = await fetchJSON(`${FAPI_BASE}/fapi/v1/ticker/24hr`);
  const candidates = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol: t.symbol,
      change: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
      price: parseFloat(t.lastPrice),
    }))
    .sort((a, b) => a.change - b.change)
    .slice(0, limit);

  const results = [];
  let done = 0;

  await pmap(candidates, async (item) => {
    try {
      const risk = await checkDumpRisk(item.symbol);
      if (risk.riskScore >= minRiskScore) {
        results.push(risk);
      }
    } catch {}
    done++;
    if (onProgress) onProgress(done, candidates.length);
  }, concurrency);

  results.sort((a, b) => b.riskScore - a.riskScore);
  return results;
}

/**
 * 格式化暴跌预警飞书推送内容。
 */
export function formatDumpPushContent(results) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  if (!results.length) {
    return {
      title: '暴跌预警 · 暂无高危币',
      content: `**扫描时间:** ${now}\n\n当前无符合暴跌预警条件的币种 ✅\n\n_风险评分 ≥ 4 · Top200 USDT 合约_`,
    };
  }

  const highRisk = results.filter(r => r.riskLevel === 'high');
  const warnRisk = results.filter(r => r.riskLevel === 'warn');

  const lines = [];

  if (highRisk.length) {
    lines.push('**🚨 高危（强烈远离）**');
    for (const r of highRisk) {
      const chg = r.change24h >= 0 ? `+${r.change24h.toFixed(1)}%` : `${r.change24h.toFixed(1)}%`;
      const tags = r.risks.map(x => `${x.level}${x.tag}(${x.detail})`).join(' ');
      lines.push(`- **${r.label}** ${chg} · 风险分 **${r.riskScore}** · ${tags}`);
    }
  }

  if (warnRisk.length) {
    lines.push('');
    lines.push('**⚠️ 警告（谨慎对待）**');
    for (const r of warnRisk) {
      const chg = r.change24h >= 0 ? `+${r.change24h.toFixed(1)}%` : `${r.change24h.toFixed(1)}%`;
      const topRisks = r.risks.slice(0, 3).map(x => `${x.level}${x.tag}`).join(' ');
      lines.push(`- **${r.label}** ${chg} · 风险分 ${r.riskScore} · ${topRisks}`);
    }
  }

  return {
    title: `暴跌预警 · ${highRisk.length} 高危 ${warnRisk.length} 警告`,
    content: `**扫描时间:** ${now}\n**🚨 ${highRisk.length} 个高危 · ⚠️ ${warnRisk.length} 个警告**\n\n${lines.join('\n')}\n\n_风险评分 ≥ 4 · Top200 USDT 合约_`,
  };
}
