# 命令后台运行设计文档

## 概述

为 Pi 的 bash 工具添加后台运行能力：命令超时后不报错，而是自动转为后台运行；新增 `Ctrl+Down` 快捷键打开后台进程管理界面；进程结束后自动通过 follow-up message 通知 agent 继续执行下一步。

## 需求

- **超时转后台**：bash 命令达到超时阈值后，不杀进程，转为后台运行，工具正常返回
- **超时阈值**：工具参数 `timeout` > settings 全局配置 `bashBackgroundTimeout`（默认 120s）> 无超时
- **完成通知**：进程退出后注入 user message（followUpQueue），不打断 agent 当前任务
- **管理界面**：`Ctrl+Down` 打开后台进程列表，支持查看输出 + 手动 Kill
- **生命周期**：后台进程必须是 pi agent 的子进程，退出时统一清理

## 架构

### 组件关系

```
createBashToolDefinition (bash.ts)
│   超时触发时不再 killProcessTree
│   → 调用 backgroundManager.spawn()
│   → 工具返回 "命令已转入后台运行" 给 agent
│
BackgroundProcessManager (新增)
│   ├── 注册表：Map<id, BackgroundProcess>
│   ├── 持续捕获 stdout/stderr (OutputAccumulator)
│   ├── 进程退出监听 → 组装通知消息
│   └── 生命周期绑定：trackDetachedChildPid
│
AgentSession
│   backgroundManager 实例持有者
│   注入 followUp 通知消息
│
InteractiveMode
│   ctrl+Down → showBackgroundProcesses()
│   └── BackgroundProcessSelector (新增 UI 组件)
│
KeybindingsManager
    app.backgroundProcesses → ctrl+down
```

### 文件结构

```
packages/coding-agent/src/
├── core/
│   ├── background-process-manager.ts          // 新增：后台进程管理器
│   ├── tools/
│   │   └── bash.ts                             // 修改：超时转后台逻辑
│   ├── settings-manager.ts                     // 修改：新增 bashBackgroundTimeout
│   └── keybindings.ts                          // 修改：新增 app.backgroundProcesses
└── modes/interactive/
    ├── interactive-mode.ts                     // 修改：注册 handler + showBackgroundProcesses
    └── components/
        └── background-process-selector.ts      // 新增：后台进程列表 UI
```

## 核心类型

### BackgroundProcess

```typescript
interface BackgroundProcess {
  id: string;                        // UUID
  pid: number;                       // 子进程 PID
  command: string;                   // 原始命令
  cwd: string;                       // 工作目录
  startedAt: number;                 // 启动时间戳
  endedAt?: number;                  // 结束时间戳
  exitCode?: number | null;          // 退出码（结束后填入）
  status: "running" | "completed";   // 状态
  output: OutputAccumulator;         // 持续捕获的输出
  child: ChildProcess;               // 子进程引用
}
```

### BackgroundProcessManager

```typescript
interface BackgroundProcessManager {
  spawn(command, cwd, env, hooks): BackgroundProcess;   // 注册并监听子进程
  kill(id: string): void;                               // 手动 kill 某个后台进程
  getAll(): BackgroundProcess[];                         // 获取所有后台进程（供 UI 使用）
  getById(id: string): BackgroundProcess | undefined;
  killAll(): void;                                      // 退出时清理
  onCompleted(cb: (proc: BackgroundProcess) => void): void;  // 注册完成回调
}
```

## 数据流

### 超时转后台

```
1. bash.execute() 调用 ops.exec(command, cwd, { timeout })
2. ops.exec 内部 spawn 子进程，设置 timeout timer
3. 超时触发：
   ├─ 旧逻辑：killProcessTree(pid) → throw "timeout:N"
   └─ 新逻辑：将 child 进程交给 BackgroundProcessManager
       ├─ 清除 timeout timer（不再 kill）
       ├─ 返回特殊状态 { backgrounded: true, backgroundId, pid }
       └─ 工具 execute() 收到后返回 "命令已转入后台运行，PID: xxx，结束后会通知你"
4. agent 收到工具结果，知道命令在后台运行，可继续其他工作
```

