---
name: agents-md-optimization
description: AGENTS.md 优化设计 — 为 AI 提供项目架构、核心数据流、扩展点分层和关键路径的完整上下文
---

# AGENTS.md 优化设计

## 背景

当前 AGENTS.md（162 行）主要包含开发规则，缺少项目架构、包职责、核心数据流、扩展点分层和关键路径的说明。AI 在理解项目时常犯以下错误：

1. 不了解 monorepo 各 package 的职责和依赖关系，改错位置或遗漏影响范围
2. 不了解 Agent/AgentHarness/AgentSession 的分层关系，修改时破坏跨层接口
3. 不清楚扩展/skill/plugin/subagent 各属于哪一层，功能放错位置
4. 不了解工具注册、模型解析、会话持久化等关键流程，修改时缺少上下文

## 目标

优化 AGENTS.md，使其：

1. **架构前置** — AI 先建立架构心智模型，再读规则
2. **职责清晰** — 每个包、每层抽象的职责一目了然
3. **数据流可见** — 核心调用链有 ASCII 图展示
4. **扩展点明确** — 新增能力时知道放哪一层
5. **路径可追踪** — 修改关键功能时知道从哪里开始
6. **规则精简** — 保留核心约束，删除冗余

## 设计方案

采用**方案 A：架构前置 + 规则精简**。

### 文档结构

1. 项目目标（微调）
2. 架构概览（新增）
   - 包依赖关系 ASCII 图
   - 各包职责表
3. 核心数据流（新增）
   - prompt 调用链 ASCII 图
   - 三层 Agent 抽象表
4. 扩展点与分层（新增）
   - 能力归属表
   - 关键约束
5. 关键路径（新增）
   - 功能入口与调用链表
6. 交流风格（精简）
7. 代码质量（精简合并）
8. 开发规范（精简合并）
   - 检查与测试
   - 依赖安全
   - Git
   - 构建与测试
   - Changelog
9. 用户覆盖（保留）

### 预期长度

约 300-350 行（当前 162 行，新增约 150-200 行架构信息，规则精简后减少约 50 行）。

## 详细设计

### 1. 项目目标

```markdown
## 项目目标

将 Pi 作为 agent 平台底座，而非原版 CLI。扩展优先级：

1. **内置扩展/插件** — `packages/plugins`，随二进制分发
2. **Skills/Prompt Templates** — `.pi/skills/`、`.pi/prompts/`，项目级或用户级
3. **MCP Server** — 通过内置 MCP 插件桥接，默认 proxy 模式控制上下文占用
4. **配置层** — settings.json、keybindings、themes

优先使用成熟生态包；只在不满足二进制内置、权限、安全或体验要求时才本地集成或 vendor。
二进制发行应自带关键能力，避免首次运行依赖网络安装。
新增能力时必须明确它属于哪一层。
```

### 2. 架构概览

```markdown
## 架构概览

### 包依赖关系

```
                    ┌─────────────┐
                    │ coding-agent │  CLI/TUI 应用，入口包
                    └──────┬──────┘
                           │ 依赖
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  agent   │ │   tui    │ │ plugins  │
        │ (核心框架) │ │ (终端UI) │ │ (内置插件) │
        └────┬─────┘ └──────────┘ └────┬─────┘
             │ 依赖                     │ 依赖
             ▼                          ▼
        ┌──────────┐              ┌──────────┐
        │    ai    │◄─────────────┤    ai    │
        │(统一LLM) │              └──────────┘
        └──────────┘
```

### 各包职责

| 包 | npm 名 | 职责 | 关键导出 |
|---|---|---|---|
| `agent` | `pi-agent-core` | Agent 循环、会话树、技能/模板、压缩、执行环境 | `Agent`, `AgentHarness`, `Session`, `AgentLoop` |
| `ai` | `pi-ai` | 统一 LLM API、多 provider 适配、模型注册表、OAuth | `stream()`, `complete()`, `getModel()`, providers |
| `tui` | `pi-tui` | 差分渲染引擎、终端组件库、键盘/快捷键系统 | `TUI`, `Terminal`, components |
| `plugins` | `pi-plugins` | 内置插件集合（目前仅 MCP），随二进制 bundled | `BUILTIN_PLUGINS`, `mcpAdapter` |
| `coding-agent` | `pi-coding-agent` | CLI/TUI/RPC 三种运行模式、内置工具、扩展系统、SDK | `createAgentSession()`, tools, `InteractiveMode` |
```

### 3. 核心数据流

```markdown
### 核心数据流

一次 prompt 的完整调用链：

```
用户输入
  │
  ▼
InteractiveMode / PrintMode / RpcMode
  │
  ▼
AgentSession.prompt()                    ← core/agent-session.ts
  │  创建 TurnState，注入 nextTurn 队列
  ▼
