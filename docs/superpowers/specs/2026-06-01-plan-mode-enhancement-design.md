---
name: plan-mode-enhancement
description: Plan 模式增强设计 — 将 plan 从 example extension 升级为内置插件，核心引擎下沉到 agent 层，支持 DAG 调度、子 agent 并行执行、结构化步骤解析和 plan 文档化
---

# Plan 模式增强设计

## 背景

当前 Plan 模式实现为 `examples/extensions/plan-mode/` 下的 example extension，存在以下问题：

1. **不是内置能力** — 需手动加载（`-e` 或 `--extension`），不随二进制分发
2. **状态管理脆弱** — 闭包变量 + JSONL 追加，恢复逻辑不可靠
3. **步骤提取粗糙** — 只识别 `Plan:` 标题后的编号列表，其他格式被忽略
4. **执行模式无顺序保证** — `[DONE:n]` 标记不强制顺序，无依赖关系
5. **与 preset 系统割裂** — preset 的 "plan" 配置和 plan extension 是两套独立机制
6. **无并行能力** — 步骤只能串行执行，无法利用子 agent 并行
7. **无文档化** — plan 执行后无持久化文档，后续会话无法引用

## 目标

1. **原生内置** — plan 模式作为内置插件随二进制分发，开箱即用
2. **核心引擎** — plan 状态机、DAG 调度、步骤解析下沉到 `packages/agent/` 核心层
3. **增强解析** — 支持多种 plan 格式，自动推断步骤依赖关系
4. **并行执行** — 无依赖步骤通过子 agent 并行执行
5. **用户可控** — 执行中可暂停、恢复、跳过、重排步骤
6. **系统集成** — 合并 preset plan、集成 subagent、plan 文档化
7. **可靠持久化** — plan 状态作为 session 一等公民，恢复可靠

## 设计方案

采用**方案 B：核心层 Plan Engine + 内置插件 UI**。

- 引擎（状态机、DAG 调度、步骤解析、子 agent 并行）在 `packages/agent/src/plan/`
- UI 和交互逻辑在 `packages/plugins/src/plan/` 内置插件
- 插件通过 `pi` API 与核心引擎交互

### 架构图

```
用户输入 (/plan, Ctrl+Alt+P, --plan)
    │
    ▼
Plan Plugin (packages/plugins/src/plan/)
    │  注册命令/快捷键/事件
    │  渲染 UI (status bar, todo widget, 确认对话框)
    │
    ▼
AgentSession.planEngine
    │
    ▼
PlanEngine (packages/agent/src/plan/)
    ├── PlanStateMachine — draft → approved → executing → completed/failed
    ├── PlanParser — LLM 自由文本 → PlanStep[] + 依赖关系
    ├── PlanScheduler — DAG 拓扑排序 + 并行调度
    └── PlanPersistence — 序列化/反序列化 + session 集成
```

## Section 1：核心数据模型

### PlanStep

```typescript
interface PlanStep {
  id: string;                    // 自动生成，如 "s1"
  text: string;                  // 用户可读的步骤描述
  status: "pending" | "in_progress" | "completed" | "skipped" | "failed";
  dependencies: string[];        // 依赖的 step id 列表
  toolRestriction?: "readonly" | "full";  // 执行时工具限制
  verification?: string;         // 验证命令或条件描述
  assignedTo?: "main" | string;  // "main" = 主 agent, subagent name = 子 agent
  result?: string;               // 执行结果摘要
}
```

### Plan

```typescript
interface Plan {
  id: string;                    // 自动生成，如 "p-20260601-001"
  title: string;                 // 从 LLM 输出提取
  steps: PlanStep[];
  status: "draft" | "approved" | "executing" | "completed" | "failed" | "paused";
  createdAt: number;
  rawMarkdown: string;           // LLM 原始输出，用于文档化
}
```

### 状态转换

```
draft → approved（用户确认）
approved → executing（开始执行）
executing → paused（用户暂停）
paused → executing（用户恢复）
executing → completed（所有步骤完成）
executing → failed（某步骤失败且用户选择中止）
任意状态 → draft（用户要求重写）
```

### DAG 调度

