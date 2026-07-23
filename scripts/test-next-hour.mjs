import { getNextHourShanghai } from '../smart-trend-monitor.mjs';

const t = new Date('2026-07-20T16:51:22Z');
const next = getNextHourShanghai(t);
const delay = Math.round((next.getTime() - t.getTime()) / 60000);
console.log('now UTC:', t.toISOString());
console.log('next:', next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
console.log('delay min:', delay);
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
}).formatToParts(t);
console.log('parts:', Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value])));
