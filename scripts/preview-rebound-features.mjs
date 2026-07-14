/**
 * 预览背离检测 + 反弹高亮 + 反弹潜力评分 新功能
 * 从现有 mock 数据注入合成背离数据后推送
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMergedSmartTrendElements, DEFAULT_MIN_RANKING_VOLUME_24H } from '../smart-trend-monitor.mjs';
import { buildSmartTrendDecision, buildSmartTrendDecisionElements } from '../smart-trend-decision.mjs';
import { calcReboundPotential } from '../scan-dump-risk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function loadEnv() {
  try {
    const raw = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && match[2] && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {}
}

function sendFeishuCard(title, elements, template = 'blue', webhook) {
  const body = {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: title }, template },
      body: { elements },
    },
  };
  return fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

/** 注入合成背离数据到 row */
function injectDivergenceData(row) {
  const r = { ...row };
  const ratio = r.ratio ?? 1.0;

  // 对 ratio > 0.9 的币种模拟大户多空比（比总 ratio 偏高 0.3~0.6）
  // 对 ratio < 0.9 的币种模拟散户多空比（偏低模拟散户偏空）
  if (ratio >= 0.9) {
    // 大户更偏多，散户偏空 → 背离
    r.whaleRatio = +(ratio + 0.3 + Math.random() * 0.3).toFixed(4);
    r.globalRatio = +(ratio - 0.2 - Math.random() * 0.15).toFixed(4);
  } else if (ratio >= 0.5) {
    // 中等情况：可能有轻微背离或无
    r.whaleRatio = +(ratio + 0.1 + Math.random() * 0.2).toFixed(4);
    r.globalRatio = +(ratio + Math.random() * 0.1).toFixed(4);
  } else {
    // 大户偏空但散户也偏空，一般无背离
    r.whaleRatio = +(ratio + Math.random() * 0.1).toFixed(4);
    r.globalRatio = +(ratio + 0.1 + Math.random() * 0.2).toFixed(4);
  }
  r.divergence = +(r.whaleRatio - r.globalRatio).toFixed(4);

  // 给一些币种注入 change24h 来触发 reboundHighlight
  if (r.divergence >= 0.2 && r.whaleRatio > 1.0 && r.globalRatio < 0.9) {
    r.change24h = r.change24h ?? -15 - Math.random() * 10;
  }
  return r;
}

