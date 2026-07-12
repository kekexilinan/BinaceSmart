/**
 * 用 mock 数据向飞书发送格式预览（不扫描币安 API）
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMergedSmartTrendElements, DEFAULT_MIN_RANKING_VOLUME_24H } from '../smart-trend-monitor.mjs';
import { buildSmartTrendDecision, buildSmartTrendDecisionElements } from '../smart-trend-decision.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function loadEnv() {
  try {
    const raw = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && match[2] && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {
    // .env optional
  }
}

async function sendFeishuCard(title, elements, template = 'blue', webhook) {
  const body = {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: title }, template },
      body: { elements },
    },
  };
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书发送失败: ${data.msg || JSON.stringify(data)}`);
  return data;
}

/** 简单确定性哈希，让每个币种的合成数据稳定且多样 */
function symHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** 根据哈希分桶生成合成 delta 百分比，覆盖大/中/小三档 */
function syntheticDeltaPct(hash, seedOffset = 0) {
  const h = Math.floor(hash / (seedOffset + 1));
  const bucket = h % 10;
  let pct;
  if (bucket < 2) {
    // 大幅变化 10%~25%
    pct = ((h % 150) / 10 + 10);
  } else if (bucket < 5) {
    // 中等变化 5%~10%
    pct = ((h % 50) / 10 + 5);
  } else {
    // 小幅变化 0.5%~5%
    pct = ((h % 45) / 10 + 0.5);
  }
  // 交替正负，让多空都有
  return (h % 2 === 0 ? 1 : -1) * pct;
}

function enrichMockRowsForPreview(rows) {
  return rows.map((row, idx) => {
    const next = { ...row };
    if (next.price > 0 && next.change8am != null && !next.price8am) {
      next.price8am = next.price / (1 + next.change8am / 100);
    }
    if (next.price > 0 && next.prevPrice == null && next.ratioDeltaPct != null) {
      next.prevPrice = next.price / (1 + (next.ratioDeltaPct / 100));
      next.priceDeltaPct = next.ratioDeltaPct;
    }

    // —— ratio 字段合成：当 prevRatio / ratio8am 缺失时生成拟真数据 ——
    if (next.ratio != null && next.ratio > 0) {
      const hash = symHash(next.symbol || `row${idx}`);

      if (next.prevRatio == null) {
        const dp = syntheticDeltaPct(hash, 0);
        next.prevRatio = next.ratio / (1 + dp / 100);
        if (next.ratioDeltaPct == null) next.ratioDeltaPct = dp;
      }

      if (next.ratio8am == null) {
        const dp8 = syntheticDeltaPct(hash, 7);
        next.ratio8am = next.ratio / (1 + dp8 / 100);
        if (next.ratio8amDeltaPct == null) next.ratio8amDeltaPct = dp8;
      }
    }

    // —— hints8amScore 回填：旧 mock 数据仅有显示字符串，需解析回数值参与排序 ——
    if (next.hints8amScore == null) {
      const m = String(next.hints8amLabel ?? '').match(/^([+-]?\d+)$/);
      next.hints8amScore = m ? parseInt(m[1], 10) : 0;
    }

    return next;
  });
}

function reorderBoardsForPreview(mock) {
  const rowMap = new Map();
  for (const board of mock.boards) {
    for (const row of board.rows || []) rowMap.set(row.symbol.toUpperCase(), row);
  }
  const pinned = new Set((mock.watchlist?.pinned || []).map(s => s.toUpperCase()));
  const mapRanked = (list) => enrichMockRowsForPreview((list || [])
    .filter(item => !pinned.has(item.symbol.toUpperCase()))
    .map(item => rowMap.get(item.symbol.toUpperCase()))
    .filter(Boolean));

  const reordered = mock.boards.map(board => {
    const rows = enrichMockRowsForPreview(board.rows || []);
    if (board.key === 'gainer') {
      return { ...board, rows: mapRanked(mock.watchlist?.gainers) };
    }
    if (board.key === 'loser') {
      return { ...board, rows: mapRanked(mock.watchlist?.losers) };
    }
    return { ...board, rows };
  });

  // 收集每个币种在所有板块中的来源，回写到 row 上供标签列显示
  const symbolSources = new Map();
  for (const board of reordered) {
    for (const row of board.rows || []) {
      const sym = row.symbol?.toUpperCase();
      if (!sym) continue;
      if (!symbolSources.has(sym)) symbolSources.set(sym, []);
      if (!symbolSources.get(sym).includes(board.key)) symbolSources.get(sym).push(board.key);
    }
  }
  for (const board of reordered) {
    board.rows = (board.rows || []).map(r => ({
      ...r,
      sources: symbolSources.get(r.symbol?.toUpperCase()) || [],
    }));
  }

  const pinnedBoard = reordered.find(b => b.key === 'pinned');
  const others = reordered.filter(b => b.key !== 'pinned');
  return pinnedBoard ? [pinnedBoard, ...others] : reordered;
}

function buildMergedPreviewElements(mock) {
  const boards = reorderBoardsForPreview(mock);
  const allRows = boards.flatMap(b => b.rows || []);
  const minRankingVolume24h = Math.max(
    0,
    parseInt(process.env.SMART_TREND_MIN_RANKING_VOLUME_24H || String(DEFAULT_MIN_RANKING_VOLUME_24H), 10) || 0,
  );
  const elements = buildMergedSmartTrendElements({
    boards,
    outlook: mock.outlook,
    enriched: allRows,
    intervalMin: mock.intervalMin ?? 60,
    highlightPct: mock.highlightPct ?? 10,
    dateKey: mock.dateKey,
    minRankingVolume24h,
  });
  elements.unshift({
    tag: 'markdown',
    content: `**🧪 格式预览（mock 数据）** · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
  });
  return elements;
}

async function main() {
  await loadEnv();
  const webhook = process.env.FEISHU_WEBHOOK;
  if (!webhook) throw new Error('FEISHU_WEBHOOK 未配置');

  const mock = JSON.parse(await readFile(join(ROOT, 'data/smart-trend-push-mock.json'), 'utf8'));
  const highlightPct = mock.highlightPct ?? 10;

  const boards = reorderBoardsForPreview(mock);
  const digestElements = buildMergedPreviewElements(mock);
  await sendFeishuCard('🧪 聪明钱监控全览 · 格式预览', digestElements, 'turquoise', webhook);
  console.log('✓ 监控全览预览已发送');

  await new Promise(r => setTimeout(r, 2500));

  const decision = buildSmartTrendDecision({
    boards,
    outlook: mock.outlook,
    highlightPct,
    previousState: {},
    now: mock.capturedAt,
  });
  const decisionElements = buildSmartTrendDecisionElements(decision, { highlightPct });
  decisionElements.unshift({
    tag: 'markdown',
    content: '**🧪 格式预览（mock 数据）**',
  });
  await sendFeishuCard(
    `🧪 聪明钱操作清单 · ${decision.summary.verdict}`,
    decisionElements,
    decision.summary.template,
    process.env.SMART_TREND_DECISION_WEBHOOK || webhook,
  );
  console.log('✓ 操作清单预览已发送');
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
