# Subagents

> **内置 subagent 工具已移除**（破坏性变更）。任务委托能力由社区扩展 [pi-subagents](https://github.com/nicobailon/pi-subagents) 提供，本文档以该扩展为主线，说明安装、agent 定义、发现路径与配置。

## 安装

```bash
pi install npm:pi-subagents
```

安装后无需额外配置：扩展注册 `subagent` 工具，Pi 会基于任务自行决定是否调用、选择 agent 并编排。直接用自然语言即可：

```text
Use reviewer to review this diff.
Ask oracle for a second opinion on my current plan.
Run parallel reviewers: one for correctness, one for tests, one for unnecessary complexity.
```

## 工作原理

Pi 是父会话（parent）。subagent 是带独立任务的子 Pi 会话（child）。前台运行会流式显示进度；后台运行可随时查看。安装扩展不会自动启动后台评审——它是给 Pi 一个委托工具；如需"每次实现后自动评审"，在 prompt 或项目指令里说明即可。

## 内置 agents

扩展自带 6 个内置 agent（`scout`/`researcher`/`worker`/`reviewer`/`oracle`/`delegate`），另提供外部 CLI 适配器（`codex-exec`、`codex-exec-writer`、`claude-code`、`claude-code-writer`、`cursor-agent`、`cursor-agent-writer`），要求本机已安装并认证对应 CLI。

推荐用法：`scout` 先侦察代码，`researcher` 先核实外部事实，`worker` 执行实现，`reviewer` 检查，`oracle` 在决策有风险时挑战假设。

## 自定义 agent 定义

一个 agent 就是一个 Markdown 文件：YAML frontmatter 定义角色，正文是系统提示词：

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls
---

Your system prompt goes here.
```

### 定义存放路径（低 → 高优先级）

| 范围 | 路径 |
| --- | --- |
| 内置 | 扩展安装目录 `agents/` |
| 包级 | `package.json` 的 `pi-subagents.agents` 或 `pi.subagents.agents` 条目 |
| 用户级 | `~/.pi/agent/agents/**/*.md`（旧）、`~/.agents/**/*.md`（新） |
| 项目级 | `<项目配置目录>/agents/**/*.md`（如 `.pi/agents/`），兼容 legacy `.agents/**/*.md` |

发现规则：

- 递归扫描子目录；`.chain.md` 不构成 agent
- 同名冲突优先级：内置 < 包级 < 用户级 < 项目级
- legacy `.agents/skills/` 下的文件被排除（防止 skill 被注册为 agent）
- **项目配置目录 `.agents/skills` 之外的 skill 目录（如 `~/.agents/all-skills/`）不在排除名单**，其中的 `SKILL.md` 拥有 `name`+`description` frontmatter，会被误注册为用户级 agent。若出现大量可疑的 user agents，检查 `~/.agents/` 下是否有非 `skills` 命名的 skill 仓库
- 设置 `subagents.agentScanDirs`（支持 `~` 与单层 `*` 通配）可追加递归扫描根；固定用户/项目目录在同名冲突时仍优先
- 环境变量 `PI_SUBAGENT_EXTRA_AGENT_DIRS`（PATH 风格分隔）追加只读扫描目录

### 常用 frontmatter 字段

| 字段 | 说明 |
| --- | --- |
| `name` / `description` | 必填。名称与用途描述 |
| `tools` | 子代理严格工具白名单；`mcp:` 前缀选择直接 MCP 工具（需安装 pi-mcp-adapter）；省略则继承 Pi 常规工具 |
| `excludeTools` | 在正常工具解析后应用的黑名单 |
| `model` / `fallbackModels` / `thinking` | 模型与回退（`thinking` 以 `:level` 后缀附加） |
| `systemPromptMode` | `replace`（默认）或 `append`（保留 Pi 基础提示词） |
| `inheritProjectContext` / `inheritGlobalContext` / `inheritSkills` | 是否继承仓库指令、全局上下文、skills 目录 |
| `defaultContext` | `fresh`（默认）或 `fork`（继承父会话上下文） |
| `skills` / `skillPath` | 子代理可用的技能及私有技能路径 |
| `async` / `timeoutMs` / `toolTimeoutMs` | 后台默认、运行期限、单工具硬超时 |
| `output` / `defaultReads` | 输出文件与前置读取 |
| `allowNestedSubagents` / `maxSubagentDepth` | 嵌套委托授权与深度限制 |
| `acceptance` / `acceptanceRole` | 验收级别与角色推断 |
| `memory` | 角色专属持久化记忆作用域（`project`/`user`） |
| `package` / `aliases` | 包标识（注册为 `<pkg>.<name>`）与别名 |

### 覆盖内置 / 项目覆盖

`subagents.agentOverrides.<name>`（settings）可按需覆盖单个字段，项目级覆盖优先于用户级。管理动作：

| 动作 | 说明 |
| --- | --- |
| `subagent({ action: "list" })` | 列出可执行 agents |
| `subagent({ action: "eject", agent })` | 将内置/包级 agent 复制为可编辑自定义文件 |
| `subagent({ action: "disable" / "enable" })` | 写/删 settings 覆盖 |
| `subagent({ action: "reset" / "delete" })` | 恢复内置默认 / 删除纯自定义 agent |
| `subagent({ action: "refine", agent })` | 项目内为单个 agent 生成约束性改进叠加层 |

## 配置

### 1. Settings 文件（`subagents.*` 键）

用户级 `~/.pi/agent/settings.json`、项目级 `.pi/settings.json`：

```json
{
  "subagents": {
    "defaultModel": "deepseek/deepseek-r1",
    "defaultProvider": "deepseek",
    "defaultThinking": "high",
    "maxThinking": "max",
    "defaultExtensions": ["pi-todo"],
    "disableBuiltins": false,
    "disableThinking": false,
    "agentScanDirs": ["~/.pi/flows/*/agents"],
    "agentOverrides": {
      "reviewer": { "description": "Independent review tier", "inheritProjectContext": false }
    },
    "modelScope": {
      "allow": ["inherit", "deepseek/deepseek-r1"]
    },
    "projectRootResolution": "git-root"
  }
}
```

| 键 | 说明 |
| --- | --- |
| `defaultModel` / `defaultProvider` / `defaultThinking` / `maxThinking` | 子代理默认模型、提供商、思考级别与上限 |
| `defaultExtensions` | 子代理默认加载的扩展名列表 |
| `agentScanDirs` | 追加递归 agent 扫描目录；支持 `~` 与单层 `*` |
| `agentOverrides` | 按 agent 名覆盖字段（`description`、`model`、`tools`、`disabled` 等） |
| `modelScope` | 模型作用域策略对象（`allow` 列表，`inherit` 表示允许继承父模型；可含 `agents.<name>` 按 agent 收紧） |
| `disableBuiltins` / `disableThinking` | 批量禁用内置 agent / 思考 |
| `projectRootResolution` | `nearest`（默认）或 `git-root`——monorepo/worktree 下防止嵌套 `.pi` 遮蔽仓库级配置 |

### 2. 扩展 config.json（`~/.pi/agent/extensions/subagent/config.json`）

常用键（完整参考见扩展自带 `docs/configuration.md`）：

```json
{
  "asyncByDefault": true,
  "defaultSubagentContext": "fresh",
  "fleetView": true,
  "fleetViewPlacement": "belowEditor",
  "asyncWidget": true,
  "waitTool": { "enabled": true, "defaultTimeoutMs": 120000 },
  "timeoutMs": 3600000,
  "toolTimeoutMs": 600000,
  "parallel": { "maxTasks": 8, "concurrency": 4 },
  "globalConcurrencyLimit": 20,
  "maxSubagentSpawnsPerRun": 64,
  "maxSubagentSpawnsPerSession": 100,
  "maxActiveAsyncRunsPerSession": 4,
  "artifactDir": "session",
  "worktreeBaseDir": "~/.pi/worktrees",
  "worktreeProvider": "auto",
  "intercomBridge": { "mode": "always" },
  "authorityPolicy": { "discardWorktree": "confirm", "destructiveCleanup": "confirm" }
}
```

### 3. 环境变量

| 变量 | 说明 |
| --- | --- |
| `PI_SUBAGENT_EXTRA_AGENT_DIRS` | 追加只读 agent 扫描目录（PATH 风格） |
| `PI_SUBAGENT_PI_BINARY` | 覆盖子进程启动的 pi 二进制/包装器 |
| `PI_SUBAGENT_TASK_DELIVERY` | `auto`/`file`——超长任务经临时文件传递（EDR 场景） |
| `PI_SUBAGENT_MAX_DEPTH` | 嵌套委托深度上限 |
| `PI_SUBAGENT_MAX_SPAWNS_PER_RUN` / `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` | 单运行树 / 会话累计 spawn 上限 |
| `PI_SUBAGENT_TOOL_TIMEOUT_MS` | 单工具硬超时 |
| `PI_SUBAGENTS_WORKTREE_DIR` | managed worktree 基目录 |

## 常用操作

可通过自然语言或斜杠命令：

| 操作 | 方式 |
| --- | --- |
| 列出 agents | "Show me the available subagents." / `subagent({ action: "list" })` |
| 查看运行中任务 | "Show active async runs." / `/subagents-fleet` |
| 健康检查 | `/subagents-doctor` |
| 某主题帮助 | `/subagents-guide [topic]` |
| 决策顾问团 | `/council`（包内 `council-mode` skill） |
| 后台运行 | "Run this in the background." |

参考文档：`subagent({ action: "guide", topic: "..." })`，topics 含 `overview`、`workflows`、`agents`、`missions`、`observability`、`tool-reference`、`configuration`、`models`、`watchdog`、`extension-api`。

## 与 Primary Agent 的关系

`plan` primary agent 的 `excludedTools: ["bash", "subagent"]` 保留 `subagent` 排除项：安装了提供 `subagent` 工具的扩展后，规划 agent 依然不会获得该工具。参见 [Primary Agents](primary-agents.md)。

## 旧会话兼容

- 旧会话文件中的 `subagent_run` 条目仍可被安全读取：它们不会成为会话 leaf，`pi --resume` 行为不受影响
- 旧记录无 UI 查看入口；执行分支压缩（compaction）时，孤立的 `subagent_run` 子树会随孤儿清理一并移除

## 替代方案

`examples/extensions/subagent/` 提供进程隔离版 min 扩展（每个子任务独立 `pi` 子进程运行），集成度低、体积小，适合不需要完整编排的场景。功能完整仍推荐 pi-subagents。

## 相关文档

- [Extensions](extensions.md) - 编写扩展注册自定义工具
- [Primary Agents](primary-agents.md) - 主 agent 角色切换
- pi-subagents 自带文档：`agents.md`（frontmatter 全参考）、`models.md`（模型分层）、`workflows.md`（编排模式）、`configuration.md`（全部配置键）、`watchdog.md`、`missions.md`
