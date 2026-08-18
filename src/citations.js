// @ts-check
/**
 * 引用契约（设计文档 §9）。单一事实来源：Doco URI、Web URL 与 citation 对象都在这里构造，
 * 避免各工具各自拼字符串导致「同一文档两种链接」。
 *
 * URI 形态（与 Doco MCP resources 对齐）：
 *   - 文档：   doco://doc/{document_id}[#block={block_id}]
 *   - 知识库： doco://kb/{id}
 */

/**
 * @param {string|number} documentId
 * @param {string|null|undefined} [blockId]
 * @returns {string}
 */
export function documentUri(documentId, blockId) {
  return blockId ? `doco://doc/${documentId}#block=${blockId}` : `doco://doc/${documentId}`;
}

/**
 * @param {string|number} kbId
 * @returns {string}
 */
export function knowledgeBaseUri(kbId) {
  return `doco://kb/${kbId}`;
}

/**
 * @param {string} webOrigin 归一化后的 Web 源（不含尾斜杠），见 config.validateOrigin
 * @param {string|number} documentId
 * @param {string|null|undefined} [blockId]
 * @returns {string}
 */
export function webUrl(webOrigin, documentId, blockId) {
  return blockId ? `${webOrigin}/doc/${documentId}#block=${blockId}` : `${webOrigin}/doc/${documentId}`;
}

/**
 * 构造 §9.1 的 `source` 引用对象。字段名稳定，未知值为 null（不省略），
 * 便于模型稳定引用而不必猜测字段是否存在。
 * @param {{
 *   document_id: string|number;
 *   block_id?: string|null;
 *   title?: string|null;
 *   heading_path?: string[]|null;
 *   source_version?: string|null;
 *   freshness?: string|null;
 *   webOrigin: string;
 * }} input
 * @returns {{
 *   document_id: string;
 *   block_id: string|null;
 *   document_uri: string;
 *   web_url: string;
 *   title: string|null;
 *   heading_path: string[];
 *   source_version: string|null;
 *   freshness: string|null;
 * }}
 */
export function citation(input) {
  const documentId = String(input.document_id);
  const blockId = input.block_id ?? null;
  return {
    document_id: documentId,
    block_id: blockId,
    document_uri: documentUri(documentId, blockId),
    web_url: webUrl(input.webOrigin, documentId, blockId),
    title: input.title ?? null,
    heading_path: input.heading_path ?? [],
    source_version: input.source_version ?? null,
    freshness: input.freshness ?? null,
  };
}

/**
 * 从一条 SearchV2Result 构造 citation（命中字段直接可用，无需二次请求）。
 * @param {Record<string, unknown>} hit SearchV2Result（已是 API data 元素）
 * @param {string} webOrigin
 */
export function citationFromHit(hit, webOrigin) {
  return citation({
    document_id: hit.document_id,
    block_id: typeof hit.block_id === 'string' ? hit.block_id : null,
    title: typeof hit.title === 'string' ? hit.title : null,
    heading_path: Array.isArray(hit.heading_path) ? hit.heading_path : [],
    source_version: typeof hit.source_version === 'string' ? hit.source_version : null,
    freshness: typeof hit.freshness === 'string' ? hit.freshness : null,
    webOrigin,
  });
}