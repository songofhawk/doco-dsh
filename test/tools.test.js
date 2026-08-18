// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeState } from './helpers/fake-context.js';
import { createDocoStatus } from '../src/tools/status.js';
import { createDocoListKnowledgeBases } from '../src/tools/listKnowledgeBases.js';
import { createDocoSearch } from '../src/tools/search.js';
import { createDocoOutline } from '../src/tools/outline.js';
import { createDocoRead } from '../src/tools/read.js';
import { createDocoSaveDraft } from '../src/tools/saveDraft.js';

const SEARCH_HIT = {
  document_id: 'doc_1',
  document_uri: 'doco://doc/doc_1',
  title: '架构决策',
  path_text: 'kb/技术/架构决策',
  block_id: 'blk_1',
  heading_path: ['技术', '架构决策'],
  matched_in: 'body',
  context: { before: '前', match: '预警：目标为 doc_1', after: '后' },
  score: 0.9,
  source_version: 'v5',
  indexed_version: 'v5',
  freshness: 'current',
};

// ---- doco_status ----

test('doco_status：未配置 → connected:false + next_step', async () => {
  const state = makeFakeState({ config: { token: '' } });
  const tool = createDocoStatus({ state, name: 'doco_status' });
  const v = await tool.execute();
  assert.equal(v.kind, 'doco_status');
  assert.equal(v.connected, false);
  assert.equal(v.configured, false);
  assert.ok(v.next_step.includes('/doco connect'));
  const rendered = tool.render(v);
  assert.equal(rendered[0].type, 'text');
});

test('doco_status：已配置且 /me 正常 → connected + 能力', async () => {
  const state = makeFakeState();
  const tool = createDocoStatus({ state, name: 'doco_status' });
  const v = await tool.execute();
  assert.equal(v.connected, true);
  assert.equal(v.capabilities.search, true);
  assert.equal(v.capabilities.read, true);
  assert.equal(v.capabilities.write, false); // allowWrites 默认 false
});

test('doco_status：/me 失败 → connected:false + 稳定错误码', async () => {
  const state = makeFakeState({
    client: { me: async () => { throw { status: 401, code: 'invalid_api_token', message: 'bad' }; } },
  });
  const tool = createDocoStatus({ state, name: 'doco_status' });
  const v = await tool.execute();
  assert.equal(v.connected, false);
  assert.equal(v.configured, true);
  assert.equal(v.error.code, 'doco_auth_required');
});

// ---- doco_search ----

test('doco_search：非法 q 不触网，返回 doco_invalid_query', async () => {
  let called = false;
  const state = makeFakeState({ client: { searchV2: async () => { called = true; return {}; } } });
  const tool = createDocoSearch({ state, name: 'doco_search' });
  const v = await tool.execute({ q: '   ' });
  assert.equal(v.kind, 'doco_error');
  assert.equal(v.code, 'doco_invalid_query');
  assert.equal(called, false);
});

test('doco_search：命中补 source/web_url，complete 时无 completeness', async () => {
  const state = makeFakeState({
    client: {
      searchV2: async () => ({
        data: {
          query: '架构', mode: 'topk',
          results: [SEARCH_HIT],
          page: { has_more: false, next_cursor: null },
          projection: { complete: true, freshness: 'current', stale_document_count: 0, document_count: 1 },
        },
      }),
    },
  });
  const tool = createDocoSearch({ state, name: 'doco_search' });
  const v = await tool.execute({ q: '架构' });
  assert.equal(v.kind, 'doco_search');
  assert.equal(v.results.length, 1);
  assert.equal(v.results[0].web_url, 'https://doco.page/doc/doc_1#block=blk_1');
  assert.equal(v.results[0].source.document_id, 'doc_1');
  assert.equal(v.completeness, null);
});

test('doco_search：projection.complete=false → completeness=doco_search_incomplete', async () => {
  const state = makeFakeState({
    client: {
      searchV2: async () => ({
        data: { query: 'x', mode: 'topk', results: [], page: {}, projection: { complete: false, freshness: 'stale', stale_document_count: 3, document_count: 3 } },
      }),
    },
  });
  const tool = createDocoSearch({ state, name: 'doco_search' });
  const v = await tool.execute({ q: 'x' });
  assert.equal(v.completeness.code, 'doco_search_incomplete');
});

// ---- doco_read ----

test('doco_read：max_tokens 越界 → doco_invalid_max_tokens', async () => {
  const state = makeFakeState();
  const tool = createDocoRead({ state, name: 'doco_read' });
  const v = await tool.execute({ document_id: 'doc_1', max_tokens: 1 });
  assert.equal(v.code, 'doco_invalid_max_tokens');
});

test('doco_read：has_more → continuation 提示；内容透传', async () => {
  const state = makeFakeState({
    client: {
      readDocument: async () => ({
        data: {
          document_id: 'doc_1', version: 'v3', view: 'markdown',
          document_uri: 'doco://doc/doc_1', content: '正文内容', has_more: true, next_cursor: 'cur2', estimated_tokens: 800, max_tokens: 4000,
        },
      }),
    },
  });
  const tool = createDocoRead({ state, name: 'doco_read' });
  const v = await tool.execute({ document_id: 'doc_1' });
  assert.equal(v.kind, 'doco_read');
  assert.equal(v.content, '正文内容');
  assert.equal(v.has_more, true);
  assert.ok(v.continuation.includes('next_cursor'));
  assert.equal(v.source.source_version, 'v3');
});

