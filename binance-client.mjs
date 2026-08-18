/**
 * Binance REST 客户端（零外部依赖）
 * - HMAC-SHA256 签名
 * - 现货 + U 本位合约双市场
 * - 内置指数退避重试 + 时间戳偏移自校正
 */
import { createHmac } from 'node:crypto';

const SPOT_BASE   = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 400;

let _apiKey = '';
let _apiSecret = '';
let _market = 'spot';          // spot | futures
let _recvWindow = 5000;
let _timestampOffset = 0;      // 本地时钟与服务器偏差(ms)
let _dryRun = true;
let _logger = console;

/** 配置 Binance 客户端 */
export function configureBinanceClient({
  apiKey, apiSecret, market = 'spot', recvWindow = 5000,
  dryRun = true, logger = console,
} = {}) {
  _apiKey = apiKey || '';
  _apiSecret = apiSecret || '';
  _market = (market || 'spot').toLowerCase();
  _recvWindow = recvWindow;
  _dryRun = !!dryRun;
  _logger = logger;
  if (!_apiKey || !_apiSecret) {
    _logger.warn?.('  ⚠ Binance client: API 密钥未配置，仅支持公开接口');
  }
  return { configured: !!(_apiKey && _apiSecret), market: _market, dryRun: _dryRun };
}

export function isDryRun() { return _dryRun; }
export function getMarket() { return _market; }

// ==================== 底层 ====================

function baseUrl() { return _market === 'futures' ? FUTURES_BASE : SPOT_BASE; }

function sign(queryString) {
  if (!_apiSecret) throw new Error('BINANCE_API_SECRET 未配置');
  return createHmac('sha256', _apiSecret).update(queryString).digest('hex');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, params = {}, { signed = false, retryable = true } = {}) {
  const url = `${baseUrl()}${path}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.append(k, String(v));
  }
  if (signed) {
    if (!_apiKey) throw new Error('BINANCE_API_KEY 未配置');
    qs.append('timestamp', String(Date.now() + _timestampOffset));
    qs.append('recvWindow', String(_recvWindow));
    const sig = sign(qs.toString());
    qs.append('signature', sig);
  }
  const fullUrl = qs.toString() ? `${url}?${qs.toString()}` : url;
  const headers = signed ? { 'X-MBX-APIKEY': _apiKey } : {};

  let lastErr;
  for (let attempt = 0; attempt <= (retryable ? MAX_RETRIES : 0); attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(fullUrl, { method, headers, signal: ac.signal });
      clearTimeout(t);
      if (res.status === 401 || res.status === 403) {
        const text = await res.text();
        throw new Error(`auth ${res.status}: ${text.slice(0, 120)}`);
      }
      if (res.status === 429) {
        await sleep(RETRY_BASE_MS * (attempt + 1) * 2);
        lastErr = new Error(`rate limited`);
        continue;
      }
      if (res.status >= 500) {
        await sleep(RETRY_BASE_MS * (attempt + 1));
        lastErr = new Error(`server ${res.status}`);
        continue;
      }
      const text = await res.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`非 JSON 响应: ${text.slice(0, 80)}`); }
      if (body?.code === -1021) {
        // 时间戳偏移校正
        const serverTime = body.msg?.match(/(\d+)/)?.[1];
        if (serverTime) {
          _timestampOffset = parseInt(serverTime) - Date.now();
          _logger.info?.(`  ⏱ 时间戳校正: ${_timestampOffset}ms`);
        }
        if (attempt < MAX_RETRIES) { lastErr = new Error('timestamp sync'); continue; }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (e.name === 'AbortError') lastErr = new Error(`timeout ${path}`);
      if (!retryable || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

// ==================== 公开接口 ====================

/** 获取当前服务器时间（ms） */
export async function getServerTime() {
  const body = await request('GET', '/api/v3/time', {}, { signed: false });
  return _market === 'futures' ? body.serverTime : body.serverTime;
}

/** 拉取 1h K 线（合约 klines，现货 klines） */
export async function getKlines(symbol, interval = '1h', limit = 30) {
  const path = _market === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines';
  return request('GET', path, { symbol: symbol.toUpperCase(), interval, limit });
}

/** 当前标记价 / 最新价 */
export async function getMarkPrice(symbol) {
  if (_market === 'futures') {
    const body = await request('GET', '/fapi/v1/premiumIndex', { symbol: symbol.toUpperCase() });
    return { price: parseFloat(body.markPrice), lastPrice: parseFloat(body.markPrice) };
  }
  const body = await request('GET', '/api/v3/ticker/price', { symbol: symbol.toUpperCase() });
  return { price: parseFloat(body.price), lastPrice: parseFloat(body.price) };
}

// ==================== 账户与订单（需签名） ====================

/** 查询可用余额（现货 USDT；合约 walletBalance） */
export async function getAvailableBalance(asset = 'USDT') {
  if (_market === 'futures') {
    const body = await request('GET', '/fapi/v2/balance', {}, { signed: true });
    const row = (body || []).find(r => r.asset === asset);
    return { free: parseFloat(row?.availableBalance || 0), total: parseFloat(row?.balance || 0) };
  }
  const body = await request('GET', '/api/v3/account', {}, { signed: true });
  const row = (body.balances || []).find(r => r.asset === asset);
  return { free: parseFloat(row?.free || 0), total: parseFloat(row?.free || 0) + parseFloat(row?.locked || 0) };
}

/** 查询当前未成交订单 */
export async function getOpenOrders(symbol) {
  const path = _market === 'futures' ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
  const params = symbol ? { symbol: symbol.toUpperCase() } : {};
  return request('GET', path, params, { signed: true });
}

/** 查询单个订单 */
export async function getOrder(symbol, orderId) {
  const path = _market === 'futures' ? '/fapi/v1/order' : '/api/v3/order';
  return request('GET', path, { symbol: symbol.toUpperCase(), orderId }, { signed: true });
}

/** 下限价单 */
export async function placeLimitOrder({ symbol, side, positionSide, quantity, price, timeInForce = "GTC" }) {
  const path = _market === 'futures' ? '/fapi/v1/order' : '/api/v3/order';
  const params = {
    symbol: symbol.toUpperCase(),
    side: side.toUpperCase(),
    type: 'LIMIT',
    quantity,
    price,
    timeInForce,
    ...(positionSide && { positionSide }),
  };
  if (_dryRun) {
    _logger.log?.(`  [DRY-RUN] place ${side} LIMIT ${symbol} qty=${quantity} price=${price}`);
    return { dryRun: true, ...params, orderId: `dry-${Date.now()}` };
  }
  return request('POST', path, params, { signed: true });
}

/** 撤单 */
export async function cancelOrder(symbol, orderId) {
  const path = _market === 'futures' ? '/fapi/v1/order' : '/api/v3/order';
  if (_dryRun) {
    _logger.log?.(`  [DRY-RUN] cancel ${symbol} orderId=${orderId}`);
    return { dryRun: true, symbol, orderId, status: 'CANCELED' };
  }
  return request('DELETE', path, { symbol: symbol.toUpperCase(), orderId }, { signed: true });
}

/** 查询交易所信息（精度规则等） */
export async function getExchangeInfo() {
  const path = _market === 'futures' ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
  return request('GET', path);
}