步骤间依赖通过 `dependencies` 字段表达。PlanScheduler 在执行时：

1. 构建依赖图
2. 拓扑排序
3. 同层无依赖步骤可并行（派发子 agent）
4. 检测循环依赖，拒绝执行

依赖推断规则（parser 层）：

- 步骤文本引用相同文件/模块 → 顺序依赖
- 步骤文本明确提到 "先"/"然后"/"after"/"before" → 顺序依赖
- 无交集 → 无依赖（可并行）
- 用户可手动调整依赖

## Section 2：Plan Parser — 自由文本解析增强

Parser 负责从 LLM 的自由文本输出中提取结构化 PlanStep 列表 + 依赖关系。

### 解析策略

LLM 输出的 plan 格式多样，parser 采用**多模式匹配 + 启发式**：

1. **编号列表**：`1. ...` / `1) ...`
2. **Markdown 任务列表**：`- [ ] ...` / `- [x] ...`
3. **标题层级**：`## Step 1: ...` / `### 1. ...`
4. **缩进块**：用缩进表达子步骤和依赖
5. **自然语言**：无明确格式时，按段落分割，每段一步

多模式匹配取最佳结果（步骤数最多的匹配）。

### 依赖推断

```typescript
function inferDependencies(steps: PlanStep[]): PlanStep[] {
  // 1. 文本引用推断：步骤 i 引用了步骤 j 产出的文件/符号
  //    - 从步骤文本中提取文件路径（/path/to/file.ts）和符号名
  //    - 如果步骤 i 引用了步骤 j 的产出 → i depends on j

  // 2. 顺序推断：无明确依赖关系时，保守地按顺序依赖
  //    - 可通过配置关闭（默认关闭，让并行调度器决定）

  // 3. 关键词推断：明确的语言标记
  //    - "先"/"first" → 前序依赖
  //    - "然后"/"then"/"after that" → 前序依赖
  //    - "同时"/"meanwhile"/"in parallel" → 无依赖
}
```

### 容错

- 解析失败时降级为单步骤 plan（整个 LLM 输出作为一个步骤）
- 解析结果与 rawMarkdown 一起保存，用户可查看原始输出

### 与 LLM 交互

Plan 模式激活时注入的 system context 会引导 LLM 产出更结构化的 plan 格式（编号列表、标注依赖、包含验证条件），但 parser 不假设 LLM 一定遵循，仍以多模式匹配为主。

## Section 3：PlanEngine — 核心引擎

### 位置

`packages/agent/src/plan/plan-engine.ts`

### API

```typescript
class PlanEngine {
  // 状态
  currentPlan: Plan | null;

  // 生命周期
  createPlan(rawMarkdown: string): Plan;           // 解析 + 创建 draft
  approvePlan(): void;                             // draft → approved
  startExecution(): void;                          // approved → executing
  pauseExecution(): void;                          // executing → paused
  resumeExecution(): void;                         // paused → executing
  resetPlan(): void;                               // 回到 draft

  // 步骤操作
  updateStep(stepId: string, update: Partial<PlanStep>): void;
  skipStep(stepId: string): void;
  retryStep(stepId: string): void;

  // 调度
  getNextExecutableSteps(): PlanStep[];            // 返回当前可执行的步骤（无未完成依赖）
  markStepStarted(stepId: string): void;
  markStepCompleted(stepId: string, result?: string): void;
  markStepFailed(stepId: string, error: string): void;

  // 并行调度
  scheduleParallel(steps: PlanStep[], agentSession: AgentSession): Promise<void>;

  // 单步执行（内部方法，由 scheduleParallel 调用）
  private async executeStep(step: PlanStep, session: AgentSession): Promise<void>;

  // 持久化
  serialize(): PlanJSON;
  static deserialize(data: PlanJSON): PlanEngine;
}

// PlanJSON 是 Plan 的 JSON 可序列化形式，结构与 Plan 一致
type PlanJSON = Omit<Plan, "steps"> & { steps: PlanStep[] };
```

### 与 AgentSession 集成

AgentSession 持有 PlanEngine 实例：

