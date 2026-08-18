// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeContext, makeFakeState, identityBuildTool } from './helpers/fake-context.js';
import { registerTools } from '../src/tools/index.js';
import { applyPolicy } from '../src/policy.js';
import { buildCommands } from '../src/commands.js';
import { promptText } from '../src/prompt.js';
import { resolveConfig } from '../src/config.js';

const EXPECTED_TOOLS = [
  'doco_status',
  'doco_list_knowledge_bases',
  'doco_search',
  'doco_outline',
  'doco_read',
  'doco_save_draft',
];

test('registerTools 注册全部工具并应用前缀', () => {
  const { ctx, registeredTools } = makeFakeContext();
  const state = makeFakeState();
  const { registered, skipped, disposers } = registerTools(ctx.tools, { state, toolPrefix: 'doco_' }, identityBuildTool);
  assert.deepEqual(registered.sort(), EXPECTED_TOOLS.slice().sort());
  assert.equal(skipped.length, 0);
  assert.equal(disposers.length, 6);
  for (const name of EXPECTED_TOOLS) {
    const tool = registeredTools.get(name);
    assert.ok(tool, `${name} 未注册`);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.deepEqual(tool.output.schema, { type: 'object', additionalProperties: true });
  }
});

test('registerTools 遇到同名工具跳过而非覆盖', () => {
  const { ctx } = makeFakeContext();
  ctx.tools.register({ name: 'doco_search' }); // 预占位（模拟 Doco MCP 已注册）
  const state = makeFakeState();
  const { registered, skipped } = registerTools(ctx.tools, { state, toolPrefix: 'doco_' }, identityBuildTool);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, 'doco_search');
  assert.ok(!registered.includes('doco_search'));
  assert.equal(registered.length, EXPECTED_TOOLS.length - 1);
});

test('applyPolicy 装配后 guard + pre-execute 生效', () => {
  const { ctx, guards, preExecute } = makeFakeContext();
  const state = makeFakeState();
  applyPolicy(ctx, state, 'doco_');
  assert.equal(guards.length, 1);
  assert.equal(preExecute.length, 1);
  // guard 对上 commit 且未开 allowWrites 的调用返回拒绝原因
  const reason = guards[0]({ name: 'doco_save_draft', arguments: { mode: 'commit' } });
  assert.ok(reason.includes('doco_write_not_confirmed'));
  assert.equal(guards[0]({ name: 'doco_search' }), undefined);
});

test('promptText 引用实际工具名并含安全规则', () => {
  const text = promptText({ toolPrefix: 'doco_' });
  assert.ok(text.includes('doco_search'));
  assert.ok(text.includes('doco_save_draft'));
  assert.ok(text.includes('doco_read'));
  assert.ok(text.includes('不完整'));
  assert.ok(text.includes('不可信'));
});

test('buildCommands 暴露 /doco 命令；status 返回连接态', async () => {
  const state = makeFakeState();
  const defs = buildCommands({ state, resolveConfig });
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'doco');
  assert.ok(defs[0].description.includes('status'));
  assert.equal(typeof defs[0].handler, 'function');

  const status = await defs[0].handler({ rawInput: 'status', signal: new AbortController().signal });
  assert.equal(status.kind, 'success');
  assert.ok(status.text.includes('已连接'));
  assert.ok(status.text.includes('documents:read'));
  // 输出绝不包含 Token
  assert.ok(!status.text.includes('doco_tok_'));
});

test('buildCommands：未知子命令 → 错误', async () => {
  const state = makeFakeState();
  const defs = buildCommands({ state, resolveConfig });
  const r = await defs[0].handler({ rawInput: 'frobnicate', signal: new AbortController().signal });
  assert.equal(r.kind, 'error');
  assert.ok(r.text.includes('未知子命令'));
});

test('buildCommands：set-kb 缺参 → 用法提示；有参 → 更新配置', async () => {
  const state = makeFakeState();
  const defs = buildCommands({ state, resolveConfig });
  const noArg = await defs[0].handler({ rawInput: 'set-kb', signal: new AbortController().signal });
  assert.equal(noArg.kind, 'error');
  assert.ok(noArg.text.includes('用法'));

  const ok = await defs[0].handler({ rawInput: 'set-kb kb9', signal: new AbortController().signal });
  assert.equal(ok.kind, 'success');
  assert.equal(state.config.defaultKb, 'kb9');
});