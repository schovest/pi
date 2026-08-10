# 架构参考

> 本文档为 Pi 项目的架构参考，包含包依赖、核心数据流、Agent 抽象层、扩展点归属和关键路径入口。
> AGENTS.md 中保留摘要索引，详细内容以此文件为准。更新此文件时须同步更新 AGENTS.md 索引。

## 包依赖关系

```
                    ┌─────────────┐
                    │ coding-agent │  CLI/TUI 应用，入口包
                    └──────┬──────┘
                           │ 依赖
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  agent   │ │   tui    │ │   ai     │
        │ (外部npm) │ │ (工作区)  │ │ (外部npm) │
        └──────────┘ └──────────┘ └──────────┘
              ▲            ▲            │
              │            │            │ (tui 不依赖 ai/agent)
              │            │            │
              └────────────┴────────────┘
                   (npm 包依赖)
```

### 各包职责

| 包 | npm 名 | 来源 | 职责 | 关键导出 |
| --- | --- | --- | --- | --- |
| `agent` | `pi-agent-core` | 外部 npm (`@earendil-works/pi-agent-core`) | Agent 循环、会话树、技能/模板、压缩、执行环境 | `Agent`, `AgentHarness`, `Session`, `AgentLoop` |
| `ai` | `pi-ai` | 外部 npm (`@earendil-works/pi-ai`) | 统一 LLM API、多 provider 适配、模型注册表、OAuth | `stream()`, `complete()`, `getModel()`, providers |
| `tui` | `@schovest/pi-tui` | 工作区包 (`packages/tui`) | 差分渲染引擎、终端组件库、键盘/快捷键系统 | `TUI`, `Terminal`, components |
| `coding-agent` | `@schovest/pi-coding-agent` | 工作区包 (`packages/coding-agent`) | CLI/TUI/RPC 三种运行模式、内置工具、扩展系统、SDK | `createAgentSession()`, tools, `InteractiveMode` |

## 核心数据流

一次 prompt 的完整调用链：

```
用户输入
  │
  ▼
InteractiveMode / runPrintMode() / runRpcMode()
  │  session.prompt(text, options)
  ▼
AgentSession.prompt()                    ← coding-agent/core/agent-session.ts
  │  处理扩展命令（/command 直接执行）
  │  发 input 事件让扩展拦截/变换
  │  展开 skill 命令（/skill:name）和 prompt templates
  │  streaming 时根据 streamingBehavior 入队 steer/followUp
  │  验证 model + API key
  │  构建 messages（含扩展自定义消息 + nextTurn 队列）
  ▼
AgentSession._runAgentPrompt(messages)
  │  调用 agent.prompt(messages)
  │  完成后循环检查 _handlePostAgentRun()（retry + compaction + 队列继续）
  ▼
Agent.prompt()                           ← agent/agent.ts
  │  normalizePromptInput() 标准化输入
  │  runWithLifecycle() 管理 activeRun + abortController
  │  runPromptMessages() → runAgentLoop()
  ▼
runAgentLoop()                           ← agent/agent-loop.ts
  │  emit agent_start, turn_start
  │  处理 pendingMessages (steering)
  ▼
streamAssistantResponse()
  │  transformContext (可选上下文变换)
  │  convertToLlm (AgentMessage[] → Message[])
  │  streamFn(model, llmContext, options)   ← 默认 streamSimple
  ▼
streamSimple()                           ← ai/stream.ts
  │  resolveApiProvider(model.api) → 查找注册的 provider
  ▼
Provider.streamSimple()                  ← ai/providers/*.ts (懒加载)
  │  发送 HTTP 请求，解析 SSE 响应
  ▼
AssistantMessageEventStream              ← ai/utils/event-stream.ts
  │  start, text_start/delta/end, thinking_*, toolcall_*, done, error 事件
  ▼
[回到 runLoop]
  ├─ tool calls: prepareToolCall → executePreparedToolCall → finalizeExecutedToolCall
  │  (parallel/sequential 两种执行模式，含 guard: malformed/repeated_tool_call)
  ├─ turn_end → prepareNextTurn → shouldStopAfterTurn
  ├─ 检查 steering → followUp 队列
  └─ agent_end

[持久化路径]
  AgentSession._handleAgentEvent()
    → sessionManager.appendMessage()
      → Session.appendMessage()          ← agent/harness/session/session.ts
        → JsonlSessionStorage.appendEntry() → 文件系统
```

