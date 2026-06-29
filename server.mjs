#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load .env file
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envContent = await readFile(join(__dirname, '.env'), 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch {}

const PORT = parseInt(process.env.PORT || '3388', 10);
const FAPI_BASE = 'https://fapi.binance.com';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function proxyBinance(path) {
  const res = await fetch(`${FAPI_BASE}${path}`);
  if (!res.ok) throw new Error(`Binance API ${res.status}: ${path}`);
  return res.json();
}

async function handleAPI(symbol) {
  const [price, topAccounts, topPositions, globalRatio, oi, oiHist, takerVol, fundingRate] =
    await Promise.all([
      proxyBinance(`/fapi/v2/ticker/price?symbol=${symbol}`),
      proxyBinance(`/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=12`),
      proxyBinance(`/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=12`),
      proxyBinance(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=12`),
      proxyBinance(`/fapi/v1/openInterest?symbol=${symbol}`),
      proxyBinance(`/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=12`),
      proxyBinance(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=12`),
      proxyBinance(`/fapi/v1/premiumIndex?symbol=${symbol}`),
    ]);
  return { price, topAccounts, topPositions, globalRatio, oi, oiHist, takerVol, fundingRate };
}

let FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || '';

async function sendFeishu(title, content) {
  const body = {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
      elements: [{ tag: 'markdown', content }],
    },
  };
  const res = await fetch(FEISHU_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/feishu-alert' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { title, content } = JSON.parse(body);
        const result = await sendFeishu(title, content);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/feishu-alert' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  if (url.pathname === '/api/klines') {
    const symbol = url.searchParams.get('symbol') || 'SLXUSDT';
    const interval = url.searchParams.get('interval') || '1h';
    const limit = url.searchParams.get('limit') || '100';
    try {
      const data = await proxyBinance(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/data') {
    const symbol = url.searchParams.get('symbol') || 'SLXUSDT';
    try {
      const data = await handleAPI(symbol);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  try {
    const content = await readFile(join(__dirname, filePath));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  🚀 聪明钱监控面板已启动: http://localhost:${PORT}`);
  console.log(`  📊 默认监控: SLXUSDT`);
  console.log(`  ⏹  Ctrl+C 退出\n`);
});
