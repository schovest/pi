# Tree Peek & Revert 设计

## 概述

在 session tree 视图中新增两个功能：

1. **Peek（定位到消息）**：在 tree 中选中节点 → Enter → 选择 "Peek"，关闭 tree 面板并滚动聊天视图到目标消息位置，不切换分支。
2. **Revert（回滚 + git 恢复）**：在 tree 中选中节点 → Enter → 选择 "Revert"，将 git 工作区恢复到目标节点对应时间点的文件状态，并切换 session 到该节点。

## 交互流程（统一操作入口）

打开 tree → 方向键选中节点 → 按 Enter → 弹出操作选择器（默认选中 Peek）：

```
┌───────────────────────────────────────┐
│ ▸ Peek                                 │  ← 默认选中，定位到消息
│   Navigate                             │  ← 原来的 "No summary"
│   Navigate with summary                │  ← 原来的 "Summarize"
│   Navigate with custom prompt          │  ← 原来的 "Summarize with custom prompt"
│   Revert                               │  ← 新增，回滚 git + 导航
└───────────────────────────────────────┘
```

Escape 行为：在操作选择器中按 Escape → 回到 tree 视图（保持现有逻辑）。

## 功能1：Peek（定位到消息）

### 边界处理

- 目标节点不在当前分支上 → 提示 "该节点不在当前分支，无法定位"
- 目标节点不是消息类型（label / compaction / custom 等）→ 提示 "该节点无可定位的消息"
- 目标节点是当前分支上已渲染的消息 → 正常滚动定位

### 技术实现

| 改动 | 文件 | 内容 |
| ------ | ------ | ------ |
| 操作选择器 | `modes/interactive/interactive-mode.ts` | `showTreeSelector` 中 Enter 回调改为先弹出操作选择器，选项含 Peek / Navigate / Navigate with summary / Navigate with custom prompt / Revert |
| 定位逻辑 | `modes/interactive/interactive-mode.ts` | 选择 Peek 时：关闭 selector，定位到目标消息 |
| 渲染映射 | `modes/interactive/interactive-mode.ts` | `renderSessionContext` 中建立 `entryId → Component` 的 Map |

### 关键挑战：entry → component 映射

当前 `buildSessionContext()` 返回 `AgentMessage[]`，不携带 entry ID。需要建立 entry → message → component 的映射。

**方案**：修改 `renderSessionContext` 使其在渲染消息时同时追踪 entry ID。具体做法：

1. `buildSessionContext` 返回的 messages 来自 entry path 的遍历，message entry 与 AgentMessage 一一对应
2. 在 `renderSessionContext` 中，改为同时遍历 entry path（从 SessionManager 获取），为每个渲染的消息组件注册 entry ID
3. 维护 `this.entryIdToComponent: Map<string, Component>`
4. Peek 时通过这个 Map 找到目标组件，计算其在 chatContainer 中的位置，滚动定位

**分支判断**：peek 时检查目标 entryId 是否在当前 branch path（root → leaf）上。通过 `SessionManager.getBranch()` 获取当前分支的 entry 列表来判断。

### 滚动定位

TUI 组件层级：`chatContainer`（滚动容器）→ 消息组件们。需要：

1. 从 Map 获取目标组件
2. 计算目标组件相对于 chatContainer 内容的行偏移
3. 设置 chatContainer 的 scroll offset 到该位置
4. 触发一次渲染，可选地给目标组件加临时高亮样式

## 功能2：Revert + Git 回滚

### Git 快照机制

**时机**：用户发送消息时（`AgentSession.prompt()` 开始时，在构建 messages 之前）。

**采集方式**：`git stash create --include-untracked`

这个命令：

- 创建一个代表当前完整工作区状态的 git commit 对象（tracked 修改 + staged + untracked）
- **不修改工作区、暂存区或 stash 栈**
- 返回 commit SHA（工作区干净时返回空字符串）

