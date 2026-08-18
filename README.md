# doco-dsh

Doco 知识库的 **DeepSeek Harness（dsh）原生插件**。用 6 个工具把 Agent 接到你的 Doco 知识库上：块级寻址、按 token 预算精读、乐观并发写入草稿、来源引用，全部复用 [`doco-agent-cli`](https://www.npmjs.com/package/doco-agent-cli) 的 `DocoClient`（HTTP / ETag / Token 逻辑不复制）。

默认**只读**；写入走 dsh 原生审批 + scope 门禁，绝不静默提交。

## 能力

| 工具 | 读/写 | 说明 |
| --- | --- | --- |
| `doco_status` | 读 | 连接自检：当前用户、scope、API 地址、读写能力 |
| `doco_list_knowledge_bases` | 读 | 列出可见知识库（选 `knowledge_base_id`） |
| `doco_search` | 读 | Search v2 全文搜索，带完整性证明（`projection.complete` / `freshness`） |
| `doco_outline` | 读 | 文档结构大纲（稳定 `block_id` + heading path），先规划再精读 |
| `doco_read` | 读 | 按 token 预算局部读取正文（`around` / `cursor` 续读） |
| `doco_save_draft` | 写 | 把 Agent 产出存成**新草稿**（`preview` → 确认 → `commit`） |

回答里的事实命中有来源引用（`document_uri` / `web_url`）；`doco_search` 返回 `complete=false` 或 `freshness=stale` 时，插件会显式标注「结果不完整」，禁止 Agent 据此断言「知识库里没有」。

## 安装

`doco-dsh` 依赖：
- `doco-agent-cli@^0.1.3`（npm 运行时依赖）；
- `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis`（**peer dep**，由宿主 dsh 提供，本插件不捆绑）。

在 dsh 中作为插件安装本包后，`apply` 会：
1. 解析配置（见下）；
2. 注册 6 个工具（命名带 `doco_` 前缀，可配 `DOCO_DSH_TOOL_PREFIX` 覆盖）；
3. 注入系统提示词分段（仅规则，不注入内容/Token）；
4. 注册 `/doco` 命令。

若 `@deepseek-ai/dsh-tools` 缺失或版本不兼容，插件会在加载期抛稳定错误码 `doco_dsh_incompatible`（不静默降级）。

## 授权（设备登录流）

```text
/doco connect                     # 默认 read_only
/doco connect --access read_write # 需要写入时选 read_write
```

命令会打开系统浏览器完成设备授权，Token 写入 `~/.config/doco/config.json`（`0600`），并自动重载插件状态。

```text
/doco status / disconnect / set-kb <kb_id>
```

Token 只走 POST 请求体与浏览器；**绝不进入工具结果、日志、错误栈或提交**。

## 配置

优先级（高 → 低）：dsh 启动参数 > `doco-agent-cli` 的 `loadConfig()`（`~/.config/doco/config.json` + `DOCO_BASE_URL`/`DOCO_TOKEN`）> 插件级环境变量 > 内置默认。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOCO_API_BASE_URL` | `https://api.doco.page/api/v1` | API 地址（仅 http/https） |
| `DOCO_API_TOKEN` | — | 令牌（也可用 `doco-agent-cli` 登录） |
| `DOCO_DEFAULT_KB` | — | 默认知识库 id |
| `DOCO_WEB_ORIGIN` | `https://doco.page` | 引用链接的 Web 源 |
| `DOCO_READ_MAX_TOKENS` | `4000` | `doco_read` 默认预算（64–50000） |
| `DOCO_READ_CONTEXT_BEFORE` / `AFTER` | `2` / `4` | 上下文块默认（0–100） |
| `DOCO_DSH_TOOL_PREFIX` | `doco` | 工具名前缀 |
| `DOCO_DSH_ALLOW_WRITES` | `false` | 写入总开关（仍受 scope + 用户确认双重门禁） |

## 写入安全（三层）

1. **同步 guard**：`DOCO_DSH_ALLOW_WRITES` 未开启时，任何 `commit` 被单调拒绝（`doco_write_not_confirmed`）。
2. **pre-execute 审批**：commit 前校验 `documents:write` scope，随后 `ask` 用户确认（dsh 原生审批）。
3. **execute 防御**：即使被直接顶层调用，`doco_save_draft` 也再校验 scope 并返回稳定错误码。

`doco_save_draft` 只 **创建新草稿**：不删除、不移动、不整篇覆盖；用唯一 `Idempotency-Key`，冲突即返回 `doco_version_conflict`，从不强覆盖。

## 与 Doco MCP 的关系

`doco-agent-cli` 自带一套 29 工具的 MCP server。本插件复用同一 `DocoClient`，并在读/搜索工具上采用**同名前缀**：若二者被同时加载，`registerTools` 检测到重名会**跳过而非覆盖**，避免同一个知识库以两套名字重复注册、重复消耗上下文。**推荐二选一**（原生插件更省一跳 RPC 且能用上 dsh 原生写入审批；MCP 更通用）。详见 [docs/adr-001-native-vs-mcp.md](docs/adr-001-native-vs-mcp.md)。

## 错误契约

工具失败「返回而非抛出」结构化错误值 `{ kind:'doco_error', code, message, next_step }`，让模型能读到 `next_step` 自行纠偏。稳定错误码见 `src/errors.js`（如 `doco_auth_required`、`doco_insufficient_scope`、`doco_rate_limited`、`doco_version_conflict`、`doco_read_cursor_stale`）。

## 开发

```bash
pnpm install
pnpm test          # 68 个测试：单测 + 真实 dsh-tools/cordis 冒烟 + 装配集成
```