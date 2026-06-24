# LoopGuard: Agent Loop 韧性增强设计

## 问题

当前 Pi 的 agent loop 对低参数模型（7B-14B 本地模型、低成本 API 模型如 GPT-4o-mini/Haiku/Flash）存在三大缺陷：

1. **错误恢复不足** — tool call 格式错误只返回 error result 不触发重试；Provider 层重试默认关闭；上下文溢出恢复仅一次；退避无 jitter
2. **零自纠能力** — steer/followUp 纯被动队列，无自动检测跑偏并注入纠正消息的逻辑；无循环 self-call 检测
3. **迭代控制粗糙** — 无 maxTurns 配置；模型说 stop 就停，低参模型可能过早认为自己做完了

## 方案：LoopGuard 插件层

在 `AgentLoopConfig` 中增加可配置的 guard 回调，由 `AgentHarness` 根据模型能力注入不同策略。底层 loop 只负责调用钩子，不改核心流程。

### 设计原则

- 所有新增字段 `optional`，不配置时行为与当前完全一致
- Guard 合约：必须不抛异常；loop 中 try/catch 包裹，异常时 fallback 到默认行为
- 策略与机制分离：底层提供钩子，上层决定策略

---

## 一、AgentLoopConfig 新增字段

### 1.1 Guard 回调

```typescript
// types.ts — AgentLoopConfig 新增

/** Tool call 验证失败（参数格式错误、工具不存在）时的处理策略 */
onMalformedToolCall?: (context: MalformedToolCallContext) => MalformedToolCallAction;

/** 模型因 output length 截断而停止时的处理策略（优先级高于 onPrematureStop）
 *  对应 stopReason === "length"（非模型主动选择，而是资源限制） */
onMaxTokens?: (context: MaxTokensContext) => MaxTokensAction;

/** 模型主动停止（stopReason !== "toolUse" 且 !== "length"，无 tool call）时的处理策略 */
onPrematureStop?: (context: PrematureStopContext) => PrematureStopAction;

/** 检测到重复 tool call 时的处理策略 */
onRepeatedToolCall?: (context: RepeatedToolCallContext) => RepeatedToolCallAction;

/** 最大 turn 数限制，超限时 agent_end 并携带 stopReason: "max_turns" */
maxTurns?: number;

/** 是否发射 guard_triggered 事件（调试/UI 展示用），默认 false */
emitGuardEvents?: boolean;
```

> **注意**：当前 `stopReason` 类型为 `"stop" | "length" | "toolUse" | "error" | "aborted"`，不存在 `"max_tokens"`。`"length"` 即对应模型输出达到 maxTokens 上限被截断的情况。

### 1.2 上下文类型

```typescript
interface MalformedToolCallContext {
  toolCall: AgentToolCall;
  error: string;
  turnNumber: number;
  recentMalformedCount: number;  // 最近 10 轮内格式错误累计次数
}

interface PrematureStopContext {
  message: AssistantMessage;
  turnNumber: number;
  totalToolCallsSoFar: number;   // 本轮 agent run 中已执行的 tool call 总数
}

interface MaxTokensContext {
  message: AssistantMessage;
  turnNumber: number;
  totalToolCallsSoFar: number;
  /** Whether the truncated output contains incomplete tool calls */
  hasIncompleteToolCalls: boolean;
}

interface RepeatedToolCallContext {
  toolCall: AgentToolCall;
  previousCalls: AgentToolCall[]; // 最近 N 轮内相同 tool + 精确匹配 args 的调用
  repeatCount: number;            // 含本次的重复次数
}
```

> **注意**：当前 `runLoop` 中不存在 `turnNumber` 和 `totalToolCallsSoFar`，需新增。`turnNumber` 在每个 `turn_end` 后递增；`totalToolCallsSoFar` 在每次 tool call 执行后累加。

### 1.3 动作类型