// ---- doco_outline ----

test('doco_outline：返回 section 与版本', async () => {
  const state = makeFakeState({
    client: {
      getOutline: async () => ({
        data: { document_id: 'doc_1', version: 'v2', block_count: 4, heading_count: 2, sections: [{ title: 'A', level: 1, block_id: 'b1', block_count: 2 }] },
      }),
    },
  });
  const tool = createDocoOutline({ state, name: 'doco_outline' });
  const v = await tool.execute({ document_id: 'doc_1' });
  assert.equal(v.kind, 'doco_outline');
  assert.equal(v.version, 'v2');
  assert.equal(v.sections.length, 1);
});

test('doco_outline：缺 document_id → doco_invalid_document', async () => {
  const tool = createDocoOutline({ state: makeFakeState(), name: 'doco_outline' });
  const v = await tool.execute({});
  assert.equal(v.code, 'doco_invalid_document');
});

// ---- doco_list_knowledge_bases ----

test('doco_list_knowledge_bases：透传 data 数组', async () => {
  const state = makeFakeState({
    client: { listKnowledgeBases: async () => ({ data: [{ id: 1, name: 'K1', document_count: 3 }] }) },
  });
  const tool = createDocoListKnowledgeBases({ state, name: 'doco_list_knowledge_bases' });
  const v = await tool.execute();
  assert.equal(v.kind, 'doco_knowledge_bases');
  assert.equal(v.knowledge_bases.length, 1);
});

// ---- doco_save_draft ----

test('doco_save_draft（preview）：绝不调用 createDocument', async () => {
  let wrote = false;
  const state = makeFakeState({
    client: { createDocument: async () => { wrote = true; return { data: { id: 'x' } }; } },
  });
  const tool = createDocoSaveDraft({ state, name: 'doco_save_draft' });
  const v = await tool.execute({ knowledge_base_id: 1, title: '草稿', content: '正文', mode: 'preview' });
  assert.equal(v.kind, 'doco_save_draft');
  assert.equal(v.mode, 'preview');
  assert.equal(v.writes_nothing, true);
  assert.equal(wrote, false);
});

test('doco_save_draft（commit）：allowWrites=false → doco_write_not_confirmed 且不写', async () => {
  let wrote = false;
  const state = makeFakeState({
    client: { createDocument: async () => { wrote = true; return { data: { id: 'x' } }; } },
  });
  const tool = createDocoSaveDraft({ state, name: 'doco_save_draft' });
  const v = await tool.execute({ knowledge_base_id: 1, title: '草稿', content: '正文', mode: 'commit' });
  assert.equal(v.code, 'doco_write_not_confirmed');
  assert.equal(wrote, false);
});

test('doco_save_draft（commit）：无 write scope → doco_write_scope_required', async () => {
  const state = makeFakeState({ config: { allowWrites: true } }); // me 默认只读 scope
  const tool = createDocoSaveDraft({ state, name: 'doco_save_draft' });
  const v = await tool.execute({ knowledge_base_id: 1, title: '草稿', content: '正文', mode: 'commit' });
  assert.equal(v.code, 'doco_write_scope_required');
});

test('doco_save_draft（commit）：allowWrites + write scope → 创建并返回 stable 对象', async () => {
  let captured = null;
  const state = makeFakeState({
    config: { allowWrites: true },
    client: {
      me: async () => ({ data: { user: { id: 'u1' }, scopes: ['documents:read', 'documents:write'], token_id: 't' } }),
      createDocument: async (body) => { captured = body; return { data: { id: 'doc_new', title: '草稿', knowledge_base_id: 1 } }; },
    },
  });
  const tool = createDocoSaveDraft({ state, name: 'doco_save_draft' });
  const v = await tool.execute({
    knowledge_base_id: 1, title: '草稿', content: '正文', mode: 'commit',
    source_documents: [{ document_id: 'doc_1', block_id: 'blk_1', source_version: 'v1' }],
  });
  assert.equal(v.kind, 'doco_save_draft');
  assert.equal(v.mode, 'commit');
  assert.equal(v.document_id, 'doc_new');
  assert.equal(v.created, true);
  // 正文追加来源且不含 Token
  assert.ok(captured.content.content.includes('## 来源'));
  assert.ok(!JSON.stringify(captured).includes('doco_tok_'));
  // 幂等键唯一（两次 uuid 不同由 crypto 保证，这里只断言 createDocument 拿到第二参）
});

test('doco_save_draft：空 title → doco_invalid_title', async () => {
  const tool = createDocoSaveDraft({ state: makeFakeState(), name: 'doco_save_draft' });
  const v = await tool.execute({ knowledge_base_id: 1, content: 'body', mode: 'preview' });
  assert.equal(v.code, 'doco_invalid_title');
});