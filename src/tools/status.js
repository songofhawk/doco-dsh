// @ts-check
/**
 * doco_status（设计文档 §8.1）：插件配置/用户/scope/服务可用性自检。
 * 永不返回 Token 原文；未配置或 /me 失败时返回 connected:false + 可执行 next_step。
 */
import { ensureIdentity, hasToken } from '../context.js';
import { toErrorValue } from '../errors.js';
import { hasScope, SCOPE_READ, SCOPE_WRITE } from '../policy.js';
import { textBlock } from './shared.js';

/** 写能力：仅当配置显式允许写入（allowWrites）时视为可用，且运行时仍受 policy 门禁。 */
function capabilities(state, scopes) {
  const read = hasToken(state) && hasScope(scopes, SCOPE_READ);
  return {
    search: read,
    read,
    write: Boolean(read && state.config.allowWrites && hasScope(scopes, SCOPE_WRITE)),
  };
}

/**
 * @param {{ state: ReturnType<import('../context.js').createState>; name: string }} deps
 */
export function createDocoStatus({ state, name }) {
  return {
    name,
    description:
      '检查 Doco 插件是否已连接：返回当前用户、权限 scope、API 地址与服务可用性，以及读写能力。' +
      ' 首次使用 Doco 或遇到 auth/scope 错误时先调用本工具定位问题。',
    parameters: {},
    async execute() {
      const configured = hasToken(state);
      const apiBase = state.config.baseUrl;
      if (!configured) {
        return {
          kind: 'doco_status',
          connected: false,
          configured: false,
          user: null,
          scopes: [],
          api_base: apiBase,
          capabilities: capabilities(state, []),
          next_step: '尚未配置 Doco 令牌：请用户执行 /doco connect 完成设备授权，或导入已有 doco 配置。',
        };
      }
      const { user, scopes, error } = await ensureIdentity(state);
      if (error) {
        const mapped = error?.code ? error : toErrorValue(new Error('unknown'));
        return {
          kind: 'doco_status',
          connected: false,
          configured: true,
          user: null,
          scopes: [],
          api_base: apiBase,
          capabilities: capabilities(state, []),
          error: mapped,
        };
      }
      return {
        kind: 'doco_status',
        connected: true,
        configured: true,
        user,
        scopes,
        api_base: apiBase,
        capabilities: capabilities(state, scopes),
      };
    },
    render(_args, value) {
      if (value.kind !== 'doco_status') return textBlock(JSON.stringify(value));
      if (!value.connected) {
        return textBlock(
          `Doco 未连接（api: ${value.api_base}）${value.error ? ` — ${value.error.code}: ${value.error.message}` : ''}\n下一步：${value.next_step || value.error?.next_step || ''}`,
        );
      }
      const caps = value.capabilities || {};
      const capTxt = `search=${caps.search ? 'on' : 'off'} read=${caps.read ? 'on' : 'off'} write=${caps.write ? 'on' : 'off'}`;
      const userTxt = value.user?.name || value.user?.id || '(未知用户)';
      return textBlock(
        `Doco 已连接\n用户：${userTxt}\nscope：${(value.scopes || []).join(', ') || '(无)'}\n能力：${capTxt}\napi：${value.api_base}`,
      );
    },
  };
}