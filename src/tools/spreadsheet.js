// @ts-check
import { ensureIdentity } from '../context.js';
import { errorValue } from '../errors.js';
import { hasScope, SCOPE_WRITE } from '../policy.js';
import { catchAsError, textBlock } from './shared.js';

const documentParameter = { type: 'string', required: true, description: '独立电子表格文档 ID。' };
const sheetParameter = { type: 'string', required: true, description: '结构端点返回的 sheet ID；旧单页为 sheet_1。' };

function spreadsheetTool({ state, name }, operation) {
  const write = operation === 'update';
  return {
    name,
    description: operation === 'metadata'
      ? '读取独立 spreadsheet 的结构、激活页、尺寸和格式元信息；顶层 version 用于写入，spreadsheet.version 是格式版本。'
      : write
        ? '带 if_match 原子批量写 spreadsheet cells（原始字符串，公式含 =，空字符串清空且保留样式）。需写权限与审批；409 含当前版本提示，不自动重试。仅版本冲突由上层重读合并，最多重试 3 次。'
        : '读取 spreadsheet sheet 的 A1 矩形区域原值；公式返回 = 字符串，空单元格返回 ""。',
    parameters: {
      document_id: documentParameter,
      ...(operation === 'metadata' ? {} : { sheet_id: sheetParameter }),
      ...(operation === 'read' ? { range: { type: 'string', required: true, description: '大写 A1 地址或矩形范围，如 C15:C18。' } } : {}),
      ...(write ? {
        cells: { type: 'json', required: true, description: '非空地址到原始字符串的映射，如 {"C15":"10","C17":"=SUM(C15:C16)"}。' },
        if_match: { type: 'string', required: true, description: '先前读到的顶层 version 或带双引号 ETag；禁止 *。' },
      } : {}),
    },
    async execute(args) {
      if (!args?.document_id || (operation !== 'metadata' && !args.sheet_id)) {
        return errorValue('invalid_request', '需要 document_id 与目标 sheet_id。');
      }
      if (write && (typeof args.if_match !== 'string' || !args.if_match.trim() || args.if_match.trim() === '*')) {
        return errorValue('invalid_request', '写入需要具体 version / ETag。', '先读取 spreadsheet 顶层 version。');
      }
      if (write) {
        const { scopes, error } = await ensureIdentity(state);
        if (error) return error;
        if (!state.config.allowWrites) return errorValue('doco_write_not_confirmed', '写入未开启。', '配置 allowWrites 并通过 dsh 写入审批。');
        if (!hasScope(scopes, SCOPE_WRITE)) return errorValue('doco_write_scope_required', 'Token 缺少 documents:write。');
      }
      const base = `/documents/${encodeURIComponent(args.document_id)}/spreadsheet`;
      const path = operation === 'metadata' ? base : `${base}/sheets/${encodeURIComponent(args.sheet_id)}/cells`;
      try {
        // 复用已发布 DocoClient.request，插件无需等待新版 CLI 发布即可调用专用端点。
        const version = write ? args.if_match.trim() : '';
        const response = await state.client.request(write ? 'PATCH' : 'GET', path, write ? {
          body: { cells: args.cells },
          headers: { 'If-Match': version.startsWith('"') ? version : `"${version}"` },
        } : operation === 'read' ? { query: { range: args.range } } : {});
        return { kind: 'doco_spreadsheet', ...response.data };
      } catch (error) {
        // 保留所有 API 错误语义，尤其不把 type_mismatch / quota 的 409 当成版本冲突。
        if (error?.status) {
          const conflict = error.code === 'document_version_conflict';
          const current = error.details?.current_version;
          return {
            ...errorValue(error.code, error.message, conflict
              ? `重读 spreadsheet 与 cells 后合并重试（最多 3 次）；current_version=${current ?? '请重读获取'}。`
              : '按错误码检查文档类型、sheet、range 或权限；不要盲目重试。'),
            http_status: error.status,
            details: error.details ?? null,
            current_version: current ?? null,
            request_id: error.requestId ?? null,
          };
        }
        return catchAsError(error);
      }
    },
    render(_args, value) { return textBlock(JSON.stringify(value)); },
  };
}

export function createDocoGetSpreadsheet(deps) { return spreadsheetTool(deps, 'metadata'); }
export function createDocoGetCells(deps) { return spreadsheetTool(deps, 'read'); }
export function createDocoUpdateCells(deps) { return spreadsheetTool(deps, 'update'); }
