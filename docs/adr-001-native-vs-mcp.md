# ADR-001：Doco 以原生 dsh 插件交付，而非仅走 MCP，且与 MCP 同名前缀防重复加载

- 状态：已采纳
- 日期：2026-08-18
- 涉及：本仓库 `doco-dsh`（原生插件）、npm 包 `doco-agent-cli`

## 背景

`doco-agent-cli` 已带一套 29 工具的 MCP server（`doco_search`、`doco_read`、`doco_outline`、`doco_list_knowledge_bases`、`doco_create_document` …）。DeepSeek Harness（dsh）既能加载 MCP server，也支持 Cordis **原生插件**（`export name / inject / apply`）。二者都能把 Doco 知识库接到 Agent 上，因此要回答两个问题：

1. 是否值得做一个原生插件（而不仅是「让用户自己配 MCP」）？
2. 若二者同时被加载，如何避免同一个知识库以两套名字重复注册、重复消耗上下文？

## 决策

**做原生插件 `doco-dsh`**，理由：

- **少一跳 RPC**：原生工具在同进程内直接执行 `DocoClient`，无 stdio/JSON-RPC 往返，降低工具调用延迟与序列化成本。
- **用上 dsh 原生能力**：MCP 协议无法表达「工具级写入审批」，而 dsh 原生插件能用 `ctx.tools.guard`（同步单调拒绝）与 `ctx.on('tools/pre-execute')`（异步 scope 校验 + `ask` 用户确认）把写入拦在审批之后，与模型回合协同。
- **不复制 HTTP / ETag / Token 逻辑**：原生插件与 MCP 都依赖同一个 npm 发布版 `doco-agent-cli`（`^0.1.3`），`DocoClient` 的请求、超时、`If-Match`、`Idempotency-Key` 只维护一份。

**同名前缀防重复加载**：原生插件在读/搜索工具上沿用 MCP 的 `doco_` 前缀与同名（`doco_search`、`doco_read`、`doco_outline`、`doco_list_knowledge_bases`）。这样：

- 若只有原生插件加载：正常注册 6 个工具。
- 若只有 MCP 加载：正常注册 29 个工具。
- 若二者**同时**加载：`registerTools` 检测到 `doco_search` 等已被注册，会**跳过（记录日志）而非覆盖**，绝不把同名工具覆写成自己的行为；Agent 依然只看到一套读/搜索工具，不会因重名而把知识库读两遍。原生插件独有的 `doco_status` 与 `doco_save_draft` 仍会注册。

**推荐二选一**（README / 系统提示词均写明）：需要 dsh 原生写入审批与低延迟时启用插件；需要跨运行时通用性时用 MCP。二者共存被设计为「安全降级为跳过」，而非「出错」。

## 取舍

- **原生插件专用性**：dsh 专属，不能直接用在非 Cordis 运行时；这就是保留 MCP 作为通用路径的原因。
- **跳过语义**：同名工具跳过时，剩余两个原生独有工具仍注册，可能出现「一半 MCP、一半原生」的混合视图——这在写入语义上可控（`doco_save_draft` 走审批，MCP 的写工具走 MCP 自身权限），并以日志与提示词说明「二选一」。
- **schema DSL 是 rc 契约**：`@deepseek-ai/dsh-tools@0.1.0-rc.*` 的参数 DSL 不保证支持 `min/max`，故所有界值（`q` 1–200、`limit` 1–100、`max_tokens` 64–50000、`context` 0–100、`title` ≤200、正文 ≤1MiB）在 `execute` 内手工校验并映射为稳定错误码，避免依赖 rc 未落定的 DSL 能力。

## 后果

- 正向：一套 `DocoClient` 同时服务 MCP 与原生插件；写入门禁集中在插件侧且可单测（`policy.js` 的纯函数）。
- 反向：若不遵守「二选一」，会出现「跳过型」混合视图，需在文档与提示词中持续强调。
- 后续：dsh 升级到正式版若放开 `min/max` DSL 与更成熟的多插件注册规则，可把 execute 内的界值校验迁回 schema，减少运行时手写校验。