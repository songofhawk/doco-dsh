// @ts-check
/**
 * 写入审批与能力门禁（设计文档 §10.5、§13.2）。
 * 三层防线：
 *   1. `ctx.tools.guard`（同步、单调拒绝）——allowWrites 配置后背；未开启则 commit 一律拒绝；
 *   2. `ctx.on('tools/pre-execute')`（异步）——await /me 后校验 documents:write scope，再 `ask` 用户确认；
 *   3. `doco_save_draft` execute 内防御性校验——即使被直接顶层调用也返回稳定错误码。
 * 预览（mode≠commit）不产生写入，不受门禁拦截。
 *
 * 本模块的纯函数（writeGuard / preExecuteDecision / hasScope / isCommitCall）可单测；
 * `applyPolicy` 只做装配并返回 disposers。
 */
import { ensureIdentity } from './context.js';

export const SCOPE_READ = 'documents:read';
export const SCOPE_WRITE = 'documents:write';
export const SCOPE_KB_READ = 'knowledge-bases:read';

/**
 * @param {ReadonlyArray<string>|null|undefined} scopes
 * @param {string} scope
 * @returns {boolean}
 */
export function hasScope(scopes, scope) {
  return Array.isArray(scopes) && scopes.includes(scope);
}

/** 写工具名（v0.1 唯一写工具是 save_draft）。 */
export function writeToolName(toolPrefix) {
  return `${toolPrefix}save_draft`;
}

/**
 * 判断一次工具调用是否为需要审批的 commit 写入。
 * @param {{ name?: string; arguments?: unknown } | null | undefined} exec
 * @param {string} toolPrefix
 * @returns {boolean}
 */
export function isCommitCall(exec, toolPrefix) {
  if (!exec || exec.name !== writeToolName(toolPrefix)) return false;
  const args = exec.arguments;
  return Boolean(args && typeof args === 'object' && args.mode === 'commit');
}

/**
 * 同步单调 guard：allowWrites 未开启时拒绝全部 commit（preview 放行）。
 * @param {{ name?: string; arguments?: unknown }} exec
 * @param {{ config: { allowWrites?: boolean } }} state
 * @param {string} toolPrefix
 * @returns {string | undefined} 拒绝原因（含稳定错误码前缀），undefined 表示放行
 */
export function writeGuard(exec, state, toolPrefix) {
  if (!isCommitCall(exec, toolPrefix)) return undefined;
  if (state.config?.allowWrites !== true) {
    return 'doco_write_not_confirmed：写入未被允许（默认只读）。请在 dsh 审批中确认，或配置 DOCO_DSH_ALLOW_WRITES=true。';
  }
  return undefined;
}

/**
 * pre-execute 决策：写工具 commit 时校验 scope 并要求用户确认。
 * @param {{ name?: string; arguments?: unknown }} exec
 * @param {() => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }>} next
 * @param {ReturnType<import('./context.js').createState>} state
 * @param {string} toolPrefix
 * @returns {Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }>}
 */
export async function preExecuteDecision(exec, next, state, toolPrefix) {
  if (!isCommitCall(exec, toolPrefix)) return next();

  if (state.config?.allowWrites !== true) {
    return { kind: 'deny', reason: 'doco_write_not_confirmed：写入未获确认（默认只读）。' };
  }

  let scopes = [];
  try {
    const identity = await ensureIdentity(state);
    scopes = Array.isArray(identity?.scopes) ? identity.scopes : [];
  } catch {
    /* scope 未知则走执行内防御性校验；这里放行到 execute 由它返回稳定码 */
  }

  if (!hasScope(scopes, SCOPE_WRITE)) {
    return { kind: 'deny', reason: 'doco_write_scope_required：当前 Token 无 documents:write 权限。请重新 /doco connect 选择读写权限。' };
  }

  const args = exec.arguments;
  const title = args && typeof args === 'object' ? String(args.title ?? '') : '';
  return { kind: 'ask', reason: `确认写入 Doco 草稿${title ? `「${title}」` : ''}？` };
}

/**
 * 装配 guard 与 pre-execute，返回 disposers（由 index.js 在 ctx.effect 中 yield）。
 * @param {{ tools: { guard(g: (...a: unknown[]) => string | undefined): () => void }; on(ev: string, cb: (...a: any[]) => unknown): () => void }} ctx
 * @param {ReturnType<import('./context.js').createState>} state
 * @param {string} toolPrefix
 * @returns {(() => void)[]}
 */
export function applyPolicy(ctx, state, toolPrefix) {
  const disposers = [];
  disposers.push(ctx.tools.guard((exec) => writeGuard(exec, state, toolPrefix)));
  disposers.push(ctx.on('tools/pre-execute', (exec, next) => preExecuteDecision(exec, next, state, toolPrefix)));
  return disposers;
}