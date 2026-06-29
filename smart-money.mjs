#!/usr/bin/env node

const SYMBOL = process.argv[2] || 'SLXUSDT';
const INTERVAL_SEC = parseInt(process.argv[3] || '60', 10);
const FAPI_BASE = 'https://fapi.binance.com';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function ts2time(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function colorRatio(ratio) {
  const n = parseFloat(ratio);
  if (n >= 1.05) return `\x1b[32m${ratio} ▲▲\x1b[0m`;
  if (n >= 1.0)  return `\x1b[32m${ratio} ▲\x1b[0m`;
  if (n >= 0.9)  return `\x1b[33m${ratio} ─\x1b[0m`;
  return `\x1b[31m${ratio} ▼\x1b[0m`;
}

function formatVol(v) {
  const n = parseFloat(v);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function formatUSDT(v) {
  const n = parseFloat(v);
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}

async function monitor() {
  const [
    price,
    topAccounts,
    topPositions,
    globalRatio,
    oi,
    oiHist,
    takerVol,
    fundingRate,
  ] = await Promise.all([
    fetchJSON(`${FAPI_BASE}/fapi/v2/ticker/price?symbol=${SYMBOL}`),
    fetchJSON(`${FAPI_BASE}/futures/data/topLongShortAccountRatio?symbol=${SYMBOL}&period=1h&limit=5`),
    fetchJSON(`${FAPI_BASE}/futures/data/topLongShortPositionRatio?symbol=${SYMBOL}&period=1h&limit=5`),
    fetchJSON(`${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=1h&limit=5`),
    fetchJSON(`${FAPI_BASE}/fapi/v1/openInterest?symbol=${SYMBOL}`),
    fetchJSON(`${FAPI_BASE}/futures/data/openInterestHist?symbol=${SYMBOL}&period=4h&limit=3`),
    fetchJSON(`${FAPI_BASE}/futures/data/takerlongshortRatio?symbol=${SYMBOL}&period=5m&limit=6`),
    fetchJSON(`${FAPI_BASE}/fapi/v1/premiumIndex?symbol=${SYMBOL}`),
  ]);

  console.clear();
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  console.log(`\x1b[1m═══════════════════════════════════════════════════════\x1b[0m`);
  console.log(`\x1b[1m  ${SYMBOL} 聪明钱监控面板    ${now}\x1b[0m`);
  console.log(`\x1b[1m═══════════════════════════════════════════════════════\x1b[0m`);

  console.log(`\n  当前价格: \x1b[1m$${parseFloat(price.price).toFixed(4)}\x1b[0m`);
  console.log(`  资金费率: ${parseFloat(fundingRate.lastFundingRate) >= 0 ? '\x1b[32m' : '\x1b[31m'}${(parseFloat(fundingRate.lastFundingRate) * 100).toFixed(4)}%\x1b[0m`);
  console.log(`  持仓量:   ${formatVol(oi.openInterest)} ${SYMBOL.replace('USDT', '')}  (${formatUSDT(parseFloat(oi.openInterest) * parseFloat(price.price))})`);

  console.log(`\n\x1b[1m  ── 大户多空比 (Top 20%, 账户维度) ──\x1b[0m`);
  console.log(`  ${'时间'.padEnd(22)}  多头%    空头%    比值`);
  for (const d of topAccounts) {
    const t = ts2time(d.timestamp);
    console.log(`  ${t.padEnd(22)}  ${(d.longAccount * 100).toFixed(1)}%    ${(d.shortAccount * 100).toFixed(1)}%    ${colorRatio(d.longShortRatio)}`);
  }

  console.log(`\n\x1b[1m  ── 大户多空比 (Top 20%, 持仓维度) ── [核心指标]\x1b[0m`);
  console.log(`  ${'时间'.padEnd(22)}  多头%    空头%    比值`);
  for (const d of topPositions) {
    const t = ts2time(d.timestamp);
    console.log(`  ${t.padEnd(22)}  ${(d.longAccount * 100).toFixed(1)}%    ${(d.shortAccount * 100).toFixed(1)}%    ${colorRatio(d.longShortRatio)}`);
  }

  console.log(`\n\x1b[1m  ── 全网多空比 ──\x1b[0m`);
  console.log(`  ${'时间'.padEnd(22)}  多头%    空头%    比值`);
  for (const d of globalRatio) {
    const t = ts2time(d.timestamp);
    console.log(`  ${t.padEnd(22)}  ${(d.longAccount * 100).toFixed(1)}%    ${(d.shortAccount * 100).toFixed(1)}%    ${colorRatio(d.longShortRatio)}`);
  }

  console.log(`\n\x1b[1m  ── 持仓量变化 (4h) ──\x1b[0m`);
  for (const d of oiHist) {
    const t = ts2time(d.timestamp);
    console.log(`  ${t.padEnd(22)}  ${formatVol(d.sumOpenInterest).padEnd(10)}  ${formatUSDT(parseFloat(d.sumOpenInterestValue))}`);
  }

  console.log(`\n\x1b[1m  ── 主动买卖量 (5min) ──\x1b[0m`);
  console.log(`  ${'时间'.padEnd(22)}  买入量      卖出量      买卖比`);
  for (const d of takerVol) {
    const t = ts2time(d.timestamp);
    const ratio = parseFloat(d.buySellRatio);
    const color = ratio >= 1.1 ? '\x1b[32m' : ratio <= 0.9 ? '\x1b[31m' : '\x1b[33m';
    console.log(`  ${t.padEnd(22)}  ${formatVol(d.buyVol).padEnd(12)}${formatVol(d.sellVol).padEnd(12)}${color}${d.buySellRatio}\x1b[0m`);
  }

  // Signal summary
  const latestTopPos = topPositions[topPositions.length - 1];
  const latestGlobal = globalRatio[globalRatio.length - 1];
  const latestTaker = takerVol[takerVol.length - 1];
  const fr = parseFloat(fundingRate.lastFundingRate);

  console.log(`\n\x1b[1m  ── 信号摘要 ──\x1b[0m`);
  const posRatio = parseFloat(latestTopPos.longShortRatio);
  if (posRatio > 1.0) console.log(`  \x1b[32m✓\x1b[0m 大户持仓偏多 (${posRatio.toFixed(4)})`);
  else console.log(`  \x1b[31m✗\x1b[0m 大户持仓偏空 (${posRatio.toFixed(4)})`);

  const gRatio = parseFloat(latestGlobal.longShortRatio);
  if (gRatio > 1.0) console.log(`  \x1b[32m✓\x1b[0m 全网偏多 (${gRatio.toFixed(4)})`);
  else console.log(`  \x1b[31m✗\x1b[0m 全网偏空 (${gRatio.toFixed(4)})`);

  if (posRatio > 1.0 && gRatio < 1.0) {
    console.log(`  \x1b[33m⚡ 大户多 + 散户空 = 聪明钱抄底信号\x1b[0m`);
  }

  const bsRatio = parseFloat(latestTaker.buySellRatio);
  if (bsRatio > 1.1) console.log(`  \x1b[32m✓\x1b[0m 强力主动买入 (${bsRatio.toFixed(4)})`);
  else if (bsRatio < 0.9) console.log(`  \x1b[31m✗\x1b[0m 强力主动卖出 (${bsRatio.toFixed(4)})`);
  else console.log(`  \x1b[33m─\x1b[0m 买卖均衡 (${bsRatio.toFixed(4)})`);

  if (fr > 0.001) console.log(`  \x1b[31m⚠\x1b[0m 资金费率偏高 (${(fr * 100).toFixed(4)}%) - 多头拥挤`);
  else if (fr < -0.001) console.log(`  \x1b[32m✓\x1b[0m 资金费率为负 (${(fr * 100).toFixed(4)}%) - 空头付费`);
  else console.log(`  \x1b[33m─\x1b[0m 资金费率中性 (${(fr * 100).toFixed(4)}%)`);

  console.log(`\n  \x1b[2m下次刷新: ${INTERVAL_SEC}s 后 | Ctrl+C 退出 | 用法: node smart-money.mjs [SYMBOL] [秒]\x1b[0m`);
}

async function run() {
  while (true) {
    try {
      await monitor();
    } catch (e) {
      console.error(`\x1b[31m请求失败: ${e.message}\x1b[0m`);
    }
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

run();