```typescript
type MalformedToolCallAction =
  | { type: "error_result" }                              // 默认：返回 error tool result
  | { type: "inject_steering"; message: string }          // 注入纠正消息 + 返回 error result
  | { type: "abort" };                                    // 终止 agent

type PrematureStopAction =
  | { type: "stop" }                                      // 默认：正常停止
  | { type: "continue"; message: string }                 // 注入 followUp 续行
  | { type: "abort" };                                    // 终止 agent

type MaxTokensAction =
  | { type: "continue"; message: string }                 // 注入 followUp 续行（最常用）
  | { type: "escalate" }                                  // 尝试提升 maxTokens（如果 provider 支持）
  | { type: "stop" };                                     // 放弃续行

type RepeatedToolCallAction =
  | { type: "proceed" }                                   // 默认：继续执行
  | { type: "inject_steering"; message: string }          // 注入警告
  | { type: "skip" }                                      // 跳过本次 tool call，返回空 result
  | { type: "abort" };                                    // 熔断终止
```

---

## 二、Loop 内部改动点

### 2.0 新增运行时状态

在 `runLoop` 中新增局部变量（当前代码中不存在）：

```typescript
let turnNumber = 0;
let totalToolCallsSoFar = 0;
let recentMalformedCount = 0;           // 滑动窗口（10 轮），每次成功 tool call 重置
let recentToolCallHistory: AgentToolCall[] = [];  // 滑动窗口（最近 10 轮的 tool calls）
```

在 `turn_end` 后：`turnNumber++`；在每次 tool call 执行后：`totalToolCallsSoFar++`。

### 2.1 Malformed Tool Call — `prepareToolCall` 函数

**位置**：`agent-loop.ts:619-625`（catch 块）和 `569-576`（Tool not found）

**问题**：`prepareToolCall` 无法访问 `runLoop` 的 `pendingMessages` 局部变量。

**方案**：`onMalformedToolCall` 的 `inject_steering` 动作**不直接操作 `pendingMessages`**，而是通过返回值将 steering 消息传回 `runLoop`。扩展 `prepareToolCall` 的返回类型：

```typescript
type ToolCallOutcome =
  | { kind: "deferred"; toolCall: AgentToolCall; tool: AgentTool }
  | { kind: "immediate"; result: AgentToolResult; isError: boolean }
  | { kind: "immediate"; result: AgentToolResult; isError: boolean; steeringMessage?: string }
  //                                                                 ^^^^^^^^^^^^^ 新增
```

在 `runLoop` 中调用 `prepareToolCall` 后，检查返回值的 `steeringMessage`，有值则 push 到 `pendingMessages`：

```
const outcome = prepareToolCall(tc, ...);
if (outcome.steeringMessage) {
  pendingMessages.push(userMessage(outcome.steeringMessage));
}
if (outcome.kind === "immediate") {
  // 直接收集 result
}
```

"Tool not found" 同理走此 guard。

需维护 `recentMalformedCount`：每次格式错误 +1，每轮成功执行 tool call 时重置为 0。

### 2.2 MaxTokens — streamAssistantResponse 返回后（最高优先级）

**位置**：`agent-loop.ts:196`（stopReason 检查之后）

在 error/aborted 检查之后、tool call 解析之前，插入 `onMaxTokens` 检查：

```
if (message.stopReason === "length") {  // "length" 对应 max_tokens 截断
  if (config.onMaxTokens) {
    const hasIncompleteToolCalls = message.content.some(c => c.type === "toolCall" && isIncomplete(c));
    const action = onMaxTokens({ message, turnNumber, totalToolCallsSoFar, hasIncompleteToolCalls });
    if (action.type === "continue") {
      pendingMessages = [userMessage(action.message)];
      continue;  // 回到内循环，模型从截断处续行
    }
    if (action.type === "escalate") → 提升 maxTokens 配置后 continue
    if (action.type === "stop") → 走正常停止逻辑
  }
}
```

`onMaxTokens` 优先级高于 `onPrematureStop`——`"length"` 截断不是模型的选择，而是资源限制，应**无条件续行**。

### 2.3 Premature Stop — 内循环退出后