### 进程完成通知

```
1. BackgroundProcessManager 监听 child.on('close')
2. 进程退出：
   ├─ 记录 exitCode、endedAt
   ├─ output.finish() 拿到最终输出快照
   ├─ status 设为 "completed"
   ├─ untrackDetachedChildPid(pid)
   └─ 触发 onCompleted 回调 + emitChange
3. AgentSession 的 onCompleted 回调：
   ├─ 组装通知文本："[后台命令完成] `make build` 退出码 0，输出:\n...（完整输出: /tmp/...）"
   └─ 根据 agent 状态选择注入方式：
       ├─ agent 正在 streaming → 放入 followUpQueue，等当前 turn 结束后处理
       └─ agent 空闲 → 直接调用 prompt() 触发新 turn
4. agent 收到通知，决定下一步
```

### ctrl+Down 管理界面

```
1. 用户按 ctrl+Down
2. InteractiveMode.showBackgroundProcesses()
3. showSelector() 替换 editorContainer 为 BackgroundProcessSelector
4. 列表展示每个后台进程：命令 / PID / 运行时长 / 状态 / 退出码
5. 交互：
   ├─ Enter：查看选中进程的完整输出（展开到 terminal 或打开临时文件）
   ├─ k / ctrl+k：Kill 运行中的进程
   └─ Escape：关闭界面
```

## 超时阈值优先级

```
工具参数 timeout（LLM 传入）  ──最高优先──→  超时转后台
        ↓ (未传入)
settings.bashBackgroundTimeout  ──默认 120s──→  超时转后台
        ↓ (未配置)
无超时（无限等待，与当前行为一致）
```

## 生命周期管理

- 后台进程注册到 `trackedDetachedChildPids`，确保 pi 退出时 `killTrackedDetachedChildren()` 统一杀死
- `BackgroundProcessManager.killAll()` 在 AgentSession 销毁时调用
- 后台进程使用 `detached: true` + 进程组（`process.kill(-pid)`），与现有 bash 一致

## 输出截断策略

后台进程输出复用 `OutputAccumulator`，截断策略与前台 bash 一致：
- 默认 250 行 / 200KB（`DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`）
- 超出存临时文件，通知消息中附上路径

## 约束与边界情况

1. **多个后台进程同时运行**：管理器支持多个并发后台进程，列表 UI 按启动时间排序
2. **agent 正在执行任务时进程完成**：通知进入 followUpQueue，不打断当前任务
3. **pi 退出时后台进程仍在运行**：统一 kill
4. **手动 kill 后台进程**：status 标记为 completed，exitCode 记录为 null（被信号杀死），仍发送通知

## 实现步骤

1. 新建 `background-process-manager.ts`：注册表 + 输出捕获 + 退出监听
2. 改造 `bash.ts`：超时转后台逻辑
3. 接入 `AgentSession`：持有 manager 实例 + 注册 onCompleted 回调注入 followUp
4. 新增 settings 配置项 `bashBackgroundTimeout`
5. 新增 keybinding `app.backgroundProcesses`
6. 新增 `BackgroundProcessSelector` UI 组件
7. InteractiveMode 注册 ctrl+Down handler + showBackgroundProcesses

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `core/background-process-manager.ts` | 新增 | 后台进程管理器 |
| `core/tools/bash.ts` | 修改 | 超时转后台逻辑 |
| `core/settings-manager.ts` | 修改 | 新增 bashBackgroundTimeout |
| `core/keybindings.ts` | 修改 | 新增 app.backgroundProcesses |
| `core/agent-session.ts` | 修改 | 持有 manager + onCompleted 回调 |
| `modes/interactive/components/background-process-selector.ts` | 新增 | 后台进程列表 UI |
| `modes/interactive/interactive-mode.ts` | 修改 | 注册 handler + showBackgroundProcesses |
| `core/sdk.ts` | 修改 | 传递 manager 给 bash 工具 |
