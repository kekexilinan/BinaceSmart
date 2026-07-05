/**
 * 暴涨 + 聪明钱加仓做多 特别提示
 * 条件：8点来涨幅 ≥ minChange% 且聪明钱信号 ≥ minSmartScore
 */

export const PUMP_SMART_MIN_CHANGE = parseFloat(process.env.PUMP_SMART_MIN_CHANGE || '20', 10);
export const PUMP_SMART_MIN_SMART_SCORE = parseInt(process.env.PUMP_SMART_MIN_SMART_SCORE || '2', 10);
export const PUMP_SMART_SCAN_LIMIT = parseInt(process.env.PUMP_SMART_SCAN_LIMIT || '30', 10);
export const PUMP_SMART_INTERVAL_MIN = parseInt(process.env.PUMP_SMART_INTERVAL_MIN || '15', 10);
export const REALTIME_ALERT_INTERVAL_MIN = parseInt(process.env.REALTIME_ALERT_INTERVAL_MIN || process.env.PUMP_SMART_INTERVAL_MIN || '15', 10);

export async function analyzeSmartMoneyLongAdd(symbol, proxyBinance) {
  const sym = symbol.toUpperCase();
  const [topPos, oiHist, takerVol, globalRatio, topAccounts, klines1h] = await Promise.all([
    proxyBinance(`/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=5`),
    proxyBinance(`/futures/data/openInterestHist?symbol=${sym}&period=4h&limit=6`),
    proxyBinance(`/futures/data/takerlongshortRatio?symbol=${sym}&period=5m&limit=6`),
    proxyBinance(`/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
    proxyBinance(`/futures/data/topLongShortAccountRatio?symbol=${sym}&period=1h&limit=5`),
    proxyBinance(`/fapi/v1/klines?symbol=${sym}&interval=1h&limit=3`),
  ]);

  const signals = [];
  let score = 0;

  if (Array.isArray(topPos) && topPos.length >= 2) {
    const latest = parseFloat(topPos[topPos.length - 1].longShortRatio);
    const prev = parseFloat(topPos[topPos.length - 2].longShortRatio);
    if (latest > 1.05 && latest > prev) {
      score += 1;
      signals.push(`大户持仓偏多↑ ${prev.toFixed(2)}→${latest.toFixed(2)}`);
    }
  }

  if (Array.isArray(oiHist) && oiHist.length >= 2 && Array.isArray(klines1h) && klines1h.length >= 2) {
    const oiLatest = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest);
    const oiPrev = parseFloat(oiHist[oiHist.length - 2].sumOpenInterest);
    const oiChg = oiPrev > 0 ? (oiLatest - oiPrev) / oiPrev : 0;
    const priceUp = parseFloat(klines1h[klines1h.length - 1][4]) > parseFloat(klines1h[klines1h.length - 2][4]);
    if (oiChg > 0.03 && priceUp) {
      score += 1;
      signals.push(`OI增仓+涨 +${(oiChg * 100).toFixed(1)}%`);
    }
  }

  if (Array.isArray(takerVol) && takerVol.length >= 2) {
    const latest = parseFloat(takerVol[takerVol.length - 1].buySellRatio);
    const prev = parseFloat(takerVol[takerVol.length - 2].buySellRatio);
    if (latest > 1.1 && latest > prev) {
      score += 1;
      signals.push(`主动买入↑ ${latest.toFixed(2)}`);
    }
  }

  if (Array.isArray(topAccounts) && topAccounts.length && Array.isArray(globalRatio) && globalRatio.length) {
    const top = parseFloat(topAccounts[topAccounts.length - 1].longShortRatio);
    const glob = parseFloat(globalRatio[globalRatio.length - 1].longShortRatio);
    if (glob > 0 && top / glob > 1.2) {
      score += 1;
      signals.push(`大户>全网 ${(top / glob).toFixed(2)}x`);
    }
  }

  return {
    confirmed: score >= PUMP_SMART_MIN_SMART_SCORE,
    score,
    signals,
  };
}

export async function checkPumpSmartAlert(item, { proxyBinance, minChange = PUMP_SMART_MIN_CHANGE } = {}) {
  const changeSince8am = item.change ?? item.changeSince8am ?? 0;
  if (changeSince8am < minChange) return null;

  const smart = await analyzeSmartMoneyLongAdd(item.symbol, proxyBinance);
  if (!smart.confirmed) return null;

  return {
    symbol: item.symbol,
    label: item.label || item.symbol.replace(/USDT$/, ''),
    price: item.price,
    changeSince8am,
    change24h: item.change24h,
    smartScore: smart.score,
    signals: smart.signals,
  };
}

export async function scanPumpSmartAlerts({
  candidates = [],
  proxyBinance,
  minChange = PUMP_SMART_MIN_CHANGE,
  concurrency = 3,
} = {}) {
  const filtered = candidates.filter(c => (c.change ?? c.changeSince8am ?? 0) >= minChange);
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < filtered.length) {
      const i = idx++;
      try {
        const r = await checkPumpSmartAlert(filtered[i], { proxyBinance, minChange });
        if (r) results.push(r);
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, filtered.length) }, () => worker()));
  results.sort((a, b) => b.changeSince8am - a.changeSince8am || b.smartScore - a.smartScore);
  return results;
}

export function buildPumpGainerAlertElements(gainers, { fmtPrice, pushCounts = {}, minChange = 20 } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const items = gainers.filter(g => (g.change ?? g.changeSince8am ?? 0) >= minChange).slice(0, 10);
  const elements = [
    { tag: 'markdown', content: `**⏰ ${now}**\n**8点来涨幅 ≥ ${minChange}%** · 实时暴涨提醒（每 ${REALTIME_ALERT_INTERVAL_MIN} 分钟扫描）` },
  ];
  if (!items.length) {
    elements.push({ tag: 'markdown', content: '当前无暴涨币' });
    return elements;
  }
  elements.push({
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    freeze_first_column: true,
    columns: [
      { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
      { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
      { name: 'chg8am', display_name: '8am', data_type: 'lark_md', width: 'auto' },
      { name: 'chg24h', display_name: '24h', data_type: 'lark_md', width: 'auto' },
      { name: 'remind', display_name: '提醒', data_type: 'text', width: 'auto' },
    ],
    rows: items.map(g => {
      const chg = g.change ?? g.changeSince8am ?? 0;
      const count = pushCounts[g.symbol] || 1;
      return {
        coin: `🚀${g.label || g.symbol.replace(/USDT$/, '')}`,
        price: `$${fmtPrice(g.price)}`,
        chg8am: `<font color='green'>▲+${chg.toFixed(1)}%</font>`,
        chg24h: g.change24h != null ? `<font color='${g.change24h >= 0 ? 'green' : 'red'}'>${g.change24h >= 0 ? '+' : ''}${g.change24h.toFixed(1)}%</font>` : '-',
        remind: count > 1 ? `第${count}次` : '首次',
      };
    }),
  });
  return elements;
}

export function buildPumpSmartAlertElements(alerts, { fmtPrice, pushCounts = {} } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const elements = [
    { tag: 'markdown', content: `**⏰ ${now}**\n**条件:** 8点来涨幅≥${PUMP_SMART_MIN_CHANGE}% + 聪明钱加仓做多（≥${PUMP_SMART_MIN_SMART_SCORE}项确认）\n_触发后每 ${REALTIME_ALERT_INTERVAL_MIN} 分钟重复提醒，直至条件消失_` },
  ];

  if (!alerts.length) {
    elements.push({ tag: 'markdown', content: '当前无符合条件的币种' });
    return elements;
  }

  elements.push({
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    freeze_first_column: true,
    columns: [
      { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
      { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
      { name: 'chg8am', display_name: '8am', data_type: 'lark_md', width: 'auto' },
      { name: 'smart', display_name: '聪明钱', data_type: 'lark_md', width: 'auto' },
      { name: 'signals', display_name: '加仓信号', data_type: 'text', width: 'auto' },
      { name: 'remind', display_name: '提醒', data_type: 'text', width: 'auto' },
    ],
    rows: alerts.map(a => {
      const count = pushCounts[a.symbol] || 1;
      const chg = a.changeSince8am;
      return {
        coin: `🚀${a.label}`,
        price: `$${fmtPrice(a.price)}`,
        chg8am: `<font color='green'>▲+${chg.toFixed(1)}%</font>`,
        smart: `<font color='orange'>${a.smartScore}项确认</font>`,
        signals: a.signals.join(' · '),
        remind: count > 1 ? `第${count}次` : '首次',
      };
    }),
  });

  return elements;
}
