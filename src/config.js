// @ts-check
/**
 * 配置解析（设计文档 §4/§5）。
 * 优先级（高 → 低，`firstDefined` 只取第一个非 undefined）：
 *   1. 启动参数 options（dsh profile / 启动参数，见 index.js 的 config 透传）；
 *   2. Doco CLI 配置 loadConfig()（~/.doco.json + DOCO_BASE_URL/DOCO_TOKEN 环境变量，二者本身由 cli 合并）；
 *   3. 插件级 headless 环境变量（DOCO_API_BASE_URL / DOCO_API_TOKEN / DOCO_DEFAULT_KB / ...）；
 *   4. 内置默认值。
 *
 * 令牌在本模块只做「解析与透传」，绝不打印；日志脱敏统一走 credentials.redactSecrets。
 */
import { loadConfig, DEFAULT_BASE_URL } from 'doco-agent-cli';
import { DocoPluginError, INVALID_CODES } from './errors.js';
import { LIMITS } from './limits.js';

export { DEFAULT_BASE_URL };

export const DEFAULT_WEB_ORIGIN = 'https://doco.page';

/** 插件级 headless 环境变量名。 */
export const ENV_KEYS = Object.freeze({
  baseUrl: 'DOCO_API_BASE_URL',
  token: 'DOCO_API_TOKEN',
  defaultKb: 'DOCO_DEFAULT_KB',
  webOrigin: 'DOCO_WEB_ORIGIN',
  readMaxTokens: 'DOCO_READ_MAX_TOKENS',
  contextBefore: 'DOCO_READ_CONTEXT_BEFORE',
  contextAfter: 'DOCO_READ_CONTEXT_AFTER',
  toolPrefix: 'DOCO_DSH_TOOL_PREFIX',
  allowWrites: 'DOCO_DSH_ALLOW_WRITES',
});

/**
 * @param {unknown} v
 * @param {boolean} fallback
 * @returns {boolean}
 */
function toBool(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/**
 * @param {unknown} v
 * @param {string} fallback
 * @returns {string}
 */
function toString(v, fallback) {
  if (v == null || v === '') return fallback;
  return String(v);
}

/**
 * 归一化工具名前缀：去掉首尾空格，补 0/1 个尾下划线，前导下划线去掉后重新加回。
 * 最终形如 `doco_`（不能为空、不能含空格）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeToolPrefix(raw) {
  let p = toString(raw, '').trim().replace(/^_+|_+$/g, '');
  if (!p) p = 'doco';
  if (/[^A-Za-z0-9_-]/.test(p)) {
    throw new DocoPluginError('doco_invalid_tool_prefix', `非法的工具名前缀：${JSON.stringify(String(raw))}`, {
      config: ENV_KEYS.toolPrefix,
    });
  }
  return p + '_';
}

/** @returns {Record<string, string | undefined>} */
function readEnv(env) {
  return {
    baseUrl: env[ENV_KEYS.baseUrl],
    token: env[ENV_KEYS.token],
    defaultKb: env[ENV_KEYS.defaultKb],
    webOrigin: env[ENV_KEYS.webOrigin],
    readMaxTokens: env[ENV_KEYS.readMaxTokens],
    contextBefore: env[ENV_KEYS.contextBefore],
    contextAfter: env[ENV_KEYS.contextAfter],
    toolPrefix: env[ENV_KEYS.toolPrefix],
    allowWrites: env[ENV_KEYS.allowWrites],
  };
}

/** @param {...(string|number|boolean|undefined)} values */
function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** 安全的 loadConfig 包装：配置损坏时退化为空对象而不抛。 */
function safeLoadConfig() {
  try {
    return loadConfig() ?? {};
  } catch {
    return {};
  }
}

/**
 * 解析并返回不可变配置对象。
 * @param {Record<string, unknown>} [options]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function resolveConfig(options = {}, env = process.env) {
  const e = readEnv(env);
  const cli = safeLoadConfig();

  // cli.loadConfig() 永远返回非空 base_url（缺省回落内置默认）与可能为空的 token。
  // 为落地 §7.1「CLI 配置(#3) > 环境变量(#4)」且不让内置默认吞掉 DOCO_API_* 环境变量：
  //   - baseUrl：仅 CLI 显式配置（≠ 内置默认）才胜过插件 env；
  //   - token：仅 CLI 有非空 token 才胜过插件 env（空串视为未配置）。
  const cliBaseExplicit = cli.base_url && cli.base_url !== DEFAULT_BASE_URL ? cli.base_url : undefined;
  const cliTokenExplicit = typeof cli.token === 'string' && cli.token.trim() ? cli.token : undefined;
  const baseUrlRaw = firstDefined(options.baseUrl, cliBaseExplicit, e.baseUrl);
  const token = firstDefined(options.token, cliTokenExplicit, e.token);

  const rawPrefix = firstDefined(options.toolPrefix, e.toolPrefix);
  const toolPrefix = normalizeToolPrefix(rawPrefix);

  const readMaxTokens = toNumInRange(
    firstDefined(options.readMaxTokens, e.readMaxTokens),
    LIMITS.READ_DEFAULT_TOKENS,
    64,
    LIMITS.READ_MAX_TOKENS,
  );
  const contextBefore = toNumInRange(
    firstDefined(options.contextBefore, e.contextBefore),
    LIMITS.CONTEXT_BEFORE_DEFAULT,
    0,
    LIMITS.CONTEXT_MAX,
  );
  const contextAfter = toNumInRange(
    firstDefined(options.contextAfter, e.contextAfter),
    LIMITS.CONTEXT_AFTER_DEFAULT,
    0,
    LIMITS.CONTEXT_MAX,
  );

  return Object.freeze({
    baseUrl: validateBaseUrl(baseUrlRaw),
    token: typeof token === 'string' ? token : '',
    webOrigin: validateOrigin(firstDefined(options.webOrigin, e.webOrigin)),
    defaultKb: firstDefined(options.defaultKb, e.defaultKb),
    toolPrefix,
    readMaxTokens,
    contextBefore,
    contextAfter,
    /** scope 见 policy.js；这里仅透传启动意图，覆盖 env 默认。 */
    allowWrites: toBool(firstDefined(options.allowWrites, e.allowWrites), false),
  });
}

/**
 * @param {unknown} v
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function toNumInRange(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 校验并归一化 Doco API base URL：剥离尾斜杠，仅允许 http(s)。
 * @param {unknown} input
 * @returns {string}
 */
export function validateBaseUrl(input) {
  if (input == null || input === '') {
    return DEFAULT_BASE_URL;
  }
  if (typeof input !== 'string') {
    throw new DocoPluginError(INVALID_CODES.baseUrl, 'Doco API 地址必须为字符串。', { got: typeof input });
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new DocoPluginError(INVALID_CODES.baseUrl, `非法的 Doco API 地址：${JSON.stringify(input)}`, {
      config: ENV_KEYS.baseUrl,
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DocoPluginError(INVALID_CODES.baseUrl, 'Doco API 地址仅支持 http(s)。', {
      config: ENV_KEYS.baseUrl,
    });
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * 校验并归一化 Web 源（用于拼 link/bookmark 的引用 URL）。
 * @param {unknown} input
 * @returns {string}
 */
export function validateOrigin(input) {
  const value = toString(input, DEFAULT_WEB_ORIGIN);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DocoPluginError(INVALID_CODES.baseUrl, `非法的 Web 源地址：${JSON.stringify(value)}`, {
      config: ENV_KEYS.webOrigin,
    });
  }
  return url.toString().replace(/\/+$/, '');
}