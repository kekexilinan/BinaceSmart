import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const PREDICTIONS_FILE = join(DATA_DIR, 'strategy-predictions.json');
const REVIEWS_FILE = join(DATA_DIR, 'strategy-reviews.json');

const REVIEW_ENABLED = process.env.STRATEGY_REVIEW_ENABLED !== 'false';
const REVIEW_HOURS = parseInt(process.env.STRATEGY_REVIEW_HOURS || process.env.STABLE_PUSH_HOURS || '4', 10);
const REVIEW_TOP_N = parseInt(process.env.STRATEGY_REVIEW_TOP_N || '10', 10);
const REVIEW_PUSH_FEISHU = process.env.STRATEGY_REVIEW_PUSH !== 'false';
const MAX_SNAPSHOTS = parseInt(process.env.STRATEGY_REVIEW_MAX_SNAPSHOTS || '168', 10);
const MAX_REVIEWS = parseInt(process.env.STRATEGY_REVIEW_MAX_REVIEWS || '90', 10);

let deps = null;
let saveQueue = Promise.resolve();
let reviewRunning = false;

export function initStrategyReview(dependencies) {
  deps = dependencies;
}

async function readJsonFile(path, fallback) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function queueSave(path, data) {
  saveQueue = saveQueue.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(path, JSON.stringify(data), 'utf8');
  }).catch(() => {});
}

function symLabel(symbol) {
  return symbol.replace(/USDT$/, '');
}

function compactItem(item, type) {
  const base = {
    symbol: item.symbol,
    label: item.label || symLabel(item.symbol),
    price: item.price,
  };
  if (type === 'long' || type === 'stable') {
    return { ...base, score: item.score, changeSince8am: item.changeSince8am ?? item.change };
  }
  if (type === 'short') {
    return { ...base, shortScore: item.shortScore, chg24h: item.chg24h, ddFromPeak: item.ddFromPeak };
  }
  if (type === 'dump') {
    return { ...base, riskScore: item.riskScore, changeSince8am: item.changeSince8am ?? item.change24h };
  }
  return base;
}

export async function savePredictionSnapshot({ long = [], short = [], stable = [], dump = [], source = 'combined' }) {
  if (!long.length && !short.length && !stable.length && !dump.length) return;

  const store = await readJsonFile(PREDICTIONS_FILE, { snapshots: [] });
  const snap = {
    ts: Date.now(),
    source,
    long: long.map(i => compactItem(i, 'long')),
    short: short.map(i => compactItem(i, 'short')),
    stable: stable.map(i => compactItem(i, 'stable')),
    dump: dump.map(i => compactItem(i, 'dump')),
  };
  store.snapshots.push(snap);
  if (store.snapshots.length > MAX_SNAPSHOTS) {
    store.snapshots = store.snapshots.slice(-MAX_SNAPSHOTS);
  }
  queueSave(PREDICTIONS_FILE, store);
}

function findSnapshotBefore(snapshots, cutoffTs) {
  let best = null;
  for (const s of snapshots) {
    if (s.ts <= cutoffTs && (!best || s.ts > best.ts)) best = s;
  }
  return best || snapshots[0] || null;
}

