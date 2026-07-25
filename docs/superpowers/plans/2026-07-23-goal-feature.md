# Goal 自主编排扩展 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个内置编排扩展，用户输入 `/goal <target>` 后 agent 自主分解任务、调度 subagent 执行、追踪进度、循环直到目标完成——全程无人值守。

**Architecture:** 单个扩展文件 `goal.ts`，通过 ExtensionAPI 实现：`registerCommand` 注册 `/goal`、`/goal:status`、`/goal:abort`；`registerTool` 注册 `updateGoal` LLM 工具；`on("before_agent_start")` 每轮注入编排上下文；`on("agent_end")` 检查状态并自动驱动下一轮。核心运行时零改动。

**Tech Stack:** TypeScript, TypeBox (schema), Pi ExtensionAPI (`@schovest/pi-coding-agent`)

**Spec:** `docs/superpowers/specs/2026-07-23-goal-feature-design.md`

## Global Constraints

- 扩展文件路径：`packages/coding-agent/dist-assets/extensions/goal.ts`
- Import 来源：`@schovest/pi-coding-agent`（ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition, TypeBox）
- 默认 export：`export default function (pi: ExtensionAPI): void`
- 状态持久化：`pi.appendEntry("goal", state)` → CustomEntry（不入 LLM 上下文）
- 状态读取：`ctx.sessionManager.getBranch()` → 过滤 `customType === "goal"` 的最新 entry
- 单 session 单 goal（全局闭包变量 `activeGoal: GoalState | undefined`）
- AGENTS.md 规范：无 `any`（除无可行类型表达处局部化）、无 inline import、代码变更后跑 `npm run check`

---

## File Structure

| 文件 | 责任 |
| ------ | ------ |
| `packages/coding-agent/dist-assets/extensions/goal.ts` | **新建** — 完整编排扩展（状态管理 + 命令 + 工具 + 事件 hooks） |
| `packages/coding-agent/dist-assets/install.sh` | 修改 — 新增 `"file:goal.ts"` 到 EXT_INSTALLS |
| `packages/coding-agent/dist/extensions/goal.ts` | 构建产物同步（`npm run build` 自动生成） |
| `packages/coding-agent/CHANGELOG.md` | 修改 — 新增 Added 条目 |

---

## Task 1: 扩展骨架 + 数据模型 + 状态管理

**Files:**

- Create: `packages/coding-agent/dist-assets/extensions/goal.ts`

**Interfaces:**

- Produces: `GoalTask`, `GoalState` 类型；`createGoal(target, maxTurns)` 工厂函数；闭包变量 `activeGoal`

- [ ] **Step 1: 创建扩展文件骨架**

```typescript
import { randomUUID } from "node:crypto";
import type { Type } from "typebox";
import type {
 ExtensionAPI,
 ExtensionContext,
 ExtensionCommandContext,
} from "@schovest/pi-coding-agent";

// ============================================================================
// 类型定义
// ============================================================================

interface GoalTask {
 id: string;
 description: string;
 status: "pending" | "in_progress" | "done" | "failed" | "skipped";
 result?: string;
 retryCount: number;
}

interface GoalState {
 id: string;
 target: string;
 createdAt: number;
 status: "planning" | "executing" | "completed" | "failed" | "aborted";
 tasks: GoalTask[];
 turnCount: number;
 maxTurns: number;
 summary?: string;
 consecutiveSameCalls: number;
 lastToolCallSignature?: string;
}

// ============================================================================
// 状态管理（模块级，单 session 单 goal）
// ============================================================================

let activeGoal: GoalState | undefined;

function createGoal(target: string, maxTurns = 50): GoalState {
 return {
  id: randomUUID(),
  target,
  createdAt: Date.now(),
  status: "planning",
  tasks: [],
  turnCount: 0,
  maxTurns,
  summary: undefined,
  consecutiveSameCalls: 0,
 };
}

/** 从 session branch 读取最新的 goal 状态 */
function loadGoalFromSession(ctx: ExtensionContext): GoalState | undefined {
 const branch = ctx.sessionManager.getBranch();
 for (let i = branch.length - 1; i >= 0; i--) {
  const entry = branch[i];
  if (
   entry.type === "custom"
   && (entry as { customType?: string }).customType === "goal"
   && (entry as { data?: GoalState }).data
  ) {
   return (entry as { data: GoalState }).data;
  }
 }
 return undefined;
}

/** 持久化当前 goal 状态到 session */
function persistGoal(pi: ExtensionAPI): void {
 if (!activeGoal) return;
 pi.appendEntry("goal", activeGoal);
}

export default function goalExtension(pi: ExtensionAPI): void {
 // Task 2-5 将在此函数内填充
}
```

