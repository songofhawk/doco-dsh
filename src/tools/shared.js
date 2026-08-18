// @ts-check
/**
 * 工具层共享语义（设计文档 §8）。
 * 关键约定：
 *   - 所有工具返回「开放对象」的 canonical 值（kind 字段标识结果类型）；
 *   - output.schema 统一为 OPEN_OBJECT，structuredContent 即 execute 返回值；
 *   - render(value) 产出面向模型的紧凑 `ContentBlock[]`（[{type:'text', text}]）。
 *   - API 错误「返回而非抛出」：execute 返回 `{kind:'doco_error', ...}`，render 据此排版。
 */
import { LIMITS } from '../limits.js';
import { errorValue, toErrorValue, INVALID_CODES } from '../errors.js';

/** 工具层输出 schema（开放对象，接受任意 lossless JSON 对象）。 */
export const OPEN_OBJECT = Object.freeze({ type: 'object', additionalProperties: true });

/** @param {string} text @returns {{ type: 'text'; text: string }[]} */
export function textBlock(text) {
  return [{ type: 'text', text }];
}

/** 折叠连续空白，用于把多行描述压成单行。 */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 校验非空查询串，返回规范化结果或非法输入的结构化错误值。
 * @param {unknown} q
 * @returns {{ ok: true; value: string } | { ok: false; error: ReturnType<typeof errorValue> }}
 */
export function validateQuery(q) {
  const value = typeof q === 'string' ? q.trim() : '';
  if (!value) {
    return { ok: false, error: errorValue(INVALID_CODES.query, '缺少查询关键词 q。', '提供一个 1–200 字符的关键词。') };
  }
  if (value.length > 200) {
    return { ok: false, error: errorValue(INVALID_CODES.query, '查询关键词超过 200 字符。', '精简后重试。') };
  }
  return { ok: true, value };
}

/**
 * 手工校验并 clamp 结果数（dsh schema DSL 不支持 min/max）。
 * @param {unknown} raw
 * @returns {{ ok: true; value: number; clamped: boolean } | { ok: false; error: ReturnType<typeof errorValue> }}
 */
export function validateLimit(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: LIMITS.SEARCH_DEFAULT_LIMIT, clamped: false };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: errorValue(INVALID_CODES.limit, 'limit 必须是 1–100 的整数。', '使用默认值 20 或指定合法范围。') };
  }
  if (n > LIMITS.SEARCH_MAX_LIMIT) {
    return { ok: true, value: LIMITS.SEARCH_MAX_LIMIT, clamped: true };
  }
  return { ok: true, value: n, clamped: false };
}

/**
 * 规范化 knowledge_base_id（string|number|null → string|null）。
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeKbId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * 把任意异常安全转成结构化错误值（工具 execute 里 catch 后 return）。
 * @param {unknown} error
 * @returns {ReturnType<typeof errorValue>}
 */
export function catchAsError(error) {
  return error?.kind === 'doco_error' ? error : toErrorValue(error);
}