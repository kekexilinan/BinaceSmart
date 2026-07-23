import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CURL_BIN = process.platform === 'win32' ? CURL_BIN : 'curl';

/** 从环境变量启用 Node fetch 代理（需配合 node --use-env-proxy） */
export function setupProxyFromEnv() {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return { enabled: false };

  process.env.NODE_USE_ENV_PROXY = '1';
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = 'localhost,127.0.0.1';
  }

  const masked = proxyUrl.replace(/:([^:@/]+)@/, ':***@');
  return { enabled: true, url: masked };
}

export function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
}

async function fetchJsonViaCurl(url, { headers = {}, timeoutSec = 15 } = {}) {
  const args = ['-s', '--max-time', String(timeoutSec)];
  const proxy = getProxyUrl();
  if (proxy) args.push('--proxy', proxy);
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  const { stdout } = await execFileAsync(CURL_BIN, args, {
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: process.platform === 'win32',
  });
  const text = stdout.trim();
  if (!text) throw new Error(`curl empty response: ${url}`);
  const json = JSON.parse(text);
  if (json?.code === 0 && json?.msg?.includes('restricted location')) {
    throw new Error(`地区限制: ${json.msg.slice(0, 80)}`);
  }
  return json;
}

/**
 * 统一 JSON 请求：Windows + 代理配置时优先 curl（Node fetch 代理不可靠）
 */
export async function fetchJson(url, {
  headers = {},
  timeoutMs = 15000,
  preferCurl,
} = {}) {
  const proxy = getProxyUrl();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url);
  const useCurl = preferCurl ?? (process.platform === 'win32' && !!proxy && !isLocal);
  const timeoutSec = Math.max(5, Math.ceil(timeoutMs / 1000));

  if (useCurl) {
    return fetchJsonViaCurl(url, { headers, timeoutSec });
  }

  setupProxyFromEnv();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${url}: ${body.slice(0, 120)}`);
  }
  return res.json();
}
