# Subagent Title 设计

## 目标

为每个 subagent 任务添加一个展示标题 `title`，用于在 UI（overlay 左侧面板、sidebar、inline tool rendering）中替代当前的 `agent` name（如 `worker`、`explorer`）显示。Title 由 LLM 在调用 subagent tool 时显式传入，是任务摘要而非角色标识。

## 现状

当前 overlay 左侧面板显示 `1. worker running`，右侧显示 `worker running`，picker 显示 `1. worker success`。这些 `worker`/`explorer` 来自 `SubagentDefinition.name`，是角色标识而非任务描述，缺乏辨识度——多个 worker 并行时用户无法区分。

## 设计

### 数据结构改动

#### 1. `SubagentTask` — title 为必填

```typescript
// packages/coding-agent/src/core/subagents/types.ts
export interface SubagentTask {
  agent: string;
  task: string;
  title: string;      // ← 新增，必填。LLM 传入的展示标题，如 "搜索数据库配置"
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}
```

#### 2. `SubagentRunEvent` — title 必填

```typescript
export interface SubagentRunEvent {
  runId: string;
  index: number;
  agent: string;
  task: string;
  title: string;      // ← 新增，必填
  status: SubagentRunStatus;
  // ...其余不变
}
```

#### 3. `SubagentRunEntry` — title optional（兼容历史）

```typescript
// packages/agent/src/harness/types.ts
export interface SubagentRunEntry extends SessionTreeEntryBase {
  type: "subagent_run";
  runId: string;
  index: number;
  agent: string;
  task: string;
  title?: string;     // ← 新增，optional。历史 entry 无此字段
  status: "success" | "failed" | "aborted";
  // ...其余不变
}
```

`title` 在持久化层为 optional——旧 JSONL 文件中的 entry 没有 `title` 字段，反序列化时为 `undefined`。

#### 4. `SubagentTaskResult` — title 必填

```typescript
export interface SubagentTaskResult {
  index: number;
  agent: string;
  task: string;
  title: string;      // ← 新增，必填
  status: Exclude<SubagentRunStatus, "pending" | "running">;
  // ...其余不变
}
```

#### 5. `SubagentDetailsItem` — title optional（兼容历史）

```typescript
// subagent-details.ts
export interface SubagentDetailsItem {
  index: number;
  agent: string;
  task: string;
  title?: string;     // ← 新增，optional
  status: string;
  // ...其余不变
}
```

#### 6. `AgentListItem` — title optional（兼容历史）

```typescript
// subagent-overlay.ts
interface AgentListItem {
  index: number;
  agent: string;
  title?: string;     // ← 新增，optional
  status: string;
  // ...其余不变
}
```

### Fallback 规则

对于没有 `title` 的数据（历史 entry、或未传入 title 的边缘情况），统一 fallback：

```
displayTitle = title ?? task.slice(0, 7)
```

从 `task` 字段提取前 7 个字符作为兜底显示。7 字符在中文/英文混合场景下足够展示关键信息（如 "搜索数据库" → "搜索数据库" 不超 7 字，"Fix login" → "Fix logi" 截断也可辨识）。

此 fallback 应在 UI 层和 tool rendering 层统一使用一个 helper 函数：

```typescript
// subagent-details.ts 或 subagent-overlay.ts 中提取为公共函数
export function displayTitle(item: { title?: string; task: string }): string {
  return item.title ?? item.task.slice(0, 7);
}
```

### Tool Schema 改动

#### `tool.ts` — title 为必填参数

```typescript
function createTaskSchema(subagentNames: string[]) {
  return Type.Object({
    agent: createSubagentNameSchema(subagentNames),
    task: Type.String(),
    title: Type.String({ description: "Short display title summarizing this subagent task, 2-6 words" }),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(ThinkingSchema),
    tools: Type.Optional(Type.Array(Type.String())),
  });
}
```

对应的 `SubagentTaskInput` 类型也加 `title: string`。

#### Prompt guidelines

在 `promptGuidelines` 中新增：

