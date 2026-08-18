// @ts-check
/**
 * doco_save_draft（设计文档 §8.6、§10.5）：把 Agent 产出保存为新 Doco 草稿。
 *   - mode=preview：只校验目标/权限/正文/来源，返回待执行计划，绝不写 Doco；
 *   - mode=commit：必须已通过 dsh 写入审批（pre-execute ask）且 Token 含 documents:write。
 * 创建用唯一 Idempotency-Key；正文保留来源链接但绝不写入 Token。
 * 注意：删除/移动/整篇覆盖不在本工具范围内。
 */
import { randomUUID } from 'node:crypto';
import { ensureIdentity } from '../context.js';
import { documentUri, webUrl } from '../citations.js';
import { errorValue, INVALID_CODES, toErrorValue } from '../errors.js';
import { LIMITS, utf8ByteLength } from '../limits.js';
import { hasScope, SCOPE_WRITE } from '../policy.js';
import { catchAsError, normalizeKbId, textBlock } from './shared.js';

/** @param {unknown} v */
function validateTitle(v) {
  const value = typeof v === 'string' ? v.trim() : '';
  if (!value) {
    return { ok: false, error: errorValue(INVALID_CODES.title, '缺少标题 title。', '给出 1–200 字符的草稿标题。') };
  }
  if (value.length > LIMITS.TITLE_MAX_CHARS) {
    return { ok: false, error: errorValue(INVALID_CODES.title, `标题超过 ${LIMITS.TITLE_MAX_CHARS} 字符。`, '精简标题。') };
  }
  return { ok: true, value };
}

/** @param {unknown} format */
function normalizeFormat(format) {
  return format === 'tiptap-json' ? 'tiptap-json' : 'markdown';
}

/** 在 markdown 正文末尾追加来源链接（§8.6：正文保留来源，不写入 Token）。 */
function appendSources(markdown, sourceDocuments, webOrigin) {
  const srcs = (Array.isArray(sourceDocuments) ? sourceDocuments : []).filter((s) => s && s.document_id != null);
  if (srcs.length === 0) return markdown;
  const lines = srcs.map((s) => {
    const uri = documentUri(s.document_id, s.block_id);
    const url = webUrl(webOrigin, s.document_id, s.block_id);
    return `- [${uri}](${url})${s.source_version ? `（version ${s.source_version}）` : ''}`;
  });
  return `${markdown}\n\n## 来源\n${lines.join('\n')}`;
}

/** 校验 content 大小与形态，返回 {format, content} 或错误。 */
function validateContent(format, content) {
  if (format === 'tiptap-json') {
    if (content == null || typeof content !== 'object') {
      return { ok: false, error: errorValue(INVALID_CODES.format, 'tiptap-json 格式需要 content 为对象（Tiptap 文档）。', '改用 markdown 格式传入字符串正文。') };
    }
    const bytes = utf8ByteLength(JSON.stringify(content));
    if (bytes > LIMITS.CONTENT_MAX_BYTES) {
      return { ok: false, error: errorValue('doco_write_limit_exceeded', '正文超过 1MiB 上限。', '拆分或精简后重试。') };
    }
    return { ok: true, content: { format, document: content } };
  }
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, error: errorValue(INVALID_CODES.format, 'markdown 格式需要 content 为非空字符串。', '提供 markdown 正文，或改 format=tiptap-json。') };
  }
  const bytes = utf8ByteLength(content);
  if (bytes > LIMITS.CONTENT_MAX_BYTES) {
    return { ok: false, error: errorValue('doco_write_limit_exceeded', '正文超过 1MiB 上限。', '拆分或精简后重试。') };
  }
  return { ok: true, content: { format, content } };
}

/**
 * @param {{ state: ReturnType<import('../context.js').createState>; name: string }} deps
 */
