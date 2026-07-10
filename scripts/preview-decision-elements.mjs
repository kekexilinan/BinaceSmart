import { readFile } from 'node:fs/promises';
import { buildSmartTrendDecision, buildSmartTrendDecisionElements } from '../smart-trend-decision.mjs';

const mock = JSON.parse(await readFile('data/smart-trend-push-mock.json', 'utf8'));
const decision = buildSmartTrendDecision({
  boards: mock.boards,
  highlightPct: mock.highlightPct ?? 10,
  previousState: {},
  now: mock.capturedAt,
});
const elements = buildSmartTrendDecisionElements(decision, { highlightPct: mock.highlightPct ?? 10 });

console.log('=== HEADER ===');
console.log(elements[0].content);
console.log('\n=== TABLES ===');
for (const el of elements) {
  if (el.tag === 'table') {
    console.log('columns:', el.columns.map(c => c.display_name).join(' | '));
    for (const row of el.rows.slice(0, 3)) console.log(row);
  }
}
console.log('\n=== ACTION TRADE VIEWS ===');
for (const a of decision.action) {
  console.log(`${a.label}: ${a.tradeView} / ${a.statusLabel} / score=${a.score}`);
}
