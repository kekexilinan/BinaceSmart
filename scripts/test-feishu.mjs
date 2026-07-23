#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let webhook = process.env.FEISHU_WEBHOOK || '';
try {
  const env = await readFile(join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.trim().match(/^FEISHU_WEBHOOK=(.*)$/);
    if (m?.[1]) webhook = m[1].trim();
  }
} catch {}

if (!webhook) {
  console.error('FEISHU_WEBHOOK not configured');
  process.exit(1);
}

const body = {
  msg_type: 'interactive',
  card: {
    header: {
      title: { tag: 'plain_text', content: 'BinaceSmart 部署测试' },
      template: 'blue',
    },
    elements: [{
      tag: 'markdown',
      content: '**master** 分支已部署到七牛云。\n\n这是一条飞书连通性测试消息。',
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