```
"Each task must include a concise title (2-6 words) summarizing what it does, e.g. '搜索数据库配置' or 'fix login CSS'. The title is displayed in the UI to identify subagent runs."
```

### Runner 改动

#### `resolveTask` — 传递 title

`ResolvedTask` 加 `title: string`，从 `task.title` 获取。

#### `createEvent` — 传递 title

```typescript
function createEvent(runId: string, resolved: ResolvedTask, status: ..., overrides: ...): SubagentRunEvent {
  return {
    // ...existing
    title: resolved.title,   // ← 新增
    // ...
  };
}
```

#### `appendSubagentRunEntry` — 传递 title

`session-manager.ts` 的 `appendSubagentRunEntry` 参数加 `title?: string`，写入 entry 时包含。

#### 返回结果 — 传递 title

`SubagentTaskResult` 和 `SubagentRunResult` 中所有返回点都包含 `title`。

### UI 改动

所有当前显示 `item.agent` 的地方改为 `displayTitle(item)`：

| 文件 | 位置 | 当前 | 改为 |
|------|------|------|------|
| `subagent-overlay.ts:216` | 左侧列表 | `${item.agent}` | `${displayTitle(item)}` |
| `subagent-overlay.ts:252` | 右侧标题 | `${item.agent}` | `${displayTitle(item)}` |
| `subagent-overlay.ts:37` | toListItems | `agent: item.agent` | `title: item.title` + `agent: item.agent` |
| `subagent-details.ts:316` | Picker | `${item.agent}` | `${displayTitle(item)}` |
| `subagent-details.ts:364` | RunView 标题 | `Subagent ${item?.agent}` | `Subagent ${displayTitle(item)}` |
| `tool.ts:128,147,162` | Inline rendering | `${item.agent}` | `${item.title ?? item.agent}` |

**注意**：overlay 右侧详情面板中仍保留 `agent` name 的显示（作为角色标识），放在 `model=` / `thinking=` 那行 metadata 中，如：

```
搜索数据库配置 running
model=claude thinking=low agent=explorer
```

### subagents-panel.ts（/subagents 命令面板）

`subagents-panel.ts` 中显示的是 **subagent definitions**（定义列表），不是 running tasks。定义的显示名仍然是 `agent.name`（如 `explorer`、`worker`）。title 是 **运行时** 的任务摘要，只出现在 running/completed entries 中。

但 definition 的显示行可以改进为同时展示定义名和 scope，与 title 无关，不在本设计范围内。

### 持久化兼容

- 旧 JSONL entry 无 `title` 字段 → 反序列化为 `undefined`
- `loadSubagentRunEntries()` → 返回 `SubagentRunEntry[]`，其中 `title` 为 `undefined`
- `SubagentDetailsData.historicalEntries` → `title` 为 `undefined`
- UI fallback：`title ?? task.slice(0, 7)` 统一兜底

### 不改动的部分

- `SubagentDefinition` — 不加 title。title 是运行时概念，与定义无关
- Footer 的 `subagents:N` 计数 — 不变
- Session tree 的 leafId 逻辑 — 不变
- `getRunningSubagentCount()` — 不变

## 影响面汇总

| 包 | 文件 | 改动类型 |
|----|------|----------|
| coding-agent | `core/subagents/types.ts` | SubagentTask +title, SubagentRunEvent +title, SubagentTaskResult +title |
| coding-agent | `core/subagents/tool.ts` | schema +title, SubagentTaskInput +title, promptGuidelines, renderDetails/resultText |
| coding-agent | `core/subagents/runner.ts` | ResolvedTask +title, createEvent +title, 返回结果 +title |
| coding-agent | `core/session-manager.ts` | appendSubagentRunEntry +title |
| agent | `harness/types.ts` | SubagentRunEntry +title (optional) |
| coding-agent | `modes/interactive/components/subagent-details.ts` | SubagentDetailsItem +title, displayTitle helper, Picker + RunView |
| coding-agent | `modes/interactive/components/subagent-overlay.ts` | AgentListItem +title, displayTitle, 左右面板 |