## Agent 抽象层

| 层 | 类 | 文件 | 职责 |
| --- | --- | --- | --- |
| 低层 | `agentLoop` / `runAgentLoop` | `agent/agent-loop.ts` | 纯算法：LLM 调用循环、tool call 执行、事件发射、guard 系统 |
| 中层 | `Agent` | `agent/agent.ts` | 有状态封装：transcript 管理、steering/follow-up 队列、abort、lifecycle |
| 应用层 | `AgentSession` | `coding-agent/core/agent-session.ts` | 应用特化：扩展命令、skill/模板展开、内置工具、模型切换、自动压缩、持久化 |
| 独立抽象 | `AgentHarness` | `agent/harness/agent-harness.ts` | 生产级集成：会话持久化、技能/模板、压缩、执行环境、hooks。**当前主调用链不经过此类**，`AgentSession` 直接调用 `Agent.prompt()` |

## 扩展点与能力归属

新增能力时，按以下表格确定归属层：

| 能力类型 | 归属位置 | 配置/注册方式 | 示例 |
| --- | --- | --- | --- |
| 核心运行时能力 | `@earendil-works/pi-agent-core`（外部 npm） | 修改需上游同步考虑；工作区内无 agent 源码 | 新的 AgentLoop 策略、新的 Session 条目类型 |
| 可安装扩展 | `pi install <source>` 或 `.pi/extensions/*.ts` | `dist-assets/install.sh` 交互选择 + settings.json | todo、ask-user-question、tps 等 |
| 项目级 skill | `.pi/skills/*.md` | SKILL.md frontmatter | add-llm-provider.md |
| 项目级 prompt | `.pi/prompts/*.md` | YAML frontmatter | pr.md, is.md |
| 项目级扩展 | `.pi/extensions/*.ts` | ExtensionAPI 注册 | tps.ts, redraws.ts |
| 内置工具 | `coding-agent/core/tools/` | `createXxxTool()` 工厂 | bash, read, edit, write, find, grep, ls |
| 工具匹配 | `coding-agent/core/tool-matcher.ts` | glob 模式（minimatch），支持 `includedTools`/`excludedTools` | subagent 工具过滤、`--tools`/`--exclude-tools` CLI |
| Primary Agent | `~/.pi/agent/primary-agents/*.md` 或 `.pi/primary-agents/*.md` | `defaultPrimaryAgent` settings | code, plan |
| Subagent | `~/.pi/agent/subagents/*.md` 或 `.pi/subagents/*.md` | `includedTools`/`excludedTools` + `skills` glob 模式 frontmatter | explorer, worker |
| MCP 工具 | Claude-compatible 插件（写入 `mcp.json`） | `claudePlugins` / `claudePluginMarketplaces` settings | 外部 MCP server |
| Claude 兼容插件 | npm 包安装 | `claudePlugins` / `claudePluginMarketplaces` settings | 社区插件 |
| Codex 插件兼容 | `core/codex-plugin-manager.ts` + `core/codex-hooks-bridge.ts` | `codexPlugins` / `codexPluginMarketplaces` settings + `pi codex-plugin` CLI | `marketplace.json` / `.codex-plugin/plugin.json` / `hooks.json` |
| 用户配置 | `~/.pi/agent/settings.json` | SettingsManager 读写 | API key、默认模型 |
| 项目配置 | `.pi/settings.json` | SettingsManager 读写 | 项目级 mcpServers、model overrides、defaultPrimaryAgent |
| 系统提示词 | `coding-agent/core/system-prompt.ts:buildSystemPrompt()` | 优先级：Primary Agent → SYSTEM.md → 默认 → APPEND_SYSTEM.md → 上下文文件 → Skills | `.pi/SYSTEM.md`、`APPEND_SYSTEM.md`、`--system-prompt` |
| 主题 | `.pi/themes/*.json` | Theme 类加载 | dark.json, light.json |
| 快捷键 | `.pi/keybindings.json` | KeybindingsManager | 自定义键绑定 |

