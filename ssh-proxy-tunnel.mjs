#!/usr/bin/env node
/**
 * SSH ProxyCommand 辅助脚本：
 * 通过本地 HTTP CONNECT 代理（默认 127.0.0.1:6789）建立到目标 host:port 的 TCP 隧道。
 * 用法：node ssh-proxy-tunnel.mjs <host> <port>
 * 环境变量：
 *   SSH_TUNNEL_PROXY_HOST（默认 127.0.0.1）
 *   SSH_TUNNEL_PROXY_PORT（默认 6789）
 */
import net from 'node:net';

const [host, port] = process.argv.slice(2);
if (!host || !port) {
  process.stderr.write(`usage: ssh-proxy-tunnel.mjs <host> <port>\n`);
  process.exit(2);
}

const PROXY_HOST = process.env.SSH_TUNNEL_PROXY_HOST || '127.0.0.1';
const PROXY_PORT = Number(process.env.SSH_TUNNEL_PROXY_PORT || 6696);

const sock = net.connect(PROXY_PORT, PROXY_HOST, () => {
  sock.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\n` +
    `Host: ${host}:${port}\r\n` +
    `Proxy-Connection: keep-alive\r\n` +
    `\r\n`
  );
});

let buf = Buffer.alloc(0);
let headerDone = false;

sock.on('data', (chunk) => {
  if (headerDone) {
    process.stdout.write(chunk);
    return;
  }
  buf = Buffer.concat([buf, chunk]);
  const idx = buf.indexOf('\r\n\r\n');
  if (idx >= 0) {
    const headerText = buf.slice(0, idx).toString('utf8');
    const statusLine = headerText.split('\r\n')[0] || '';
    const m = statusLine.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
    if (!m || m[1] !== '200') {
      process.stderr.write(`proxy CONNECT failed: ${statusLine}\n`);
      process.exit(1);
    }
    headerDone = true;
    const rest = buf.slice(idx + 4);
    if (rest.length) process.stdout.write(rest);
  }
});

sock.on('error', (e) => {
  process.stderr.write(`proxy socket error: ${e.message}\n`);
  process.exit(1);
});
sock.on('close', () => process.exit(0));

process.stdin.on('data', (chunk) => sock.write(chunk));
process.stdin.on('end', () => sock.end());
process.stdin.on('error', () => sock.destroy());