**位置**：`agent-loop.ts:254-266`

在内循环退出后、followUp 检查之前插入：

```
// 模型说 stop（非 toolUse 且非 length），无 tool call，无 steering
if (message.stopReason !== "toolUse" && message.stopReason !== "length" && toolCalls.length === 0) {
  if (config.onPrematureStop) {
    const action = onPrematureStop({ message, turnNumber, totalToolCallsSoFar });
    if (action.type === "continue") {
      pendingMessages = [userMessage(action.message)];
      continue;  // 回到外循环，重新进入内循环
    }
    if (action.type === "abort") → break 外循环
  }
}
// 然后是原有的 followUp 检查
```

**注意**：`continue` 回到外循环顶部（非内循环），因为此时已在内循环之外。外循环条件检查 `pendingMessages.length > 0` 会自动重新进入内循环。

### 2.4 Repeated Tool Call — `executeToolCalls` 前

**位置**：`agent-loop.ts:207`（toolCalls 解析后，执行前）

新增 `recentToolCallHistory: AgentToolCall[]` 滑动窗口（默认保留最近 10 轮的 tool calls）：

```
for (const tc of toolCalls) {
  const prevCalls = recentToolCallHistory.filter(
    pc => pc.name === tc.name && pc.arguments === tc.arguments  // 精确 JSON 匹配
  );
  if (prevCalls.length > 0 && config.onRepeatedToolCall) {
    const action = onRepeatedToolCall({ toolCall: tc, previousCalls: prevCalls, repeatCount: prevCalls.length + 1 });
    if (action.type === "skip") {
      // 收集一个空 result 代替执行
      continue;
    }
    if (action.type === "inject_steering") {
      pendingMessages.push(userMessage(action.message));
    }
    if (action.type === "abort") → 设置 abort 标志
  }
  // 正常执行
}
// 执行完毕后将本轮 toolCalls 追加到 recentToolCallHistory
```

### 2.5 maxTurns — turn_end 后

**位置**：`agent-loop.ts:241`（shouldStopAfterTurn 之前）

```
turnNumber++;
if (config.maxTurns && turnNumber > config.maxTurns) {
  await emit({ type: "agent_end", messages: newMessages, stopReason: "max_turns" });
  return;
}
```

### 2.6 不改动的部分

- `streamAssistantResponse` — 错误恢复由 AgentSession 层处理
- `executeToolCalls` / `executeToolCallsParallel` — 内部逻辑不变，guard 在调用前拦截
- `Agent` 类 — guard 通过 AgentLoopConfig 传入，Agent 只是透传
- 事件序列 — guard 注入的 steering/followUp 走现有 `message_start/message_end` 流程

---

## 三、AgentHarness 层 Guard 策略注入

### 3.1 模型能力分级

```typescript
type ModelResilience = "high" | "medium" | "low";
// high:   GPT-4o, Claude Sonnet+ — tool call 可靠，推理强
// medium: GPT-4o-mini, Claude Haiku, Flash — 偶尔格式错误，推理尚可
// low:    7B-14B 本地模型 — 频繁格式错误，容易跑偏，过早停止
```

### 3.2 模型 Guard 配置

在现有 `~/.pi/agent/models.json` 的模型条目上扩展 `resilience` 和 guard 覆盖字段。**只有配置了 `resilience` 的模型才启用 guard，未配置的模型行为与当前完全一致。**

现有配置格式（扩展前）：

```json
{
  "providers": {
    "cli-proxy-api": {
      "baseUrl": "http://api.et.net:8317",
      "api": "anthropic-messages",
      "apiKey": "sk-cpa-kali",
      "models": [
        { "id": "deepseek-v4-pro", "contextWindow": 1000000, "reasoning": true },
        { "id": "glm-5.1", "reasoning": true, "contextWindow": 200000 }
      ]
    }
  }
}
```

扩展后（loop-guard 生效）：