```typescript
class AgentSession {
  planEngine: PlanEngine;

  // plan 相关方法
  async enterPlanMode(): Promise<void>;
  async exitPlanMode(): Promise<void>;
  async submitPlanDraft(prompt: string): Promise<Plan>;
}
```

集成点：

1. **before_agent_start** — 如果 plan 状态为 executing，注入当前步骤上下文
2. **turn_end** — 检查当前步骤是否完成（通过 verification 条件或 LLM 声明）
3. **agent_end** — 如果 plan 状态为 draft，提取 plan 并通知用户确认

### 并行调度实现

```typescript
async scheduleParallel(steps: PlanStep[], session: AgentSession): Promise<void> {
  // 1. 按依赖分组，同组步骤可并行
  const groups = topologicalGroupByDependency(steps);

  // 2. 对每组，派发子 agent 并行执行
  for (const group of groups) {
    if (group.length === 1) {
      // 单步骤，主 agent 执行
      await this.executeStep(group[0], session);
    } else {
      // 多步骤，派发子 agent
      const subagentPromises = group.map(step =>
        session.runSubagent({
          name: `plan-step-${step.id}`,
          prompt: step.text,
          tools: step.toolRestriction === "readonly" ? READONLY_TOOLS : FULL_TOOLS,
        })
      );
      await Promise.all(subagentPromises);
    }
  }
}
```

### 错误处理

- 步骤失败时暂停执行，通知用户选择：重试 / 跳过 / 中止
- 子 agent 失败时，结果记录到 step.result，不自动中止整个 plan

## Section 4：内置插件 — UI 与交互

### 插件结构

```
packages/plugins/src/plan/
├── index.ts              # 插件入口，注册命令/快捷键/事件
├── ui/
│   ├── status.ts         # 状态栏渲染（plan: 3/5）
│   ├── widget.ts         # Todo widget 渲染（checkbox 列表）
│   └── prompt.ts         # 用户确认/选择对话框
├── commands/
│   ├── plan.ts           # /plan 命令
│   ├── plan-approve.ts   # /plan-approve
│   ├── plan-edit.ts      # /plan-edit（打开编辑器调整步骤）
│   └── plan-status.ts    # /plan-status（显示当前 plan 详情）
└── manifest.json         # 插件 manifest
```

### 命令

| 命令 | 描述 |
|---|---|
| `/plan` | 切换 plan 模式（draft 状态） |
| `/plan-approve` | 确认当前 plan，进入执行 |
| `/plan-edit` | 打开编辑器调整步骤顺序/依赖 |
| `/plan-pause` | 暂停执行 |
| `/plan-resume` | 恢复执行 |
| `/plan-status` | 显示当前 plan 详情 |
| `/plan-save` | 将 plan 保存为文档 |

### 快捷键

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Alt+P` | 切换 plan 模式 |
| `Ctrl+Alt+E` | 编辑当前 plan |
| `Ctrl+Alt+S` | 暂停/恢复执行 |

### UI 组件

**状态栏**：显示当前 plan 状态和进度

```
[plan: 3/5]          // executing，3 步完成
[plan: draft]        // draft 状态
[plan: paused]       // 暂停
```

**Todo Widget**：在输入框上方显示步骤列表

```
□ 1. 分析现有代码结构
☑ 2. 设计数据模型
▶ 3. 实现 PlanEngine（进行中）
□ 4. 编写单元测试
□ 5. 集成到 AgentSession
```

**确认对话框**：plan 创建后显示

```
Plan created with 5 steps. What would you like to do?

[Execute]  [Edit]  [Discard]
```

### 与 preset 集成

preset 的 "plan" 配置合并到 plan 插件的默认配置：

- 用户可通过 `/preset plan` 快速进入 plan 模式
- preset 可覆盖 plan 插件的默认行为（如默认工具集、解析器配置）

## Section 5：集成与文档化

### 与 Subagent 集成

Plan 模式与 subagent 系统的双向集成：

1. **Plan 调用 planner subagent**：用户进入 plan 模式后，可调用内置 `planner` subagent 做深度分析，subagent 产出直接成为 plan 步骤的输入
2. **Plan 步骤派发子 agent**：执行阶段，并行步骤通过 `AgentSession.runSubagent()` 派发，每个子 agent 执行一个步骤
3. **子 agent 结果回写**：子 agent 完成后，结果写入 `PlanStep.result`，主 agent 可引用

### Plan 文档化

Plan 完成后自动持久化为文档。

**存储位置**：`.pi/plans/<plan-id>.md`

**格式**：

```markdown
# Plan: <title>

