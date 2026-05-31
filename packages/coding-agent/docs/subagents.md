# Subagents

Subagent 是一种任务委托机制，允许主 agent 将任务分配给专门的子 agent 执行。内置 subagent tool 在当前进程内运行，不创建子进程，子会话不持久化。

## 内置 Agent

| Agent | 描述 | 默认工具 |
|-------|------|----------|
| `scout` | 只读探索，收集上下文 | read, grep, find, ls |
| `planner` | 创建实现计划 | read, grep, find, ls |
| `reviewer` | 代码和计划审查 | read, grep, find, ls |
| `worker` | 执行实现任务 | read, bash, edit, write, grep, find, ls |

## 自定义 Agent

创建 Markdown 文件定义自定义 agent：

**用户级**：`~/.pi/agent/subagents/*.md`
**项目级**：`.pi/subagents/*.md`（需要 `subagentScope: "project"` 或 `"both"`）

```markdown
---
description: 审查补丁的专注 reviewer
model: anthropic/claude-sonnet-4-5
thinking: high
tools: [read, grep, find, ls]
---

审查回归、缺失测试和行为变更。先给出发现。
```

**Frontmatter 字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | Agent 描述，用于工具提示 |
| `model` | string | 模型 ID，如 `anthropic/claude-sonnet-4-5` |
| `thinking` | string | 思考级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `tools` | string[] | 允许的工具列表 |

Frontmatter 中的 `model` 和 `thinking` 可被任务参数覆盖。

## 运行模式

### 单任务

```json
{
  "agent": "reviewer",
  "task": "审查当前变更集",
  "thinking": "high"
}
```

### 并行任务

最多 8 个任务，并发度 4。结果顺序与输入顺序一致。

```json
{
  "tasks": [
    { "agent": "scout", "task": "查找 settings 相关文件", "tools": ["read", "grep", "find"] },
    { "agent": "reviewer", "task": "审查测试覆盖", "tools": ["read", "grep"] }
  ]
}
```

### 链式任务

顺序执行，`{previous}` 被替换为前一步输出。

```json
{
  "chain": [
    { "agent": "scout", "task": "总结认证流程" },
    { "agent": "planner", "task": "基于此上下文规划安全重构：{previous}" }
  ]
}
```

## Agent Scope

| Scope | 加载的 Agent |
|-------|-------------|
| `user`（默认） | 内置 + `~/.pi/agent/subagents/` |
| `project` | 内置 + `.pi/subagents/` |
| `both` | 内置 + 用户级 + 项目级 |

项目级 agent 覆盖同名的用户级 agent。

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
tools: [read, grep, find, ls, bash]
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
|------|------|
| `read` | 读取文件内容 |
| `bash` | 执行命令（git、构建工具等） |
| `edit` | 编辑文件 |
| `write` | 创建/覆盖文件 |
| `grep` | 搜索文件内容 |
| `find` | 查找文件 |
| `ls` | 列出目录 |

**只读 agent**：`read, grep, find, ls`
**分析 + 执行 agent**：`read, bash, grep, find, ls`
**完整能力 agent**：`read, bash, edit, write, grep, find, ls`

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
tools: [read, grep, find, ls, bash]
---
...
EOF

# 项目级（仅当前项目）
mkdir -p .pi/subagents
cat > .pi/subagents/project-reviewer.md << 'EOF'
---
description: 项目特定审查规则
tools: [read, grep, find, ls]
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
|------|------|
| 独立任务（无依赖） | parallel |
| 需要前一步结果 | chain |
| 混合 | 分组并行 + 链式 |

### 上下文传递

链式模式使用 `{previous}` 占位符：

```json
{
  "chain": [
    { "agent": "scout", "task": "查找认证相关代码" },
    { "agent": "planner", "task": "基于以下上下文规划重构：\n{previous}" },
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
  agent: "planner",
  task: "规划 subagent 发现的最小实现",
  thinking: "medium",
});

// 禁用内置 subagent tool，保留 SDK 方法
await createAgentSession({ enableSubagents: false });
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
