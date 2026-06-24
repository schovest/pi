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

/** 模型因 max_tokens 截断而停止时的处理策略（优先级高于 onPrematureStop） */
onMaxTokens?: (context: MaxTokensContext) => MaxTokensAction;

/** 模型主动停止（非 max_tokens、无 tool call）时的处理策略 */
onPrematureStop?: (context: PrematureStopContext) => PrematureStopAction;

/** 检测到重复 tool call 时的处理策略 */
onRepeatedToolCall?: (context: RepeatedToolCallContext) => RepeatedToolCallAction;

/** 最大 turn 数限制，超限时 agent_end 并携带 stopReason: "max_turns" */
maxTurns?: number;

/** 是否发射 guard_triggered 事件（调试/UI 展示用），默认 false */
emitGuardEvents?: boolean;
```

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

### 2.1 Malformed Tool Call — `prepareToolCall` 函数

**位置**：`agent-loop.ts:619-625`（catch 块）和 `569-576`（Tool not found）

在 catch 块中，返回 error result 之前调用 `onMalformedToolCall`：

```
catch (error) {
  if (config.onMalformedToolCall) {
    const action = onMalformedToolCall({ toolCall, error, turnNumber, recentMalformedCount });
    if (action.type === "inject_steering") {
      pendingMessages.push(userMessage(action.message));
    }
    if (action.type === "abort") → 设置 abort 标志
  }
  // 所有路径都返回 error result（inject_steering 额外追加了纠正消息）
  return { kind: "immediate", result: createErrorToolResult(...), isError: true };
}
```

"Tool not found" 同理走此 guard。

需维护 `recentMalformedCount`：在 `runLoop` 中用滑动窗口计数器（窗口 10 轮），每次格式错误 +1，每轮成功执行 tool call 时重置。

### 2.2 MaxTokens — streamAssistantResponse 返回后（最高优先级）

**位置**：`agent-loop.ts:196`（stopReason 检查之后）

在 error/aborted 检查之后、tool call 解析之前，插入 `onMaxTokens` 检查：

```
if (message.stopReason === "max_tokens") {
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

`onMaxTokens` 优先级高于 `onPrematureStop`——`max_tokens` 截断不是模型的选择，而是资源限制，应**无条件续行**。

### 2.3 Premature Stop — 内循环退出后

**位置**：`agent-loop.ts:254-266`

在内循环退出后、followUp 检查之前插入：

```
// 模型说 stop/end_turn（非 toolUse），无 tool call，无 steering
if (message.stopReason !== "toolUse" && toolCalls.length === 0) {
  if (config.onPrematureStop) {
    const action = onPrematureStop({ message, turnNumber, totalToolCallsSoFar });
    if (action.type === "continue") {
      pendingMessages = [userMessage(action.message)];
      continue;  // 回到内循环
    }
    if (action.type === "abort") → break 外循环
  }
}
// 然后是原有的 followUp 检查
```

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
    // 处理 action...
  }
}
// 执行完毕后将本轮 toolCalls 追加到 history
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

在 `@earendil-works/pi-ai` 的 `Model<TApi>` 接口（ai/types.ts:568-598）中新增可选字段：

```typescript
interface Model<TApi = string> {
  // ... 现有字段
  resilience?: ModelResilience;  // 不设值时默认 "medium"
}
```

### 3.2 Guard 策略工厂

新增文件 `packages/agent/src/harness/loop-guards.ts`：

```typescript
export function createLoopGuards(level: ModelResilience): Partial<AgentLoopConfig>
```

三级策略：