```json
{
  "providers": {
    "cli-proxy-api": {
      "baseUrl": "http://api.et.net:8317",
      "api": "anthropic-messages",
      "apiKey": "sk-cpa-kali",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "contextWindow": 1000000,
          "reasoning": true,
          "thinkingLevelMap": { "xhigh": "xhigh" },
          "resilience": "high"
        },
        {
          "id": "deepseek-v4-flash",
          "contextWindow": 1000000,
          "reasoning": true,
          "thinkingLevelMap": { "xhigh": "xhigh" },
          "resilience": "medium"
        },
        {
          "id": "glm-5.1",
          "reasoning": true,
          "contextWindow": 200000,
          "thinkingLevelMap": { "xhigh": "xhigh" },
          "resilience": "medium",
          "maxTurns": 60
        },
        {
          "id": "qwen3.6-35b-a3b",
          "reasoning": true,
          "contextWindow": 128000,
          "thinkingLevelMap": { "xhigh": "xhigh" },
          "resilience": "low",
          "maxTurns": 100
        },
        {
          "id": "kimi-k2.6",
          "contextWindow": 256000,
          "reasoning": true,
          "thinkingLevelMap": { "xhigh": "xhigh" }
        }
      ]
    }
  }
}
```

上例中 `kimi-k2.6` 没有 `resilience` 字段，不启用 guard。

类型扩展（在现有模型条目类型上追加）：

```typescript
/** models.json 模型条目的 guard 扩展字段 */
interface ModelEntryGuardFields {
  resilience?: ModelResilience;   // 启用 guard 的标记，同时指定韧性级别
  maxTurns?: number;              // 覆盖级别默认的 maxTurns
  onPrematureStop?: "stop" | "continue" | "abort";  // 覆盖级别默认策略
  onMalformedToolCall?: "error_result" | "inject_steering" | "abort";
  onMaxTokens?: "continue" | "escalate" | "stop";
  onRepeatedToolCall?: "proceed" | "inject_steering" | "skip" | "abort";
}
```

查找逻辑：

```typescript
export function findModelGuardConfig(
  modelsJson: ModelsJsonConfig,
  modelId: string,
): ModelEntryGuardFields | undefined {
  for (const provider of Object.values(modelsJson.providers)) {
    const model = provider.models.find(m => m.id === modelId);
    if (model?.resilience) return model;
  }
  return undefined;
}
```

### 3.3 Guard 策略工厂

新增文件 `packages/agent/src/harness/loop-guards.ts`：

```typescript
export function createLoopGuards(
  level: ModelResilience,
  overrides?: ModelEntryGuardFields,
): Partial<AgentLoopConfig>
```

三级策略：

| Guard | high | medium | low |
|-------|------|--------|-----|
| `onMalformedToolCall` | `error_result` | `inject_steering`（连续 2 次以上时） | `inject_steering`（每次，含具体纠正提示） |
| `onMaxTokens` | `continue`（"Please continue from where you left off."） | `continue`（无条件续行） | `continue`（无条件续行，含具体提示） |
| `onPrematureStop` | `stop` | `continue`（toolCallsSoFar < 3 时） | `continue`（toolCallsSoFar < 5 时） |
| `onRepeatedToolCall` | `proceed` | `inject_steering`（repeatCount ≥ 3） | `inject_steering`（repeatCount ≥ 2）+ `skip`（≥ 4） |
| `maxTurns` | undefined（不设上限） | 50 | 80 |

`overrides` 中的字段覆盖级别默认值。例如 `resilience: "low"` 但 `maxTurns: 100` 会使用 low 级别的所有 guard 策略，但 maxTurns 覆盖为 100。

**resilience 自动推导默认值**：只配 `resilience` 即可，所有 guard 行为和 `maxTurns` 自动按级别填充。用户显式指定的字段优先。

| resilience | maxTurns 默认值 | 说明 |
|------------|----------------|------|
| high | undefined（不设上限） | 强模型无需兜底 |
| medium | 50 | 偶尔跑偏，中等上限 |
| low | 80 | 弱模型需要更多 turn 自纠 |

