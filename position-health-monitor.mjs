import { getUserPositions } from './user-positions.mjs';
import { evaluatePositionHealth } from './position-health.mjs';

const HEALTH_RANK = { healthy: 0, warning: 1, critical: 2 };

let deps = null;
let running = false;
const lastState = new Map();

export function initPositionHealthMonitor(dependencies) {
  deps = dependencies;
}

function isUrgent(health, action) {
  return health === 'critical' || action === 'stop_loss';
}

function urgentCooldownMs() {
  return (deps?.urgentCooldownMin ?? 60) * 60 * 1000;
}

function updateState(id, health, action) {
  const prev = lastState.get(id);
  lastState.set(id, {
    health,
    action,
    at: Date.now(),
    lastUrgentAt: prev?.lastUrgentAt ?? 0,
    wasUrgent: isUrgent(health, action),
  });
}

function isUrgentAlert(id, health, action) {
  const prev = lastState.get(id);
  const nowUrgent = isUrgent(health, action);

  if (!nowUrgent) {
    updateState(id, health, action);
    return false;
  }

  const prevWasUrgent = prev?.wasUrgent ?? isUrgent(prev?.health, prev?.action);

  // 首次进入危险/止损：立即推送
  if (!prevWasUrgent) {
    lastState.set(id, { health, action, at: Date.now(), lastUrgentAt: Date.now(), wasUrgent: true });
    return true;
  }

  // 已在紧急状态：仅当明显恶化且过了冷却期才再推（避免每 30 分钟重复轰炸）
  const worse = HEALTH_RANK[health] > HEALTH_RANK[prev.health]
    || (action === 'stop_loss' && prev.action !== 'stop_loss');
  if (!worse) {
    updateState(id, health, action);
    return false;
  }

  const cooldown = urgentCooldownMs();
  if (prev.lastUrgentAt && Date.now() - prev.lastUrgentAt < cooldown) {
    updateState(id, health, action);
    return false;
  }

  lastState.set(id, { health, action, at: Date.now(), lastUrgentAt: Date.now(), wasUrgent: true });
  return true;
}

export function resetPositionHealthState() {
  lastState.clear();
}

async function collectPositionHealth() {
  const positions = await getUserPositions();
  const watchSet = deps.watchSymbols;
  const filtered = watchSet.size > 0
    ? positions.filter(p => watchSet.has(p.symbol.toUpperCase()))
    : positions;
  if (!filtered.length) return [];

  const results = [];
  for (const pos of filtered) {
    try {
      const h = await evaluatePositionHealth({
        symbol: pos.symbol,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
      });
      results.push({ pos, h });
    } catch (e) {
      console.warn(`  ⚠ 持仓健康检查失败 ${pos.symbol}: ${e.message}`);
    }
  }
  return results;
}

function formatHealthLines(items) {
  return items.map(({ pos, h }) => {
    const dir = pos.direction === 'long' ? '做多' : '做空';
    const pnlSign = h.pnlPct >= 0 ? '+' : '';
    return [
      `**${h.label}** ${dir} @ $${h.entryPrice}`,
      `现价 $${h.currentPrice} · 盈亏 ${pnlSign}${h.pnlPct}%`,
      `${h.healthLabel} · ${h.actionLabel}`,
      ...(h.reasons?.slice(0, 3).map(r => `• ${r}`) || []),
    ].join('\n');
  });
}

async function sendHealthPush(items, { kind = 'scheduled' } = {}) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const watchLabel = deps.watchSymbols.size
    ? [...deps.watchSymbols].map(s => s.replace('USDT', '')).join(', ')
    : '全部手动持仓';
  const pushHours = deps.pushHours ?? 2;
  const header = kind === 'urgent'
    ? `**🚨 持仓紧急预警** · 监控 ${watchLabel}`
    : `**💊 持仓健康报告** · 每 ${pushHours}h 50分 · 监控 ${watchLabel}`;
  const content = [`**⏰ ${now}**`, header, '', ...formatHealthLines(items)].join('\n\n');
  const titlePrefix = kind === 'urgent' ? '🚨 持仓紧急' : '💊 持仓健康';
  const title = `${titlePrefix} · ${items.map(a => a.h.label).join(', ')}`;
  const result = await deps.sendFeishu(title, content);
  if (result?.code !== 0 && result?.StatusCode !== 0) {
    throw new Error(result?.msg || JSON.stringify(result));
  }
  console.log(`  ✓ 持仓健康${kind === 'urgent' ? '紧急' : ''}推送 (${items.map(a => a.h.label).join(', ')})`);
}

export async function runPositionHealthPush(options = {}) {
  const { force = false, mode = 'scheduled' } = options;
  if (force) lastState.clear();
  if (!deps?.enabled || !deps?.feishuEnabled || running) return;
  running = true;
  try {
    const results = await collectPositionHealth();
    if (!results.length) return;

    let toPush = [];
    if (force || mode === 'scheduled') {
      toPush = results;
      for (const { pos, h } of results) updateState(pos.id, h.health, h.action);
    } else if (mode === 'urgent') {
      toPush = results.filter(({ pos, h }) => isUrgentAlert(pos.id, h.health, h.action));
    }

    if (!toPush.length) return;
    await sendHealthPush(toPush, { kind: mode === 'urgent' ? 'urgent' : 'scheduled' });
  } catch (e) {
    console.warn(`  ⚠ 持仓健康推送失败: ${e.message}`);
  } finally {
    running = false;
  }
}

export function startPositionHealthScheduler() {
  if (!deps?.enabled) return;
  const pushHours = deps.pushHours ?? 2;
  const urgentMin = deps.urgentCheckMin ?? 30;
  const urgentCooldown = deps.urgentCooldownMin ?? 60;
  const watchLabel = deps.watchSymbols.size
    ? [...deps.watchSymbols].map(s => s.replace('USDT', '')).join(', ')
    : '全部手动持仓';

  const slots = [];
  for (let h = 0; h < 24; h += pushHours) slots.push(`${String(h).padStart(2, '0')}:50`);
  console.log(`  💊 持仓健康监控: 上海时间 ${slots.join(' / ')}（每 ${pushHours}h）→ 飞书 · 危险/止损即时推送（${urgentMin}min 扫描，同仓 ${urgentCooldown}min 去重）· 监控 ${watchLabel}`);

  const scheduleNext = () => {
    const getNext = deps.getNextPushTime;
    if (typeof getNext !== 'function') return;
    const next = getNext(new Date(), pushHours);
    const delay = Math.max(0, next.getTime() - Date.now());
    const label = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    console.log(`  ⏭ 持仓健康下次: ${label}（${Math.round(delay / 60000)} 分钟后）`);
    setTimeout(async () => {
      await runPositionHealthPush({ mode: 'scheduled' });
      scheduleNext();
    }, delay);
  };
  scheduleNext();

  setInterval(() => runPositionHealthPush({ mode: 'urgent' }), urgentMin * 60 * 1000);
  setTimeout(() => runPositionHealthPush({ mode: 'urgent' }), 120_000);
}
