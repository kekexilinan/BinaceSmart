import { getUserPositions } from './user-positions.mjs';
import { evaluatePositionHealth } from './position-health.mjs';

const HEALTH_RANK = { healthy: 0, warning: 1, critical: 2 };

let deps = null;
let running = false;
const lastState = new Map();

export function initPositionHealthMonitor(dependencies) {
  deps = dependencies;
}

function shouldPush(id, health, action) {
  const prev = lastState.get(id);
  lastState.set(id, { health, action, at: Date.now() });
  if (!prev) {
    return HEALTH_RANK[health] >= 1 || action === 'stop_loss';
  }
  const worse = HEALTH_RANK[health] > HEALTH_RANK[prev.health];
  const newStop = action === 'stop_loss' && prev.action !== 'stop_loss';
  return worse || newStop;
}

export function resetPositionHealthState() {
  lastState.clear();
}

export async function runPositionHealthPush(options = {}) {
  if (options.force) lastState.clear();
  if (!deps?.enabled || !deps?.feishuEnabled || running) return;
  running = true;
  try {
    const positions = await getUserPositions();
    const watchSet = deps.watchSymbols;
    const filtered = watchSet.size > 0
      ? positions.filter(p => watchSet.has(p.symbol.toUpperCase()))
      : positions;

    if (!filtered.length) return;

    const alerts = [];
    for (const pos of filtered) {
      try {
        const h = await evaluatePositionHealth({
          symbol: pos.symbol,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
        });
        if (shouldPush(pos.id, h.health, h.action)) {
          alerts.push({ pos, h });
        }
      } catch (e) {
        console.warn(`  ⚠ 持仓健康检查失败 ${pos.symbol}: ${e.message}`);
      }
    }

    if (!alerts.length) return;

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const lines = alerts.map(({ pos, h }) => {
      const dir = pos.direction === 'long' ? '做多' : '做空';
      const pnlSign = h.pnlPct >= 0 ? '+' : '';
      return [
        `**${h.label}** ${dir} @ $${h.entryPrice}`,
        `现价 $${h.currentPrice} · 盈亏 ${pnlSign}${h.pnlPct}%`,
        `${h.healthLabel} · ${h.actionLabel}`,
        ...(h.reasons?.slice(0, 3).map(r => `• ${r}`) || []),
      ].join('\n');
    });

    const watchLabel = deps.watchSymbols.size
      ? [...deps.watchSymbols].map(s => s.replace('USDT', '')).join(', ')
      : '全部手动持仓';
    const content = [
      `**⏰ ${now}**`,
      `**持仓健康预警** · 每 ${deps.intervalMin} 分钟 · 监控 ${watchLabel}`,
      '',
      ...lines,
    ].join('\n\n');

    const title = `💊 持仓健康 · ${alerts.map(a => a.h.label).join(', ')}`;
    const result = await deps.sendFeishu(title, content);
    if (result?.code !== 0 && result?.StatusCode !== 0) {
      throw new Error(result?.msg || JSON.stringify(result));
    }
    console.log(`  ✓ 持仓健康推送 (${alerts.map(a => a.h.label).join(', ')})`);
  } catch (e) {
    console.warn(`  ⚠ 持仓健康推送失败: ${e.message}`);
  } finally {
    running = false;
  }
}

export function startPositionHealthScheduler() {
  if (!deps?.enabled) return;
  const ms = deps.intervalMin * 60 * 1000;
  const watchLabel = deps.watchSymbols.size
    ? [...deps.watchSymbols].map(s => s.replace('USDT', '')).join(', ')
    : '全部手动持仓';
  console.log(`  💊 持仓健康监控: 每 ${deps.intervalMin} 分钟 → 飞书 · 监控 ${watchLabel}`);
  setInterval(() => runPositionHealthPush(), ms);
  setTimeout(() => runPositionHealthPush(), 90_000);
}
