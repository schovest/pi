# Subagent 历史持久化与查看

## 目标

同一会话中所有运行过的 subagent 的运行情况都能查看，包括退出后 resume 的场景。按创建时间倒序排列，最新创建的在左栏最上方。

## 方案

独立 subagent 会话文件 + 父会话引用条目。

## 数据持久化

### 独立 subagent 会话文件

**存储位置**：`.pi/sessions/<sessionId>/subagents/<filename>.jsonl`

- `<sessionId>`：父会话 ID
- `<filename>`：runId 中的 `:` 替换为 `-`，如 `subagent:1733123456789:abc123` → `subagent-1733123456789-abc123.jsonl`
- `SubagentRunEntry.runId` 保存原始 runId（含 `:`），`runIdToFilename()` 和 `filenameToRunId()` 负责互转

**文件格式**：复用现有 JSONL 格式

- 第一行：session header（type: "session", version: 3, id: `<runId>`, parentSession: `<sessionId>`, timestamp, cwd）
- 后续行：标准 `SessionTreeEntry`（message, thinking_level_change, model_change 等）

**写入时机**：`runOne()` 完成后（无论成功/失败/中止），在 `child.dispose()` 之前将 child session 的消息写入文件。

### 父会话引用条目

新增 `SessionTreeEntry` 类型：

```typescript
interface SubagentRunEntry extends SessionTreeEntryBase {
  type: "subagent_run";
  runId: string;           // 对应独立文件名
  index: number;           // 在同次调用中的序号
  agent: string;           // subagent 名称
  task: string;            // 任务描述
  status: "success" | "failed" | "aborted";
  model?: string;
  thinking?: string;
  totalTokens?: number;
  toolCount: number;
  outputSummary?: string;  // 截断到 240 字符
  error?: string;
  timestamp: string;       // ISO 格式
}
```

**写入时机**：`runOne()` 完成后，调用父 session 的 `appendEntry()` 写入引用条目。

**排序依据**：`timestamp` 字段，UI 按此倒序显示。

### 目录结构

```
.pi/
└── sessions/
    └── <sessionId>/
        ├── session.jsonl          # 主会话
        └── subagents/
            ├── subagent-1733123456789-abc123.jsonl
            ├── subagent-1733123457890-def456.jsonl
            └── ...
```

## SessionManager 扩展

### 新增方法

```typescript
class SessionManager {
  // 获取 subagent 存储目录
  getSubagentDir(): string;

  // 创建 subagent session storage（JSONL 格式，写入独立文件）
  createSubagentStorage(runId: string): SessionStorage;

  // 加载历史 subagent 引用条目（从主会话 JSONL 过滤 type="subagent_run"）
  loadSubagentRunEntries(): Promise<SubagentRunEntry[]>;

  // 加载指定 subagent 的完整会话（从独立 JSONL 文件）
  loadSubagentSession(runId: string): Promise<SessionContext | null>;
}
```

## Runner 修改

### runOne() 改动

1. 创建 subagent storage（替代 inMemory），传入 `createSubagentChildSession()`
2. 完成后写入父会话引用条目

```typescript
async function runOne(
  session: AgentSession,
  runId: string,
  resolved: ResolvedTask,
  options: SubagentRunOptions,
): Promise<SubagentTaskResult> {
  // 新增：创建 subagent storage
  const subagentStorage = session.sessionManager.createSubagentStorage(runId);
  const child = session.createSubagentChildSession({
    model: resolved.model,
    thinkingLevel: resolved.thinking,
    tools: resolved.tools,
    storage: subagentStorage,  // 新增参数
  });

  // ... 现有执行逻辑不变 ...

  // 新增：完成后写入父会话引用条目
  await session.sessionManager.appendEntry({
    type: "subagent_run",
    id: generateEntryId(),
    parentId: null,
    timestamp: new Date().toISOString(),
    runId,
    index: resolved.index,
    agent: resolved.definition.name,
    task: resolved.task.task,
    status,
    model: formatModel(resolved.model),
    thinking: resolved.thinking,
    totalTokens: usage?.totalTokens,
    toolCount: countToolCalls(events),
    outputSummary: output.slice(0, 240),
    error,
  });

  return result;
}
```