### 关键约束

- 扩展通过 `pi install` 安装或 `.pi/extensions/` 发现；核心扩展列表见 `packages/coding-agent/dist-assets/install.sh`
- MCP 能力通过 Claude-compatible 插件系统间接支持，插件安装时将 MCP 服务器配置写入 `mcp.json`；默认 proxy 模式控制上下文占用
- Claude 兼容插件使用独立 `claudePlugins` settings，不污染 Pi 原生 `packages` 配置
- Subagent 工具通过 `includedTools`/`excludedTools` glob 模式控制工具权限；旧 `tools` 字段自动映射
- Primary agent 的 system prompt 始终 prepend 在 SYSTEM.md 之前
- 内置工具默认启用 `read, bash, edit, write`；`grep, find, ls` 按需启用
- 发行版资产目录 `packages/coding-agent/dist-assets/` 包含随二进制分发的内置扩展（tps.ts、sudo-helper.ts）、内置 primary agents（coding.md、plan.md）和 `install.sh` 安装脚本；内置 skills（pi-config、pi-docs-reference）位于 `packages/coding-agent/skills/`，随构建拷贝至 `dist/skills/` 并由 resource-loader 兜底加载

## 关键路径入口

修改以下功能时，从这些入口开始追踪：

| 功能 | 主入口 | 关键调用链 |
| --- | --- | --- |
| **工具注册** | `coding-agent/core/sdk.ts:createAgentSession()` | → `createXxxTool()` → `AgentTool` 接口 → `Agent` 注册 |
| **工具匹配** | `coding-agent/core/tool-matcher.ts:resolveActiveTools()` | glob 模式 → `includedTools`/`excludedTools` → 最终工具集 |
| **模型解析** | `coding-agent/core/model-resolver.ts:findInitialModel()` | → `ModelRuntime.getModel()` → `model-runtime.ts` → provider 匹配 |
| **模型/认证运行时** | `coding-agent/core/model-runtime.ts:ModelRuntime` | → `getModels()`/`getAvailable()`/`getAuth()`/`login()`/`logout()` → provider-composer → auth-storage |
| **会话持久化** | `coding-agent/core/session-manager.ts:SessionManager` | → `SessionManager.appendMessage()` → `Session.appendMessage()` → `JsonlSessionStorage.appendEntry()` |
| **扩展加载** | `coding-agent/core/extensions/loader.ts:discoverAndLoadExtensions()` | → `ExtensionRunner` → 事件分发 → 扩展 handler |
| **技能加载** | `coding-agent/core/skills.ts:loadSkills()` | → `loadSkillsFromDir()` → SKILL.md 解析 → `formatSkillsForPrompt()` |
| **系统提示词** | `coding-agent/core/system-prompt.ts:buildSystemPrompt()` | Primary Agent → SYSTEM.md → 默认 → Append → 上下文文件 → Skills |
| **Primary Agent** | `coding-agent/core/primary-agents/discovery.ts` | → `switchPrimaryAgent()` → 工具重解析 → `defaultPrimaryAgent` 持久化 |
| **压缩** | `coding-agent/core/compaction/compaction.ts:compact()` | → `findCutPoint()` → `generateSummary()` → 会话条目重写 |
| **子 agent** | `coding-agent/core/subagents/runner.ts:runSubagents()` | → `SubagentDefinition` → `resolveActiveTools()` → 独立 AgentSession |
| **MCP 连接** | Claude Plugin 系统（写入 `mcp.json`） | → 外部 MCP 客户端进程读取配置 → tool 注册 |
| **TUI 渲染** | `tui/src/tui.ts:TUI.render()` | → 差分计算 → `Terminal.write()` |
| **交互模式** | `coding-agent/modes/interactive/interactive-mode.ts` | → 键盘事件循环 → 消息渲染 → 斜杠命令处理 |
