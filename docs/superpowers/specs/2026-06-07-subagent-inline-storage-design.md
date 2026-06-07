# Subagent History Inline Storage Design

## Status: Approved

## Problem

当前 subagent 的消息存储在独立的 JSONL 文件中（`.pi/sessions/<sessionId>/subagents/<filename>.jsonl`），
父 session 中只保留 `SubagentRunEntry` 引用。这种设计导致了多个问题：

1. **runId 匹配 bug**：storage key 含 index（`subagent:<ts>:<rand>:<idx>`），但 `filenameToRunId` 正则需要同步更新
2. **文件管理复杂**：独立文件需要 `runIdToFilename`/`filenameToRunId` 转换、`getSubagentDir()` 目录管理、`createSubagentStorage()` 独立 SessionManager
3. **异步加载复杂**：overlay 需要异步加载子 session 文件、缓存管理
4. **leafId 被污染**：`SubagentRunEntry` 的 `parentId: null` 导致 `_buildIndex` 和 `_appendEntry` 必须特殊处理 leafId

## Design

### 核心思路

subagent 的消息以普通 `message` entry 的形式直接写入父 session 的 JSONL 文件，挂在 `SubagentRunEntry` 下作为独立子树。

```
主链:  user_msg → assistant_msg → SubagentRunEntry → user_msg → ...
                              ↘
子树:                   SubagentRunEntry → msg(user) → msg(assistant) → msg(toolResult) → ...
```

`SubagentRunEntry` 作为子树根节点，其 `parentId` 指向主链上的前一个 entry（与当前行为一致）。
子消息的 `parentId` 指向 `SubagentRunEntry` 的 id，形成独立分支。

### 树结构遍历

- **`getBranch(leafId)`**：从主链 leaf 往 root 走，不经过 `SubagentRunEntry` 的子节点 → **零改动**
- **`buildSessionContext`**（两个实现）：`appendMessage` 只处理 `message`/`custom_message`/`branch_summary`，
  `SubagentRunEntry` 的子节点不在 `getBranch` 路径上 → **零改动**
- **Compaction**：`getMessageFromEntry` 已跳过 `subagent_run`，`findValidCutPoints` switch 不含 `subagent_run`，
  子节点不在主链路径上 → **零改动**
- **Branch summarization**：`getMessageFromEntryForBranchSummary` 已跳过 `subagent_run` → **零改动**
- **`_buildIndex`**：已跳过 `subagent_run` 不更新 `leafId` → **零改动**
- **`getTree()`**：子消息作为 `SubagentRunEntry` 的子节点出现在树中 → **零改动**

### 运行时行为

1. 子 agent 运行时仍使用 `SessionManager.inMemory()`（与当前行为一致，不写入任何文件）
2. 运行结束后（成功或失败），将内存中的 messages 以 `message` entry 追加到父 session
3. 每个 `message` entry 的 `parentId` 指向 `SubagentRunEntry` 的 id（子树的根）

### 恢复时行为

1. `loadSubagentRunEntries()` 返回所有 `SubagentRunEntry`（与当前行为一致）
2. 新增 `getSubagentMessages(runId)` 方法：通过遍历 `byId` 找到 `SubagentRunEntry`，然后找其直接子节点
   （`parentId === subagentRunEntry.id`），从子节点链重建消息列表
3. 不再需要 `loadSubagentSession(runId)` 的异步文件 I/O

## API Changes

### `session-manager.ts`

**删除**：
- `runIdToFilename()` 函数
- `filenameToRunId()` 函数
- `getSubagentDir()` 方法
- `createSubagentStorage(runId)` 方法
- `loadSubagentSession(runId)` 异步方法

**修改**：
- `appendSubagentRunEntry(entry)` → 追加子消息的逻辑移到此处或在 runner 中单独处理

**新增**：
- `appendSubagentMessages(subagentEntryId: string, messages: AgentMessage[])` — 将消息以 `parentId = subagentEntryId` 追加到父 session
- `getSubagentMessages(subagentEntryId: string): AgentMessage[]` — 同步方法，扫描 `fileEntries` 找 `parentId === subagentEntryId` 的 entry，按 timestamp 排序后返回消息列表

**不变**：
- `loadSubagentRunEntries()` — 仍然返回 `SubagentRunEntry[]`
- `appendSubagentRunEntry()` — 接口不变，内部实现不需要特殊处理 leafId 恢复（因为子消息的追加方式改变）
- `_buildIndex` — 已跳过 `subagent_run`

### `runner.ts`

**修改**：
- `runOne()` 不再创建 `createSubagentStorage(storageKey)`
- 子 agent 使用 `SessionManager.inMemory()`
- 运行结束后，调用新方法将 messages 追加到父 session 的 JSONL（挂在 `SubagentRunEntry` 下）

**新增辅助**：
- `appendSubagentMessages(parentSm, subagentEntryId, messages)` — 将消息以 `parentId = subagentEntryId` 追加

### `agent-session.ts`

**修改**：
- `createSubagentChildSession()` 删除 `sessionManager?` 参数，始终使用 `SessionManager.inMemory()`

### `subagent-overlay.ts`

**修改**：
- `loadHistoricalSession` 回调从异步改为同步（`getSubagentMessages`）
- `getMessagesForAgent()` 第 3 步：从 `historicalMessagesCache` 改为直接调用 `getSubagentMessages`
- 删除 `loadHistoricalMessages` 异步方法
- 删除 `historicalMessagesCache`
- 删除异步加载占位符 "(loading...)" 逻辑

