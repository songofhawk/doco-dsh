// @ts-check
/**
 * 凭据相关（设计文档 §7.3）。核心约束：Token 永不进入 prompt / tool result / 日志 / 错误堆栈。
 * 本模块导出两个纯函数：
 *   - userAgent(pluginVersion)  传给 DocoClient 的 UA（含插件名+版本，不含 Token）；
 *   - redactSecrets(text, extra)  日志/测试用脱敏，替换 doco_tok_* 及任意额外 secret。
 */
import { VERSION } from './version.js';

/** @param {string} [pluginVersion] */
export function userAgent(pluginVersion = VERSION) {
  return `doco-dsh/${pluginVersion}`;
}

// 后端令牌前缀 doco_tok_，后随 URL-safe 随机串；匹配任何 Token。
const TOKEN_RE = /\bdoco_tok_[A-Za-z0-9_-]+/g;

/**
 * 把文本中的 Doco Token（以及调用方额外指定的 secret）替换为 ***。
 * 覆盖「工具名、HTTP 状态、错误码、资源 ID」日志里可能混入的 Token。
 * @param {unknown} text
 * @param {string[]} [extraSecrets]
 * @returns {string}
 */
export function redactSecrets(text, extraSecrets = []) {
  if (text == null) return '';
  let out = String(text).replace(TOKEN_RE, 'doco_tok_***');
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('***');
    }
  }
  return out;
}