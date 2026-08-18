// @ts-check
/**
 * 错误码契约（设计文档 §17）。分两类：
 *   1. 本插件主动抛出的 `DocoPluginError`（负载期配置错误、`doco_dsh_incompatible`）。
 *   2. 工具执行期统一返回的结构化错误值 `{kind:'doco_error', code, message, next_step}` ——
 *      工具失败「返回而非抛出」，让模型能够读到 next_step 自行纠偏（例如触发登录）。
 *
 * 后端错误码（DocoApiError.code）与插件错误码的映射集中在 `mapApiError`，不散落在各工具里。
 */

export class DocoPluginError extends Error {
  /**
   * @param {string} code 稳定错误码（见下方 PLUGIN_ERROR_CODES）
   * @param {string} message 人类可读描述（可含 next step 提示）
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DocoPluginError';
    this.code = code;
    this.details = details ?? {};
  }
}

/** 参数非法时的插件错误码（在 execute 内手工校验后抛出/返回）。 */
export const INVALID_CODES = Object.freeze({
  baseUrl: 'doco_invalid_base_url',
  query: 'doco_invalid_query',
  limit: 'doco_invalid_limit',
  mode: 'doco_invalid_mode',
  kbId: 'doco_invalid_kind_id',
  docPath: 'doco_invalid_document',
  blockRef: 'doco_invalid_block_ref',
  maxTokens: 'doco_invalid_max_tokens',
  context: 'doco_invalid_context',
  title: 'doco_invalid_title',
  format: 'doco_invalid_format',
  scope: 'doco_invalid_scope',
});

/** 单一事实来源的 next_step 文案，供 render 与返回值复用。 */
export const NEXT_STEPS = Object.freeze({
  auth: '在 Doco 设备登录页完成授权，或将 doco 令牌写入 ~/.doco.json（--token 导入），再重试。',
  scope: '通过 Doco 个人设置页申请 write/admin 权限，或改用只读操作（search/outline/read）。',
  kb: '先在 doco_status 或 doco_list_knowledge_bases 里拿到有效的 knowledge_base_id。',
  doc: '先确认 doc_path/docId 指向一篇实际存在的文档（用 doco_search 定位）。',
  version: '版本已变化：先 doco_read 拉取最新内容再重写，或点「覆盖」强制写入。',
  retry: '这是瞬时故障，稍后重试通常可恢复。',
  confirm: '写入已进入 wait_user 等待确认；请确认后重试，或将 scope 调高到 write。',
});

/**
 * 规范化的结构化错误值（工具返回值，而非异常）。
 * @param {string} code
 * @param {string} message
 * @param {string} [nextStep]
 * @returns {{ kind: 'doco_error'; code: string; message: string; next_step: string }}
 */
export function errorValue(code, message, nextStep = '') {
  return { kind: 'doco_error', code, message, next_step: nextStep };
}

/**
 * 把任意异常映射为插件错误码 + 可读消息 + next_step + 是否可重试。
 * 优先识别 DocoApiError（带 status/code），其次识别网络错误与 429 限流。
 *
 * @param {unknown} error
 * @returns {{ code: string; message: string; next_step: string; http_status: number|null; retry_after: number|null; retryable: boolean }}
 */
export function mapApiError(error) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const rawMessage = typeof error?.message === 'string' ? error.message : String(error ?? '');

  // 429 限流（后端可能给 429 也可能用 code='rate_limited'）。
  if (status === 429 || code === 'rate_limited') {
    const retryAfter = Number(error?.details?.retry_after ?? error?.retryAfter ?? 0) || null;
    return {
      code: 'doco_rate_limited',
      message: 'Doco API 限流' + (retryAfter ? `（请约 ${retryAfter}s 后重试）` : '（请稍后重试）'),
      next_step: NEXT_STEPS.retry,
      http_status: 429,
      retry_after: retryAfter,
      retryable: true,
    };
  }

  if (status === 401 || code === 'invalid_api_token') {
    return {
      code: 'doco_auth_required',
      message: 'Doco 令牌无效或已过期。',
      next_step: NEXT_STEPS.auth,
      http_status: 401,
      retry_after: null,
      retryable: false,
    };
  }

  if (status === 403 || code === 'insufficient_scope') {
    return {
      code: 'doco_insufficient_scope',
      message: '当前令牌权限不足，无法完成该操作。',
      next_step: NEXT_STEPS.scope,
      http_status: 403,
      retry_after: null,
      retryable: false,
    };
  }

  if (status === 404 || code === 'not_found') {
    return {
      code: 'doco_not_found',
      message: '目标文档或知识库不存在。',
      next_step: NEXT_STEPS.doc,
      http_status: 404,
      retry_after: null,
      retryable: false,
    };
  }

  // read 的旧游标是 409 的特例，须先于通用 409 命中（否则被归为 version_conflict）。
  if (code === 'read_cursor_stale') {
    return {
      code: 'doco_read_cursor_stale',
      message: 'read 携带的 cursor/version 已过期。',
      next_step: '去掉 version/cursor 参数重读最新内容，或换用最新 cursor。',
      http_status: status,
      retry_after: null,
      retryable: false,
    };
  }

  if (status === 409 || status === 412 || code === 'version_conflict') {
    return {
      code: 'doco_version_conflict',
      message: '目标已在他处被修改，写下被乐观锁拒绝。',
      next_step: NEXT_STEPS.version,
      http_status: status,
      retry_after: null,
      retryable: false,
    };
  }

  // 传输层失败：DocoClient 把 fetch 抛错 / 超时统一包装成 status=0 的 DocoApiError
  // （code='network_error'|'timeout'）；裸 TypeError 也可能直接冒泡（status==null）。
  if (
    status === 0 ||
    code === 'network_error' ||
    code === 'timeout' ||
    (status == null && /fetch|ECONN|ETIMEDOUT|network|ENOTFOUND|socket/i.test(rawMessage))
  ) {
    const timeout = code === 'timeout';
    return {
      code: 'doco_network',
      message: timeout ? '连接 Doco API 超时。' : '无法连接到 Doco API（网络或 DNS 故障）。',
      next_step: '检查网络、https_proxy、以及 DOCO_API_BASE_URL 指向的可达性后重试。',
      http_status: status === 0 ? null : status,
      retry_after: null,
      retryable: true,
    };
  }

  // 兜底：未知内部错误。
  return {
    code: 'doco_internal',
    message: 'Doco API 返回了未预期的错误：' + rawMessage,
    next_step: '将原始 message 贴给管理员，或稍后重试。',
    http_status: status,
    retry_after: null,
    retryable: false,
  };
}

/**
 * 把异常转成结构化错误值（工具返回值）。
 * @param {unknown} error
 * @returns {ReturnType<typeof errorValue>}
 */
export function toErrorValue(error) {
  const mapped = mapApiError(error);
  return errorValue(mapped.code, mapped.message, mapped.next_step);
}