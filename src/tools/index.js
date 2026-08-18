// @ts-check
/**
 * 工具注册装配（设计文档 §8、§10.2）。
 * 职责：用 buildTool（真实 dsh 的 defineTool，或测试注入的 identity）把各工具工厂
 * 包成 registry-ready 的工具，统一补 output.schema=OPEN_OBJECT 与 render，
 * 并在重名时「跳过并记录」而非覆盖（§5.2：与 Doco MCP 共存时不重复注册）。
 */
import { createDocoStatus } from './status.js';
import { createDocoListKnowledgeBases } from './listKnowledgeBases.js';
import { createDocoSearch } from './search.js';
import { createDocoOutline } from './outline.js';
import { createDocoRead } from './read.js';
import { createDocoSaveDraft } from './saveDraft.js';
import { OPEN_OBJECT } from './shared.js';

const DUPLICATE_RE = /is already registered/i;

/**
 * 注册全部读/写工具。返回已注册与跳过的工具名。
 * @param {{
 *   register(def: unknown): () => void;
 *   get?(name: string): unknown;
 * }} ctxTools dsh 的 ctx.tools（含 .register/.get）
 * @param {{ state: unknown; toolPrefix: string }} deps
 * @param {(def: import('./shared.js').Record<string, unknown>) => unknown} buildTool
 *   defineTool（真实运行时）或测试注入的 identity/o.wrap。
 * @param {{ log?(message: string): void }} [hooks]
 * @returns {{ registered: string[]; skipped: { name: string; reason: string }[]; disposers: (() => void)[] }}
 */
export function registerTools(ctxTools, deps, buildTool, hooks = {}) {
  const { state, toolPrefix } = deps;
  const name = (base) => `${toolPrefix}${base}`;

  const factories = [
    createDocoStatus,
    createDocoListKnowledgeBases,
    createDocoSearch,
    createDocoOutline,
    createDocoRead,
    createDocoSaveDraft,
  ];

  const registered = [];
  const skipped = [];
  const disposers = [];

  for (const factory of factories) {
    const base = factoryBaseName(factory);
    const def = factory({ state, name: name(base) });
    const tool = buildTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: { schema: OPEN_OBJECT, render: def.render },
      execute: def.execute,
    });
    try {
      disposers.push(ctxTools.register(tool));
      registered.push(def.name);
    } catch (error) {
      if (DUPLICATE_RE.test(String(error?.message ?? ''))) {
        skipped.push({ name: def.name, reason: String(error.message) });
        if (hooks.log) hooks.log(`doco-dsh: 跳过重复工具 ${def.name}（已由其他插件注册）`);
      } else {
        throw error;
      }
    }
  }

  return { registered, skipped, disposers };
}

/** 从工厂函数推基名（createDocoSearch → search；createDocoListKnowledgeBases → list_knowledge_bases）。 */
function factoryBaseName(factory) {
  const raw = factory.name.replace(/^createDoco/, '');
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export { createDocoStatus, createDocoListKnowledgeBases, createDocoSearch, createDocoOutline, createDocoRead, createDocoSaveDraft };
export { OPEN_OBJECT };