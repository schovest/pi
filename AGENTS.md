# 自定义 Agents 开发规则

本仓库基于 Pi 开发自己的 agents、工具链和发行版。默认目标不是维护上游 `pi-mono`，而是在保留 Pi 核心能力的基础上，迭代适合本地工作流的 agent 运行时、内置扩展、MCP 能力、技能和二进制分发。

## 交流风格

- 使用中文回复。
- 回答要短、直接、技术化。
- 用户问问题时先回答问题，再执行实现命令。
- 不使用表情符号、夸张语气或客套填充。
- 反馈分析时先明确说“同意”或“不同意”，再说明改动。
- 不要默认按上游贡献流程处理问题；除非用户明确要求，不创建上游 issue、PR 或 release。

## 项目目标

- 将 Pi 作为 agent 平台底座，而不是只作为原版 CLI 使用。
- 优先通过内置扩展、Pi package、skills、prompt templates、MCP server 和配置层扩展能力。
- 能使用成熟插件或现有生态包时，优先使用已有实现；只有当现成方案不满足二进制内置、权限、安全或体验要求时，才进行本地集成或 vendor。
- 二进制发行应尽量自带关键能力，避免首次运行依赖网络安装插件。
- 新增 agent 能力时，明确它属于哪一层：核心运行时、内置扩展、项目配置、用户配置、skill、prompt template 或 MCP server。

## 代码质量

- 大范围修改前必须完整阅读相关文件，不要只依赖搜索片段。
- 不使用 `any`，除非没有可行的类型表达方式；必须局部化并说明原因。
- 单一调用点的单行 helper 直接内联。
- 外部 API 类型以 `node_modules` 或官方文档为准，不猜测。
- 不使用 inline import：禁止 `await import()`、`import("pkg").Type`、动态 type import。使用顶层 import。
- 不通过删除或降级功能来修复类型错误；依赖过旧时优先升级依赖。
- 根配置检查的 TypeScript 代码必须使用 erasable syntax：禁止参数属性、`enum`、`namespace`/`module`、`import =`、`export =` 等需要 JS emit 的语法。
- 删除看起来有意存在的功能或代码前，先询问用户。
- 不为了兼容旧行为而额外保留复杂分支，除非用户要求。
- 不硬编码快捷键判断；默认快捷键应放入对应默认 keybindings 配置。
- 不直接手改 `packages/ai/src/models.generated.ts`；需要更新模型时改生成脚本或运行既有生成流程。

## Agents 与扩展开发

- 新 agent 能力优先做成可测试、可禁用的模块。
- 内置扩展应有清晰开关，例如 CLI flag 或 settings 配置。
- 内置插件统一放在 `packages/plugins`，通过插件 registry 暴露 manifest/factory；不要再把插件源码散落到 `packages/coding-agent/src/core/builtin`。
- `packages/plugins` 是本发行版的内置插件集合，不作为独立 npm 包发布；`coding-agent` 需要使用本地 bundled dependency 或二进制打包方式携带它。
- 扩展注册 tool、command、shortcut、provider 时，要考虑名称冲突、来源信息和 reload 行为。
- MCP 能力默认通过 adapter/proxy 控制上下文占用；只有少量高频工具适合 direct tools。
- 涉及第三方源码 vendor 时，保留许可证和来源信息，并尽量减少本地改动面。
- 打包到二进制的功能必须避免运行时依赖未安装的 npm package。
- 新增或调整内置插件时，同时更新 `packages/plugins/README.md`、插件 registry、相关 build/binary copy 流程，以及必要的 resource-loader 测试。
- Claude-compatible plugins 使用独立 `plugins` / `pluginMarketplaces` settings，不要复用或污染 Pi 原生 `packages`；安装、移除或更新插件时同步验证 skills/prompts 发现和 Pi-owned MCP config 写入/清理。
- 修改 Claude-compatible plugins 的 CLI 或交互式管理能力时，同步更新 `packages/coding-agent/docs/plugins.md`，并覆盖 `PluginManager`、CLI handler 和 interactive command/component 的单测。

## 命令

- 代码改动后运行：
  ```bash
  npm run check
  ```
  需要完整输出，不要 `tail`。修复所有 errors、warnings 和 infos。
- 文档或纯说明文件改动通常不需要跑 `npm run check`，除非改动影响脚本、包配置或生成文件。
- 不要主动运行 `npm test` 或完整 vitest suite；它可能触发 e2e 和真实 provider。
- 非 e2e 测试用：
  ```bash
  ./test.sh
  ```
- 单个测试文件从对应 package 目录运行：
  ```bash
  node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
  ```
- `packages/coding-agent/test/suite/` 下测试使用 `test/suite/harness.ts` 和 faux provider，不调用真实 provider、API key 或付费 token。
- 修改测试文件后，必须运行对应测试并迭代到通过。
- 临时脚本写到 `/tmp`，运行后删除；不要把多行脚本塞进 bash 命令。
- 除非用户要求，不提交 commit。

## 依赖与安装安全

- npm 依赖和 lockfile 变更视为代码变更，需要审查。
- 直接外部依赖必须固定精确版本。
- 本地安装/更新使用：
  ```bash
  npm install --ignore-scripts
  ```
- 干净安装使用：
  ```bash
  npm ci --ignore-scripts
  ```
- 不运行 lifecycle scripts，除非用户明确要求。
- 仅刷新 lockfile 时使用：
  ```bash
  npm install --package-lock-only --ignore-scripts
  ```
- 如果 `packages/coding-agent/npm-shrinkwrap.json` 需要更新，运行：
  ```bash
  node scripts/generate-coding-agent-shrinkwrap.mjs
  ```
  并用 `--check` 或 `npm run check` 验证。
- 如果内置插件通过 `bundledDependencies` 接入 `coding-agent`，`scripts/generate-coding-agent-shrinkwrap.mjs` 必须保留 bundled internal workspace 语义，不能把这类插件改成需要 registry tarball 的独立包。
- 新依赖带 lifecycle scripts 时，需要显式审查并更新 allowlist，不能静默放行。

## Git

本目录可能有多个 agent 会话并行修改不同文件。任何会影响未暂存、已暂存或未跟踪文件的 Git 操作都可能破坏别人的工作。

提交规则：

- 只提交当前会话自己修改的文件。
- 使用显式路径 stage：
  ```bash
  git add path1 path2
  ```
- 禁止 `git add -A`、`git add .`。
- 提交前运行 `git status`，确认只 stage 自己的文件。
- 除非用户要求，不 commit。

禁止命令：

- `git reset --hard`
- `git checkout .`
- `git clean -fd`
- `git stash`
- `git add -A`
- `git add .`
- `git commit --no-verify`

冲突处理：

- 只解决自己修改过的文件里的冲突。
- 冲突发生在自己没改过的文件时，停止并询问用户。
- 不 force push。

## 二进制与交互模式测试

测试 TUI 时使用受控 tmux 会话：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape
tmux kill-session -t pi-test
```

需要构建 Node dist 时运行：

```bash
npm run build
```

需要构建 Bun 单文件二进制时，从 `packages/coding-agent` 使用已有脚本：

```bash
npm run build:binary
```

## Changelog

- 只有用户明确要求准备发布、提交 changelog 或整理 release notes 时，才修改 `packages/*/CHANGELOG.md`。
- 新条目放入 `## [Unreleased]`。
- 不修改已发布版本段落。

## 用户覆盖

如果用户明确要求与本文件冲突，先说明冲突点并请求确认。用户确认后按用户要求执行。
