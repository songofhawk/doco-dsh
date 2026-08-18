// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DocoPluginError, errorValue, mapApiError, toErrorValue, INVALID_CODES,
} from '../src/errors.js';
import { resolveConfig, normalizeToolPrefix, validateBaseUrl, validateOrigin, ENV_KEYS } from '../src/config.js';
import { clipToOutputLimit, clampInt, utf8ByteLength, LIMITS } from '../src/limits.js';
import { documentUri, knowledgeBaseUri, webUrl, citation, citationFromHit } from '../src/citations.js';
import { redactSecrets, userAgent } from '../src/credentials.js';
import { validateQuery, validateLimit, normalizeKbId, textBlock, oneLine } from '../src/tools/shared.js';

// ---- errors ----

test('mapApiError: 429 → doco_rate_limited（可重试 + retry_after）', () => {
  const m = mapApiError({ status: 429, code: 'rate_limited', message: 'x', details: { retry_after: 7 } });
  assert.equal(m.code, 'doco_rate_limited');
  assert.equal(m.retryable, true);
  assert.equal(m.retry_after, 7);
});

test('mapApiError: 401 → doco_auth_required / 403 → insufficient_scope / 404 → not_found', () => {
  assert.equal(mapApiError({ status: 401, code: 'invalid_api_token', message: 'x' }).code, 'doco_auth_required');
  assert.equal(mapApiError({ status: 403, code: 'insufficient_scope', message: 'x' }).code, 'doco_insufficient_scope');
  assert.equal(mapApiError({ status: 404, code: 'not_found', message: 'x' }).code, 'doco_not_found');
});

test('mapApiError: 409/412 → doco_version_conflict', () => {
  assert.equal(mapApiError({ status: 409, code: 'version_conflict', message: 'x' }).code, 'doco_version_conflict');
  assert.equal(mapApiError({ status: 412, code: 'conflict', message: 'x' }).code, 'doco_version_conflict');
});

test('mapApiError: read_cursor_stale → doco_read_cursor_stale', () => {
  assert.equal(mapApiError({ status: 409, code: 'read_cursor_stale', message: 'x' }).code, 'doco_read_cursor_stale');
});

test('mapApiError: 传输层 status=0 / network_error / timeout → doco_network（可重试）', () => {
  assert.equal(mapApiError({ status: 0, code: 'network_error', message: '无法连接' }).code, 'doco_network');
  assert.equal(mapApiError({ status: 0, code: 'timeout', message: '超时' }).code, 'doco_network');
  assert.equal(mapApiError({ status: 0, code: 'network_error', message: 'x' }).retryable, true);
  // 裸 TypeError（status==null）
  assert.equal(mapApiError(new TypeError('fetch failed')).code, 'doco_network');
});

test('mapApiError: 未知错误 → doco_internal（不可重试）', () => {
  const m = mapApiError({ status: 500, code: 'boom', message: 'server exploded' });
  assert.equal(m.code, 'doco_internal');
  assert.equal(m.retryable, false);
  assert.match(m.message, /server exploded/);
});

test('errorValue / toErrorValue 返回统一 shape', () => {
  const v = errorValue('doco_invalid_query', 'msg', 'next');
  assert.deepEqual(v, { kind: 'doco_error', code: 'doco_invalid_query', message: 'msg', next_step: 'next' });
  const t = toErrorValue({ status: 429, message: 'x' });
  assert.equal(t.kind, 'doco_error');
  assert.equal(t.code, 'doco_rate_limited');
});

test('DocoPluginError 携带 code/details', () => {
  const e = new DocoPluginError('doco_x', 'm', { a: 1 });
  assert.equal(e.name, 'DocoPluginError');
  assert.equal(e.code, 'doco_x');
  assert.deepEqual(e.details, { a: 1 });
});

// ---- limits ----

