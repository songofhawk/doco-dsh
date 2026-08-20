// @ts-check
/**
 * doco 服务（设计文档 §9：两层插件架构的依赖契约）。
 *
 * doco-dsh 通过 ctx.provide('doco', …) 暴露的命名服务。下游插件（如
 * doco-memory-dsh）以 `inject: ['doco']` 声明依赖，仅当本服务可用时才会被
 * cordis 启动其 fiber（registry.inject 的依赖解析语义）。
 *
 * 服务面设计原则：
 * - 只暴露「能力」而非「可变内部」：client 可能因 reconfigure 被整体替换，
 *   因此一律通过 getClient()/getConfig() 读取，不让下游持有过期引用；
 * - 门禁相关（scope 判定、错误映射）复用本插件的既有实现，下游不复制；
 * - 不暴露任何删除/覆盖类破坏性原语（与全插件红线一致）。
 */
import { DocoPluginError, errorValue, toErrorValue, mapApiError } from './errors.js';
import { hasScope } from './policy.js';
import { ensureIdentity } from './context.js';
import { PLUGIN_NAME, VERSION } from './version.js';

/**
 * 构造 doco 服务对象（绑定到当前 state 的活引用）。
 * @param {ReturnType<import('./context.js').createState>} state
 * @param {{ toolPrefix: string }} opts
 */
export function createDocoService(state, { toolPrefix }) {
  return {
    /** 服务标识 */
    pluginName: PLUGIN_NAME,
    version: VERSION,
    toolPrefix,

    // ---- 配置与客户端（活引用；client 可能被 reconfigure 替换） ----
    getConfig() {
      return state.config;
    },
    getClient() {
      return state.client;
    },
    /** 惰性身份（/me），缓存于 state；失败返回 { user, scopes, error } 而非抛异常 */
    ensureIdentity() {
      return ensureIdentity(state);
    },
    /** 当前是否已配置 Token */
    hasToken() {
      return Boolean(state.config?.token);
    },

    // ---- 门禁与错误契约 ----
    /** scope 判定（复用 policy.hasScope） */
    hasScope(scopes, scope) {
      return hasScope(scopes, scope);
    },
    /** 写入所需 scope 常量 */
    scopes: { READ: 'documents:read', WRITE: 'documents:write', KB_READ: 'knowledge-bases:read' },
    /** 结构化错误值（工具返回值形态） */
    errorValue,
    /** 异常 → 结构化错误值 */
    toErrorValue,
    /** 异常 → 错误码/消息/next_step（完整映射） */
    mapApiError,
    /** 插件错误类（装配期配置错误用） */
    DocoPluginError,
  };
}

export { DocoPluginError, errorValue, toErrorValue, mapApiError, hasScope };