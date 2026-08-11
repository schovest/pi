# Primary Agents

Primary agent 是控制 agent 角色、工具集和系统提示词的顶层配置机制。每个会话激活一个 primary agent，决定 agent 的行为模式。

## 概述

Primary agent 通过以下方式影响 agent 行为：

- **系统提示词**：agent 定义文件的 body 内容作为角色 prompt，始终 prepend 在系统提示词最前面
- **工具集**：通过 `includedTools` / `excludedTools` 控制可用工具范围
- **Skills**：通过 `skills` 控制可用 skills 范围（不配置则全部，显式空则无）
- **模型和思考级别**（可选）：可指定默认模型和思考级别

切换 primary agent 后：

- agent 角色 prompt 立即更新
- 工具集立即重解析
- 系统提示词自动重建
- 选择持久化到全局 settings（`defaultPrimaryAgent`），下次启动自动恢复

## 内置 Agent

| Agent | 描述 | 工具 | 角色 Prompt |
|-------|------|------|-------------|
| `code` | 默认 agent，拥有全部工具，用于实现和执行 | 全部内置工具（read, bash, edit, write, grep, find, ls）+ `subagent` + 扩展注册的工具 | 无（使用默认系统提示词） |
| `plan` | 规划 agent，只读工具，用于分析和设计 | 排除 `bash` 和 `subagent`；剩余工具（read, edit, write, grep, find, ls）均在列表中，但 prompt 约束为只读行为 | "You are a planning agent..." |

`code` 是初始默认值，每次启动时如果未恢复其他 agent 则使用 `code`。`code` 的 `systemPrompt` 为空，意味着使用 Pi 的默认系统提示词（无额外角色 prompt）。

`plan` 的实现是 `excludedTools: ["bash", "subagent"]`，未设置 `includedTools`，因此除 bash 和 subagent 外的所有工具都在可用列表中。plan 的 systemPrompt 要求不修改文件、不执行命令，实际效果为只读。

## 加载和优先级

Primary agent 从三个来源加载，按优先级覆盖：

| 优先级 | 来源 | 路径 | Scope |
| -------- | ------ | ------ | ------- |
| 1（最低） | 内置 | 硬编码 | `builtin` |
| 2 | 用户级 | `~/.pi/agent/primary-agents/*.md` | `user` |
| 3（最高） | 项目级 | `.pi/primary-agents/*.md`（从 cwd 向上查找） | `project` |

同名 agent 按优先级覆盖：项目 > 用户 > 内置。

## 创建自定义 Primary Agent

### 文件结构

```
~/.pi/agent/primary-agents/
└── my-agent.md
```

或项目级：

```
.pi/primary-agents/
└── my-agent.md
```

文件名（不含 `.md`）即为 agent 名称。

### 格式

```markdown
---
description: 简短描述 agent 的用途和行为
model: anthropic/claude-sonnet-4-5
thinking: high
includedTools: [read, grep, find, ls]
excludedTools: [subagent]
---

你是一个专注代码审查的 agent。分析代码变更，找出：
1. 逻辑错误和边界情况
2. 安全漏洞
3. 性能问题
4. 测试覆盖缺口

始终提供具体的文件路径和行号。不要修改文件——只报告发现的问题。
```

### Frontmatter 字段

| 字段 | 类型 | 说明 |
| ------ | ------ | ------ |
| `description` | string | Agent 描述，显示在 agent 选择器中 |
| `model` | string | 默认模型 ID，如 `anthropic/claude-sonnet-4-5`。切换到此 agent 时自动切换模型 |
| `thinking` | string | 默认思考级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `includedTools` | string[] | 允许的工具列表，支持 glob 模式（详见下文） |
| `excludedTools` | string[] | 排除的工具列表，支持 glob 模式（详见下文） |
| `skills` | string[] | Skills 过滤列表，支持 glob 模式（详见下文） |