| Guard | high | medium | low |
|-------|------|--------|-----|
| `onMalformedToolCall` | `error_result` | `inject_steering`（连续 2 次以上时） | `inject_steering`（每次，含具体纠正提示） |
| `onMaxTokens` | `continue`（"Please continue from where you left off."） | `continue`（无条件续行） | `continue`（无条件续行，含具体提示） |
| `onPrematureStop` | `stop` | `continue`（toolCallsSoFar < 3 时） | `continue`（toolCallsSoFar < 5 时） |
| `onRepeatedToolCall` | `proceed` | `inject_steering`（repeatCount ≥ 3） | `inject_steering`（repeatCount ≥ 2）+ `skip`（≥ 4） |
| `maxTurns` | undefined（不设上限） | 50 | 80 |

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

### 3.3 AgentHarness 集成

在 `AgentHarness.createLoopConfig()` (agent-harness.ts:421-470) 中注入 guard：

```typescript
private createLoopConfig(
  getTurnState: () => AgentHarnessTurnState<...>,
  setTurnState: (turnState: AgentHarnessTurnState<...>) => void,
): AgentLoopConfig {
  const turnState = getTurnState();
  const resilience = turnState.model.resilience ?? "medium";
  const guards = createLoopGuards(resilience);
  return {
    model: turnState.model,
    // ... 现有字段
    ...guards,  // guard 回调展开到 config 中
  };
}
```

`setModel()` 切换模型时，通过 `prepareNextTurn` 回调在下一个 turn 重新注入对应级别的 guards（`prepareNextTurn` 已在 `createLoopConfig` 中配置，会调用 `createTurnState()` 获取最新模型）。

### 3.4 用户显式配置覆盖

用户可在 `settings.json` 中覆盖任何 guard 默认值：

```json
{
  "loopGuards": {
    "maxTurns": 100,
    "resilience": "low"
  }
}
```

显式配置优先于模型级别默认值。优先级：用户 settings > 模型 `resilience` 字段 > 级别默认策略。

AgentHarness 构造时接收可选的 `loopGuards` 配置，在 `createLoopConfig()` 中与模型级别 guards 合并（用户配置覆盖模型默认）。

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

当前：`delayMs = baseDelayMs * 2^(attempt-1)`（无 jitter，无 cap）

改为：
```
delayMs = min(baseDelayMs * 2^(attempt-1), maxRetryDelayMs) * (0.5 + Math.random() * 0.5)
```

新增配置项：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxRetryDelayMs` | 30000 | 单次退避上限 30s |

### 4.3 上下文溢出恢复允许多次

`_overflowRecoveryAttempted` 布尔标志改为计数器：

```typescript
private _overflowRecoveryAttempts = 0;
private readonly MAX_OVERFLOW_RECOVERY = 3;
```

每次溢出恢复递增，成功后不重置（同一轮 agent run 内累计）。不同 prompt 调用时重置。

### 4.4 重试 off-by-one 修复

AgentSession 中的重试逻辑需确保 `maxRetries=N` 时实际重试 N 次（而非 N+1 次）。具体位置需在实现时精确定位 agent-session.ts 中的重试循环，修正边界条件从 `>` 改为 `>=`（或等效调整）。

---

## 五、事件和类型扩展

### 5.1 AgentEndEvent 扩展

```typescript
interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
  stopReason?: "normal" | "max_turns" | "guard_abort";  // 新增可选字段
}
```

- `"normal"` — 默认，模型自然停止
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
| `Model.resilience` 缺失时默认 medium 可能不足 | 用户可通过 settings.json 覆盖；长期靠生成脚本预设 |
| guard 回调抛异常 | loop 中 try/catch 包裹，异常时 fallback 到默认行为 |
| Provider 层默认重试增加延迟 | 默认只 2 次，退避有 jitter + cap，总延迟可控在 ~6s 内 |

---

## 八、向后兼容

- 所有新增字段都是 optional，不配置时行为与当前完全一致
- `AgentEndEvent.stopReason` 可选字段，现有消费者不受影响
- `Model.resilience` 默认 `"medium"`，行为接近当前
- Provider 层 `maxRetries` 从 0 改为 2 是行为变更，但只影响 API 调用失败场景
- 重试 off-by-one 修复是行为修正，减少一次意外重试
