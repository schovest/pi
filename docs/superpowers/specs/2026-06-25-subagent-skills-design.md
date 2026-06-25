# Subagent Skills 设计文档

> 日期：2026-06-25
> 状态：已确认，待实施

## 概述

为 subagent 新增 `skills` 配置能力，允许在 subagent 定义的 frontmatter 中声明 glob 模式列表，从主 agent 已加载的 skills 中过滤子集注入到子 agent 的 system prompt 中。

## 需求

- subagent 可以像主 agent 一样加载 skills
- 在 subagent 元数据中写入 `skills: ["skill1", "skill2", "open-*"]` 配置子 agent 的 skills 集合
- 支持 glob 通配符模式（minimatch，与 `includedTools`/`excludedTools` 一致）
- 子 agent 的 skills 仅注入描述（name/description/location），按需 read 完整内容
- 子 agent 的 skills 来源为主 agent 已加载 skills 的子集，不独立发现
- 默认不配置则为空 skills

## 设计决策

### 1. 方案选择：Frontmatter 声明

选择在 subagent 定义的 frontmatter 中新增 `skills` 字段，与 `includedTools`/`excludedTools` 模式一致。

排除的方案：
- Skill 级别反向声明：反直觉，新增 skill 需修改所有相关 skill 文件
- settings.json 统一管理：脱离 subagent 定义本身，与 frontmatter 声明式风格不一致

### 2. 注入方式：仅描述注入

与主 agent 一致，只在 system prompt 中注入 `<available_skills>` 块（name/description/location），子 agent 需要用 read tool 按需读取完整内容。

排除的方式：
- 完整内容注入：上下文占用大，可能超 token 限制
- 混合模式：实现复杂，收益不明显

### 3. Skills 来源：主 agent 已加载 skills 的子集

子 agent 从主 agent 的 skills 列表中用 minimatch 过滤，不独立执行 skill 发现流程。

### 4. 主 Agent 感知：description 追加

在 subagent 工具的 description 中自动追加可用 skills 列表，让主 agent 知道子 agent 有哪些 skills。不修改工具 schema，不给主 agent 增加 `skills` 覆盖参数。

## 数据模型变更

### SubagentDefinition

```ts
// packages/coding-agent/src/core/subagents/types.ts
export interface SubagentDefinition {
  name: string;
  description: string;
  prompt: string;
  scope: SubagentScope;
  sourcePath?: string;
  model?: string;
  thinking?: string;
  includedTools?: string[];
  excludedTools?: string[];
  skills?: string[];  // 新增：glob 模式列表，匹配主 agent 已加载的 skills
}
```

### SubagentTask

```ts
export interface SubagentTask {
  agent: string;
  prompt?: string;
  model?: string;
  thinking?: string;
  includedTools?: string[];
  excludedTools?: string[];
  skills?: string[];  // 新增：运行时覆盖 definition 的 skills
}
```

### Frontmatter 示例

```yaml
---
name: explorer
description: 快速搜索发现
skills:
  - grep-*
  - search
  - inspect
---

你是一个搜索专家...
```

默认值：`skills` 未配置或为空数组 → 子 agent 无 skills。

## 调用链路

```
1. AgentSession 创建时
   → loadSkills() 加载主 agent 的 skills
   → skills 存储在 AgentSession 实例上（已有）

2. 主 agent 调用 subagent 工具
   → tool.ts execute() 解析 tasks[]
   → AgentSession.runSubagents()

3. runSubagents()
   → discoverSubagents() 获取所有 SubagentDefinition（含 skills 字段）
   → resolveTask() 解析每个 task 的 skills patterns

4. runOne()
   → resolveActiveSkills(session.skills, skillsPatterns)
     → 从主 agent skills 中用 minimatch 过滤
   → createSubagentChildSession({ ..., skills: resolvedSkills })
     → 子 AgentSession 存储 skills 列表
   → child.prompt(resolvedPrompt)
     → 子会话 buildSystemPrompt() 注入 skills 描述
```

## 实现细节

### 1. discovery.ts — frontmatter 解析

在现有 frontmatter 解析逻辑中新增 `skills` 字段读取，与 `includedTools`/`excludedTools` 同构。

### 2. runner.ts — resolveTask() 与 runOne()

`resolveTask()` 新增 skills 解析：

```ts
const skillsPatterns = task.skills ?? definition.skills;
```

`runOne()` 在创建子会话前过滤 skills：

```ts
const availableSkills = resolveActiveSkills(session.skills, skillsPatterns);
```

### 3. tool-matcher.ts — 新增 resolveActiveSkills()

```ts
export function resolveActiveSkills(
  allSkills: Skill[],
  patterns: string[] | undefined
): Skill[] {
  if (!patterns || patterns.length === 0) return [];
  return allSkills.filter(skill =>
    patterns.some(pattern => minimatch(skill.name, pattern))
  );
}
```

### 4. agent-session.ts — createSubagentChildSession()

新增 `skills` 参数：

```ts
createSubagentChildSession(options: {
  // ... 现有参数
  skills?: Skill[];  // 新增
})
```

子会话存储 skills 列表，`buildSystemPrompt()` 复用现有注入逻辑。

### 5. tool.ts — description 追加 skills 信息

```ts
function formatSubagentDescription(def: SubagentDefinition, availableSkills: Skill[]): string {
  let desc = def.description;
  if (def.skills && def.skills.length > 0) {
    const matchedNames = availableSkills
      .filter(s => def.skills!.some(p => minimatch(s.name, p)))
      .map(s => s.name);
    if (matchedNames.length > 0) {
      desc += `\n\nAvailable skills: ${matchedNames.join(", ")}`;
    }
  }
  return desc;
}
```

## 边界情况

| 场景 | 行为 |
|------|------|
| `skills` 未配置 | 子 agent 无 skills，与当前行为一致 |
| `skills: []` | 显式空数组 = 无 skills |
| `skills: ["*"]` | 匹配主 agent 所有 skills |
| glob 匹配不到任何 skill | 无 skills 注入，不报错 |
| 主 agent 本身无 skills | 无论 skills 配置如何，子 agent 无 skills |
| 内置 subagent（explorer/worker） | 暂不配置 skills，保持向后兼容 |
| 任务级 `skills` 覆盖 | `task.skills` 优先于 `definition.skills` |
| 子 agent 无 read 工具 | `formatSkillsForPrompt()` 已有 `hasRead` 检查，无 read 则不注入 |

## 改动文件清单

| 文件 | 改动类型 |
|------|----------|
| `packages/coding-agent/src/core/subagents/types.ts` | 类型新增 `skills` 字段 |
| `packages/coding-agent/src/core/subagents/discovery.ts` | frontmatter 解析 `skills` |
| `packages/coding-agent/src/core/subagents/runner.ts` | `resolveTask()` 解析 skills，`runOne()` 过滤并传递 |
| `packages/coding-agent/src/core/subagents/tool.ts` | description 追加 skills 信息 |
| `packages/coding-agent/src/core/agent-session.ts` | `createSubagentChildSession()` 接收 skills，子会话存储 |
| `packages/coding-agent/src/core/tool-matcher.ts` | 新增 `resolveActiveSkills()` |

## 不改动的文件

- `packages/agent/src/harness/skills.ts` — agent 层 skills 加载不变
- `packages/coding-agent/src/core/skills.ts` — loadSkills 不变
- `packages/agent/src/harness/types.ts` — SubagentRunEntry 不变
- TUI 组件 — skills 是内部行为，不影响展示
- `packages/coding-agent/src/core/system-prompt.ts` — 复用现有 `formatSkillsForPrompt()` 逻辑
