// @ts-check
/**
 * 真实 dsh 冒烟：用安装好的 @deepseek-ai/dsh-tools 的 defineTool /
 * valueSchemaSpecToJsonSchema / validateArgs 校验本插件的 schema DSL
 * （§20 要求「不猜 dsh API」——这里直接对齐真实运行时，而非替身）。
 *
 * 覆盖三类最容易猜错的点：
 *   1. 6 个工具的 parameters（隐式开放对象 + required:true）能否被编译；
 *   2. output.schema=OPEN_OBJECT（ObjectValueSchemaSpec，additionalProperties:true）能否编译；
 *   3. 真实 defineTool 的 execute 封装会按 schema 校验参数（缺必填 q → ToolArgsError）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, valueSchemaSpecToJsonSchema, validateArgs } from '@deepseek-ai/dsh-tools';
import { Context } from '@deepseek-ai/cordis';
import { registerTools, OPEN_OBJECT } from '../src/tools/index.js';
import { createDocoSaveDraft } from '../src/tools/saveDraft.js';
import { apply } from '../src/index.js';
import { makeFakeContext, makeFakeState } from './helpers/fake-context.js';

test('真实 defineTool 接受并编译全部 6 个工具', () => {
  const { ctx } = makeFakeContext();
  const state = makeFakeState();
  const { registered, skipped } = registerTools(ctx.tools, { state, toolPrefix: 'doco_' }, defineTool);
  assert.equal(registered.length, 6);
  assert.equal(skipped.length, 0);

  for (const name of registered) {
    const tool = ctx.tools.get(name);
    assert.equal(tool.name, name);
    // defineTool 把隐式开放参数对象编译为标准 JSON Schema
    assert.equal(tool.parameters?.type, 'object');
    assert.equal(tool.output?.schema?.type, 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output?.render, 'function');
  }
});

test('OPEN_OBJECT 通过 valueSchemaSpecToJsonSchema 编译为开放对象', () => {
  const compiled = valueSchemaSpecToJsonSchema(OPEN_OBJECT);
  assert.equal(compiled.type, 'object');
  assert.equal(compiled.additionalProperties, true);
});

test('真实 defineTool 的 execute 按 schema 校验：合法参数通过、缺必填抛 ToolArgsError', async () => {
  const { ctx } = makeFakeContext();
  const state = makeFakeState({
    client: {
      searchV2: async (query) => ({
        data: { query: query.q, mode: 'topk', results: [], page: {}, projection: { complete: true, freshness: 'current' } },
      }),
    },
  });
  registerTools(ctx.tools, { state, toolPrefix: 'doco_' }, defineTool);
  const search = ctx.tools.get('doco_search');

  const ok = await search.execute({ q: '预算与分账' });
  assert.equal(ok.kind, 'doco_search');

  await assert.rejects(
    () => search.execute({}),
    (e) => e?.name === 'ToolArgsError',
  );
});

// 回归（0.1.4）：dsh 宿主以 (args, value) 两个实参调用 output.render，首参是工具入参。
// 0.1.3 及之前 render 写成单参，实际拿到 args，导致 doco_search 读 value.results 崩
// （Cannot read properties of undefined），status/list 渲染成空壳。这里按真实调用方式断言。
test('回归：output.render 按 dsh 真实约定 (args, value) 调用，渲染依赖 value 而非 args', async () => {
  const { ctx } = makeFakeContext();
  const state = makeFakeState({
    client: {
      searchV2: async (query) => ({
        data: {
          query: query.q,
          mode: 'topk',
          results: [{
            document_id: 'doc_1', document_uri: 'doco://doc/doc_1', title: '架构决策',
            path_text: 'kb/技术', block_id: 'blk_1', matched_in: 'body', score: 0.9,
          }],
          page: {}, projection: { complete: true, freshness: 'current' },
        },
      }),
    },
  });
  registerTools(ctx.tools, { state, toolPrefix: 'doco_' }, defineTool);
  const search = ctx.tools.get('doco_search');

  const args = { q: '预算与分账' };
  const value = await search.execute(args);
  assert.equal(value.kind, 'doco_search');

  // 成功路径：render 输出必须反映执行结果（命中标题），而不是把 args 当 value 读崩。
  const blocks = search.output.render(args, value);
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].text.includes('架构决策'));
  assert.ok(blocks[0].text.includes('预算与分账'));

  // 错误路径：错误值也要按 value 排版出稳定错误码。
  const errValue = { kind: 'doco_error', code: 'doco_network', message: '无法连接到 Doco API', next_step: '重试' };
  const errBlocks = search.output.render(args, errValue);
  assert.ok(errBlocks[0].text.includes('doco_network'));
});

test('validateArgs：必填参数缺省返回违规，合法样本返回空数组', () => {
  const state = makeFakeState();
  // 直接拿工厂的原始 DSL 参数（未编译），validateArgs 只吃 DSL。
  const raw = createDocoSaveDraft({ state, name: 'doco_save_draft' }).parameters;

  assert.equal(validateArgs(raw, { title: 'T', content: 'C', knowledge_base_id: 1, mode: 'preview' }).length, 0);
  assert.ok(validateArgs(raw, { title: 'T', content: 'C' }).length > 0); // 缺 knowledge_base_id
  assert.ok(validateArgs(raw, {}).length > 0);
});

// 完整 apply()：真实 cordis Context + 真实 defineTool + dsh 服务 shim（tools/systemPrompt/commands）。
// 验证 index.js 的 effect/on/logger/生命周期调用方式与真实 cordis 兼容。
test('apply 在真实 cordis Context 上装配 6 个工具并可正常执行', async () => {
  const ctx = new Context();
  const registered = new Map();
  const guards = [];
  const sections = [];
  const commands = [];

  ctx.tools = {
    register(def) {
      if (registered.has(def.name)) throw new Error(`tool "${def.name}" is already registered`);
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
    guard(fn) { guards.push(fn); return () => {}; },
  };
  ctx.systemPrompt = { section(s) { sections.push(s); return () => {}; } };
  ctx.commands = { register(d) { commands.push(d); return () => {}; } };

  apply(ctx, { baseUrl: 'https://api.example.test/api/v1', token: 'doco_tok_TEST_ONLY_0000000000' });

  assert.equal(registered.size, 6);
  assert.ok(registered.has('doco_search'));
  assert.equal(guards.length, 1);          // 写入门禁已装
  assert.equal(sections.length, 1);        // 系统提示词分段已注入
  assert.equal(sections[0].text.includes('doco_search'), true);
  assert.equal(commands.length, 1);        // /doco 命令已注册
  assert.equal(commands[0].name, 'doco');

  // 真实 defineTool 封装的 execute 仍可用（无网络：只校验必填参数）
  await assert.rejects(() => registered.get('doco_search').execute({}), (e) => e?.name === 'ToolArgsError');
});