**Status**: completed
**Created**: 2026-06-01
**Completed**: 2026-06-01

## Steps

1. ✅ 分析现有代码结构
   - Result: 识别了 3 个核心模块...

2. ✅ 设计数据模型
   - Result: PlanStep/Plan 接口定义...

3. ✅ 实现 PlanEngine
   - Result: 核心引擎实现，含 DAG 调度...

4. ✅ 编写单元测试
   - Result: 12 个测试用例全部通过

5. ✅ 集成到 AgentSession
   - Result: plan 状态成为 session 一等公民
```

**用途**：

- 后续会话可通过 `/plan-status --history` 查看历史 plan
- LLM 可引用历史 plan 了解项目演进
- 用户可手动编辑 `.pi/plans/` 下的文件

### Session 持久化

Plan 状态作为 session 的一等公民持久化：

```typescript
// session JSONL 中的 plan entry
{
  type: "plan",
  planId: "p-20260601-001",
  status: "executing",
  steps: [
    { id: "s1", text: "...", status: "completed", result: "..." },
    { id: "s2", text: "...", status: "in_progress" },
  ],
  timestamp: 1748764800000
}
```

恢复会话时，PlanEngine 从最后一个 plan entry 反序列化，完整恢复状态。

## 文件变更清单

### 新增文件

| 文件 | 描述 |
|---|---|
| `packages/agent/src/plan/plan-engine.ts` | PlanEngine 核心引擎 |
| `packages/agent/src/plan/plan-types.ts` | Plan/PlanStep 类型定义 |
| `packages/agent/src/plan/plan-parser.ts` | 自由文本解析器 |
| `packages/agent/src/plan/plan-scheduler.ts` | DAG 调度器 |
| `packages/agent/src/plan/plan-persistence.ts` | 序列化/反序列化 |
| `packages/agent/src/plan/index.ts` | 模块导出 |
| `packages/plugins/src/plan/index.ts` | 内置插件入口 |
| `packages/plugins/src/plan/ui/status.ts` | 状态栏渲染 |
| `packages/plugins/src/plan/ui/widget.ts` | Todo widget 渲染 |
| `packages/plugins/src/plan/ui/prompt.ts` | 用户确认对话框 |
| `packages/plugins/src/plan/commands/plan.ts` | /plan 命令 |
| `packages/plugins/src/plan/commands/plan-approve.ts` | /plan-approve 命令 |
| `packages/plugins/src/plan/commands/plan-edit.ts` | /plan-edit 命令 |
| `packages/plugins/src/plan/commands/plan-status.ts` | /plan-status 命令 |
| `packages/plugins/src/plan/manifest.json` | 插件 manifest |

### 修改文件

| 文件 | 变更 |
|---|---|
| `packages/agent/src/index.ts` | 导出 plan 模块 |
| `packages/coding-agent/src/core/agent-session.ts` | 集成 PlanEngine，添加 plan 相关方法 |
| `packages/plugins/src/index.ts` | 注册 plan 内置插件 |
| `packages/coding-agent/src/core/subagents/discovery.ts` | planner subagent 与 plan engine 集成 |

### 可删除文件

| 文件 | 原因 |
|---|---|
| `packages/coding-agent/examples/extensions/plan-mode/` | 功能由内置插件替代 |
| `packages/coding-agent/examples/extensions/preset.ts` 中的 plan preset | 合并到 plan 插件 |

## 迁移策略

1. 先实现核心层（plan-types → plan-parser → plan-scheduler → plan-engine → plan-persistence）
2. 再实现内置插件（命令 → UI → 事件处理）
3. 集成到 AgentSession
4. 迁移 preset plan 配置
5. 删除旧 example extension
6. 更新测试

每步完成后运行 `npm run check` 确保类型正确。