#### 工具匹配（glob 模式）

`includedTools` / `excludedTools` 使用 [minimatch](https://github.com/isaacs/minimatch) glob 模式匹配工具名（大小写不敏感）：

- `"read"` — 精确匹配 `read` 工具
- `"read*"` — 匹配 `read`、`readFile` 等所有以 read 开头的工具
- `"!*"` — 匹配所有工具的否定模式
- 未设置 `includedTools` 且未设置 `excludedTools` — 使用全部已注册工具
- `includedTools: []`（空数组）— 无工具
- 若同时设置 `includedTools` 和 `excludedTools`，`includedTools` 生效，`excludedTools` 被忽略（included 优先）

内置工具名：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。此外 `subagent` 工具由 coding-agent 扩展注册，扩展也可注册自定义工具名。

#### Skills 过滤（glob 模式）

`skills` 字段使用与 `includedTools` / `excludedTools` 相同的 [minimatch](https://github.com/isaacs/minimatch) glob 模式匹配 skill 名称（大小写不敏感）：

- 未设置 `skills` — 使用全部已加载的 skills（默认行为）
- `skills: []`（空数组）— 无 skills
- `skills: ["review-*"]` — 只启用名称匹配 `review-*` 的 skills
- `skills: ["*"]` — 启用全部 skills（等效于不设置）

> **注意**：Primary agent 的 skills 过滤仅影响主会话的系统提示词，不影响 subagent。Subagent 始终从全局已加载的全部 skills 中按自身 `skills` 字段过滤。

兼容性：`tools`（旧字段名）仍然可读，自动映射到 `includedTools`，优先使用 `includedTools`。

### Body（系统提示词）

Frontmatter 之后的 Markdown body 是 agent 的角色 prompt。它 **始终 prepend** 在完整系统提示词的最前面。这意味着即使存在 `SYSTEM.md` 或 `--system-prompt`，primary agent 的角色 prompt 依然在它们之前生效。

**`code` agent 的特殊情况**：`code` 的 systemPrompt 为空字符串，因此不注入额外的角色 prompt，直接使用默认系统提示词（或 `SYSTEM.md` 自定义 prompt）。

## 系统提示词构成

完整系统提示词按以下优先级构成：

| 顺序 | 组成部分 | 来源 | 是否可替换 |
| ------ | ---------- | ------ | ------------ |
| 1 | **Primary Agent Prompt** | Agent 定义文件的 body | 始终在最前 |
| 2 | **Custom Prompt** | `.pi/SYSTEM.md` 或 `--system-prompt` | 存在时替换默认 prompt |
| 3 | **Default Prompt** | 内置默认系统提示词 | 当 custom prompt 不存在时使用 |
| 4 | **Append** | `APPEND_SYSTEM.md` 或 `--append-system-prompt` | 追加 |
| 5 | **Context Files** | `AGENTS.md` / `CLAUDE.md` | 追加 |
| 6 | **Skills** | Skills 元数据 | 追加 |
| 7 | **Date & CWD** | 自动生成 | 末尾 |

### 示例

**使用默认 code agent**（systemPrompt 为空）：

```
[默认系统提示词]
→ You are an expert coding assistant...
→ Tools: ...
→ Guidelines: ...

→ AGENTS.md 内容
→ Skills
→ Current date and CWD
```

**使用 plan agent**（有 systemPrompt）：

```
[primaryAgentPrompt prepend]
→ You are a planning agent. Analyze requirements...

[默认系统提示词]
→ You are an expert coding assistant...
→ Tools: read, grep, find, ls
→ Guidelines: ...

→ AGENTS.md 内容
→ Skills
→ Current date and CWD
```

**使用自定义 agent + SYSTEM.md**（custom prompt 替换默认）：

```
[primaryAgentPrompt prepend]
→ 你是一个专注代码审查的 agent...

[SYSTEM.md 内容]
→ 项目的自定义 prompt...

→ AGENTS.md 内容
→ Skills
→ Current date and CWD
```

## 切换 Agent

### 交互模式

- 使用 `/agent` 打开 agent 选择器（TUI overlay）
- 使用 `/agent <name>` 直接切换，如 `/agent plan`
- Footer 始终显示当前 agent 名称（accent 颜色），格式：`{agent} • {model} • {thinking}`

### SDK

```typescript
// 列出可用 agent
const agents = await session.listPrimaryAgents();

// 切换 agent
await session.switchPrimaryAgent("plan");

// 获取当前 agent
const currentAgent = session.currentPrimaryAgent;  // "code" | "plan" | ...
```

### RPC

```json
// 获取可用 agent（通过 get_commands 获取 extension 注册的 agent 命令）
{"type": "prompt", "message": "/agent"}
```

## 持久化

切换 primary agent 时，选择自动保存到全局 settings（`~/.pi/settings.json`）：

```json
{
  "defaultPrimaryAgent": "plan"
}
```

下次在相同项目启动会话时，自动恢复上次使用的 agent（除非恢复的是 `code`，则不写入 settings）。恢复逻辑在 `restorePrimaryAgent()` 中实现，仅在 `savedAgent !== "code"` 且 agent 仍然存在时才切换。

## Agent 选择器

交互模式中的 agent 选择器（TUI overlay）显示：

- 所有已发现的 agent（按字母顺序排列）
- 每个 agent 的 scope（`builtin` / `user` / `project`）和描述
- 当前激活的 agent 标记 `(active)`
- 详细信息：描述、prompt 摘要（截断至 120 字符）、工具约束、模型、思考级别

键盘控制：`↑/↓` 或 `j/k` 导航，`Enter` 选择，`Escape` 关闭。

## 与 Subagent 的区别

| 维度 | Primary Agent | Subagent |
| ------ | --------------- | ---------- |
| 作用范围 | 整个会话 | 单次任务委托 |
| 系统提示词 | 修改主 agent 的系统提示词 | 有自己的独立系统提示词 |
| 工具控制 | `includedTools` / `excludedTools` | `includedTools` / `excludedTools` |
| Skills 控制 | `skills`（不配置则全部） | `skills`（不配置则不继承） |
| 持久化 | 自动保存到全局 settings | 不持久化 |
| 数量 | 一个会话同时只有一个 | 可并行运行多个 |
| 定义位置 | `primary-agents/*.md` | `subagents/*.md` |

## 示例：创建代码审查 Agent

```bash
mkdir -p ~/.pi/agent/primary-agents
cat > ~/.pi/agent/primary-agents/reviewer.md << 'EOF'
---
description: 代码审查专家，只读模式，分析代码质量和安全性
model: anthropic/claude-sonnet-4-5
thinking: high
includedTools: [read, grep, find, ls]
excludedTools: [bash, edit, write, subagent]
---

你是代码审查专家。对代码变更进行严格审查：

检查清单：
1. **逻辑正确性**：边界情况、空值处理、并发安全
2. **安全性**：注入风险、权限问题、敏感数据泄漏
3. **性能**：不必要的分配、N+1 查询、阻塞调用
4. **可维护性**：命名清晰度、函数复杂度、代码重复

输出格式：
- 每个问题标注严重程度：🔴严重 / 🟡中等 / 🟢建议
- 提供具体的文件路径和行号
- 给出具体的修改建议

不要修改任何文件，只报告发现的问题。
EOF
```

然后在交互模式中使用：

```
/agent reviewer
```

## 相关文档

- [Subagents](subagents.md) - 子 agent 任务委托
- [Settings](settings.md) - `defaultPrimaryAgent` 设置
- [Extensions](extensions.md) - 扩展 API 与系统提示词交互
- [Usage](usage.md) - 系统提示词文件（SYSTEM.md / APPEND_SYSTEM.md）
