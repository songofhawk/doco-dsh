// @ts-check
/**
 * doco_search（设计文档 §8.3）：Search v2 全文搜索，返回带完整性证明的命中。
 * 每条命中补 web_url 与 `source` 引用对象；projection.complete=false / freshness=stale 时
 * 在值和 render 里都明确标注（§11：doco_search_incomplete），禁止据不完整结果断言「不存在」。
 */
import { ensureIdentity } from '../context.js';
import { citationFromHit, webUrl } from '../citations.js';
import { validateQuery, validateLimit, normalizeKbId, catchAsError, textBlock } from './shared.js';

const SNIPPET_MAX = 200;

/** @param {string} s */
function clip(s) {
  const t = String(s ?? '');
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX - 1)}…` : t;
}

/**
 * @param {{ state: ReturnType<import('../context.js').createState>; name: string }} deps
 */
export function createDocoSearch({ state, name }) {
  return {
    name,
    description:
      '按关键词在 Doco 知识库全文搜索（Search v2），返回目录路径、标题路径、命中块与其前后文、source/indexed 版本和新鲜度。' +
      ' projection.complete=false 或 freshness=stale 表示结果不完整，此时不能断言「知识库里没有该内容」（可用 cursor 继续遍历）。',
    parameters: {
      q: { type: 'string', required: true, description: '标题或正文关键词，1–200 字符。' },
      knowledge_base_id: { type: 'json', description: '可选：仅在该知识库内搜索（string 或 number）。' },
      mode: { type: 'string', enum: ['topk', 'exhaustive'], description: '默认 topk；exhaustive 配 cursor 可做完整遍历。' },
      limit: { type: 'integer', description: '返回结果数，1–100，默认 20。' },
      cursor: { type: 'string', description: 'exhaustive 续页游标（上次响应 page.next_cursor）。' },
      locale: { type: 'string', description: '可选：BCP 47 语言标签或 all。' },
      include_summary: { type: 'boolean', description: '默认 false；命中附带的文档摘要。' },
    },
    async execute(args) {
      const q = validateQuery(args?.q);
      if (!q.ok) return q.error;
      const limit = validateLimit(args?.limit);
      if (!limit.ok) return limit.error;

      const { error } = await ensureIdentity(state);
      if (error) return error.code ? error : catchAsError(new Error('identity unavailable'));

      const query = {
        q: q.value,
        ...(normalizeKbId(args?.knowledge_base_id) ? { knowledge_base_id: normalizeKbId(args?.knowledge_base_id) } : {}),
        ...(args?.mode ? { mode: args.mode } : {}),
        ...(args?.cursor ? { cursor: args.cursor } : {}),
        ...(args?.locale ? { locale: args.locale } : {}),
        ...(args?.include_summary ? { include_summary: args.include_summary } : {}),
        limit: limit.value,
      };

      try {
        const data = (await state.client.searchV2(query)).data ?? {};
        const projection = data.projection ?? {};
        const page = data.page ?? {};
        const results = Array.isArray(data.results) ? data.results : [];

        const complete = projection.complete !== false;
        const freshness = projection.freshness ?? 'current';
        const hits = results.map((hit) => ({
          document_id: hit.document_id,
          document_uri: hit.document_uri,
          web_url: webUrl(state.config.webOrigin, hit.document_id, hit.block_id),
          title: hit.title,
          path_text: hit.path_text,
          block_id: hit.block_id ?? null,
          heading_path: Array.isArray(hit.heading_path) ? hit.heading_path : [],
          matched_in: hit.matched_in,
          context: hit.context ?? null,
          score: hit.score,
          source_version: hit.source_version ?? null,
          indexed_version: hit.indexed_version ?? null,
          freshness: hit.freshness ?? null,
          source: citationFromHit(hit, state.config.webOrigin),
        }));

        return {
          kind: 'doco_search',
          query: data.query ?? q.value,
          mode: data.mode ?? (args?.mode ?? 'topk'),
          results: hits,
          page: { has_more: page.has_more === true, next_cursor: page.next_cursor ?? null },
          projection: {
            complete,
            freshness,
            stale_document_count: projection.stale_document_count ?? 0,
            document_count: projection.document_count ?? results.length,
          },
          completeness: complete
            ? null
            : { code: 'doco_search_incomplete', note: '投影不完整：以上为部分结果，可能遗漏内容。用 cursor 继续遍历，或改用 exhaustive 模式。' },
        };
      } catch (err) {
        return catchAsError(err);
      }
    }
  };
}