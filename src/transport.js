// @ts-check
import { ProxyAgent } from 'undici';

/**
 * 仅为 DocoClient 注入代理 fetch，不修改全局 dispatcher。
 * withToken() 会沿用该 fetch，因此设备授权与后续 API 使用同一代理。
 * @param {string} proxyUrl 已经 validateProxyUrl 校验的配置
 * @param {typeof globalThis.fetch} [fetchImpl]
 */
export function createTransport(proxyUrl, fetchImpl = globalThis.fetch) {
  if (!proxyUrl) return { fetch: fetchImpl, dispose: async () => {} };

  const uri = new URL(proxyUrl);
  const token = uri.username || uri.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(uri.username)}:${decodeURIComponent(uri.password)}`).toString('base64')}`
    : undefined;
  uri.username = '';
  uri.password = '';
  const dispatcher = new ProxyAgent({ uri: uri.toString(), token });
  return {
    fetch: (input, init) => fetchImpl(input, { ...init, dispatcher }),
    // close 等待正在进行的请求结束；卸载和重配时回收连接池。
    dispose: () => dispatcher.close().catch(() => {}),
  };
}
