# Goal 功能设计：自主编排执行

> **日期**: 2026-07-23
> **状态**: 设计已确认，待 review
> **方案**: B（状态化编排 + agent_end 自动驱动）
> **归属**: 内置扩展（dist-assets/extensions/goal.ts），随发行

## 目标

为 Pi 增加"自主编排执行"能力：用户输入一个高层目标 → agent 自动分解为子任务 → 调度 subagent 执行 → 追踪进度 → 遇阻自主调整 → 循环直到目标完成。

全自动无人值守，核心运行时零改动，完全通过 ExtensionAPI 实现。

## 背景与现状

### 现有能力空白

| 能力 | 实现 | 局限 |
| ------ | ------ | ------ |
| Plan Agent | 内置 primary agent（只读规划） | 产出计划，**不执行** |
| Build Agent | 内置 primary agent（全工具） | 单轮对话式，无目标追踪 |
| Subagent | `subagents/*.md`（explorer/worker/reviewer） | 单次委托，不持久，无跨轮目标 |
| Plan Mode | 扩展（非核心） | 交互式规划，不自动执行 |
| Todo | 外部插件 `@juicesharp/rpiv-todo` | 非内置，纯任务清单，无编排 |
| Handoff | 扩展 `/handoff <goal>` | 转移上下文到新 session |

**空白**：无"设定目标 → 自主分解 → 调度执行 → 追踪进度 → 循环完成"的端到端机制。plan（规划）和 build（执行）割裂，无自动衔接和进度追踪。

### 关键技术可行性（已验证）

| 能力 | 验证结果 | 机制 |
| ------ | --------- | ------ |
| `/goal` 命令触发编排 | ✅ | `registerCommand` + `sendUserMessage()` 始终触发 turn |
| 多 turn 自动驱动 | ✅ | `agent_end` 事件中 `pi.sendMessage({triggerTurn:true})` 启动新 turn |
| subagent 调度 | ✅ | `runSubagents` parallel/chain，上限 8 任务/并发 4 |
| goal 状态持久化 | ✅ | `appendEntry(customType, data)` → CustomEntry（不入 LLM 上下文） |
| 读取持久化状态 | ✅ | `getBranch()` → 过滤最新 goal entry |
| 持续注入编排上下文 | ✅ | `before_agent_start` hook 修改 systemPrompt + `nextTurn` 消息 |
| 结构化进度更新 | ✅ | `registerTool` 注册 `updateGoal` LLM 工具 |
| 中断 | ✅ | `ctx.abort()` + `/goal:abort` 命令 |
| 硬性 maxTurns 护栏 | ⚠️ 编排层自计数 | loop guard 未实现（仅有设计文档），编排层独立计数 |

## 架构

### 整体流程

```
用户输入: /goal 把这个项目的测试覆盖率提升到 80%
  │
  ▼
┌──────────────────────────────────────────────────────┐
│  Extension: goal.ts                                   │
│                                                        │
│  ① registerCommand("goal", handler)                   │
│     → 创建 GoalState，appendEntry("goal", state)      │
│     → sendUserMessage(orchestrationPrompt)            │
│                                                        │
│  ② registerTool("updateGoal")                         │
│     → LLM 调用更新 task 状态                           │
│     → 更新 GoalState，appendEntry                     │
│                                                        │
│  ③ on("before_agent_start", handler)                  │
│     → 检测 activeGoal，注入编排指令到 systemPrompt     │
│                                                        │
│  ④ on("agent_end", handler)                           │
│     → 检查 goal 状态：未完成 → sendMessage(trigger)   │
│     → 已完成/失败/超限 → 清理 activeGoal              │
│                                                        │
│  ⑤ registerCommand("goal:status", ...)                │
│  ⑥ registerCommand("goal:abort", ...)                 │
└──────────────────────────────────────────────────────┘
```

### 设计原则

- **编排状态机**：goal 扩展叠加在现有 agent loop 之上，不修改核心运行时
- **状态持久化**：GoalState 存储在 CustomEntry（不入 LLM 上下文），compaction 不影响
- **三层 prompt 注入**：初始编排 prompt + 每轮 systemPrompt 追加 + 每轮 nextTurn 进度快照
- **结构化进度更新**：LLM 通过 updateGoal 工具更新状态，比解析文本更可靠

## 数据模型