### createSubagentChildSession() 改动

新增 `storage` 参数。传入时使用该 storage 替代 `SessionManager.inMemory()`，child session 的消息自动持久化到 JSONL 文件。不传时退化为原有 inMemory 行为。

```typescript
createSubagentChildSession(options: {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  storage?: SessionStorage;  // 新增，不传则 SessionManager.inMemory()
}): AgentSession
```

**注意**：child session 使用独立 `SessionManager` 实例包装传入的 storage，而非复用父 session 的 `SessionManager`。这样 child 的 `appendEntry()` 直接写入独立 JSONL 文件，不污染父会话。

## UI 改进

### SubagentOverlayComponent 改动

**左栏**：
- 从 `SessionManager.loadSubagentRunEntries()` 加载历史条目
- 按 timestamp 倒序显示（最新在上）
- 每条显示：序号、agent 名称、状态、token 数、工具数、最近工具
- 运行中的 subagent 仍从 `_runningSubagents` 内存 Map 获取实时状态

**右栏**：
- 选中条目后，从 `SessionManager.loadSubagentSession(runId)` 加载完整会话
- 渲染完整消息历史（复用现有 `renderMessages`）
- 运行中的 subagent 仍从 child session 实时订阅

**内嵌展示**：
- 新增方法 `showSubagentInline(runId: string)`，在聊天区域渲染 subagent 会话
- 按 `Esc` 返回主会话视图

### 数据流

```
用户按快捷键打开 Overlay
  │
  ▼
SessionManager.loadSubagentRunEntries()
  │ 读取主会话 JSONL，过滤 type="subagent_run" 的条目
  ▼
按 timestamp 倒序排序
  │
  ▼
渲染左栏列表
  │
  ▼
用户选中某个条目
  │
  ▼
SessionManager.loadSubagentSession(runId)
  │ 读取 .pi/sessions/<sessionId>/subagents/<runId>.jsonl
  ▼
渲染右栏详情（完整消息）
```

## 清理策略

- **会话删除时**：删除 `.pi/sessions/<sessionId>/` 整个目录，包含所有 subagent 文件
- **压缩时**：`subagent_run` 条目不参与压缩（它们是引用，不是消息）
- **孤立文件清理**：启动时检查 `subagents/` 目录，删除没有对应 `subagent_run` 条目的文件

## 涉及文件

| 文件 | 改动类型 |
|---|---|
| `packages/agent/src/harness/types.ts` | 新增 `SubagentRunEntry` 类型，扩展 `SessionTreeEntry` 联合类型 |
| `packages/agent/src/harness/session/jsonl-storage.ts` | 解析 `subagent_run` 条目 |
| `packages/agent/src/harness/session/memory-storage.ts` | 支持 `subagent_run` 条目 |
| `packages/agent/src/harness/session/session.ts` | `buildSessionContext` 跳过 `subagent_run` 条目 |
| `packages/coding-agent/src/core/session-manager.ts` | 新增 `getSubagentDir()`, `createSubagentStorage()`, `loadSubagentRunEntries()`, `loadSubagentSession()` |
| `packages/coding-agent/src/core/agent-session.ts` | `createSubagentChildSession()` 新增 `storage` 参数 |
| `packages/coding-agent/src/core/subagents/runner.ts` | `runOne()` 使用独立 storage + 写入引用条目 |
| `packages/coding-agent/src/core/subagents/types.ts` | 新增 `SubagentRunEntry` 导出 |
| `packages/coding-agent/src/modes/interactive/components/subagent-overlay.ts` | 左栏加载历史条目，右栏加载完整会话 |
| `packages/coding-agent/src/modes/interactive/components/subagent-details.ts` | 适配 `SubagentRunEntry` 数据源 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 内嵌展示逻辑 + Overlay 数据源切换 |
