# Subagents

Subagent 是一种任务委托机制，允许主 agent 将任务分配给专门的子 agent 执行。内置 subagent tool 在当前进程内运行，不创建子进程，子会话不持久化。

## 内置 Agent

| Agent | 描述 | 默认工具 | thinking |
| ------- | ------ | ---------- | ---------- |
| `explorer` | 快速并行搜索，返回定位和摘要 | 全工具（prompt 约束只读） | low |
| `worker` | 单元化任务执行，拥有全部权限 | 全工具 | —（继承主 agent） |
| `reviewer` | 代码审查（质量、安全、可维护性），输出分级问题报告 | 全工具（prompt 约束只读） | —（继承主 agent） |

## 自定义 Agent

创建 Markdown 文件定义自定义 agent：

**用户级**：`~/.pi/agent/subagents/*.md`
**项目级**：`.pi/subagents/*.md`（需要 `subagentScope: "project"` 或 `"both"`）

```markdown
---
description: 审查补丁的专注审计员
model: anthropic/claude-sonnet-4-5
thinking: high
includedTools: [read, grep, find, ls]
---
```

**Frontmatter 字段**：

| 字段 | 类型 | 说明 |
| ------ | ------ | ------ |
| `description` | string | Agent 描述，用于工具提示 |
| `model` | string | 模型 ID，如 `anthropic/claude-sonnet-4-5` |
| `thinking` | string | 思考级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `includedTools` | string[] | 允许的工具列表，支持 glob 模式（详见下文） |
| `excludedTools` | string[] | 排除的工具列表，支持 glob 模式（详见下文） |
| `skills` | string[] | 允许主 agent 已加载的 skills 列表，支持 glob 模式（详见下文） |

#### 工具匹配（glob 模式）