AgentHarness.prompt()                    ← agent/harness/agent-harness.ts
  │  组装 system prompt + skills + 上下文文件
  │  创建 streamFn（处理 API key、headers、hooks）
  ▼
Agent.prompt()                           ← agent/agent.ts
  │  管理 transcript、steering/follow-up 队列
  ▼
runAgentLoop()                           ← agent/agent-loop.ts
  │  循环：convertToLlm → streamFn → 解析 tool calls → 执行 → 检查消息队列
  ▼
stream() / streamSimple()                ← ai/stream.ts
  │  查找 provider → 调用 LLM API → 返回事件流
  ▼
Provider (anthropic/openai/google/...)   ← ai/providers/*.ts
  │  发送 HTTP 请求，解析 SSE 响应
  ▼
AssistantMessageEventStream              ← ai/utils/event-stream.ts
  │  text_start/delta/end, thinking_*, toolcall_*, done, error
  ▼
AgentLoop 处理 tool calls
  │  beforeToolCall → 执行 → afterToolCall
  ▼
Session.appendMessage()                  ← agent/harness/session/session.ts
  │  持久化到 JSONL 文件
  ▼
AgentSession 自动持久化 + 事件通知
```

### 三层 Agent 抽象

| 层 | 类 | 文件 | 职责 |
|---|---|---|---|
| 低层 | `agentLoop` / `runAgentLoop` | `agent/agent-loop.ts` | 纯算法：LLM 调用循环、tool call 执行、事件发射 |
| 中层 | `Agent` | `agent/agent.ts` | 有状态封装：transcript 管理、steering/follow-up 队列、abort |
| 高层 | `AgentHarness` | `agent/harness/agent-harness.ts` | 生产级集成：会话持久化、技能/模板、压缩、执行环境、hooks |
| 应用层 | `AgentSession` | `coding-agent/core/agent-session.ts` | 应用特化：内置工具、扩展事件、模型切换、自动压缩 |
```

### 4. 扩展点与分层

```markdown
### 扩展点与能力归属

新增能力时，按以下表格确定归属层：

| 能力类型 | 归属位置 | 配置/注册方式 | 示例 |
|---|---|---|---|
| 核心运行时能力 | `packages/agent/src/` | 修改源码，需上游同步考虑 | 新的 AgentLoop 策略、新的 Session 条目类型 |
| 内置扩展/插件 | `packages/plugins/src/` | `BUILTIN_PLUGINS` registry + manifest | MCP 插件、未来内置的 web-search 插件 |
| 项目级 skill | `.pi/skills/*.md` | SKILL.md frontmatter | add-llm-provider.md |
| 项目级 prompt | `.pi/prompts/*.md` | YAML frontmatter | pr.md, is.md |
| 项目级扩展 | `.pi/extensions/*.ts` | ExtensionAPI 注册 | tps.ts, redraws.ts |
| 内置工具 | `coding-agent/core/tools/` | `createXxxTool()` 工厂 | bash, read, edit, write, find, grep, ls |
| MCP 工具 | 通过 MCP 插件桥接 | `.pi/settings.json` 的 mcpServers 配置 | 外部 MCP server |
| Claude 兼容插件 | npm 包安装 | `plugins` / `pluginMarketplaces` settings | 社区插件 |
| 用户配置 | `~/.pi/agent/settings.json` | SettingsManager 读写 | API key、默认模型 |
| 项目配置 | `.pi/settings.json` | SettingsManager 读写 | 项目级 mcpServers、model overrides |
| 主题 | `.pi/themes/*.json` | Theme 类加载 | dark.json, light.json |
| 快捷键 | `.pi/keybindings.json` | KeybindingsManager | 自定义键绑定 |

**关键约束**：
- 内置插件统一在 `packages/plugins`，不要散落到 `coding-agent/src/core/builtin`
- `packages/plugins` 不作为独立 npm 包发布，通过 `bundledDependencies` 接入 `coding-agent`
- MCP 能力默认 proxy 模式（控制上下文），只有少量高频工具适合 direct tools
- Claude 兼容插件使用独立 `plugins` settings，不污染 Pi 原生 `packages` 配置
```

### 5. 关键路径

```markdown
### 关键路径入口

修改以下功能时，从这些入口开始追踪：

| 功能 | 主入口 | 关键调用链 |
|---|---|---|
| **工具注册** | `coding-agent/core/sdk.ts:createAgentSession()` | → `createXxxTool()` → `AgentTool` 接口 → `AgentHarness` 注册 |
| **模型解析** | `coding-agent/core/model-resolver.ts:findInitialModel()` | → `ModelRegistry.getModel()` → `ai/models.ts` → provider 匹配 |
| **会话持久化** | `agent/harness/session/jsonl-storage.ts` | → `Session.appendMessage()` → `JsonlSessionStorage.saveEntry()` |
| **扩展加载** | `coding-agent/core/extensions/loader.ts:discoverAndLoadExtensions()` | → `ExtensionRunner` → 事件分发 → 扩展 handler |
| **技能加载** | `agent/harness/skills.ts:loadSkills()` | → 目录扫描 → SKILL.md 解析 → `formatSkillsForSystemPrompt()` |
| **压缩** | `coding-agent/core/compaction/compaction.ts:compact()` | → `findCutPoint()` → `generateSummary()` → 会话条目重写 |
| **子 agent** | `coding-agent/core/subagents/runner.ts:runSubagents()` | → `SubagentDefinition` → 独立 AgentSession |
| **MCP 连接** | `plugins/src/mcp/adapter/init.ts` | → `ServerManager` → `McpClient` → tool/resource 注册 |
| **TUI 渲染** | `tui/src/tui.ts:TUI.render()` | → 差分计算 → `Terminal.write()` |
| **交互模式** | `coding-agent/modes/interactive/interactive-mode.ts` | → 键盘事件循环 → 消息渲染 → 斜杠命令处理 |
```

### 6. 交流风格

```markdown
## 交流风格

- 中文回复，短、直接、技术化
- 先回答问题，再执行命令
- 不用表情符号、夸张语气或客套填充
- 反馈分析时先明确"同意"或"不同意"，再说明改动
- 不默认按上游贡献流程处理；除非用户明确要求，不创建上游 issue/PR/release
```

### 7. 代码质量

```markdown
## 代码质量

- 大范围修改前必须完整阅读相关文件，不只依赖搜索片段
- 禁止 `any`，除非无可行类型表达；必须局部化并说明原因
- 禁止 inline import（`await import()`、`import("pkg").Type`）；使用顶层 import
- 禁止 erasable syntax 违规（参数属性、`enum`、`namespace`/`module`、`import =`、`export =`）
- 不通过删除或降级功能修复类型错误；依赖过旧时优先升级
- 单一调用点的单行 helper 直接内联
- 外部 API 类型以 `node_modules` 或官方文档为准，不猜测
- 不硬编码快捷键；默认快捷键放入 keybindings 配置
- 不手改 `packages/ai/src/models.generated.ts`；更新模型改生成脚本
- 删除看似有意存在的功能前先询问
- 不为兼容旧行为保留复杂分支，除非用户要求
```

### 8. 开发规范

```markdown
## 开发规范

### 检查与测试

- 代码改动后运行 `npm run check`（完整输出，不 tail），修复所有 errors/warnings/infos
- 文档或纯说明文件改动通常不需要跑 check
- 不主动运行 `npm test` 或完整 vitest suite（可能触发 e2e 和真实 provider）
- 非 e2e 测试用 `./test.sh`；单文件从对应 package 运行：
  `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- `packages/coding-agent/test/suite/` 用 `harness.ts` + faux provider，不调真实 provider
- 修改测试文件后必须运行对应测试并迭代到通过
- 临时脚本写到 `/tmp`，运行后删除

### 依赖安全

- npm 依赖和 lockfile 变更视为代码变更，需审查；直接外部依赖固定精确版本
- 安装/更新：`npm install --ignore-scripts`
- 干净安装：`npm ci --ignore-scripts`
- 仅刷新 lockfile：`npm install --package-lock-only --ignore-scripts`
- 不运行 lifecycle scripts，除非用户明确要求
- 新依赖带 lifecycle scripts 时需显式审查并更新 allowlist
- `coding-agent/npm-shrinkwrap.json` 更新：`node scripts/generate-coding-agent-shrinkwrap.mjs`
- shrinkwrap 生成必须保留 bundled internal workspace 语义

### Git

- 多 agent 会话可能并行修改不同文件
- 只提交当前会话修改的文件；用显式路径 stage（`git add path1 path2`）
- 禁止 `git add -A`、`git add .`、`git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git commit --no-verify`
- 提交前 `git status` 确认只 stage 自己的文件
- 只解决自己修改过的文件里的冲突；冲突在他人文件时停止并询问
- 不 force push
- 除非用户要求，不 commit

### 构建与测试

- Node dist：`npm run build`
- Bun 单文件二进制：从 `packages/coding-agent` 运行 `npm run build:binary`
- TUI 测试用受控 tmux 会话

### Changelog

- 只在用户明确要求时修改 `packages/*/CHANGELOG.md`
- 新条目放入 `## [Unreleased]`，不修改已发布版本段落
```

### 9. 用户覆盖

```markdown
## 用户覆盖

用户明确要求与本文件冲突时，先说明冲突点并请求确认。用户确认后按用户要求执行。
```

## 实现步骤

1. 备份当前 AGENTS.md
2. 按上述设计重写 AGENTS.md
3. 运行 `npm run check` 验证无问题
4. 提交变更

## 验收标准

- [ ] AGENTS.md 包含架构概览、核心数据流、扩展点分层、关键路径
- [ ] 规则部分精简合并，无冗余
- [ ] 总长度约 300-350 行
- [ ] `npm run check` 通过
