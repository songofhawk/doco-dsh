// @ts-check
/**
 * 人类命令（设计文档 §10.4）：/doco status / connect / disconnect / set-kb。
 * 命令不消耗模型 turn；结果绝不打印 Token 原文。
 * 命令名统一为 `doco`（无前导斜杠），rawInput 是子命令与参数；device_code/Token 仅走 POST body 与系统浏览器。
 */
import { openBrowser, waitForDeviceToken, saveConfig, clearConfig } from 'doco-agent-cli';
import { ensureIdentity, reconfigure, hasToken } from './context.js';
import { redactSecrets } from './credentials.js';

/** @param {string} rawInput */
function parseSub(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
  return { sub: tokens[0] ?? '', rest: tokens.slice(1) };
}

/**
 * 构造命令定义数组（由 index.js 逐个 ctx.commands.register）。
 * @param {{
 *   state: ReturnType<import('./context.js').createState>;
 *   resolveConfig: typeof import('./config.js').resolveConfig;
 * }} deps
 * @returns {Array<{ name: string; description: string; input?: { hint: string }; recordInput?: boolean; handler: (inv: { rawInput: string; signal: AbortSignal }) => Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> }>}
 */
export function buildCommands({ state, resolveConfig }) {
  return [
    {
      name: 'doco',
      description: 'Doco 知识库连接与状态：status / connect [--access read_only|read_write] / disconnect / set-kb <kb_id>',
      input: { hint: 'status | connect [--access read_only|read_write] | disconnect | set-kb <kb_id>' },
      handler: async ({ rawInput, signal }) => {
        const { sub, rest } = parseSub(rawInput);

        if (sub === '' || sub === 'status') {
          if (!hasToken(state)) {
            return { kind: 'success', text: 'Doco 未连接：请先执行 /doco connect 完成设备授权。' };
          }
          const { user, scopes, error } = await ensureIdentity(state);
          if (error) {
            return { kind: 'error', text: `Doco 连接异常（${error.code}）：${error.message}。请重试 /doco connect。` };
          }
          return {
            kind: 'success',
            text: `已连接：${user?.name || user?.email || user?.id || '(未知)'}，scope：${(scopes || []).join(', ') || '(无)'}，api：${state.config.baseUrl}`,
          };
        }

        if (sub === 'connect') {
          const access = rest.includes('read_write') ? 'read_write' : 'read_only';
          try {
            const anon = state.client.withToken('');
            const { data: code } = await anon.requestDeviceCode({ clientName: 'Doco dsh plugin', scopes: access });
            openBrowser(code.verification_uri_complete);
            const grant = await waitForDeviceToken(anon, code.device_code, {
              interval: code.interval ?? 5,
              expiresIn: code.expires_in ?? 600,
              onWaiting: () => {},
            });
            saveConfig({ base_url: state.config.baseUrl, token: grant.token, user: grant.user });
            reconfigure(state, { token: grant.token }, resolveConfig);
            return {
              kind: 'success',
              text: `已连接（${access}）：${grant.user?.email || grant.user?.name || ''}。scope：${(grant.scopes || []).join(', ')}`,
            };
          } catch (error) {
            if (signal.aborted) return { kind: 'error', text: '连接已取消。' };
            if (error?.code === 'access_denied') return { kind: 'error', text: '用户在网页端拒绝了本次授权。' };
            return { kind: 'error', text: `连接失败：${redactSecrets(error?.message || error)}` };
          }
        }

        if (sub === 'disconnect' || sub === 'logout') {
          clearConfig();
          reconfigure(state, { token: '' }, resolveConfig);
          return { kind: 'success', text: '已清除本地 Doco 令牌（网页端签发的 Token 可在「设置 → API 管理」撤销）。' };
        }

        if (sub === 'set-kb') {
          const kbId = rest[0];
          if (!kbId) return { kind: 'error', text: '用法：/doco set-kb <knowledge_base_id>' };
          reconfigure(state, { defaultKb: kbId }, resolveConfig);
          return { kind: 'success', text: `默认知识库已设为 ${kbId}（可用工具参数覆盖）。` };
        }

        return { kind: 'error', text: `未知子命令「${sub}」。可用：status / connect / disconnect / set-kb` };
      },
    },
  ];
}