test('clipToOutputLimit 短文本原样、超长截断', () => {
  assert.deepEqual(clipToOutputLimit('abc'), { text: 'abc', truncated: false });
  const long = 'x'.repeat(LIMITS.MAX_TOOL_OUTPUT_CHARS + 10);
  const r = clipToOutputLimit(long);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < long.length + 50);
});

test('clampInt / utf8ByteLength', () => {
  assert.equal(clampInt(5, 20, 1, 100), 5);
  assert.equal(clampInt(999, 20, 1, 100), 100);
  assert.equal(clampInt('bad', 20, 1, 100), 20);
  assert.equal(clampInt(2.9, 20, 1, 100), 2); // trunc
  assert.equal(utf8ByteLength('中文'), 6);
  assert.equal(utf8ByteLength('abc'), 3);
});

// ---- citations ----

test('documentUri / knowledgeBaseUri / webUrl 拼接', () => {
  assert.equal(documentUri('d1'), 'doco://doc/d1');
  assert.equal(documentUri('d1', 'b1'), 'doco://doc/d1#block=b1');
  assert.equal(knowledgeBaseUri('k1'), 'doco://kb/k1');
  assert.equal(webUrl('https://doco.page', 'd1', 'b1'), 'https://doco.page/doc/d1#block=b1');
});

test('citation 稳定字段（未知为 null，不省略）', () => {
  const c = citation({ document_id: 'd1', webOrigin: 'https://doco.page' });
  assert.deepEqual(c, {
    document_id: 'd1',
    block_id: null,
    document_uri: 'doco://doc/d1',
    web_url: 'https://doco.page/doc/d1',
    title: null,
    heading_path: [],
    source_version: null,
    freshness: null,
  });
});

test('citationFromHit 从 SearchV2 命中构造', () => {
  const c = citationFromHit(
    { document_id: 'd1', block_id: 'b1', title: 'T', heading_path: ['H'], source_version: 'v2', freshness: 'stale' },
    'https://doco.page',
  );
  assert.equal(c.document_uri, 'doco://doc/d1#block=b1');
  assert.deepEqual(c.heading_path, ['H']);
  assert.equal(c.freshness, 'stale');
});

// ---- credentials ----

test('redactSecrets 打码 doco_tok_* 与额外 secret', () => {
  assert.equal(redactSecrets('tok=doco_tok_ABC_def-1'), 'tok=doco_tok_***');
  assert.equal(redactSecrets('a doco_tok_XYZ b'), 'a doco_tok_*** b');
  assert.equal(redactSecrets('hit super123 then', ['super123']), 'hit *** then');
});
test('userAgent 含插件名+版本，不含 token', () => {
  assert.equal(userAgent('1.2.3'), 'doco-dsh/1.2.3');
});

// ---- config ----

test('normalizeToolPrefix 补尾下划线、缺省 doco，非法抛错', () => {
  assert.equal(normalizeToolPrefix(undefined), 'doco_');
  assert.equal(normalizeToolPrefix('doco'), 'doco_');
  assert.equal(normalizeToolPrefix('_my_'), 'my_');
  assert.throws(() => normalizeToolPrefix('a b'), DocoPluginError);
  assert.throws(() => normalizeToolPrefix('a/b'), DocoPluginError);
});

test('validateBaseUrl 剥离尾斜杠、拒绝非 http(s)', () => {
  assert.equal(validateBaseUrl('https://api.doco.page/api/v1/'), 'https://api.doco.page/api/v1');
  assert.throws(() => validateBaseUrl('ftp://x'), DocoPluginError);
  assert.throws(() => validateBaseUrl('::::'), DocoPluginError);
});
test('validateOrigin 缺省 doco.page', () => {
  assert.equal(validateOrigin(undefined), 'https://doco.page');
  assert.equal(validateOrigin('https://x.test/'), 'https://x.test');
});