function buildReflections(review) {
  const lines = [];

  const topGainerLabels = review.actualTopGainers.slice(0, 3).map(g => g.label).join('、');
  const topLoserLabels = review.actualTopLosers.slice(0, 3).map(g => g.label).join('、');

  if (review.longMisses.length) {
    const names = review.longMisses.slice(0, 5).map(m => m.label).join('、');
    lines.push(`**涨幅遗漏**：${names} 位居涨幅前${REVIEW_TOP_N}，但未出现在做多/稳趋势推荐中（榜首 ${topGainerLabels}）`);
  }

  if (review.shortFalseSignals.length) {
    const names = review.shortFalseSignals.slice(0, 5).map(m => `${m.label}(+${m.changeSinceSnap.toFixed(1)}%)`).join('、');
    lines.push(`**做空失误**：${names} 曾被推荐做空，但期间仍在上涨 — 暴涨续涨模式，不宜过早做空`);
  }

  if (review.shortMisses.length) {
    const names = review.shortMisses.slice(0, 5).map(m => `${m.label}(${m.change.toFixed(1)}%)`).join('、');
    lines.push(`**跌幅遗漏**：${names} 位居跌幅前${REVIEW_TOP_N}，但未出现在做空/暴跌预警中（榜末 ${topLoserLabels}）`);
  }

  if (review.shortInGainers.length) {
    const names = review.shortInGainers.map(m => `${m.label}(#${m.gainerRank})`).join('、');
    lines.push(`**方向冲突**：${names} 被做空推荐却进入涨幅榜 — 策略可能把「暴涨」误判为「见顶」`);
  }

  if (review.longHits.length) {
    const names = review.longHits.slice(0, 3).map(m => m.label).join('、');
    lines.push(`**做多命中**：${names} 在推荐后表现良好`);
  }

  if (review.shortHits.length) {
    const names = review.shortHits.slice(0, 3).map(m => `${m.label}(${m.changeSinceSnap.toFixed(1)}%)`).join('、');
    lines.push(`**做空命中**：${names} 推荐后确实下跌`);
  }

  if (!lines.length) {
    lines.push('本周期策略与涨跌幅榜基本吻合，暂无明显偏差。');
  }

  const suggestions = [];
  if (review.shortFalseSignals.length >= 2 || review.shortInGainers.length >= 2) {
    suggestions.push('考虑提高做空门槛：24h涨幅>80%且峰值回撤<5%时不做空（续涨模式）');
  }
  if (review.longMisses.length >= 3) {
    suggestions.push('考虑增加「8点以来涨幅>20% + 量能放大」的追涨做多因子');
  }
  if (review.shortMisses.length >= 2) {
    suggestions.push('考虑增加「8点以来跌幅>15% + OI下降」的追跌做空因子');
  }
  if (suggestions.length) {
    lines.push('');
    lines.push('**策略建议**：');
    for (const s of suggestions) lines.push(`- ${s}`);
  }

  return lines;
}

