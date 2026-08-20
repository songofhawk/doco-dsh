// @ts-check
/**
 * doco_read（设计文档 §8.5）：按 token 预算局部读取文档正文。
 * 支持 around（稳定块锚定）、cursor 续读、view 选择；返回版本、预算状态、续读游标与来源引用。
 * 旧游标 409 read_cursor_stale 时明确提示重新规划（重读 outline 或从 around 开始）。
 */
import { ensureIdentity } from '../context.js';
import { documentUri, webUrl } from '../citations.js';
import { errorValue, INVALID_CODES } from '../errors.js';
import { LIMITS, clipToOutputLimit } from '../limits.js';
import { catchAsError, textBlock } from './shared.js';

/** @param {unknown} id */
function validateDocumentId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) {
    return { ok: false, error: errorValue(INVALID_CODES.docPath, '缺少 document_id。', '先用 doco_search 定位目标文档。') };
  }
  return { ok: true, value };
}

/** @param {unknown} v @param {number} fallback */
function validateTokens(v, fallback) {
  if (v === undefined || v === null) return { ok: true, value: fallback };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 64 || n > LIMITS.READ_MAX_TOKENS) {
    return { ok: false, error: errorValue(INVALID_CODES.maxTokens, 'max_tokens 必须是 64–50000 的整数。', '使用默认 4000 或指定合法范围。') };
  }
  return { ok: true, value: n };
}

/** @param {unknown} v @param {number} fallback */
function validateContext(v, fallback) {
  if (v === undefined || v === null) return { ok: true, value: fallback };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > LIMITS.CONTEXT_MAX) {
    return { ok: false, error: errorValue(INVALID_CODES.context, 'context_before/after 必须是 0–100 的整数。', '使用默认 before=2 after=4。') };
  }
  return { ok: true, value: n };
}

/** 从 DocumentRead 抽出正文（按 view 决定字段）。 */
function extractBody(data) {
  if (data?.view === 'tiptap-json') return { content: null, document: data.document ?? null };
  if (data?.view === 'outline') return { content: null, sections: Array.isArray(data.sections) ? data.sections : [] };
  return { content: typeof data?.content === 'string' ? data.content : null };
}

/**
 * @param {{ state: ReturnType<import('../context.js').createState>; name: string }} deps
 */
export function createDocoRead({ state, name }) {
  return {
    name,
    description:
      '按 token 预算局部读取 Doco 文档正文。用 around 锚定某个稳定 block_id 精读该段，或用 next_cursor 续读。' +
      ' 返回内容版本（source_version）用于后续写入并发依据；budget_exceeded/truncated/has_more 时必须按提示续读。',
    parameters: {
      document_id: { type: 'string', required: true, description: '文档 ID。' },
      around: { type: 'string', description: '可选：锚定的稳定 block_id，精读该块及其上下文。' },
      max_tokens: { type: 'integer', description: '预算（token），64–50000，默认 4000。' },
      context_before: { type: 'integer', description: '目标块之前的上下文块数，0–100，默认 2。' },
      context_after: { type: 'integer', description: '目标块之后的上下文块数，0–100，默认 4。' },
      cursor: { type: 'string', description: '可选：上次响应 next_cursor，续读用（绑定正文版本）。' },
      view: { type: 'string', enum: ['markdown', 'plain-text', 'tiptap-json', 'outline'], description: '默认 markdown。' },
      locale: { type: 'string', description: '可选：BCP 47 语言标签或 all。' },
    },
    async execute(args) {
      const id = validateDocumentId(args?.document_id);
      if (!id.ok) return id.error;
      const maxTokens = validateTokens(args?.max_tokens, state.config.readMaxTokens);
      if (!maxTokens.ok) return maxTokens.error;
      const before = validateContext(args?.context_before, state.config.contextBefore);
      if (!before.ok) return before.error;
      const after = validateContext(args?.context_after, state.config.contextAfter);
      if (!after.ok) return after.error;

      const { error } = await ensureIdentity(state);
      if (error) return error.code ? error : catchAsError(new Error('identity unavailable'));

      const query = {
        ...(args?.around ? { around: args.around } : {}),
        ...(args?.cursor ? { cursor: args.cursor } : {}),
        ...(args?.view ? { view: args.view } : {}),
        ...(args?.locale ? { locale: args.locale } : {}),
        max_tokens: maxTokens.value,
        context_before: before.value,
        context_after: after.value,
      };

      try {
        const data = (await state.client.readDocument(id.value, query)).data ?? {};
        const docId = data.document_id ?? id.value;
        const body = extractBody(data);
        const hasMore = data.has_more === true;
        const truncated = data.truncated === true;
        const budgetExceeded = data.budget_exceeded === true;
        const needsContinuation = hasMore || truncated || budgetExceeded;

        return {
          kind: 'doco_read',
          document_id: docId,
          version: data.version ?? null,
          view: data.view ?? (args?.view ?? 'markdown'),
          document_uri: data.document_uri ?? documentUri(docId),
          web_url: webUrl(state.config.webOrigin, docId),
          range: data.range ?? null,
          estimated_tokens: data.estimated_tokens ?? null,
          max_tokens: data.max_tokens ?? maxTokens.value,
          budget_exceeded: budgetExceeded,
          truncated,
          omitted_ranges: Array.isArray(data.omitted_ranges) ? data.omitted_ranges : [],
          has_more: hasMore,
          next_cursor: data.next_cursor ?? null,
          ...body,
          source: {
            document_id: String(docId),
            block_id: data.range?.block_id ?? args?.around ?? null,
            document_uri: data.document_uri ?? documentUri(docId),
            web_url: webUrl(state.config.webOrigin, docId),
            title: null,
            heading_path: [],
            source_version: data.version ?? null,
            freshness: 'current',
          },
          continuation: needsContinuation
            ? '本次读取未覆盖全文：请用返回的 next_cursor 续读，或用 doco_outline 先规划再按块精读。'
            : null,
        };
      } catch (err) {
        return catchAsError(err);
      }
    },
    render(_args, value) {
      if (value.kind === 'doco_error') {
        return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      }
      const header =
        `${value.document_uri}（version=${value.version ?? '?'}，view=${value.view}）`;
      let body = '';
      if (typeof value.content === 'string') {
        body = value.content;
      } else if (Array.isArray(value.sections)) {
        body = value.sections.map((s) =>
          `${'  '.repeat(Math.max(0, (s.level ?? 1) - 1))}- ${s.title ?? '(无标题)'}${s.block_id ? ` [${s.block_id}]` : ''}`,
        ).join('\n');
      } else if (value.document != null) {
        body = `（tiptap-json 结构共 ${JSON.stringify(value.document).length} 字符，见 structuredContent；需要可读正文请改用 view=markdown）`;
      }
      const footer = value.continuation
        ? `\n\n⚠ ${value.continuation}`
        : '';

      const clipped = clipToOutputLimit(`${header}\n\n${body}${footer}`);
      if (clipped.truncated) {
        clipped.text += '\n⚠ 输出超 200000 字符：请减小 max_tokens 或用 around 精读局部。';
      }
      return textBlock(clipped.text);
    },
  };
}