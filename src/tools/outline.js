// @ts-check
/**
 * doco_outline（设计文档 §8.4）：读取文档结构大纲，而非全文。
 * 用稳定 block_id + heading_path 先规划，再决定用 doco_read 精读哪一段。
 */
import { ensureIdentity } from '../context.js';
import { documentUri, webUrl } from '../citations.js';
import { errorValue, INVALID_CODES } from '../errors.js';
import { catchAsError, textBlock } from './shared.js';

/** @param {unknown} id */
function validateDocumentId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) {
    return { ok: false, error: errorValue(INVALID_CODES.docPath, '缺少 document_id。', '先用 doco_search 定位目标文档。') };
  }
  return { ok: true, value };
}

/**
 * @param {{ state: ReturnType<import('../context.js').createState>; name: string }} deps
 */
export function createDocoOutline({ state, name }) {
  return {
    name,
    description:
      '读取一篇 Doco 文档的结构大纲（每个标题的稳定 block_id、heading_path 和块区间），用于先规划再局部精读。' +
      ' 不要用它读取正文内容；正文用 doco_read。',
    parameters: {
      document_id: { type: 'string', required: true, description: '文档 ID。' },
    },
    async execute(args) {
      const id = validateDocumentId(args?.document_id);
      if (!id.ok) return id.error;
      const { error } = await ensureIdentity(state);
      if (error) return error.code ? error : catchAsError(new Error('identity unavailable'));
      try {
        const data = (await state.client.getOutline(id.value)).data ?? {};
        return {
          kind: 'doco_outline',
          document_id: data.document_id ?? id.value,
          version: data.version ?? null,
          document_uri: documentUri(data.document_id ?? id.value),
          web_url: webUrl(state.config.webOrigin, data.document_id ?? id.value),
          block_count: data.block_count ?? 0,
          heading_count: data.heading_count ?? 0,
          preamble: data.preamble ?? null,
          sections: Array.isArray(data.sections) ? data.sections : [],
        };
      } catch (err) {
        return catchAsError(err);
      }
    },
    render(_args, value) {
      if (value.kind === 'doco_error') {
        return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      }
      const head = `大纲 ${value.document_uri}（version=${value.version ?? '?'}，${value.sections.length} 个标题，${value.block_count} 块）`;
      if (value.sections.length === 0) return textBlock(`${head}\n（该文档暂无标题结构）`);
      const lines = value.sections.map((s) => {
        const indent = '  '.repeat(Math.max(0, (s.level ?? 1) - 1));
        return `${indent}- ${s.title ?? '(无标题)'}${s.block_id ? `  [${s.block_id}]` : ''}${s.block_count != null ? `  (${s.block_count} 块)` : ''}`;
      });
      return textBlock(`${head}\n${lines.join('\n')}`);
    },
  };
}