- [ ] **Step 2: 验证 TypeScript 编译无误**

Run: `npx tsgo --noEmit packages/coding-agent/dist-assets/extensions/goal.ts 2>&1 | head -20`

> 注：独立文件编译可能因 tsconfig 路径解析报 import 错误，这是正常的——只要没有语法错误。后续 `npm run build` 时会正确解析。

Expected: 无语法错误（import 路径解析错误可接受）

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/dist-assets/extensions/goal.ts
git commit -m "feat(goal): add extension skeleton with data model and state management"
```

---

## Task 2: 完成判断 + 循环检测工具函数

**Files:**

- Modify: `packages/coding-agent/dist-assets/extensions/goal.ts`

**Interfaces:**

- Consumes: `GoalState` (from Task 1)
- Produces: `checkGoalCompletion(state)`, `detectLoop(state, signature)`, `formatProgress(state)`, `formatStatus(state)`

- [ ] **Step 1: 在 `goalExtension` 函数前添加完成判断逻辑**

在 `persistGoal` 函数后、`goalExtension` 函数前插入：

```typescript
// ============================================================================
// 编排逻辑
// ============================================================================

type CompletionResult = "continue" | "completed" | "failed";

function checkGoalCompletion(state: GoalState): CompletionResult {
 // 1. 用户主动中止
 if (state.status === "aborted") return "failed";

 // 2. maxTurns 超限
 if (state.turnCount >= state.maxTurns) return "failed";

 // 3. 所有 tasks 已终态（done/failed/skipped）
 const allTerminal = state.tasks.every(
  (t) => t.status === "done" || t.status === "failed" || t.status === "skipped",
 );
 if (!allTerminal) return "continue";

 // 4. 全部 done/skipped → completed
 const allDone = state.tasks.every(
  (t) => t.status === "done" || t.status === "skipped",
 );
 if (allDone) return "completed";

 // 5. 有 failed 但无 pending → failed
 return "failed";
}

const LOOP_THRESHOLD = 3;

function detectLoop(state: GoalState, signature: string): boolean {
 if (state.lastToolCallSignature === signature) {
  state.consecutiveSameCalls++;
  if (state.consecutiveSameCalls >= LOOP_THRESHOLD) {
   return true;
  }
 } else {
  state.consecutiveSameCalls = 0;
  state.lastToolCallSignature = signature;
 }
 return false;
}

// ============================================================================
// 格式化
// ============================================================================

const TASK_ICONS: Record<GoalTask["status"], string> = {
 pending: "⬜",
 in_progress: "🔄",
 done: "✅",
 failed: "❌",
 skipped: "⏭️",
};

function formatProgress(state: GoalState): string {
 const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
 const total = state.tasks.length;
 const inProgress = state.tasks.find((t) => t.status === "in_progress");
 const part = inProgress ? ` | 进行中: ${inProgress.id}(${truncate(inProgress.description, 30)})` : "";
 return `[Goal 进度] 已完成 ${done}/${total}${part}`;
}

function formatStatus(state: GoalState): string {
 const lines = [`🎯 ${state.target}`];
 for (const task of state.tasks) {
  const icon = TASK_ICONS[task.status];
  const result = task.result ? ` (${truncate(task.result, 40)})` : "";
  const retry = task.status === "failed" && task.retryCount > 0 ? ` [重试 ${task.retryCount}/2]` : "";
  lines.push(`  ${icon} ${task.id}: ${truncate(task.description, 50)}${retry}${result}`);
 }
 const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
 lines.push(`  进度: ${done}/${state.tasks.length} | 轮次: ${state.turnCount}/${state.maxTurns}`);
 return lines.join("\n");
}

function formatFooter(state: GoalState): string {
 const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
 const total = state.tasks.length;
 return `🎯 goal: ${done}/${total} (${state.status})`;
}

