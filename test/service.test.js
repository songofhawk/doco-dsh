// @ts-check
/**
 * doco 服务（src/service.js）单测。
 * 依赖契约面（设计文档 §9）：
 *   - doco-dsh 通过 ctx.provide('doco', …) 暴露服务，disposer 随 effect 清理；
 *   - 下游插件 inject: ['doco'] 拿到 { getConfig, getClient, ensureIdentity,
 *     hasScope, errorValue, toErrorValue, mapApiError, DocoPluginError, ... }；
 *   - client 是活引用：reconfigure 后 getClient() 返回新 client，服务对象不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeContext, makeFakeState } from './helpers/fake-context.js';
import { createDocoService } from '../src/service.js';
import { reconfigure } from '../src/context.js';
import { resolveConfig } from '../src/config.js';
import { apply } from '../src/index.js';

test('createDocoService 暴露完整服务面', () => {
  const state = makeFakeState();
  const svc = createDocoService(state, { toolPrefix: 'doco_' });

  assert.equal(svc.pluginName, 'doco-dsh');
  assert.equal(svc.toolPrefix, 'doco_');
  assert.equal(typeof svc.version, 'string');
  assert.equal(typeof svc.getConfig, 'function');
  assert.equal(typeof svc.getClient, 'function');
  assert.equal(typeof svc.ensureIdentity, 'function');
  assert.equal(typeof svc.hasToken, 'function');
  assert.equal(typeof svc.hasScope, 'function');
  assert.equal(typeof svc.errorValue, 'function');
  assert.equal(typeof svc.toErrorValue, 'function');
  assert.equal(typeof svc.mapApiError, 'function');
  assert.equal(typeof svc.DocoPluginError, 'function');

  // scope 常量
  assert.equal(svc.scopes.READ, 'documents:read');
  assert.equal(svc.scopes.WRITE, 'documents:write');
  assert.equal(svc.scopes.KB_READ, 'knowledge-bases:read');
});

test('getClient/getConfig 是活引用：reconfigure 后返回新 client/新配置', () => {
  const state = makeFakeState();
  const svc = createDocoService(state, { toolPrefix: 'doco_' });
  const clientBefore = svc.getClient();
  assert.equal(clientBefore, state.client);

  reconfigure(state, { defaultKb: 'kb9' }, resolveConfig, {
    fetch: async () => { throw new Error('unused'); },
  });

  assert.notEqual(svc.getClient(), clientBefore);
  assert.equal(svc.getConfig().defaultKb, 'kb9');
  // 服务对象本身保持不变（下游 inject 持有的引用稳定）
  assert.equal(svc.pluginName, 'doco-dsh');
});

test('ensureIdentity 委托 state 身份（失败不抛）', async () => {
  const state = makeFakeState(); // 默认 me 返回 documents:read
  const svc = createDocoService(state, { toolPrefix: 'doco_' });
  const { user, scopes, error } = await svc.ensureIdentity();
  assert.equal(user.name, 'Alice');
  assert.deepEqual(scopes, ['documents:read']);
  assert.equal(error, null);
});

test('hasScope 判定与错误契约函数', () => {
  const state = makeFakeState();
  const svc = createDocoService(state, { toolPrefix: 'doco_' });

  assert.equal(svc.hasScope(['documents:read'], 'documents:read'), true);
  assert.equal(svc.hasScope(['documents:read'], 'documents:write'), false);

  const ev = svc.errorValue('doco_x', '测试错误', '重试');
  assert.deepEqual(ev, { kind: 'doco_error', code: 'doco_x', message: '测试错误', next_step: '重试' });

  const mapped = svc.mapApiError({ status: 429, code: 'rate_limited' });
  assert.equal(mapped.code, 'doco_rate_limited');
  assert.equal(mapped.retryable, true);
});

test('apply 装配后提供 doco 服务且 dispose 清理', () => {
  const { ctx, disposers, providedServices } = makeFakeContext();
  apply(ctx, {
    token: 'doco_tok_TEST_ONLY_0000000000',
    baseUrl: 'https://api.example.test/api/v1',
  });

  assert.ok(providedServices.has('doco'));
  const svc = providedServices.get('doco');
  assert.equal(svc.pluginName, 'doco-dsh');
  assert.equal(typeof svc.getClient, 'function');

  // provide disposer 已 yield 进 effect 的 disposer 列表（插件卸载时调用）
  const svcDisposer = disposers.find((d) => typeof d === 'function');
  assert.ok(svcDisposer);
  svcDisposer();
  assert.ok(!providedServices.has('doco'));
});