```typescript
interface GoalTask {
  id: string;              // "t1", "t2"...
  description: string;     // "为 src/utils/date.ts 补充单元测试"
  status: "pending" | "in_progress" | "done" | "failed" | "skipped";
  result?: string;         // 执行结果摘要
  retryCount: number;      // 重试计数
}

interface GoalState {
  id: string;              // UUID
  target: string;          // 原始目标："把测试覆盖率提升到 80%"
  createdAt: number;       // 创建时间戳
  status: "planning" | "executing" | "completed" | "failed" | "aborted";
  tasks: GoalTask[];       // 分解的子任务列表
  turnCount: number;       // 已执行轮次（护栏计数）
  maxTurns: number;        // 硬上限（默认 50）
  summary?: string;        // 最终总结（完成/失败时填写）
  consecutiveSameCalls: number;  // 循环检测计数
  lastToolCallSignature?: string; // 上次 tool call 签名（用于循环检测）
}
```

### 持久化

- **写入**：`appendEntry("goal", state)` → CustomEntry（不进入 LLM 上下文）
- **每次状态更新**追加新 entry（append-only，可追溯历史）
- **读取**：`getBranch()` → 过滤 `type === "custom"` 且 `customType === "goal"` 的最新 entry
- **compaction 安全**：CustomEntry 不参与 LLM 上下文，compaction 不影响 goal 状态

## 编排状态机

```
                    /goal <target>
                          │
                          ▼
                   ┌─── PLANNING ────┐
                   │ 创建 GoalState   │
                   │ status=planning  │
                   │ 注入分解 prompt   │
                   └───────┬──────────┘
                           │ (LLM 分解出 tasks)
                           │ (updateGoal: tasks=[...])
                           ▼
                   ┌─── EXECUTING ────┐
              ┌───→│ status=executing  │←───────────────┐
              │    │ 注入执行 prompt    │                │
              │    └───────┬───────────┘                │
              │            │ (LLM 调度 subagent)          │
              │            ▼                             │
              │    ┌─── agent_end ────┐                 │
              │    │ 检查 goal 状态    │                 │
              │    └───┬──────┬───────┘                 │
              │   未完成│      │已完成                     │
              │        │      ▼                          │
              │        │  COMPLETED                      │
              │        │  (清理, 汇报)                    │
              │        ▼                                 │
              │  turnCount < maxTurns?                   │
              │     ├─ Yes: triggerTurn (自动继续) ──────┘
              │     └─ No: FAILED (超限, 停止)
              │
              └── (用户 /goal:abort → ABORTED)
```

### 完成判断逻辑（agent_end 时）

```
function checkGoalCompletion(state: GoalState): "continue" | "completed" | "failed" {
  // 1. 用户主动中止
  if (state.status === "aborted") return "failed";

  // 2. maxTurns 超限
  if (state.turnCount >= state.maxTurns) return "failed";

  // 3. 所有 tasks 已终态（done/failed/skipped）
  const allTerminal = state.tasks.every(t =>
    t.status === "done" || t.status === "failed" || t.status === "skipped"
  );
  if (!allTerminal) return "continue";

  // 4. 全部 done → completed
  const allDone = state.tasks.every(t => t.status === "done" || t.status === "skipped");
  if (allDone) return "completed";

  // 5. 有 failed 但无 pending → failed
  return "failed";
}
```

## Prompt 设计（三层注入）

### ① 初始编排 Prompt

`/goal` 命令时通过 `sendUserMessage` 发送：

```
## 🎯 目标编排模式已激活

你的目标：{target}

### 工作流程
1. **分解**：将目标拆分为可独立验证的子任务（3-12 个）
2. **执行**：对每个子任务，使用 subagent 工具调度 worker/reviewer
3. **追踪**：每完成一个子任务，调用 updateGoal 工具更新进度
4. **循环**：所有子任务完成后，验证整体目标是否达成
5. **收尾**：产出最终总结

### updateGoal 工具用法
调用 updateGoal 更新任务状态：
- 开始子任务时：taskId, status="in_progress"
- 完成子任务时：taskId, status="done", result="结果摘要"
- 子任务失败时：taskId, status="failed", result="失败原因"

### 完成标准
目标达成的定义：{target}
必须通过具体验证（运行测试、检查覆盖率等），不能自我宣称完成。

### 护栏
- 最大轮次：{maxTurns}
- 每个子任务最多重试 2 次
- 遇到阻塞性问题（无法绕过）时标记失败并停止
```

### ② 持续上下文注入（before_agent_start hook）

每轮 `before_agent_start` 检测 activeGoal，返回修改后的 `systemPrompt`（在原 systemPrompt **末尾追加**编排上下文）：