function truncate(text: string, max: number): string {
 return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** 构建每轮 before_agent_start 注入的编排上下文 */
function buildOrchestrationContext(state: GoalState): string {
 const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
 const pending = state.tasks
  .filter((t) => t.status === "pending" || t.status === "in_progress")
  .map((t) => `${t.id}`)
  .join(", ");
 return [
  "",
  "## 🎯 当前 Goal 编排（自动模式）",
  "",
  `目标：${state.target}`,
  `进度：${done}/${state.tasks.length} tasks completed`,
  `待办：${pending || "无"}`,
  "",
  "你正在自主编排模式下工作。继续执行下一个待办子任务。",
  "所有子任务完成后，验证整体目标并调用 updateGoal 标记 goal 完成。",
 ].join("\n");
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsgo --noEmit packages/coding-agent/dist-assets/extensions/goal.ts 2>&1 | grep -v "Cannot find" | head -10`

Expected: 无语法/类型逻辑错误

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/dist-assets/extensions/goal.ts
git commit -m "feat(goal): add completion check, loop detection, and formatting functions"
```

---

## Task 3: 注册 `/goal`、`/goal:status`、`/goal:abort` 命令

**Files:**

- Modify: `packages/coding-agent/dist-assets/extensions/goal.ts`

**Interfaces:**

- Consumes: `createGoal`, `persistGoal`, `formatStatus`, `formatFooter` (from Task 1-2)
- Produces: 三个 `pi.registerCommand` 调用

- [ ] **Step 1: 在 `goalExtension` 函数体内添加 `/goal` 命令**

```typescript
export default function goalExtension(pi: ExtensionAPI): void {
 // ========================================================================
 // 命令: /goal <target>
 // ========================================================================
 pi.registerCommand("goal", {
  description: "启动目标编排：agent 自主分解并执行直到目标完成",
  handler: async (args: string, ctx: ExtensionCommandContext) => {
   const target = args.trim();
   if (!target) {
    ctx.ui.notify("Usage: /goal <目标描述>", "error");
    return;
   }

   // 已有 active goal 则拒绝
   const existing = activeGoal ?? loadGoalFromSession(ctx);
   if (existing && (existing.status === "planning" || existing.status === "executing")) {
    ctx.ui.notify(
     `已有进行中的 goal: ${truncate(existing.target, 40)}。使用 /goal:abort 中止后再启动新的。`,
     "error",
    );
    return;
   }

   // 创建新 goal
   activeGoal = createGoal(target);
   persistGoal(pi);
   ctx.ui.notify(`🎯 目标编排已启动: ${truncate(target, 50)}`, "info");

   // 发送初始编排 prompt（触发首个 agent turn）
   const orchestrationPrompt = [
    "## 🎯 目标编排模式已激活",
    "",
    `你的目标：${target}`,
    "",
    "### 工作流程",
    "1. **分解**：将目标拆分为可独立验证的子任务（3-12 个）",
    "2. **执行**：对每个子任务，使用 subagent 工具调度 worker/reviewer",
    "3. **追踪**：每完成一个子任务，调用 updateGoal 工具更新进度",
    "4. **循环**：所有子任务完成后，验证整体目标是否达成",
    "5. **收尾**：产出最终总结",
    "",
    "### updateGoal 工具用法",
    "- 分解完成后：调用 updateGoal 设置所有子任务（每个 task 含 id, description, status=pending）",
    "- 开始子任务时：taskId, status=in_progress",
    "- 完成子任务时：taskId, status=done, result=结果摘要",
    "- 子任务失败时：taskId, status=failed, result=失败原因",
    "",
    "### 完成标准",
    `目标达成的定义：${target}`,
    "必须通过具体验证（运行测试、检查覆盖率等），不能自我宣称完成。",
    "",
    "### 护栏",
    `- 最大轮次：${activeGoal.maxTurns}`,
    "- 每个子任务最多重试 2 次",
    "- 遇到阻塞性问题（无法绕过）时标记失败并停止",
   ].join("\n");

   pi.sendUserMessage(orchestrationPrompt);
  },
 });

 // ========================================================================
 // 命令: /goal:status
 // ========================================================================
 pi.registerCommand("goal:status", {
  description: "查看当前 goal 的进度",
  handler: async (_args: string, ctx: ExtensionCommandContext) => {
   const goal = activeGoal ?? loadGoalFromSession(ctx);
   if (!goal) {
    ctx.ui.notify("当前没有活动的 goal", "info");
    return;
   }
   ctx.ui.notify(formatStatus(goal), "info");
  },
 });

 // ========================================================================
 // 命令: /goal:abort
 // ========================================================================
 pi.registerCommand("goal:abort", {
  description: "中止当前 goal 编排",
  handler: async (_args: string, ctx: ExtensionCommandContext) => {
   const goal = activeGoal ?? loadGoalFromSession(ctx);
   if (!goal) {
    ctx.ui.notify("当前没有活动的 goal", "info");
    return;
   }
   if (goal.status === "completed" || goal.status === "failed" || goal.status === "aborted") {
    ctx.ui.notify("Goal 已结束，无需中止", "info");
    return;
   }
   goal.status = "aborted";
   persistGoal(pi);
   const done = goal.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
   ctx.ui.notify(`编排已中止。已完成 ${done}/${goal.tasks.length} 子任务。`, "warn");
   activeGoal = undefined;
  },
 });

 // Task 4-5 将继续在此函数体内添加 tool 和 event hooks
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsgo --noEmit packages/coding-agent/dist-assets/extensions/goal.ts 2>&1 | grep -v "Cannot find" | head -10`

Expected: 无语法/类型逻辑错误

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/dist-assets/extensions/goal.ts
git commit -m "feat(goal): register /goal, /goal:status, /goal:abort commands"
```

---

## Task 4: 注册 `updateGoal` LLM 工具

**Files:**

- Modify: `packages/coding-agent/dist-assets/extensions/goal.ts`

**Interfaces:**

- Consumes: `activeGoal`, `persistGoal` (from Task 1), `GoalTask` (from Task 1)
- Produces: `pi.registerTool` 调用；LLM 可调用的 `updateGoal` 工具

- [ ] **Step 1: 在 `goalExtension` 函数体内（三个命令之后）添加 `updateGoal` 工具**

需要先在文件顶部添加 TypeBox import。修改顶部 import：

```typescript
import { Type } from "typebox";
```

然后在 `goalExtension` 函数内，`goal:abort` 命令注册后添加：

```typescript
 // ========================================================================
 // 工具: updateGoal（LLM 可调用）
 // ========================================================================
 const updateGoalSchema = Type.Object({
  action: Type.Union([
   Type.Literal("set_tasks"),
   Type.Literal("update_task"),
   Type.Literal("complete"),
  ]),
  tasks: Type.Optional(
   Type.Array(
    Type.Object({
     id: Type.String({ description: "子任务 ID，如 t1, t2" }),
     description: Type.String({ description: "子任务描述" }),
    }),
    { description: "action=set_tasks 时：完整子任务列表" },
   ),
  ),
  taskId: Type.Optional(Type.String({ description: "action=update_task 时：目标 task ID" })),
  status: Type.Optional(
   Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("done"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
   ]),
  ),
  result: Type.Optional(Type.String({ description: "结果摘要或失败原因" })),
  summary: Type.Optional(Type.String({ description: "action=complete 时：最终总结" })),
 });

 pi.registerTool({
  name: "updateGoal",
  label: "Goal Progress",
  description:
   "更新当前 goal 编排的进度。三种用法：1) set_tasks：分解完成后设置所有子任务；2) update_task：更新单个子任务状态；3) complete：标记整个 goal 完成。",
  parameters: updateGoalSchema,
  promptSnippet: "updateGoal: 更新 goal 编排进度（set_tasks/update_task/complete）",
  promptGuidelines: [
   "分解目标后立即调用 updateGoal(set_tasks) 注册所有子任务",
   "每次子任务状态变更时调用 updateGoal(update_task)",
   "所有子任务完成验证后调用 updateGoal(complete)",
  ],
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
   if (!activeGoal) {
    const loaded = loadGoalFromSession(ctx);
    if (loaded) {
     activeGoal = loaded;
    } else {
     return {
      content: [{ type: "text" as const, text: "❌ 当前没有活动的 goal" }],
     };
    }
   }

   switch (params.action) {
    case "set_tasks": {
     if (!params.tasks || params.tasks.length === 0) {
      return {
       content: [{ type: "text" as const, text: "❌ set_tasks 需要 tasks 参数" }],
      };
     }
     activeGoal.tasks = params.tasks.map((t, i) => ({
      id: t.id || `t${i + 1}`,
      description: t.description,
      status: "pending" as const,
      retryCount: 0,
     }));
     activeGoal.status = "executing";
     persistGoal(pi);
     return {
      content: [
       {
        type: "text" as const,
        text: `✅ 已设置 ${activeGoal.tasks.length} 个子任务。开始执行第一个。`,
       },
      ],
     };
    }

    case "update_task": {
     if (!params.taskId || !params.status) {
      return {
       content: [{ type: "text" as const, text: "❌ update_task 需要 taskId 和 status" }],
      };
     }
     const task = activeGoal.tasks.find((t) => t.id === params.taskId);
     if (!task) {
      return {
       content: [{ type: "text" as const, text: `❌ 未找到 task: ${params.taskId}` }],
      };
     }

     // 重试逻辑：failed 时检查 retryCount
     if (params.status === "failed") {
      if (task.retryCount < 2) {
       task.retryCount++;
       task.status = "pending"; // 重置为待重试
       task.result = params.result;
       persistGoal(pi);
       return {
        content: [
         {
          type: "text" as const,
          text: `🔄 Task ${task.id} 失败，将重试 (${task.retryCount}/2)。原因: ${params.result ?? "未知"}`,
         },
        ],
       };
      }
      // 超过重试上限，标记为永久失败
      task.status = "failed";
     } else {
      task.status = params.status;
     }
     task.result = params.result;
     persistGoal(pi);
     return {
      content: [
       { type: "text" as const, text: `✅ Task ${task.id} → ${task.status}` },
      ],
     };
    }

    case "complete": {
     activeGoal.status = "completed";
     activeGoal.summary = params.summary;
     persistGoal(pi);
     return {
      content: [
       {
        type: "text" as const,
        text: `🎉 Goal 已标记完成。${params.summary ?? ""}`,
       },
      ],
     };
    }

    default:
     return {
      content: [{ type: "text" as const, text: `❌ 未知 action: ${params.action}` }],
     };
   }
  },
 });