`includedTools` / `excludedTools` 使用 [minimatch](https://github.com/isaacs/minimatch) glob 模式匹配工具名（大小写不敏感）：

- `"read"` — 精确匹配 `read` 工具
- `"read*"` — 匹配 `read`、`readFile` 等所有以 read 开头的工具
- `"!*"` — 匹配所有工具的否定模式
- 未设置 `includedTools` 且未设置 `excludedTools` — 使用默认工具集 `read, bash, edit, write`
- `includedTools: []`（空数组）— 无工具
- 若同时设置 `includedTools` 和 `excludedTools`，`includedTools` 生效，`excludedTools` 被忽略（included 优先）

内置工具名：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。此外 `subagent` 工具由 coding-agent 扩展注册，扩展也可注册自定义工具名。

#### Skills 匹配（glob 模式）

`skills` 字段允许 subagent 继承主 agent 已加载的 skills。同样使用 minimatch 匹配 skill 名称（大小写不敏感）：

- 未设置或空数组 `[]` — subagent **不继承**任何 skill（默认行为）
- `"test-*"` — 匹配名称以 `test-` 开头的 skills
- `"*"` — 匹配所有 skills

匹配的 skills 会注入到 subagent 的系统提示词中，效果与主 agent 加载 skill 一致。skill 内容仍按需加载（progressive disclosure）。

#### 兼容性

旧字段名 `tools` 仍然可读，但会自动映射到 `includedTools`，优先使用 `includedTools`。

Frontmatter 中的 `model` 和 `thinking` 可被任务参数覆盖。

## 运行模式

### 单任务

```json
{
  "agent": "worker",
  "task": "审查当前变更集",
  "thinking": "high"
}
```

### 并行任务

最多 8 个任务，并发度 4。结果顺序与输入顺序一致。

```json
{
  "tasks": [
    { "agent": "explorer", "task": "查找 settings 相关文件", "includedTools": ["read", "grep", "find"] },
    { "agent": "worker", "task": "审查测试覆盖", "includedTools": ["read", "grep"] }
  ]
}
```

### 链式任务

顺序执行，`{previous}` 被替换为前一步输出。

```json
{
  "chain": [
    { "agent": "explorer", "task": "总结认证流程" },
    { "agent": "worker", "task": "基于此上下文规划安全重构：{previous}" }
  ]
}
```

## Agent Scope

| Scope | 加载的 Agent |
| ------- | ------------- |
| `user`（默认） | 内置 + `~/.pi/agent/subagents/` |
| `project` | 内置 + `.pi/subagents/` |
| `both` | 内置 + 用户级 + 项目级 |

项目级 agent 覆盖同名的用户级 agent。

在任务中通过 `subagentScope` 参数控制 agent 搜索范围：

```json
{
  "agent": "project-reviewer",
  "task": "审查代码",
  "subagentScope": "project"
}
```

## 运行时监控

- 状态栏显示 `subagents:N` 表示运行中的 subagent 数量
- `/running-subagents` 查看每个 subagent 的事件、工具、输出、错误、模型、思考级别和用量

## 创建自定义 Agent

### 1. 确定 Agent 目标

明确 agent 的职责边界：

- 输入：agent 接收什么任务描述
- 输出：agent 应返回什么格式
- 工具：agent 需要哪些工具
- 模型：任务需要什么能力的模型

### 2. 编写 Agent 定义

```markdown
---
description: 分析依赖关系并生成依赖图
model: anthropic/claude-sonnet-4-5
thinking: medium
includedTools: [read, grep, find, ls, bash]
---

你是依赖分析专家。分析项目的依赖关系并生成结构化报告。

策略：
1. 查找 package.json、Cargo.toml、go.mod 等依赖文件
2. 分析直接依赖和传递依赖
3. 识别循环依赖和版本冲突

输出格式：

## 依赖文件
列出发现的依赖文件。

## 直接依赖
按类型分组的主要依赖。

## 传递依赖
关键传递依赖及其来源。

## 问题
循环依赖、版本冲突、安全警告。

## 建议
优化建议。
```

### 3. 选择工具集

| 工具 | 用途 |
| ------ | ------ |
| `read` | 读取文件内容 |
| `bash` | 执行命令（git、构建工具等） |
| `edit` | 编辑文件 |
| `write` | 创建/覆盖文件 |
| `grep` | 搜索文件内容（支持 glob 过滤文件） |
| `find` | 按 glob 模式查找文件（respects .gitignore） |
| `ls` | 列出目录 |

此外，`subagent` 工具由 coding-agent 扩展注册，扩展也可注册自定义工具名。

**只读 agent**：`read, grep, find, ls`
**分析 + 执行 agent**：`read, bash, grep, find, ls`
**完整能力 agent**：`read, bash, edit, write, grep, find, ls`

如果 subagent 需要使用主 agent 已加载的 skills，在 frontmatter 中设置 `skills` 字段（glob 模式匹配 skill 名称，如 `skills: ["test-*"]` 或 `skills: ["*"]` 继承全部）。

### 4. 设计输出格式

结构化输出便于：

- 主 agent 理解结果
- 链式模式传递给下一步
- 用户审查

```markdown
## 摘要
一句话总结。

## 发现
- 发现1
- 发现2

## 文件
- `path/to/file.ts` - 说明

## 下一步
建议的后续行动。
```

### 5. 放置 Agent 文件

```bash
# 用户级（所有项目可用）
mkdir -p ~/.pi/agent/subagents
cat > ~/.pi/agent/subagents/dep-analyzer.md << 'EOF'
---
description: 分析依赖关系
model: anthropic/claude-sonnet-4-5
includedTools: [read, grep, find, ls, bash]
---
...
EOF

# 项目级（仅当前项目）
mkdir -p .pi/subagents
cat > .pi/subagents/project-reviewer.md << 'EOF'
---
description: 项目特定审查规则
includedTools: [read, grep, find, ls]
---
...
EOF
```

### 6. 测试 Agent

```bash
# 交互式测试
pi
> 使用 dep-analyzer 分析当前项目的依赖

# 指定 scope 测试项目级 agent
> 用 subagentScope=both 运行 project-reviewer 审查 src/
```

## 最佳实践

### Agent 设计

1. **单一职责**：每个 agent 专注一个领域
2. **明确输出格式**：结构化输出便于解析和传递
3. **工具最小化**：只授予必要的工具
4. **模型匹配**：简单任务用 Haiku，复杂任务用 Sonnet/Opus

### 并行 vs 链式

| 场景 | 模式 |
| ------ | ------ |
| 独立任务（无依赖） | parallel |
| 需要前一步结果 | chain |
| 混合 | 分组并行 + 链式 |

### 上下文传递

链式模式使用 `{previous}` 占位符：

```json
{
  "chain": [
    { "agent": "explorer", "task": "查找认证相关代码" },
    { "agent": "worker", "task": "基于以下上下文规划重构：\n{previous}" },
    { "agent": "worker", "task": "执行以下计划：\n{previous}" }
  ]
}
```

### 错误处理

- 链式模式在第一个失败步骤停止
- 并行模式继续执行其他任务，汇总成功/失败数
- 检查 `status` 字段判断成功与否

### 性能考虑

- 并行任务上限 8 个，并发度 4
- 大输出会被截断，完整结果保留在 tool details

## SDK 用法

```typescript
const { session } = await createAgentSession();

// 运行 subagent
const result = await session.runSubagents({
  agent: "worker",
  task: "规划 subagent 发现的最小实现",
  thinking: "medium",
});
```

## 示例：独立进程 Subagent

`examples/extensions/subagent/` 提供了一个独立进程 subagent 的示例实现，每个 subagent 在隔离的 `pi` 子进程中运行。这是一个示例扩展，需要手动安装：

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
```

详见 `examples/extensions/subagent/README.md`。

## 相关文档

- [Extensions](extensions.md) - 编写扩展注册自定义工具
- [Skills](skills.md) - 技能系统
- [Prompt Templates](prompt-templates.md) - 提示模板
