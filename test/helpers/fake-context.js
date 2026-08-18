// @ts-check
/**
 * 单测桩：dsh Context 的最小可测替身 + 无脑 identity BuildTool。
 * 目的：让 tools / policy / commands / registerTools 的装配逻辑可以脱离
 * 真实的 @deepseek-ai/cordis + @deepseek-ai/dsh-tools 运行时被断言。
 *
 * 行为对齐真实 dsh：
 *   - ctx.tools.register(def) 同名抛 `tool "X" is already registered`；
 *   - ctx.tools.guard(guard)、ctx.on('tools/pre-execute', cb) 可注入并记录；
 *   - ctx.effect(generator) 同步推进 generator 并把 yield 的 disposer 收进列表；
 *   - ctx.systemPrompt.section / ctx.commands.register 记录入参。
 */

/** 构造一个最小 dsh Context 替身，所有注册物都会被记录供断言。 */
export function makeFakeContext() {
  const registeredTools = new Map();
  const disposers = [];
  const guards = [];
  const preExecute = [];
  const promptSections = [];
  const commands = [];

  const tools = {
    register(def) {
      if (registeredTools.has(def.name)) {
        throw new Error(`tool "${def.name}" is already registered`);
      }
      registeredTools.set(def.name, def);
      return () => {
        registeredTools.delete(def.name);
      };
    },
    get(name) {
      return registeredTools.get(name);
    },
    guard(fn) {
      guards.push(fn);
      return () => {};
    },
  };

  const ctx = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    tools,
    on(event, handler) {
      if (event === 'tools/pre-execute') preExecute.push(handler);
      return () => {};
    },
    systemPrompt: {
      section(section) {
        promptSections.push(section);
        return () => {};
      },
    },
    commands: {
      register(def) {
        commands.push(def);
        return () => {};
      },
    },
    effect(fn) {
      const it = fn();
      let step = it.next();
      while (!step.done) {
        if (step.value) disposers.push(step.value);
        step = it.next();
      }
      return () => {};
    },
  };

  return {
    ctx,
    registeredTools,
    disposers,
    guards,
    preExecute,
    promptSections,
    commands,
    loggerCalls: [],
  };
}

/**
 * 「无脑」buildTool：把 { name, parameters, output, execute } 原样包一层做标记。
 * 真实运行时的 defineTool 会做 schema 校验；单测不需要那一层，只要 execute/render/name 透传。
 * @param {Record<string, unknown>} def
 */
export function identityBuildTool(def) {
  return { __docoIdentityTool: true, ...def };
}

/**
 * 构造与 createState() 返回值同形的最小 state 假体。
 * 所有 client 方法都是可替换的 stub；默认 me 返回读 scope 用户。
 * @param {object} [overrides]
 * @param {Record<string, (...a: unknown[]) => unknown>} [overrides.client]
 * @param {Record<string, unknown>} [overrides.config]
 */
export function makeFakeState(overrides = {}) {
  const client = {
    me: async () => ({
      data: {
        user: { id: 'u1', name: 'Alice', email: 'alice@example.test' },
        scopes: ['documents:read'],
        token_id: 'tok_1',
      },
    }),
    searchV2: async () => ({ data: { query: 'q', mode: 'topk', results: [], page: {}, projection: { complete: true, freshness: 'current' } } }),
    readDocument: async () => ({ data: {} }),
    getOutline: async () => ({ data: { document_id: 'doc1', sections: [] } }),
    listKnowledgeBases: async () => ({ data: [] }),
    createDocument: async (body) => ({ data: { id: 'doc_new', title: body?.title, knowledge_base_id: body?.knowledge_base_id } }),
    withToken: () => client,
    requestDeviceCode: async () => ({ data: { device_code: 'dc', verification_uri_complete: 'https://x.test/verify', interval: 5, expires_in: 600 } }),
    pollDeviceToken: async () => ({ data: {} }),
    ...(overrides.client ?? {}),
  };

  return {
    config: {
      baseUrl: 'https://api.example.test/api/v1',
      webOrigin: 'https://doco.page',
      token: 'doco_tok_TEST_ONLY_0000000000',
      readMaxTokens: 4000,
      contextBefore: 2,
      contextAfter: 4,
      allowWrites: false,
      toolPrefix: 'doco_',
      defaultKb: null,
      ...(overrides.config ?? {}),
    },
    client,
    user: null,
    scopes: [],
    tokenId: null,
    identityError: null,
    ...(overrides.state ?? {}),
  };
}