async function main() {
  await loadEnv();
  const webhook = process.env.FEISHU_WEBHOOK;
  if (!webhook) throw new Error('FEISHU_WEBHOOK 未配置');

  const divergenceThreshold = parseFloat(process.env.SMART_TREND_DIVERGENCE_THRESHOLD || '0.25');
  const reboundHighlightPct = parseFloat(process.env.REBOUND_HIGHLIGHT_CHANGE_PCT || '15');

  // 读取现有 mock 数据
  const mock = JSON.parse(await readFile(join(ROOT, 'data/smart-trend-push-mock.json'), 'utf8'));

  // 对所有行注入合成背离数据
  for (const board of mock.boards) {
    board.rows = (board.rows || []).map(injectDivergenceData);
  }
  const allRows = mock.boards.flatMap(b => b.rows || []);

  // 重新计算 outlook（含 divergence 统计）
  const { computeMarketOutlook } = await import('../smart-trend-monitor.mjs');
  mock.outlook = computeMarketOutlook(allRows, divergenceThreshold);

  // --- 第1次推送：聪明的钱全览卡片（含背离列 + 背离统计 + 反弹高亮） ---
  const minRankingVolume24h = Math.max(
    0, parseInt(process.env.SMART_TREND_MIN_RANKING_VOLUME_24H || String(DEFAULT_MIN_RANKING_VOLUME_24H), 10) || 0,
  );

  // 生成决策（会产出 reboundHighlights 和 heldSymbols 过滤）
  const highlightPct = mock.highlightPct ?? 10;
  const heldSymbols = new Set(['BTWUSDT', 'BANKUSDT', 'DEXEUSDT', 'LUMIAUSDT']); // 模拟已持仓币种（含现货LUMIA）
  const decision = buildSmartTrendDecision({
    boards: mock.boards,
    outlook: mock.outlook,
    highlightPct,
    divergenceThreshold,
    reboundHighlightPct,
    heldSymbols,
    previousState: {},
    now: mock.capturedAt || Date.now(),
  });

  // 构建全览卡片（含 reboundHighlights）
  const digestElements = buildMergedSmartTrendElements({
    boards: mock.boards,
    outlook: mock.outlook,
    enriched: allRows,
    intervalMin: mock.intervalMin ?? 60,
    highlightPct,
    dateKey: mock.dateKey,
    minRankingVolume24h,
    reboundHighlights: decision.reboundHighlights || [],
  });
  digestElements.unshift({
    tag: 'markdown',
    content: `**🧪 新功能预览：背离检测 + 反弹高亮（合成数据）** · 背离阈值=${divergenceThreshold} · 反弹高亮跌幅≥${reboundHighlightPct}%`,
  });

  const digestResult = await sendFeishuCard(
    `🧪 聪明钱监控 · 背离+反弹预览 | 背离 ${mock.outlook?.divergenceCount || 0} 个信号`,
    digestElements,
    'turquoise',
    webhook,
  );
  console.log(`✓ 全览推送: ${JSON.stringify(digestResult)}`);

  await new Promise(r => setTimeout(r, 2500));

  // --- 第2次推送：操作清单卡片（含 rebound_watch 信号） ---
  const decisionElements = buildSmartTrendDecisionElements(decision, { highlightPct, heldSymbols });
  decisionElements.unshift({
    tag: 'markdown',
    content: `**🧪 新功能预览（合成数据）** · 背离信号触发 rebound_watch 观察`,
  });
  const decisionResult = await sendFeishuCard(
    `🧪 聪明钱操作清单 · ${decision.summary.verdict} | ${decision.reboundHighlights?.length || 0} 个反弹观察`,
    decisionElements,
    decision.summary.template || 'blue',
    process.env.SMART_TREND_DECISION_WEBHOOK || webhook,
  );
  console.log(`✓ 操作清单: ${JSON.stringify(decisionResult)}`);

  // --- 第3次推送：暴跌推送反弹潜力预览 ---
  await new Promise(r => setTimeout(r, 2500));
  const { checkDumpRisk } = await import('../scan-dump-risk.mjs');

  // 直接模拟一些暴跌币 + 反弹潜力评分
  const testSymbols = ['LABUSDT', 'EVAAUSDT', 'SKYAIUSDT', 'AIOTUSDT', 'RIVERUSDT', 'AIOUSDT', 'BUSDT'];
  const dumpResults = [];
  for (const sym of testSymbols) {
    try {
      const result = await checkDumpRisk(sym);
      dumpResults.push(result);
    } catch (e) {
      console.warn(`  ⚠ ${sym}: ${e.message}`);
    }
  }
  dumpResults.sort((a, b) => b.riskScore - a.riskScore);

  console.log('\n反弹潜力评分:');
  for (const r of dumpResults) {
    console.log(`  ${r.label.padEnd(10)} 风险=${r.riskScore} 反弹=${r.reboundScore}(${r.reboundLevel}) ${r.reboundFactors?.map(f => `${f.tag}:${f.score}`).join(' ') || ''}`);
  }

  // 构建暴跌推送卡片
  const dumpTableRows = dumpResults.map(r => {
    const color = r.reboundLevel === 'high' ? 'green' : r.reboundLevel === 'medium' ? 'orange' : 'grey';
    const riskColor = r.riskLevel === 'high' ? 'red' : 'orange';
    return {
      coin: r.label,
      price: r.price.toFixed ? (r.price < 1 ? r.price.toFixed(6) : r.price.toFixed(4)) : String(r.price),
      risk: `<font color='${riskColor}'>${r.riskScore}</font>`,
      rebound: `<font color='${color}'>${r.reboundScore}${r.reboundLabel}</font>`,
      change: `${r.change24h > 0 ? '+' : ''}${r.change24h?.toFixed(1)}%`,
      factors: r.risks.slice(0, 3).map(x => `${x.level}${x.tag}`).join(' ').slice(0, 60),
    };
  });

  const dumpElements = [
    {
      tag: 'markdown',
      content: `**🧪 新功能预览：暴跌推送 + 反弹潜力评分**`,
    },
    {
      tag: 'table',
      page_size: 10,
      row_height: 'low',
      columns: [
        { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
        { name: 'price', display_name: '币价', data_type: 'text', width: 'auto' },
        { name: 'risk', display_name: '风险', data_type: 'lark_md', width: 'auto' },
        { name: 'rebound', display_name: '反弹', data_type: 'lark_md', width: 'auto' },
        { name: 'change', display_name: '24h', data_type: 'lark_md', width: 'auto' },
        { name: 'factors', display_name: '风险标签', data_type: 'text', width: 'auto' },
      ],
      rows: dumpTableRows,
    },
  ];

  const dumpResult = await sendFeishuCard(
    `🧪 暴跌警报 · 反弹潜力预览 | ${dumpResults.filter(r => r.reboundLevel === 'high').length} 个高反弹潜力`,
    dumpElements,
    'red',
    webhook,
  );
  console.log(`✓ 暴跌推送: ${JSON.stringify(dumpResult)}`);

  console.log('\n✅ 预览推送完成，请查看飞书群');
}

main().catch(e => {
  console.error('❌', e.message || e);
  process.exit(1);
});
