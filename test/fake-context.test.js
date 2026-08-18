// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeContext, identityBuildTool, makeFakeState } from './helpers/fake-context.js';

test('ctx.tools.register 记录并支持 get / 重复名抛错', () => {
  const { ctx, registeredTools } = makeFakeContext();
  const dispose = ctx.tools.register({ name: 'doco_x' });
  assert.equal(ctx.tools.get('doco_x').name, 'doco_x');
  assert.equal(registeredTools.size, 1);
  assert.throws(() => ctx.tools.register({ name: 'doco_x' }), /is already registered/);
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(registeredTools.size, 0);
});

test('ctx.effect 推进 generator 并收集 yield 的 disposer', () => {
  const { ctx, disposers } = makeFakeContext();
  const a = () => {};
  const b = () => {};
  ctx.effect(function* () {
    yield a;
    yield b;
  });
  assert.deepEqual(disposers, [a, b]);
});

test('ctx.tools.guard / ctx.on 记录守卫与 pre-execute 处理器', () => {
  const { ctx, guards, preExecute } = makeFakeContext();
  const g = () => undefined;
  const h = () => {};
  ctx.tools.guard(g);
  ctx.on('tools/pre-execute', h);
  assert.equal(guards.length, 1);
  assert.equal(preExecute.length, 1);
});

test('identityBuildTool 透传 execute/render/parameters', () => {
  const exec = async () => ({ kind: 'x' });
  const render = () => [{ type: 'text', text: 'y' }];
  const tool = identityBuildTool({ name: 't', parameters: { a: { type: 'string' } }, output: { schema: {} }, execute: exec, render });
  assert.equal(tool.__docoIdentityTool, true);
  assert.equal(tool.name, 't');
  assert.equal(tool.execute, exec);
  assert.equal(tool.render, render);
});

test('makeFakeState 默认 me 返回读 scope 用户，client 方法可覆盖', async () => {
  const state = makeFakeState();
  const me = await state.client.me();
  assert.equal(me.data.user.name, 'Alice');
  assert.deepEqual(me.data.scopes, ['documents:read']);

  const state2 = makeFakeState({ client: { me: async () => ({ data: { scopes: ['documents:write'] } }) } });
  assert.deepEqual((await state2.client.me()).data.scopes, ['documents:write']);
  assert.equal(state2.config.token, 'doco_tok_TEST_ONLY_0000000000');
});