// @ts-check
/**
 * doco-dsh 插件入口（设计文档 §10）。
 * 保持普通 Cordis 插件形状：export name + inject + apply(ctx, config)。
 * 唯一从 @deepseek-ai/dsh-tools 导入的模块；缺依赖 / 版本不兼容时抛 `doco_dsh_incompatible`。
 * 测试不 import 本文件（见 test/），因此无需安装 dsh 运行时依赖即可单测。
 */
import { DocoPluginError } from './errors.js';
import { resolveConfig } from './config.js';
import { createState } from './context.js';
import { registerTools } from './tools/index.js';
import { applyPolicy } from './policy.js';
import { buildCommands } from './commands.js';
import { promptText, PROMPT_SECTION_NAME } from './prompt.js';
import { PLUGIN_NAME, VERSION } from './version.js';

export const name = 'doco-dsh';
export const inject = ['tools', 'commands', 'systemPrompt'];
export const pluginVersion = VERSION;

// 顶层 await：@deepseek-ai/dsh-tools 由 host dsh 提供（peerDependency）。缺失时不静默降级，
// 而在 apply 阶段抛稳定错误码，符合「无法加载插件时给出明确兼容性错误，不静默降级为无证据回答」。
let defineTool;
let incompatibility = null;
try {
  const dshTools = await import('@deepseek-ai/dsh-tools');
  defineTool = dshTools?.defineTool;
} catch (error) {
  incompatibility = error;
}

/**
 * 装配插件：解析配置 → 唯一 DocoClient → 注册读/写工具、写入门禁、系统提示词、/doco 命令。
 * 所有注册在 ctx.effect 内向 dsh 声明 disposer，卸载时一并清理。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [options] dsh profile / 启动参数（最高优先级配置）
 */
export function apply(ctx, options = {}) {
  if (typeof defineTool !== 'function') {
    const cause = incompatibility?.message ? `（${incompatibility.message}）` : '';
    throw new DocoPluginError(
      'doco_dsh_incompatible',
      `${PLUGIN_NAME} 需要的 @deepseek-ai/dsh-tools 在当前 dsh 中不可用或版本不兼容${cause}。请确认 target dsh 版本 ≥ 0.1.0-rc.7。`,
      { required: '@deepseek-ai/dsh-tools >= 0.1.0-rc.7' },
    );
  }

  const config = resolveConfig(options ?? {});
  const state = createState(config);
  const toolPrefix = config.toolPrefix;
  const log = (m) => { try { ctx.logger?.warn?.(m); } catch { /* 诊断日志失败不阻塞 */ } };

  ctx.effect(function* () {
    // 1. 工具（重复名跳过，不覆盖其他插件/MCP 的同名工具）
    const { disposers, skipped } = registerTools(ctx.tools, { state, toolPrefix }, defineTool, { log });
    for (const skip of skipped) log(`${PLUGIN_NAME}: 未注册 ${skip.name}（已存在同名工具，二选一：原生插件与 Doco MCP 不重复加载）`);
    for (const dispose of disposers) yield dispose;

    // 2. 写入审批与 scope 门禁（guard + pre-execute ask）
    for (const dispose of applyPolicy(ctx, state, toolPrefix)) yield dispose;

    // 3. 系统提示词（仅规则，不注入内容/Token）
    yield ctx.systemPrompt.section({ name: PROMPT_SECTION_NAME, order: 400, text: promptText({ toolPrefix }) });

    // 4. /doco 命令
    for (const def of buildCommands({ state, resolveConfig })) yield ctx.commands.register(def);
  }, `${PLUGIN_NAME} lifecycle`);
}

export { resolveConfig, registerTools, applyPolicy, buildCommands, promptText, createState };