#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let webhook = process.env.SMART_TREND_DECISION_WEBHOOK || '';
try {
  const env = await readFile(join(root, '.env'), 'utf8');
  const m = env.match(/^SMART_TREND_DECISION_WEBHOOK=(.*)$/m);
  if (m?.[1]) webhook = m[1].trim();
} catch {}

if (!webhook) {
  console.error('SMART_TREND_DECISION_WEBHOOK not configured');
  process.exit(1);
}

const body = {
  msg_type: 'interactive',
  card: {
    header: {
      title: { tag: 'plain_text', content: '聪明钱决策 Webhook 测试' },
      template: 'purple',
    },
    elements: [{
      tag: 'markdown',
      content: '**SMART_TREND_DECISION_WEBHOOK** 已配置成功。\n\n这是决策频道连通性测试。',
    }],
  },
};

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(15000),
});

const text = await res.text();
console.log('status:', res.status);
console.log('body:', text.slice(0, 500));
