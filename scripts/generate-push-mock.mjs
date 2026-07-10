/**
 * 从 smart-trend-state + watchlist 快照生成 push mock 数据（用于离线回归/预览）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATE_FILE = join(DATA_DIR, 'smart-trend-state.json');
const WATCHLIST_FILE = join(DATA_DIR, 'smart-trend-watchlist.json');
const MOCK_FILE = join(DATA_DIR, 'smart-trend-push-mock.json');

function badgeFromScore(score, direction) {
  if (score >= 6) return direction === 'long' ? '🟢' : '🔴';
  if (score >= 4) return direction === 'long' ? '🟡' : '🟠';
  return '⚪';
}

function stateToRow(sym, s, change = null) {
  const ratio = s.ratio ?? 0;
  const ratio8am = s.ratio8am ?? null;
  return {
    symbol: sym,
    label: sym.replace(/USDT$/, ''),
    badge: badgeFromScore(s.score ?? 0, s.direction ?? 'short'),
    direction: s.direction ?? 'short',
    ratio,
    prevRatio: null,
    ratioDeltaPct: null,
    ratio8am,
    ratio8amDeltaPct: ratio8am && ratio8am > 0 ? ((ratio - ratio8am) / ratio8am) * 100 : null,
    change24h: change,
    change8am: change,
    price: s.price ?? null,
    prevPrice: null,
    fundingRate: s.fundingRate ?? null,
    prevFundingRate: null,
    fundingDeltaPct: null,
    hints8amLabel: s.longHints8am || s.shortHints8am
      ? `${s.longHints8am ? `多${s.longHints8am}` : ''}${s.shortHints8am ? `空${s.shortHints8am}` : ''}`.replace(/^$/, '-')
      : '-',
    marketCapLabel: null,
    pinned: false,
    volumeRank: null,
  };
}

function buildBoardRows(list, state, tieBreakFn) {
  const rows = (list || [])
    .map(({ symbol, change, volume }) => {
      const s = state[symbol.toUpperCase()];
      if (!s) return null;
      const row = stateToRow(symbol.toUpperCase(), s, change);
      if (volume != null) row.volumeRank = volume;
      return row;
    })
    .filter(Boolean);
  return rows.sort(tieBreakFn);
}

async function main() {
  const raw = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  const watchlist = JSON.parse(await readFile(WATCHLIST_FILE, 'utf8'));
  const meta = raw._meta || {};
  const state = { ...raw };
  delete state._meta;

  const pinned = watchlist.pinned || [];
  const pinnedSet = new Set(pinned.map(s => s.toUpperCase()));
  const excludePinned = (list) => (list || []).filter(i => !pinnedSet.has(i.symbol.toUpperCase()));

  const gainerRows = buildBoardRows(
    excludePinned(watchlist.gainers),
    state,
    (a, b) => (b.change24h ?? 0) - (a.change24h ?? 0),
  );
  const loserRows = buildBoardRows(
    excludePinned(watchlist.losers),
    state,
    (a, b) => (a.change24h ?? 0) - (b.change24h ?? 0),
  );
  const pinnedRows = buildBoardRows(
    pinned.map(s => ({ symbol: s, change: 0 })),
    state,
    (a, b) => Math.abs(b.ratio8amDeltaPct ?? 0) - Math.abs(a.ratio8amDeltaPct ?? 0),
  ).map(r => ({ ...r, pinned: true }));
  const rightSideRows = buildBoardRows(
    watchlist.rightSide,
    state,
    (a, b) => (b.change24h ?? 0) - (a.change24h ?? 0),
  );
  const volumeRows = buildBoardRows(
    watchlist.volumeTop,
    state,
    (a, b) => (b.volumeRank ?? 0) - (a.volumeRank ?? 0),
  );

  const boards = [
    { key: 'gainer', label: '📈 24h涨幅榜', template: 'green', rowCount: gainerRows.length, rows: gainerRows },
    { key: 'loser', label: '📉 24h跌幅榜', template: 'red', rowCount: loserRows.length, rows: loserRows },
  ];
  if (pinnedRows.length) {
    boards.push({ key: 'pinned', label: '📌 固定监控', template: 'blue', rowCount: pinnedRows.length, rows: pinnedRows });
  }
  if (rightSideRows.length) {
    boards.push({ key: 'rightSide', label: '📐 右侧交易', template: 'orange', rowCount: rightSideRows.length, rows: rightSideRows });
  }
  if (volumeRows.length) {
    boards.push({ key: 'volumeTop', label: `💰 24h交易额 Top${watchlist.volumeTopN ?? 50}`, template: 'purple', rowCount: volumeRows.length, rows: volumeRows });
  }

  const allRows = [...gainerRows, ...loserRows, ...pinnedRows, ...rightSideRows, ...volumeRows];
  const highlightPct = 10;
  const totalBig = allRows.filter(r => r.ratioDeltaPct != null && Math.abs(r.ratioDeltaPct) >= highlightPct).length;

  const snapshot = {
    capturedAt: watchlist.updatedAt || Date.now(),
    source: 'state-snapshot',
    dateKey: watchlist.dateKey,
    mergeCards: true,
    highlightPct,
    intervalMin: 60,
    stateMeta: meta,
    watchlist: {
      gainers: watchlist.gainers,
      losers: watchlist.losers,
      pinned: watchlist.pinned,
      rightSide: watchlist.rightSide,
      volumeTop: watchlist.volumeTop,
      volumeTopN: watchlist.volumeTopN,
      topN: watchlist.topN,
    },
    boards,
    stats: {
      totalCoins: allRows.length,
      totalBig,
      failed: 0,
      symbolCount: watchlist.symbols?.length ?? Object.keys(state).length,
    },
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MOCK_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`✓ mock 已写入 ${MOCK_FILE} (${boards.length} 板块 · ${snapshot.stats.symbolCount} 币种)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
