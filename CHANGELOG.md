# Changelog

All notable changes to the doco-dsh plugin are documented here.
版本号遵循 [SemVer](https://semver.org/)。

## [0.1.2] - 2026-08-19

### Added
- `dsh.bundle.patch` 声明 + `cordis.patch.yml`，让 `dsh plugin --profile <name> add doco-dsh` 装完即自动挂入 profile 层栈，无需手写 composition。

## [0.1.1] - 2026-08-19

### Changed
- README「安装」补充 dsh Composition 挂载步骤与可复制的安装片段（`pnpm add doco-dsh` + 组合 YAML 里 `name: 'doco-dsh'`），并注明配置走环境变量而非 YAML `config:` 块。

## [0.1.0] - 2026-08-18

### Added
- 首个原生 Doco 知识库插件（DeepSeek Harness / dsh），复用 `doco-agent-cli` 的 `DocoClient`。
- 6 个工具：`doco_status`、`doco_list_knowledge_bases`、`doco_search`、`doco_outline`、`doco_read`、`doco_save_draft`。
- `/doco` 命令族：`status` / `connect`（设备授权流）/ `disconnect` / `set-kb`。
- 系统提示词分段（仅规则，不注入内容/Token）。
- 三层写入安全：同步 guard（`DOCO_DSH_ALLOW_WRITES`）+ pre-execute scope 校验与用户确认 + execute 防御性校验。
- 统一错误契约 `{ kind:'doco_error', code, message, next_step }` 及后端错误码映射。
- 引用契约：`doco://doc/...` URI 与 `https://doco.page/doc/...` Web URL 的单一事实来源。
- 测试套件：68 个测试，含与真实 `@deepseek-ai/dsh-tools` 的 schema 冒烟（`defineTool` / `valueSchemaSpecToJsonSchema` / `validateArgs`）。
- 与 Doco MCP 的同名共存策略（重名跳过、不覆盖），详见 `docs/adr-001-native-vs-mcp.md`。