```

- [ ] **Step 2: 验证编译**

Run: `npx tsgo --noEmit packages/coding-agent/dist-assets/extensions/goal.ts 2>&1 | grep -v "Cannot find" | head -10`

Expected: 无语法/类型逻辑错误

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/dist-assets/extensions/goal.ts
git commit -m "feat(goal): register updateGoal LLM tool with set_tasks/update_task/complete actions"
```

---

## Task 5: `before_agent_start` + `agent_end` 事件 hooks（编排引擎核心）

**Files:**

- Modify: `packages/coding-agent/dist-assets/extensions/goal.ts`

**Interfaces:**

- Consumes: `activeGoal`, `loadGoalFromSession`, `checkGoalCompletion`, `buildOrchestrationContext`, `formatProgress`, `persistGoal` (from Task 1-2), `GoalState` (from Task 1)
- Produces: `on("before_agent_start")` 和 `on("agent_end")` 事件处理器

- [ ] **Step 1: 在 `goalExtension` 函数体内（updateGoal 工具之后）添加 `before_agent_start` hook**

```typescript
 // ========================================================================
 // 事件: before_agent_start（每轮注入编排上下文）
 // ========================================================================
 pi.on("before_agent_start", (event, ctx) => {
  // 确保 activeGoal 与 session 同步
  if (!activeGoal) {
   activeGoal = loadGoalFromSession(ctx);
  }
  if (!activeGoal) return;

  // turnCount 递增
  activeGoal.turnCount++;

  // 注入编排上下文到 systemPrompt
  const orchestrationCtx = buildOrchestrationContext(activeGoal);
  const progressSnapshot = formatProgress(activeGoal);

  // 返回修改后的 systemPrompt（原 prompt + 编排上下文）
  const result: { systemPrompt: string; messages?: unknown[] } = {
   systemPrompt: event.systemPrompt + orchestrationCtx,
  };

  // 同时通过 nextTurn 消息注入进度快照
  pi.sendMessage(
   {
    customType: "goal_progress",
    content: [{ type: "text", text: progressSnapshot }],
   },
   { deliverAs: "nextTurn" },
  );

  persistGoal(pi);
  return result;
 });
```