**防止 gc**：为每个快照创建 ref `refs/pi-snapshots/<entry-id>` → `<stashCommit>`，避免 git 回收未引用对象。用户可通过 `git update-ref -d refs/pi-snapshots/<entry-id>` 手动清理。

**存储**：CustomEntry，`customType: "git_snapshot"`

```typescript
interface GitSnapshotData {
  head: string;                    // HEAD commit hash（git rev-parse HEAD）
  stashCommit: string | null;      // git stash create --include-untracked 结果
  clean: boolean;                  // 工作区是否干净（stash create 返回空 = 干净）
}
```

### Revert 流程

1. 用户在 tree 中选中节点 → Enter → 选择 "Revert"
2. 从目标节点向上遍历 entry path，找最近的 `git_snapshot` CustomEntry
3. 如果找不到快照 → 提示 "该节点无 git 快照"
4. 执行 `git status --porcelain` 检查当前工作区
5. 如果有未提交变更 → 弹出警告选择器："检测到未提交变更，确认回滚？"（选项：确认回滚 / 取消）
6. 用户确认后执行 git 恢复：

```bash
# 1. 清空当前工作区变更
git checkout -- .
git clean -fd                      # 删除当前 untracked 文件

# 2. 如果快照 HEAD 与当前不同，恢复 tracked 文件到快照 HEAD 的内容
git checkout <snapshot.head> -- .

# 3. 如果快照有工作区变更（stashCommit 非空），恢复完整工作区状态
git stash apply <snapshot.stashCommit>
```

1. 执行 `session.navigateTree(targetId)` 切换 session 分支
2. 提示 "已回滚到目标节点"

### 快照清理

- Session 加载时扫描所有 `git_snapshot` CustomEntry，为存在的 stashCommit 重新创建 ref（防止 ref 被手动删除后 gc）
- Session 关闭时可选清理 `refs/pi-snapshots/*`（后续迭代考虑）

### 技术实现

| 改动 | 文件 | 内容 |
| ------ | ------ | ------ |
| Git 快照管理器 | 新建 `core/git-snapshot.ts` | `takeSnapshot(cwd): Promise<GitSnapshotData \| null>` / `restoreSnapshot(cwd, snapshot): Promise<void>` / `hasUncommittedChanges(cwd): Promise<boolean>` / `protectSnapshot(entryId, stashCommit, cwd): Promise<void>` |
| 快照采集 | `core/agent-session.ts` | `prompt()` 开始时调用 `takeSnapshot`，存储 CustomEntry |
| Revert 逻辑 | `modes/interactive/interactive-mode.ts` | 操作选择器中选择 Revert 时：查找快照 → 检查工作区 → 警告确认 → 恢复 git → navigateTree |

### 错误处理

- `git stash apply` 冲突 → 捕获错误，提示用户手动解决
- 非 git 仓库 → takeSnapshot 返回 null（不存储快照），revert 提示 "非 git 仓库，无法回滚"
- 快照 ref 已被 gc → 提示 "git 快照已过期，无法回滚"

## 实现顺序

1. **Phase 1：Peek** — 操作选择器改造 + entry→component 映射 + 滚动定位
2. **Phase 2：Revert** — git-snapshot 模块 + 快照采集 + revert 逻辑

## 测试

### Peek 测试

- 在当前分支上 peek 一个消息节点 → 聊天滚动到该消息
- peek 不在当前分支的节点 → 提示无法定位
- peek 非消息类型节点 → 提示无可定位消息
- peek 后继续对话仍在原分支

### Revert 测试

- 发消息修改文件 → revert 到之前节点 → 文件内容恢复
- 创建 untracked 文件后 revert → untracked 文件被正确恢复
- 有未提交变更时 revert → 弹出警告
- 非 git 仓库 revert → 提示无法回滚

### 操作选择器测试

- Enter 后默认选中 Peek
- Escape 回到 tree 视图
- Navigate / Navigate with summary / Navigate with custom prompt 保持原有行为