```
## 🎯 当前 Goal 编排（自动模式）

目标：{target}
进度：{doneCount}/{totalCount} tasks completed
待办：{pendingTasks 一行摘要}

你正在自主编排模式下工作。继续执行下一个待办子任务。
所有子任务完成后，验证整体目标并调用 updateGoal 标记 goal 完成。
```

### ③ 进度快照注入（每轮 nextTurn 消息）

每轮 turn 开始前通过 `nextTurn` 消息注入进度快照：

```
[Goal 进度] 已完成 3/8 | 进行中: t4(补充 date.ts 测试) | 待办: t5,t6,t7,t8
```

## updateGoal 工具

### 工具定义

```typescript
registerTool({
  name: "updateGoal",
  description: "更新当前 goal 的子任务状态。在编排模式下使用。",
  inputSchema: Type.Object({
    taskId: Type.String({ description: "子任务 ID（如 t1, t2）" }),
    status: Type.Union([
      Type.Literal("in_progress"),
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
    ]),
    result: Type.Optional(Type.String({ description: "结果摘要或失败原因" })),
  }),
  execute: async (_toolCallId, params) => {
    // 1. 读取当前 GoalState
    // 2. 更新对应 task 状态
    // 3. retryCount 管理（failed 时检查是否可重试）
    // 4. appendEntry("goal", updatedState)
    // 5. 返回确认信息
    return {
      content: [{ type: "text", text: `Task ${params.taskId} → ${params.status}` }],
    };
  },
});
```

### 重试逻辑

- task status=failed 时，检查 `retryCount < 2`：是 → 重置为 pending（retryCount++），否 → 保持 failed
- 工具返回中包含重试提示：`Task t3 failed, retrying (1/2)` 或 `Task t3 failed permanently`

## 护栏机制

| 护栏 | 实现 | 默认值 |
| ------ | ------ | -------- |
| **maxTurns** | 编排层 turnCount 自计数，agent_end 时检查，超限 → status=failed | 50 |
| **循环检测** | 检测连续相同 tool call 签名 → consecutiveSameCalls++，超 3 次注入纠正消息 | 3 次 |
| **子任务重试上限** | 每个 task 独立 retryCount，updateGoal 工具内管理 | 2 次 |
| **abort** | `/goal:abort` 命令 → status=aborted，agent_end 不再驱动 | — |
| **错误兜底** | subagent 返回 failed → updateGoal 标记 task=failed，不无限重试 | — |
| **并发安全** | GoalState 在扩展闭包中维护（内存），单 session 单 goal | — |

### 循环检测

```
function detectLoop(state: GoalState, currentToolCallSignature: string): boolean {
  if (state.lastToolCallSignature === currentToolCallSignature) {
    state.consecutiveSameCalls++;
    if (state.consecutiveSameCalls >= 3) {
      // 注入纠正消息
      return true;
    }
  } else {
    state.consecutiveSameCalls = 0;
    state.lastToolCallSignature = currentToolCallSignature;
  }
  return false;
}
```

纠正消息（通过 nextTurn 注入）：

```
⚠️ 检测到循环行为（连续 3 次相同操作）。请改变策略或标记当前子任务为 failed。
```

## 运行时可见性

goal 编排不是黑盒——agent 的每一步操作都通过标准 TUI 对话流实时可见，无需额外开发。补充的结构化视图（footer + 命令）提供汇总进度。

### 对话流（天然可见，零开发成本）

goal 编排走的是标准 agent loop，所有操作在对话窗口实时渲染：

| 实时可见内容 | 渲染来源 |
| ------------ | -------- |
| Agent 的思考/规划文本 | assistant message 流式输出 |
| 每次 tool call（read/bash/edit/write...） | tool-execution 组件渲染 |
| **subagent 调度**（谁、做什么、结果） | subagents-panel 组件渲染 |
| `updateGoal` 调用（task 状态变更） | 作为 tool call 渲染，显示 `t1 → done` |

用户体验等同于看一场正常的 agent 对话，区别仅在于 agent 会**自动连续跑多个 turn**，不需要用户每轮按 Enter。

### Footer 进度指示

Footer 底栏额外显示一行（利用现有 footer 渲染管道）：

```
 build • glm-5.2 • max    🎯 goal: 3/8 (executing)    ~/work/foo  ✓main
```

状态语义：`executing`（执行中）| `planning`（分解中）| `completed`（已完成）| `failed`（失败）| `aborted`（已中止）。

> 降级：若 footer data provider API 不可用，省略此行，仅通过 `/goal:status` 查看。

### `/goal:status` 结构化进度

随时查看完整任务列表和状态：