- [ ] **Step 2: 添加 `agent_end` hook（自动驱动核心）**

在 `before_agent_start` hook 后添加：

```typescript
 // ========================================================================
 // 事件: agent_end（检查状态，自动驱动下一轮）
 // ========================================================================
 pi.on("agent_end", (_event, ctx) => {
  if (!activeGoal) {
   activeGoal = loadGoalFromSession(ctx);
  }
  if (!activeGoal) return;

  const completion = checkGoalCompletion(activeGoal);

  switch (completion) {
   case "completed": {
    activeGoal.status = "completed";
    persistGoal(pi);
    ctx.ui.notify(
     `🎉 Goal 完成: ${truncate(activeGoal.target, 40)}`,
     "info",
    );
    activeGoal = undefined;
    break;
   }

   case "failed": {
    if (activeGoal.status !== "aborted") {
     activeGoal.status = "failed";
    }
    persistGoal(pi);
    const reason =
     activeGoal.turnCount >= activeGoal.maxTurns
      ? `达到最大轮次 (${activeGoal.maxTurns})`
      : "有子任务失败";
    ctx.ui.notify(`❌ Goal 失败: ${reason}`, "warn");
    activeGoal = undefined;
    break;
   }

   case "continue": {
    // 确保不在 streaming 中（agent_end 时应已 idle）
    if (!ctx.isIdle()) {
     // 安全降级：等 idle 后由下次 agent_end 处理
     break;
    }
    // 自动驱动下一轮
    pi.sendMessage(
     {
      customType: "goal_continue",
      content: [
       {
        type: "text",
        text: `继续执行 goal。当前进度: ${formatProgress(activeGoal)}`,
       },
      ],
     },
     { triggerTurn: true },
    );
    break;
   }
  }
 });
```