export async function runStrategyReview({ pushFeishu = REVIEW_PUSH_FEISHU } = {}) {
  if (!deps || reviewRunning) return null;
  reviewRunning = true;

  try {
    const { getGainersSince8am, getLosersSince8am, getPrices, sendFeishuCard, fmtPrice } = deps;
    const periodMs = REVIEW_HOURS * 3600 * 1000;
    const now = Date.now();
    const cutoff = now - periodMs;

    const store = await readJsonFile(PREDICTIONS_FILE, { snapshots: [] });
    const prevSnap = findSnapshotBefore(store.snapshots, cutoff);
    if (!prevSnap) {
      console.log('  ⏭ 策略复盘：尚无历史预测快照，跳过');
      return null;
    }

    const [gainersData, losersData] = await Promise.all([
      getGainersSince8am(Math.max(REVIEW_TOP_N, 50)),
      getLosersSince8am(Math.max(REVIEW_TOP_N, 50)),
    ]);

    const topGainers = gainersData.items.slice(0, REVIEW_TOP_N);
    const topLosers = losersData.items.slice(0, REVIEW_TOP_N);
    const gainerSet = new Set(topGainers.map(g => g.symbol));
    const loserSet = new Set(topLosers.map(g => g.symbol));
    const gainerRank = new Map(topGainers.map((g, i) => [g.symbol, i + 1]));

    const prevLongSet = new Set([
      ...prevSnap.long.map(i => i.symbol),
      ...prevSnap.stable.map(i => i.symbol),
    ]);
    const prevShortSet = new Set([
      ...prevSnap.short.map(i => i.symbol),
      ...prevSnap.dump.map(i => i.symbol),
    ]);

    const allPrevSymbols = [...new Set([
      ...prevSnap.long.map(i => i.symbol),
      ...prevSnap.short.map(i => i.symbol),
      ...prevSnap.stable.map(i => i.symbol),
      ...prevSnap.dump.map(i => i.symbol),
    ])];

    const currentPrices = await getPrices(allPrevSymbols);

    const longMisses = topGainers
      .filter(g => !prevLongSet.has(g.symbol))
      .map(g => ({ symbol: g.symbol, label: symLabel(g.symbol), change: g.change, rank: gainerRank.get(g.symbol) }));

    const shortMisses = topLosers
      .filter(g => !prevShortSet.has(g.symbol))
      .map(g => ({ symbol: g.symbol, label: symLabel(g.symbol), change: g.change }));

    const shortFalseSignals = [];
    const shortHits = [];
    const longHits = [];

    for (const item of prevSnap.short) {
      const cur = currentPrices[item.symbol];
      if (!cur || !item.price) continue;
      const changeSinceSnap = ((cur - item.price) / item.price) * 100;
      const entry = { ...item, changeSinceSnap, currentPrice: cur };
      if (changeSinceSnap > 3) shortFalseSignals.push(entry);
      else if (changeSinceSnap < -3) shortHits.push(entry);
    }

    for (const item of [...prevSnap.long, ...prevSnap.stable]) {
      const cur = currentPrices[item.symbol];
      if (!cur || !item.price) continue;
      const changeSinceSnap = ((cur - item.price) / item.price) * 100;
      if (changeSinceSnap > 5 && gainerSet.has(item.symbol)) {
        longHits.push({ ...item, changeSinceSnap, rank: gainerRank.get(item.symbol) });
      }
    }

    const shortInGainers = prevSnap.short
      .filter(s => gainerSet.has(s.symbol))
      .map(s => {
        const cur = currentPrices[s.symbol];
        const changeSinceSnap = cur && s.price ? ((cur - s.price) / s.price) * 100 : 0;
        return {
          ...s,
          gainerRank: gainerRank.get(s.symbol),
          change: topGainers.find(g => g.symbol === s.symbol)?.change,
          changeSinceSnap,
          currentPrice: cur,
        };
      })
      .sort((a, b) => a.gainerRank - b.gainerRank);

    const review = {
      ts: now,
      periodHours: REVIEW_HOURS,
      sinceSnapshotTs: prevSnap.ts,
      sinceSnapshotAge: Math.round((now - prevSnap.ts) / 60000),
      actualTopGainers: topGainers.map(g => ({ symbol: g.symbol, label: symLabel(g.symbol), change: g.change })),
      actualTopLosers: topLosers.map(g => ({ symbol: g.symbol, label: symLabel(g.symbol), change: g.change })),
      prevLongCount: prevSnap.long.length + prevSnap.stable.length,
      prevShortCount: prevSnap.short.length + prevSnap.dump.length,
      longMisses,
      shortMisses,
      shortFalseSignals,
      shortHits,
      longHits,
      shortInGainers,
      reflections: [],
    };

    review.reflections = buildReflections(review);

    const reviewStore = await readJsonFile(REVIEWS_FILE, { reviews: [] });
    reviewStore.reviews.push(review);
    if (reviewStore.reviews.length > MAX_REVIEWS) {
      reviewStore.reviews = reviewStore.reviews.slice(-MAX_REVIEWS);
    }
    queueSave(REVIEWS_FILE, reviewStore);

    const snapTime = new Date(prevSnap.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const reviewTime = new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

    console.log(`\n  🔍 策略复盘完成 (${REVIEW_HOURS}h)`);
    console.log(`     对比快照: ${snapTime} (${review.sinceSnapshotAge}分钟前)`);
    console.log(`     涨幅遗漏: ${longMisses.length} | 做空失误: ${shortFalseSignals.length} | 跌幅遗漏: ${shortMisses.length}`);
    for (const line of review.reflections.slice(0, 3)) {
      console.log(`     ${line.replace(/\*\*/g, '')}`);
    }

    if (pushFeishu && sendFeishuCard && deps.feishuEnabled) {
      const elements = [];
      elements.push({ tag: 'markdown', content: `**复盘时间:** ${reviewTime}\n**对比快照:** ${snapTime}（${review.sinceSnapshotAge}分钟前）\n**周期:** ${REVIEW_HOURS}小时` });

      elements.push({ tag: 'markdown', content: `**📈 涨幅 Top${REVIEW_TOP_N}（8点基准）**\n${topGainers.slice(0, 5).map((g, i) => `${i + 1}. **${symLabel(g.symbol)}** +${g.change.toFixed(1)}%${prevLongSet.has(g.symbol) ? ' ✓已推荐' : ' ✗遗漏'}`).join('\n')}` });

      elements.push({ tag: 'markdown', content: `**📉 跌幅 Top${REVIEW_TOP_N}（8点基准）**\n${topLosers.slice(0, 5).map((g, i) => `${i + 1}. **${symLabel(g.symbol)}** ${g.change.toFixed(1)}%${prevShortSet.has(g.symbol) ? ' ✓已推荐' : ' ✗遗漏'}`).join('\n')}` });

      if (shortFalseSignals.length || shortInGainers.length) {
        const rows = [...shortFalseSignals, ...shortInGainers.filter(s => !shortFalseSignals.find(f => f.symbol === s.symbol))]
          .slice(0, 8)
          .map(s => ({
            coin: s.label,
            snapPrice: `$${fmtPrice(s.price)}`,
            nowPrice: `$${fmtPrice(s.currentPrice || currentPrices[s.symbol] || s.price)}`,
            chg: `<font color='red'>+${(s.changeSinceSnap ?? s.change ?? 0).toFixed(1)}%</font>`,
            rank: s.gainerRank ? `#${s.gainerRank}` : '-',
          }));
        if (rows.length) {
          elements.push({ tag: 'markdown', content: `**⚠️ 做空推荐但仍在涨 · ${rows.length} 个**` });
          elements.push({
            tag: 'table',
            page_size: 8,
            row_height: 'low',
            columns: [
              { name: 'coin', display_name: '币种', data_type: 'text', width: '80px' },
              { name: 'snapPrice', display_name: '快照价', data_type: 'text', width: 'auto' },
              { name: 'nowPrice', display_name: '现价', data_type: 'text', width: 'auto' },
              { name: 'chg', display_name: '期间涨跌', data_type: 'lark_md', width: 'auto' },
              { name: 'rank', display_name: '涨幅排名', data_type: 'text', width: 'auto' },
            ],
            rows,
          });
        }
      }

      elements.push({ tag: 'markdown', content: review.reflections.join('\n') });
      elements.push({ tag: 'markdown', content: `_每${REVIEW_HOURS}h复盘 · 对比${REVIEW_HOURS}h前预测 vs 当前涨跌幅榜_` });

      const missCount = longMisses.length + shortMisses.length;
      const failCount = shortFalseSignals.length;
      const template = failCount >= 2 || missCount >= 3 ? 'red' : missCount >= 1 ? 'orange' : 'green';
      const title = `策略复盘 · ${failCount ? `做空失误${failCount}` : ''}${failCount && missCount ? ' · ' : ''}${missCount ? `遗漏${missCount}` : ''}${!failCount && !missCount ? '策略正常' : ''}`;

      await sendFeishuCard(title, elements, template);
      console.log(`  ✓ 策略复盘已推送飞书`);
    }

    return review;
  } catch (e) {
    console.warn(`  ⚠ 策略复盘失败: ${e.message}`);
    return null;
  } finally {
    reviewRunning = false;
  }
}

export async function getStrategyReviews(hours = 48) {
  const store = await readJsonFile(REVIEWS_FILE, { reviews: [] });
  const cutoff = Date.now() - hours * 3600 * 1000;
  return {
    reviews: store.reviews.filter(r => r.ts >= cutoff),
    totalReviews: store.reviews.length,
    reviewHours: REVIEW_HOURS,
    topN: REVIEW_TOP_N,
  };
}

export async function getLatestPredictions(hours = 24) {
  const store = await readJsonFile(PREDICTIONS_FILE, { snapshots: [] });
  const cutoff = Date.now() - hours * 3600 * 1000;
  return store.snapshots.filter(s => s.ts >= cutoff);
}

export function startStrategyReviewScheduler() {
  if (!REVIEW_ENABLED || !deps) {
    console.log(`  ⏸ 策略复盘未启用`);
    return;
  }

  const { getNextReviewTime } = deps;
  const slots = [];
  for (let h = 0; h < 24; h += REVIEW_HOURS) {
    slots.push(`${String(h).padStart(2, '0')}:50`);
  }
  console.log(`  🔍 策略复盘: 上海时间 ${slots.join(' / ')}（每 ${REVIEW_HOURS}h）${REVIEW_PUSH_FEISHU && deps.feishuEnabled ? '→ 飞书' : ''}`);

  const scheduleNext = () => {
    const next = getNextReviewTime(new Date(), REVIEW_HOURS);
    const delay = Math.max(0, next.getTime() - Date.now());
    const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  ⏭ 下次复盘: ${label}（${Math.round(delay / 60000)} 分钟后）`);
    setTimeout(async () => {
      await runStrategyReview();
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}