**low 级别注入消息模板**：

`onMalformedToolCall`:
```
"Your last tool call had an error: {error}. Common fixes:
- Check that all required parameters are present
- Ensure parameter types match the schema (strings quoted, numbers unquoted)
- Use the exact tool name as defined
Please try again with corrected arguments."
```

`onPrematureStop`:
```
"You appear to have stopped before completing the task. If there are remaining steps,
continue with the appropriate tool calls. If you are truly done, say so explicitly."
```

`onMaxTokens`（low 级别）:
```
"Your response was cut off due to the output length limit. Please continue exactly
from where you left off. Do not repeat what you already wrote — just continue the
incomplete part."
```

`onMaxTokens`（high/medium 级别）:
```
"Please continue from where you left off."
```

`onRepeatedToolCall`:
```
"You have called {toolName} with the same arguments {repeatCount} times. This suggests
you may be stuck in a loop. Consider a different approach or verify the tool result."
```

### 3.4 AgentHarness 集成

在 `AgentHarness.createLoopConfig()` (agent-harness.ts:421-470) 中注入 guard：

```typescript
private createLoopConfig(
  getTurnState: () => AgentHarnessTurnState<...>,
  setTurnState: (turnState: AgentHarnessTurnState<...>) => void,
): AgentLoopConfig {
  const turnState = getTurnState();
  const modelId = turnState.model.id;

  // 从 models.json 查找 guard 配置，未配置 resilience 则不启用
  const guardConfig = findModelGuardConfig(this.modelsJsonConfig, modelId);
  const guards = guardConfig
    ? createLoopGuards(guardConfig.resilience!, guardConfig)
    : {};

  return {
    model: turnState.model,
    // ... 现有字段
    ...guards,  // 未配置时为空对象，行为与当前一致
  };
}
```

`AgentHarness` 构造时接收 `modelsJsonConfig`（已在现有代码中加载 `models.json`，直接复用）。

`setModel()` 切换模型时，通过 `prepareNextTurn` 回调在下一个 turn 重新查找对应模型的 guard 配置（`prepareNextTurn` 已在 `createLoopConfig` 中配置，会调用 `createTurnState()` 获取最新模型）。

### 3.5 不改 Model 接口和生成脚本

- `Model<TApi>` 接口不加 `resilience` 字段
- `generate-models.ts` 不改动
- `models.generated.ts` 不改动
- Guard 配置完全在 agent 运行时层，与 ai 包解耦

---

## 四、重试和退避增强

### 4.1 Provider 层默认开启重试

所有 provider 的 `maxRetries` 默认从 0 改为 2：

```typescript
// ai/providers/*.ts
maxRetries: options?.maxRetries ?? 2
```

覆盖：`anthropic.ts`、`openai-codex-responses.ts`、`openai-responses.ts`、`openai-completions.ts`、`google.ts`。

### 4.2 退避加 jitter + cap

当前退避在 `agent-session.ts:2688`：

```typescript
const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
```

默认值：`baseDelayMs = 2000`，`maxRetries = 3`。当前无 jitter、无 cap。

改为：
```
delayMs = min(baseDelayMs * 2^(attempt-1), maxRetryDelayMs) * (0.5 + Math.random() * 0.5)
```

