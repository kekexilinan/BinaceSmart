/**
 * api-trend.mjs
 * 趋势数据 API 路由处理
 */
import { querySentiment, querySymbolTrend, queryLatestSnapshot, queryLatestDecision, queryStats } from './db.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

/**
 * 处理趋势 API 请求
 * @returns {boolean} 是否已处理该请求
 */
export function handleTrendAPI(url, req, res) {
  const { pathname, searchParams } = url;

  if (req.method === 'OPTIONS' && pathname.startsWith('/api/trend')) {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  // GET /api/trend/sentiment?range=24h
  if (pathname === '/api/trend/sentiment' && req.method === 'GET') {
    const range = searchParams.get('range') || '24h';
    const limit = parseInt(searchParams.get('limit') || '200');
    const data = querySentiment({ range, limit });
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, count: data.length, data }));
    return true;
  }

  // GET /api/trend/symbol?s=BTCUSDT&range=24h
  if (pathname === '/api/trend/symbol' && req.method === 'GET') {
    const symbol = (searchParams.get('s') || searchParams.get('symbol') || '').toUpperCase();
    if (!symbol) {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Missing symbol param (s=BTCUSDT)' }));
      return true;
    }
    const range = searchParams.get('range') || '24h';
    const limit = parseInt(searchParams.get('limit') || '200');
    const data = querySymbolTrend({ symbol, range, limit });
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, symbol, count: data.length, data }));
    return true;
  }

  // GET /api/trend/latest - 最新一批快照
  if (pathname === '/api/trend/latest' && req.method === 'GET') {
    const data = queryLatestSnapshot();
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, count: data.length, data }));
    return true;
  }

  // GET /api/trend/decision - 最新决策
  if (pathname === '/api/trend/decision' && req.method === 'GET') {
    const data = queryLatestDecision();
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, data }));
    return true;
  }

  // GET /api/trend/stats - 数据库统计
  if (pathname === '/api/trend/stats' && req.method === 'GET') {
    const stats = queryStats();
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ ok: true, ...stats }));
    return true;
  }

  return false;
}