- [ ] **Step 3: 验证编译**

Run: `npx tsgo --noEmit packages/coding-agent/dist-assets/extensions/goal.ts 2>&1 | grep -v "Cannot find" | head -10`

Expected: 无语法/类型逻辑错误

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/dist-assets/extensions/goal.ts
git commit -m "feat(goal): add before_agent_start and agent_end event hooks for orchestration loop"
```

---

## Task 6: install.sh 注册 + 构建产物同步

**Files:**

- Modify: `packages/coding-agent/dist-assets/install.sh`
- Create: `packages/coding-agent/dist/extensions/goal.ts`（构建自动生成）

- [ ] **Step 1: 在 install.sh 的 EXT_INSTALLS 数组中添加 goal.ts**

定位 `EXT_INSTALLS` 数组（约第 110 行附近），在 `"file:sudo-helper.ts"` 后添加：

```bash
 "file:goal.ts"
```

Run: `grep -n "file:.*\.ts" packages/coding-agent/dist-assets/install.sh`

验证输出包含 `goal.ts`。

- [ ] **Step 2: 运行 npm run build 同步 dist 产物**

Run: `npm run build`

Expected: 构建成功，`packages/coding-agent/dist/extensions/goal.ts` 自动生成。

- [ ] **Step 3: 验证 dist 产物存在**

Run: `ls -la packages/coding-agent/dist/extensions/goal.ts`

Expected: 文件存在。

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/dist-assets/install.sh packages/coding-agent/dist/extensions/goal.ts
git commit -m "feat(goal): register in install.sh and sync dist build artifacts"
```

---

## Task 7: CHANGELOG + `npm run check`

**Files:**

- Modify: `packages/coding-agent/CHANGELOG.md`

- [ ] **Step 1: 更新 CHANGELOG**

在 `## [Unreleased]` → `### Added` 下添加：

```markdown
- Goal 自主编排扩展：`/goal <target>` 启动全自动编排（分解→调度→追踪→循环完成）
- `updateGoal` LLM 工具：结构化进度更新（set_tasks / update_task / complete）
- `/goal:status` 和 `/goal:abort` 命令
```

- [ ] **Step 2: 运行完整 check**

Run: `npm run check`