export function createDocoSaveDraft({ state, name }) {
  return {
    name,
    description:
      '把 Agent 研究结果保存为新的 Doco 草稿文档。mode=preview 只返回计划不写入；' +
      ' mode=commit 需先经用户确认且 Token 有 documents:write 权限，用唯一幂等键创建。' +
      ' 不提供删除、移动或整篇覆盖。',
    parameters: {
      knowledge_base_id: { type: 'json', required: true, description: '目标知识库 ID（string 或 number）。' },
      title: { type: 'string', required: true, description: '草稿标题，1–200 字符。' },
      format: { type: 'string', enum: ['markdown', 'tiptap-json'], description: '默认 markdown。' },
      content: { type: 'json', required: true, description: '正文：markdown 为字符串，tiptap-json 为对象。' },
      mode: { type: 'string', enum: ['preview', 'commit'], description: '默认 preview。' },
      folder_id: { type: 'json', description: '可选：目标文件夹 ID。' },
      source_documents: {
        type: 'array',
        description: '可选：引用的来源文档 [{document_id, block_id?, source_version?}]。',
        items: { type: 'json' },
      },
    },
    async execute(args) {
      const title = validateTitle(args?.title);
      if (!title.ok) return title.error;
      const kbId = normalizeKbId(args?.knowledge_base_id);
      if (!kbId) {
        return errorValue(INVALID_CODES.kbId, '缺少目标知识库 knowledge_base_id。', '先用 doco_list_knowledge_bases 选定，或配置 DOCO_DEFAULT_KB。');
      }
      const format = normalizeFormat(args?.format);
      const content = validateContent(format, args?.content);
      if (!content.ok) return content.error;
      const mode = args?.mode === 'commit' ? 'commit' : 'preview';
      const sourceDocuments = Array.isArray(args?.source_documents)
        ? args.source_documents.filter(Boolean).map((s) => ({
          document_id: s.document_id,
          block_id: s.block_id ?? null,
          source_version: s.source_version ?? null,
        }))
        : [];

      const { scopes, error: identityError } = await ensureIdentity(state);
      const canWrite = Boolean(state.config.allowWrites && hasScope(scopes, SCOPE_WRITE));

      // ---- preview：绝不写 Doco ----
      if (mode === 'preview') {
        const contentBytes = format === 'markdown'
          ? utf8ByteLength(args?.content ?? '')
          : utf8ByteLength(JSON.stringify(args?.content ?? {}));
        return {
          kind: 'doco_save_draft',
          mode: 'preview',
          planned: {
            knowledge_base_id: kbId,
            folder_id: args?.folder_id ?? null,
            title: title.value,
            format,
            content_bytes: contentBytes,
            source_documents: sourceDocuments,
          },
          writes_nothing: true,
          commit_available: canWrite,
          note: canWrite
            ? '预览通过。commit 会经用户确认后写入。'
            : '预览通过。但当前无法 commit：' + (identityError ? `身份不可用（${identityError.code}）` : '缺少 documents:write 权限或未开启 allowWrites。'),
        };
      }

      // ---- commit：防御性校验（正常应已被 policy 拦截）----
      if (identityError) return identityError.code ? identityError : toErrorValue(new Error('identity unavailable'));
      if (!state.config.allowWrites) {
        return errorValue('doco_write_not_confirmed', '写入未获用户确认（allowWrites 未开启）。', '在 dsh 审批中确认写入，或配置 DOCO_DSH_ALLOW_WRITES=true。');
      }
      if (!hasScope(scopes, SCOPE_WRITE)) {
        return errorValue('doco_write_scope_required', '当前 Token 无 documents:write 权限，无法 commit。', '重新 /doco connect 选择读写权限。');
      }

      const finalContent = format === 'markdown'
        ? { format, content: appendSources(content.content.content, sourceDocuments, state.config.webOrigin) }
        : content.content;

      try {
        const response = await state.client.createDocument(
          {
            title: title.value,
            knowledge_base_id: kbId,
            ...(args?.folder_id != null ? { folder_id: args?.folder_id } : {}),
            content: finalContent,
            document_type: 'document',
          },
          { idempotencyKey: `doco-draft-${randomUUID()}` },
        );
        const doc = response.data ?? {};
        const docId = doc.id ?? doc.document_id;
        if (!docId) {
          return errorValue('doco_internal', '创建文档返回了未预期的空结果。', '检查网络后重试，或联系管理员。');
        }
        return {
          kind: 'doco_save_draft',
          mode: 'commit',
          document_id: String(docId),
          title: doc.title ?? title.value,
          document_uri: documentUri(docId),
          web_url: webUrl(state.config.webOrigin, docId),
          version: doc.version ?? response.etag ?? null,
          knowledge_base_id: doc.knowledge_base_id ?? kbId,
          source_documents: sourceDocuments,
          created: true,
        };
      } catch (err) {
        return catchAsError(err);
      }
    },
    render(value) {
      if (value.kind === 'doco_error') {
        return textBlock(`Doco 错误（${value.code}）：${value.message}\n下一步：${value.next_step || ''}`);
      }
      if (value.mode === 'preview') {
        const p = value.planned || {};
        return textBlock(
          `草稿预览（未写入）\n标题：${p.title}\n目标知识库：${p.knowledge_base_id}\n格式：${p.format || 'markdown'}${p.folder_id ? `\n文件夹：${p.folder_id}` : ''}\n来源：${(p.source_documents || []).length} 条\n${value.note}`,
        );
      }
      return textBlock(
        `草稿已创建：${value.title ?? ''}\n${value.document_uri}\n${value.web_url}${value.version ? `\nversion：${value.version}` : ''}`,
      );
    },
  };
}