```
🎯 把测试覆盖率提升到 80%
  ✅ t1: 分析当前覆盖率 (45%)
  🔄 t2: 为 src/utils/ 补充测试
  ❌ t3: 为 src/core/ 补充测试 (失败, 重试 1/2)
  ⬜ t4-t8: 待执行
  进度: 1/8 | 轮次: 3/50
```

### 编排中用户介入

编排过程中用户**仍可打字**——消息通过现有 steer 机制注入当前 turn。用户可以：

- 补充指令或约束（"注意不要动 src/legacy/ 目录"）
- 纠正方向（"t4 不需要做了，直接跳到 t5"）
- 中止编排（`/goal:abort`）

## 用户交互

### 命令

| 命令 | 作用 |
| ------ | ------ |
| `/goal <target>` | 启动编排，创建 GoalState，触发首个 turn |
| `/goal:status` | 查看当前 goal 进度（任务列表 + 状态） |
| `/goal:abort` | 中止编排，设置 status=aborted |

### 状态显示

- **Footer**（如 `registerFooterDataProvider` 可用）：`🎯 goal: 3/8 (executing)` 或 `🎯 goal: completed`
- **降级**：API 不可用时，仅通过 `/goal:status` 命令查看

### 交互示例

```
用户: /goal 把测试覆盖率提升到 80%
[goal] 🎯 目标编排已启动。Agent 将自主分解并执行。

Agent: [分解出 8 个子任务]
  t1: 分析当前覆盖率
  t2: 为 src/utils/ 补充测试
  ...
  t8: 运行覆盖率验证

Agent: [调用 subagent 执行 t1...]
Agent: [updateGoal: t1=done, result="当前覆盖率 45%"]
Agent: [继续 t2...]

用户: /goal:status
[goal] 🎯 把测试覆盖率提升到 80%
  ✅ t1: 分析当前覆盖率 (45%)
  🔄 t2: 为 src/utils/ 补充测试
  ⬜ t3-t8: 待执行
  进度: 1/8 | 轮次: 3/50

用户: /goal:abort
[goal] 编排已中止。已完成 1/8 子任务。
```

## 文件变更

| 文件 | 变更类型 | 说明 |
| ------ | --------- | ------ |
| `packages/coding-agent/dist-assets/extensions/goal.ts` | **新建** | ~400 行，编排扩展 |
| `packages/coding-agent/dist-assets/install.sh` | 修改 | 新增 `"file:goal.ts"` 到 EXT_INSTALLS |
| `packages/coding-agent/dist/extensions/goal.ts` | 新建 | 构建产物同步 |
| `packages/coding-agent/CHANGELOG.md` | 修改 | `### Added`: goal 自主编排扩展 |
| `packages/coding-agent/docs/extensions.md` | 修改 | 如有扩展列表，补充 goal 说明 |

**核心运行时零改动**——所有能力通过 ExtensionAPI 实现。

## 已知风险与缓解

| 风险 | 影响 | 缓解 |
| ------ | ------ | ------ |
| LLM 过早宣称"完成" | goal 提前结束 | 完成判断不依赖 LLM 自述，agent_end 时检查 tasks 全部终态；prompt 强约束"必须验证" |
| compaction 丢失编排上下文 | 编排指令消失 | GoalState 在 CustomEntry（不入 LLM），compaction 不影响；`before_agent_start` 每轮重新注入 |
| 上下文爆炸（长目标） | token 耗尽 | 依赖现有 compaction + 每轮只注入进度摘要（非完整历史） |
| `sendUserMessage` 在 streaming 时排队 | 自动驱动失败 | agent_end 时 `isStreaming=false`，triggerTurn 安全；代码中防御性检查 |
| footer API 可能不存在 | 无法实时显示进度 | 降级为纯命令交互（/goal:status） |
| subagent 并发限制（max 8） | 大目标无法一次全部并行 | 编排 prompt 指导分批调度；不违反 MAX_PARALLEL_TASKS |
| 用户在编排中手动输入消息 | 干扰编排 | steer/followUp 机制天然支持用户中途介入；用户消息作为 steer 注入 |

## 非目标（YAGNI）

以下功能**不在本次范围**，避免过度设计：

- ❌ TUI 专属 goal 进度面板（用 footer + 命令即可）
- ❌ 多 goal 并行（单 session 单 goal 足够）
- ❌ goal 模板/预设（直接输入目标即可）
- ❌ goal 跨 session 恢复（session 结束 goal 自然终止）
- ❌ 核心 loop guard 集成（编排层自计数足够）