### `interactive-mode.ts`

**修改**：
- `showSubagentDetails()` 中的 `loadHistoricalSession` 回调改为同步调用 `sessionManager.getSubagentMessages(subagentEntryId)`

### `subagent-details.ts`

**不变**。

### `compaction.ts`, `branch-summarization.ts`

**不变**。`subagent_run` 的子节点不在主链路径上，`getBranch(leafId)` 不会经过它们。

### `packages/agent/src/harness/types.ts`

**不变**。`SubagentRunEntry` 接口保持不变（`runId` 字段仍然保留用于查找子消息）。

### `packages/agent/src/harness/session/session.ts`

**不变**。`buildSessionContext` 的 `appendMessage` 只处理 `message`/`custom_message`/`branch_summary`，
子节点不在路径上。

## SubagentRunEntry.runId 变更

当前 `runId` 格式为 `subagent:<timestamp>:<random>:<index>`，用于文件名匹配。
内嵌模式不再需要文件名转换，但 `runId` 仍用于在 `byId` 中查找 `SubagentRunEntry`。

`runId` 可以简化为 `subagent:<timestamp>:<random>:<index>`（保持当前格式），
作为 `SubagentRunEntry` 的唯一标识符。不再需要 `runIdToFilename`/`filenameToRunId` 转换。

## 多个历史 subagent 的读取

`loadSubagentRunEntries()` 返回数组，`.reverse()` 即为时间倒序——这与当前 overlay 的 newest-first 排序一致，零成本。

对于选中某个 subagent 后的消息读取：

- **历史的**：从 `byId` 找到 `SubagentRunEntry`，遍历 `fileEntries` 找 `parentId === subagentEntryId` 的 entry
- **运行中的**：从 child session 内存取（与当前行为一致）

这个操作只在用户点击 overlay 时触发，不是热路径，O(n) 完全可接受。
如果将来发现慢，在 `_buildIndex` 遍历时顺便建 `subagentChildren` Map 只需加 3 行。

```typescript
getSubagentMessages(subagentEntryId: string): AgentMessage[] {
    const messages: { ts: number; msg: AgentMessage }[] = [];
    for (const entry of this.fileEntries) {
        if (entry.type === "message" && entry.parentId === subagentEntryId) {
            messages.push({
                ts: new Date(entry.timestamp).getTime(),
                msg: entry.message,
            });
        }
    }
    messages.sort((a, b) => a.ts - b.ts);
    return messages.map((m) => m.msg);
}
```

## `appendSubagentMessages` 实现细节

```typescript
// 在 SessionManager 中
appendSubagentMessages(subagentEntryId: string, messages: AgentMessage[]): void {
    for (const message of messages) {
        const entry: SessionMessageEntry = {
            type: "message",
            id: generateId(this.byId),
            parentId: subagentEntryId,  // 指向 SubagentRunEntry
            timestamp: new Date().toISOString(),
            message,
        };
        this.fileEntries.push(entry);
        this.byId.set(entry.id, entry);
        // 不更新 leafId — 子树消息不影响主链
        this._persist(entry);
    }
}
```

注意：子消息之间**不需要**形成链（`parentId` 都指向 `SubagentRunEntry`）。
这样在恢复时，只需扫描 `fileEntries` 找 `parentId === subagentEntryId` 的 entry。

子消息也不需要形成链的原因：它们是只读的历史记录，不会被编辑或分支。
如果未来需要支持子消息的分支，可以改为链式 `parentId`。

## `getSubagentMessages` 实现细节

```typescript
// 在 SessionManager 中
getSubagentMessages(subagentEntryId: string): AgentMessage[] {
    const messages: { ts: number; msg: AgentMessage }[] = [];
    for (const entry of this.fileEntries) {
        if (entry.type === "message" && entry.parentId === subagentEntryId) {
            messages.push({
                ts: new Date(entry.timestamp).getTime(),
                msg: entry.message,
            });
        }
    }
    messages.sort((a, b) => a.ts - b.ts);
    return messages.map((m) => m.msg);
}
```

## 测试变更

### 现有测试

- `subagents.test.ts`：使用 `SessionManager.inMemory()`，不受影响
- `subagent-details-component.test.ts`：UI 测试，不受影响
- `subagents-panel-component.test.ts`：UI 测试，不受影响
- `compaction.test.ts`：需要确认 `subagent_run` 子消息不被 compaction 处理

### 新增测试

- `session-manager` 中 `appendSubagentMessages` + `getSubagentMessages` 的单元测试
- 验证 `buildSessionContext` 不包含子消息
- 验证 compaction 不影响子消息
- 验证 `getBranch(leafId)` 不经过子消息
- 验证 `getTree()` 正确展示子树结构

## 迁移

旧 session 文件中可能存在 `subagents/` 目录下的独立 JSONL 文件。
不需要自动迁移——这些文件可以保留但不被新代码读取。
旧 `SubagentRunEntry` 中的 `runId` 仍然有效（作为标识符），只是没有内嵌消息可供读取。

## 文件清理

删除 `packages/coding-agent/src/core/session-manager.ts` 中的：
- `runIdToFilename()` 函数
- `filenameToRunId()` 函数

删除 `packages/coding-agent/src/core/session-manager.ts` 中 `SessionManager` 类的：
- `getSubagentDir()` 方法
- `createSubagentStorage(runId)` 方法
- `loadSubagentSession(runId)` 异步方法
