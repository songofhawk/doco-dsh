// @ts-check
/**
 * v0.1 的硬限制。上限值来自设计文档 §16，本质是：
 *   - MAX_TOOL_OUTPUT_CHARS 对齐 doco-agent-cli MCP 的 200_000 字符软顶（避免模型上下文爆炸）；
 *   - read 的最大 token 对齐后端 /api/v1/documents/{id}/read 的 max_tokens 法定上限（64–50000）。
 * 所有「输入参数」的长度/取值范围在 execute 内手工校验并映射为
 * `doco_write_limit_exceeded` / `doco_invalid_*`（见 errors.js），因为 dsh 的 schema DSL
 * 在 rc 阶段不保证支持 min/max 约束。
 */
export const LIMITS = Object.freeze({
  /** 任何一次模型可见输出的字符软顶；后端另有 1MB 硬顶。 */
  MAX_TOOL_OUTPUT_CHARS: 200_000,
  /** read 单次最大 token 数（对齐后端法定上限）。 */
  READ_MAX_TOKENS: 50_000,
  /** read 单次默认 token 数。 */
  READ_DEFAULT_TOKENS: 4_000,
  /** read 上下文块 before/after 的默认值。 */
  CONTEXT_BEFORE_DEFAULT: 2,
  CONTEXT_AFTER_DEFAULT: 4,
  /** search 单次最大结果数（§8.3 / §12：最大 100）。 */
  SEARCH_MAX_LIMIT: 100,
  /** search 单次默认结果数（§12：默认 20）。 */
  SEARCH_DEFAULT_LIMIT: 20,
  /** read 上下文块 before/after 的最大值（§8.5：0–100）。 */
  CONTEXT_MAX: 100,
  /** save_draft 标题最大字符数。 */
  TITLE_MAX_CHARS: 200,
  /** save_draft 内容最大字节数（1MiB，对齐后端）。 */
  CONTENT_MAX_BYTES: 1_048_576,
  /** save_draft 失败时最多自动重试次数。 */
  SAVE_RETRY_MAX: 3,
  /** token 隐式阈值：显式少于该值视为「token 暴露风险」，status 会提示。 */
  TOKEN_IMPLICIT_THRESHOLD: 130,
});

/**
 * 安全裁剪模型可见文本到 `LIMITS.MAX_TOOL_OUTPUT_CHARS`，并在截断处追加可读标记。
 * 按 UTF-16 code unit 计（与 doco-agent-cli MCP 的 slice 口径一致）。
 * @param {string} text
 * @returns {{ text: string; truncated: boolean }}
 */
export function clipToOutputLimit(text) {
  const value = String(text ?? '');
  if (value.length <= LIMITS.MAX_TOOL_OUTPUT_CHARS) {
    return { text: value, truncated: false };
  }
  const truncated = '…（已截断，超 ' + LIMITS.MAX_TOOL_OUTPUT_CHARS + ' 字符）';
  return {
    text: value.slice(0, LIMITS.MAX_TOOL_OUTPUT_CHARS) + truncated,
    truncated: true,
  };
}

/**
 * clamp 一个整数到 [min, max]；非数字返回 fallback。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 按 UTF-8 估算给定字符串的字节数（用 TextEncoder，Node 18+ 全局可用）。
 * @param {string} value
 * @returns {number}
 */
export function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}