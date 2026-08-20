// @ts-check
/**
 * doco_list_knowledge_bases（设计文档 §8.2）：列出当前用户可见知识库。
 * 直接透传 DocoClient.listKnowledgeBases() 的 data（数组）；不追加读取任何知识库正文。
 */
import { ensureIdentity } from '../context.js';
import { catchAsError, textBlock } from './shared.js';

/**
 * @param {{ state: ReturnType<import('../context.js').createState>; name: string }} deps
 */
export function createDocoListKnowledgeBases({ state, name }) {
  return {
    name,
    description:
      '列出当前用户可访问的全部 Doco 知识库（id/name 等元数据）。' +
      ' 在搜索/写入前用它选定 knowledge_base_id；不读取知识库正文。',
    parameters: {},
    async execute() {
      const { error } = await ensureIdentity(state);
      if (error) return error.code ? error : catchAsError(new Error('identity unavailable'));
      try {
        const data = (await state.client.listKnowledgeBases()).data ?? [];
        return { kind: 'doco_knowledge_bases', knowledge_bases: Array.isArray(data) ? data : [] };
      } catch (err) {
        return catchAsError(err);
      }
    },
    render(_args, value) {
      if (value.kind === 'doco_error') {
        return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      }
      const kbs = value.knowledge_bases || [];
      if (kbs.length === 0) return textBlock('（无可访问的知识库）');
      const lines = kbs.map((kb) =>
        `- [${kb.id}] ${kb.name ?? '(未命名)'}${kb.description ? ` — ${String(kb.description)}` : ''}${kb.document_count != null ? `（${kb.document_count} 篇文档）` : ''}`,
      );
      return textBlock(`共 ${kbs.length} 个知识库：\n${lines.join('\n')}`);
    },
  };
}