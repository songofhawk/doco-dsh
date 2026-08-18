// @ts-check
/**
 * 运行时状态与 DocoClient 生命周期（设计文档 §5.1、§7）。
 * 唯一 HTTP 入口：复用 doco-agent-cli 的 DocoClient（这里构造并缓存到 state.client），
 * 插件各工具只从 state.client 调方法，不再 new 第二个 client。
 */
import { DocoClient } from 'doco-agent-cli';
import { userAgent } from './credentials.js';
import { toErrorValue } from './errors.js';

/**
 * 构造插件运行时状态（含唯一 DocoClient）。不做任何网络调用。
 * @param {import('./config.js').ResolvedConfig} config
 * @param {object} [impl] 测试注入点：提供 fetch 替身
 * @returns {{
 *   config: import('./config.js').ResolvedConfig;
 *   client: DocoClient;
 *   user: unknown;
 *   scopes: string[];
 *   tokenId: string|null;
 *   identityError: ReturnType<typeof toErrorValue> | null;
 * }}
 */
export function createState(config, impl = {}) {
  const client = new DocoClient({
    baseUrl: config.baseUrl,
    token: config.token || '',
    fetchImpl: impl.fetch,
    userAgent: userAgent(),
  });
  return {
    config,
    client,
    user: null,
    scopes: [],
    tokenId: null,
    identityError: null,
  };
}

/**
 * 调用 GET /me 刷新身份与 scope。失败时把稳定错误码缓存到 state.identityError 再抛出。
 * @param {ReturnType<typeof createState>} state
 * @returns {Promise<{ user: unknown; scopes: string[] }>}
 */
export async function refreshIdentity(state) {
  try {
    const response = await state.client.me();
    const data = response.data ?? {};
    state.user = data.user ?? null;
    state.scopes = Array.isArray(data.scopes) ? data.scopes : [];
    state.tokenId = data.token_id ?? null;
    state.identityError = null;
    return { user: state.user, scopes: state.scopes };
  } catch (error) {
    state.identityError = toErrorValue(error);
    throw error;
  }
}

/**
 * 惰性 /me：仅当已配 Token 且身份尚未取得（且上次无失败）时才请求。
 * 返回 `{ user, scopes, error }` —— error 非空时表示身份不可用，而非抛异常。
 * @param {ReturnType<typeof createState>} state
 * @returns {Promise<{ user: unknown; scopes: string[]; error: ReturnType<typeof toErrorValue> | null }>}
 */
export async function ensureIdentity(state) {
  if (!state.config.token) {
    return { user: null, scopes: [], error: state.identityError ?? toErrorValue(new Error('未配置 Token')) };
  }
  if (state.user == null && state.identityError == null) {
    try {
      await refreshIdentity(state);
    } catch {
      // identityError 已在 refreshIdentity 内缓存
    }
  }
  return { user: state.user, scopes: state.scopes, error: state.identityError };
}

/**
 * 认证或配置变更后重建身份：更新配置 patch、重建 client、清空身份缓存。
 * @param {ReturnType<typeof createState>} state
 * @param {Record<string, unknown>} patch 例如 { token } 或 { defaultKb }
 * @param {import('./config.js').resolveConfig} resolveConfig
 * @param {object} [impl] 测试注入点
 */
export function reconfigure(state, patch, resolveConfig, impl = {}) {
  const nextConfig = resolveConfig({ ...state.config, ...patch });
  const next = createState(nextConfig, impl);
  // 原地替换 state 字段，便于已持有 state 引用的工具持续读到新配置
  state.config = next.config;
  state.client = next.client;
  state.user = null;
  state.scopes = [];
  state.tokenId = null;
  state.identityError = null;
  return state;
}

/** @returns {boolean} 是否已配置 Token */
export function hasToken(state) {
  return Boolean(state.config?.token);
}