test('resolveConfig 优先级 options > env，缺省取内置默认', () => {
  const env = {
    [ENV_KEYS.baseUrl]: 'https://env.test/api/v1',
    [ENV_KEYS.allowWrites]: 'true',
    [ENV_KEYS.readMaxTokens]: '10000',
  };
  const c = resolveConfig({ baseUrl: 'https://opt.test/api/v1' }, env);
  assert.equal(c.baseUrl, 'https://opt.test/api/v1'); // options 压过 env
  assert.equal(c.allowWrites, true);
  assert.equal(c.readMaxTokens, 10000);
  assert.equal(c.toolPrefix, 'doco_');
});

test('resolveConfig 非法 baseUrl 抛 DocoPluginError', () => {
  assert.throws(() => resolveConfig({ baseUrl: 'not-a-url' }, {}), (e) => e.code === INVALID_CODES.baseUrl);
});

test('resolveConfig：CLI 显式(#3) > 插件 env(#4) > 内置默认，且内置默认不吞掉 DOCO_API_*', () => {
  const saved = {
    baseUrl: process.env.DOCO_BASE_URL,
    token: process.env.DOCO_TOKEN,
    config: process.env.DOCO_CONFIG,
    apiBase: process.env.DOCO_API_BASE_URL,
    apiToken: process.env.DOCO_API_TOKEN,
  };
  try {
    // 隔离真实 ~/.config/doco/config.json，避免测试机本地配置干扰。
    process.env.DOCO_CONFIG = '/tmp/doco-dsh-unittest-nonexistent-config.json';
    delete process.env.DOCO_BASE_URL;
    delete process.env.DOCO_TOKEN;
    delete process.env.DOCO_API_BASE_URL;
    delete process.env.DOCO_API_TOKEN;

    // 仅插件 env（#4）→ 应覆盖内置默认，不再被 loadConfig 的默认 base_url 吞掉
    process.env.DOCO_API_BASE_URL = 'https://plugin.test/api/v1';
    process.env.DOCO_API_TOKEN = 'doco_tok_PLUGIN_ONLY';
    let c = resolveConfig({});
    assert.equal(c.baseUrl, 'https://plugin.test/api/v1');
    assert.equal(c.token, 'doco_tok_PLUGIN_ONLY');

    // CLI 显式（#3，DOCO_BASE_URL / DOCO_TOKEN）胜过插件 env
    process.env.DOCO_BASE_URL = 'https://cli.test/api/v1';
    process.env.DOCO_TOKEN = 'doco_tok_CLI';
    c = resolveConfig({});
    assert.equal(c.baseUrl, 'https://cli.test/api/v1');
    assert.equal(c.token, 'doco_tok_CLI');

    // dsh 显式参数（#1）胜过一切
    c = resolveConfig({ baseUrl: 'https://opt.test/api/v1', token: 'doco_tok_OPT' });
    assert.equal(c.baseUrl, 'https://opt.test/api/v1');
    assert.equal(c.token, 'doco_tok_OPT');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---- shared ----

test('validateQuery：空/超 200 拒绝，合法 trim', () => {
  assert.equal(validateQuery('').ok, false);
  assert.equal(validateQuery('   ').ok, false);
  assert.equal(validateQuery('x'.repeat(201)).ok, false);
  assert.deepEqual(validateQuery('  hello  '), { ok: true, value: 'hello' });
});

test('validateLimit：默认 20、clamp 到 100、非法拒绝', () => {
  assert.deepEqual(validateLimit(undefined), { ok: true, value: 20, clamped: false });
  assert.deepEqual(validateLimit(120), { ok: true, value: 100, clamped: true });
  assert.equal(validateLimit(0).ok, false);
  assert.equal(validateLimit('nope').ok, false);
});

test('normalizeKbId：空 → null，数字 → 字符串', () => {
  assert.equal(normalizeKbId(undefined), null);
  assert.equal(normalizeKbId(''), null);
  assert.equal(normalizeKbId(42), '42');
  assert.equal(normalizeKbId('  kb1 '), 'kb1');
});

test('textBlock / oneLine', () => {
  assert.deepEqual(textBlock('hi'), [{ type: 'text', text: 'hi' }]);
  assert.equal(oneLine('a\n  b\tc'), 'a b c');
});