# Primary Agent & Tool Matcher Enhancement Design

**日期**: 2026-06-23
**状态**: 设计中

---

## 概述

四项改进：

1. SYSTEM.md 与主 Agent 提示词共存 —— 主 Agent 提示词前置，SYSTEM.md 追加
2. Subagent 工具支持黑白名单 + 全局 Glob 匹配
3. 主 Agent 选择持久化到项目 settings.json
4. 底部栏始终显示主 Agent 信息并高亮

---

## 第一节：System Prompt 组装顺序

### 当前行为

```ts
// system-prompt.ts buildSystemPrompt()
if (customPrompt) {
    prompt = customPrompt;  // primaryAgentPrompt 被完全丢弃
}
```

### 新行为

```
primaryAgentPrompt + "\n\n" + customPrompt（若存在）
否则：primaryAgentPrompt + 默认模板（不变）
```

### 改动

`packages/coding-agent/src/core/system-prompt.ts:56-83`，约 5 行。

---

## 第二节：工具黑白名单统一 + Glob 支持

### 2.1 Subagent 字段重命名

`SubagentDefinition` / `SubagentTask`：

| 旧字段 | 新字段 | 说明 |
|--------|--------|------|
| `tools?: string[]` | `includedTools?: string[]` | 白名单 |
| — | `excludedTools?: string[]` | 新增黑名单 |

**兼容**：旧 `tools` 字段自动映射为 `includedTools`。`discovery.ts` 中 `readAgentFile()` 同时读 `tools` 和 `includedTools`，前者作为后者的 fallback。

### 2.2 Glob 匹配

新增公共工具函数（位置：`packages/coding-agent/src/core/tool-matcher.ts`）：

```ts
import { minimatch } from "minimatch";

function isGlobPattern(pattern: string): boolean {
    return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
    if (!isGlobPattern(pattern)) return toolName === pattern;
    return minimatch(toolName, pattern, { nocase: true });
}

function matchesAnyToolPattern(toolName: string, patterns: string[]): boolean {
    return patterns.some(p => matchesToolPattern(toolName, p));
}

function resolveActiveTools(
    allToolNames: string[],
    includedPatterns?: string[],
    excludedPatterns?: string[],
    defaults?: string[],
): string[] {
    if (includedPatterns?.length) {
        return allToolNames.filter(t => matchesAnyToolPattern(t, includedPatterns));
    }
    if (excludedPatterns?.length) {
        return allToolNames.filter(t => !matchesAnyToolPattern(t, excludedPatterns));
    }
    return defaults ?? allToolNames;
}
```

**示例**：`includedTools: ["read", "mcp_*"]` → `read` + 所有 `mcp_` 前缀工具。

### 2.3 影响范围

5 处精确匹配全部改为 glob 匹配：

| 位置 | 文件 | 当前 | 改为 |
|------|------|------|------|
| 主 Agent 切换 | `agent-session.ts` `switchPrimaryAgent()` | `this._toolRegistry.has(t)` | `resolveActiveTools(allToolNames, includedTools, excludedTools)` |
| 动态设置工具 | `agent-session.ts` `setActiveToolsByName()` | `this._toolRegistry.get(name)` | 遍历 pattern 匹配所有 registry key |
| 工具注册刷新 | `agent-session.ts` `_refreshToolRegistry()` | `allowedToolNames.has(name)` | `matchesAnyToolPattern(name, allowedToolNames)` |
| Subagent runner | `subagents/runner.ts` | `task.tools ?? definition.tools ?? [...]` | `resolveActiveTools(allToolNames, includedTools, excludedTools, [...]）` |
| SDK `tools`/`excludeTools` | `agent-session.ts` `_allowedToolNames` | `Set.has` | 同上 |

### 2.4 影响文件

- `packages/coding-agent/src/core/tool-matcher.ts` — 新增
- `packages/coding-agent/src/core/subagents/types.ts` — 字段重命名 + 新增 `excludedTools`
- `packages/coding-agent/src/core/subagents/discovery.ts` — 兼容旧 `tools` 字段
- `packages/coding-agent/src/core/subagents/tool.ts` — schema 加 `excludedTools`
- `packages/coding-agent/src/core/subagents/runner.ts` — 改名为 `includedTools`，加 `excludedTools`
- `packages/coding-agent/src/core/agent-session.ts` — 4 处匹配逻辑

---

## 第三节：主 Agent 持久化

### 存储

- **位置**：项目级 `.pi/settings.json`
- **字段**：`"defaultPrimaryAgent": "plan"`

### 写入

`switchPrimaryAgent()` 调用时自动写入：

```ts
this._settingsManager.set("defaultPrimaryAgent", name);
```

### 读取

`AgentSession` 初始化时读取，存在则自动切换：

```ts
const savedAgent = this._settingsManager.get("defaultPrimaryAgent");
const targetAgent = savedAgent !== "build" && definitions.find(d => d.name === savedAgent)
    ? savedAgent : "build";
```

### 降级

若保存的 agent 名已被删除（文件不存在），回退到 `"build"`，并清除无效配置。

### 影响文件

- `packages/coding-agent/src/core/agent-session.ts` — `switchPrimaryAgent()` 加写入，初始化加读取
- `packages/coding-agent/src/core/settings-manager.ts` — 无需改动（已有泛型 `set`/`get`）

---

## 第四节：底部栏显示优化

### 当前行为

```ts
// footer.ts:184
const agentPrefix = agentRole !== "build" ? `${agentRole} • ` : "";
```

`build` 模式隐藏 agent 名。

### 新行为

1. 始终显示：移除 `build` 特判
2. agent 名用 `theme.fg("accent", agentRole)` 高亮，其余部分 dim

```
// ▶ 效果
build • deepseek-v4-pro • xhigh     // build 时也显示
plan • deepseek-v4-pro • xhigh      // plan 时 plan 高亮
```

### 实现注意

当前第 228 行对整个 `rightSide` 加 `theme.fg("dim", ...)`。accent 颜色码在前，dim 码在后时可能出现覆盖问题。改为分段 dim：

```ts
const accentAgent = theme.fg("accent", agentRole);
const dimRest = theme.fg("dim", ` • ${modelName} • ${thinkingStr}`);
rightSide = accentAgent + dimRest;
```

### 影响文件

- `packages/coding-agent/src/modes/interactive/components/footer.ts` — 约 5 行

---

## 测试要点

| 场景 | 验证方式 |
|------|----------|
| SYSTEM.md + plan agent | 确认 prompt 以 plan 提示词开头，SYSTEM.md 内容紧随其后 |
| `includedTools: ["read", "mcp_*"]` | 确认 `mcp_foo`、`mcp_bar` 可用 |
| `excludedTools: ["bash"]` | 确认 bash 被排除，其余全可用 |
| 旧 `tools: [a, b]` 格式 | 确认自动映射为 `includedTools` |
| 切换 agent 后重启 | 确认新会话使用上次的 agent |
| 删除 agent 定义文件后启动 | 确认回退到 build |
| 底部栏 build/plan/自定义 | 确认始终显示且高亮 |
