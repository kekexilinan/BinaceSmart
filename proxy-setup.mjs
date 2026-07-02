/** 从环境变量启用 Node fetch 代理（需配合 node --use-env-proxy） */
export function setupProxyFromEnv() {
  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;

  if (!proxyUrl) return { enabled: false };

  process.env.NODE_USE_ENV_PROXY = '1';
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = 'localhost,127.0.0.1';
  }

  const masked = proxyUrl.replace(/:([^:@/]+)@/, ':***@');
  return { enabled: true, url: masked };
}