Expected: 0 errors, 0 warnings。

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/CHANGELOG.md
git commit -m "docs(goal): update CHANGELOG with goal feature entry"
```

---

## Task 8: 端到端手动验证

> 此任务不产生代码提交，仅为验证清单。

- [ ] **Step 1: 启动 TUI 验证扩展加载**

Run: `npx pi`（或等效启动命令）

在 TUI 中输入 `/goal` 按 Tab，确认命令补全出现 `goal`、`goal:status`、`goal:abort`。

- [ ] **Step 2: 验证编排启动**

输入：`/goal 在项目根目录创建一个 hello.txt 文件，内容为 Hello World`

Expected:

- 通知显示"🎯 目标编排已启动"
- Agent 开始自主工作（分解任务 → 执行）
- `updateGoal` tool call 在对话流中可见
- Footer 或对话流中可见进度

- [ ] **Step 3: 验证状态查看**

输入：`/goal:status`

Expected: 显示当前 goal 的任务列表和进度。

- [ ] **Step 4: 验证中止**

输入：`/goal:abort`

Expected: 通知显示"编排已中止"，agent_end 后不再自动驱动新 turn。

- [ ] **Step 5: 验证自动完成**

输入：`/goal 在项目根目录创建 hello.txt 文件`

Expected: Agent 自主完成后，显示"🎉 Goal 完成"，不再自动驱动新 turn。

- [ ] **Step 6: 验证护栏**

输入：`/goal 这个目标不可能完成因为前提条件不满足 xxx`

Expected: Agent 尝试后标记 failed，达到 maxTurns 或全部 task failed 时停止并显示"❌ Goal 失败"。

---

## Self-Review

### Spec 覆盖检查

| Spec 要求 | 覆盖 Task | 状态 |
| ----------- | ---------- | ------ |
| GoalState 数据模型 | Task 1 | ✅ |
| GoalTask 数据模型 | Task 1 | ✅ |
| 持久化 (appendEntry/getBranch) | Task 1 (loadGoalFromSession/persistGoal) | ✅ |
| 编排状态机 (PLANNING→EXECUTING→COMPLETED/FAILED) | Task 2 (checkGoalCompletion) + Task 5 (agent_end) | ✅ |
| 三层 prompt 注入 | Task 3 (初始) + Task 5 (before_agent_start systemPrompt + nextTurn) | ✅ |
| updateGoal 工具 (set_tasks/update_task/complete) | Task 4 | ✅ |
| 重试逻辑 (max 2) | Task 4 (update_task case) | ✅ |
| maxTurns 护栏 (50) | Task 1 (createGoal) + Task 2 (checkGoalCompletion) + Task 5 (agent_end) | ✅ |
| 循环检测 (3 次) | Task 2 (detectLoop) | ✅ |
| `/goal` 命令 | Task 3 | ✅ |
| `/goal:status` 命令 | Task 3 | ✅ |
| `/goal:abort` 命令 | Task 3 | ✅ |
| 对话流可见性 | 天然（标准 TUI 渲染） | ✅ |
| Footer 进度 | Task 2 (formatFooter) — 暂未集成 footer API（降级到命令） | ⚠️ 降级 |
| install.sh 注册 | Task 6 | ✅ |
| CHANGELOG | Task 7 | ✅ |

### 循环检测集成缺口

`detectLoop` 函数已在 Task 2 定义，但**未在事件 hook 中调用**——因为 `agent_end` 事件不含 tool call 签名信息，需要 `tool_call` 事件才能检测。当前 spec 将循环检测列为护栏但未指定触发点。

**决策**：循环检测降级为"仅定义、暂不集成"。理由：

1. `tool_call` 事件需要确认 ctx 能力（是否含 toolCall 参数）
2. maxTurns + 子任务重试上限已提供基本的失控保护
3. YAGNI——先验证核心编排循环，循环检测可后续增量添加

如果需要集成，在 Task 5 后追加：`pi.on("tool_call", ...)` 检测签名，超阈值时注入 nextTurn 纠正消息。

### Type 一致性

- `GoalTask.status`: Task 1 定义 = Task 4 schema 字面量 ✅
- `GoalState.status`: Task 1 定义 = Task 2 checkGoalCompletion + Task 5 agent_end ✅
- `activeGoal`: 全局闭包变量，Task 1 定义，Task 3-5 均引用 ✅
- `updateGoalSchema.action`: Task 4 定义 = execute switch 分支 ✅