新增配置项：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxRetryDelayMs` | 30000 | 单次退避上限 30s |

### 4.3 上下文溢出恢复允许多次

`agent-session.ts:303` 的 `_overflowRecoveryAttempted` 布尔标志改为计数器：

```typescript
private _overflowRecoveryAttempts = 0;
private readonly MAX_OVERFLOW_RECOVERY = 3;
```

每次溢出恢复递增，成功后不重置（同一轮 agent run 内累计）。不同 prompt 调用时重置（在 `_runAgentPrompt` 之前的现有重置点）。

### 4.4 重试 off-by-one 修复

AgentSession 中的重试逻辑需确保 `maxRetries=N` 时实际重试 N 次（而非 N+1 次）。具体位置需在实现时精确定位 agent-session.ts 中的重试循环，修正边界条件从 `>` 改为 `>=`（或等效调整）。

---

## 五、事件和类型扩展

### 5.1 AgentEndEvent 新增 stopReason

当前定义（types.ts:406）：
```typescript
| { type: "agent_end"; messages: AgentMessage[] }
```

改为：
```typescript
| { type: "agent_end"; messages: AgentMessage[]; stopReason?: "normal" | "max_turns" | "guard_abort" }
```

- `"normal"` — 默认，模型自然停止（包括 stop/length/error/aborted）
- `"max_turns"` — 超过 maxTurns 限制
- `"guard_abort"` — guard 返回 abort 动作
- 不设值时等同于 `"normal"`，向后兼容

### 5.2 Guard 触发事件

```typescript
interface GuardTriggeredEvent {
  type: "guard_triggered";
  guard: "malformed_tool_call" | "premature_stop" | "repeated_tool_call" | "max_tokens";
  action: string;
  turnNumber: number;
  details?: string;
}
```

仅在 `emitGuardEvents: true` 时发射，用于调试和 UI 展示（"自动纠正了 1 次格式错误"）。

---

## 六、不改动的范围

| 模块 | 原因 |
|------|------|
| `Agent` 类 (`agent.ts`) | guard 通过 AgentLoopConfig 传入，Agent 只是透传 |
| `streamAssistantResponse` | 错误恢复由 AgentSession 处理 |
| `AgentHarness` 核心流程 | 只在 `createLoopConfig()` 中追加 guard 字段，不改其他方法 |
| `Model<TApi>` 接口 | 不加 resilience 字段，guard 配置与 ai 包解耦 |
| `generate-models.ts` / `models.generated.ts` | 不改生成脚本和生成产物 |
| `convertToLlm` / `transformContext` | 与 guard 无关 |
| 压缩算法 (`compaction.ts`) | 只改溢出恢复次数，不改压缩逻辑 |
| 事件序列基本结构 | guard 注入走现有 message_start/message_end 流程 |

---

## 七、风险和缓解

| 风险 | 缓解 |
|------|------|
| guard 注入过多 steering 消息导致上下文膨胀 | maxTurns 硬上限 + 每次 guard inject 只追加一条消息 + low 级别 maxTurns=80 |
| `onPrematureStop` 误判续行 | 续行消息含"如果确实做完了请明确告知"；low 级别仅在 toolCallsSoFar < 5 时续行 |
| `onMaxTokens` 无限续行循环 | maxTurns 硬上限兜底；续行消息明确要求"不要重复已写内容" |
| `onRepeatedToolCall` 精确匹配可能漏检 | 第一版用精确 JSON 匹配，简单可靠；后续可升级为模糊匹配 |
| `Model.resilience` 缺失时默认 medium 可能不足 | 未配置的模型不启用 guard，无此问题；配置了的模型由用户显式指定 resilience |
| guard 回调抛异常 | loop 中 try/catch 包裹，异常时 fallback 到默认行为 |
| `prepareToolCall` 无法访问 `pendingMessages` | 通过返回值 `steeringMessage` 传回 `runLoop`，不直接操作局部变量 |
| Provider 层默认重试增加延迟 | 默认只 2 次，退避有 jitter + cap，总延迟可控在 ~6s 内 |

---

## 八、向后兼容

- 所有新增字段都是 optional，不配置时行为与当前完全一致
- `AgentEndEvent.stopReason` 新增可选字段，现有消费者不受影响
- Guard 配置通过 `~/.pi/agent/models.json` 管理，未配置 `resilience` 的模型不启用 guard
- `stopReason === "length"` 对应原设计中的 `"max_tokens"`，与 ai 包的实际类型一致
- `turnNumber` / `totalToolCallsSoFar` 为 `runLoop` 新增局部变量，不改变外部接口
- Provider 层 `maxRetries` 从 0 改为 2 是行为变更，但只影响 API 调用失败场景
- 重试 off-by-one 修复是行为修正，减少一次意外重试
