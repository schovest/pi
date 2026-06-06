# Subagent Alternate Screen 实时流式渲染设计

## 背景

当前 `/running-subagents` 命令流程：
1. 用户输入 `/running-subagents` → 显示 `SubagentPickerComponent`（列表选择器）
2. 用户选择一个子 agent → 显示状态消息 `"Subagent N: status (detailed view not yet implemented in alt-screen mode)"`
3. 无法查看子 agent 的真实输出

问题：摘要式显示无法呈现子 agent 的真实工作过程（工具调用、文件读写、bash 执行等），可读性差。

## 目标

- 选择子 agent 后进入 alternate screen buffer，用与主 agent 相同的组件实时渲染子 agent 的流式输出
- 子 agent 仍在运行时：实时流式渲染，体验与主 agent 一致
- 子 agent 已完成时：快照模式，从结果数据重建输出
- 按键逻辑与 less 类似（j/k/方向键/PageUp/PageDown/Home/End/q/Esc/Ctrl+O）
- 子 agent 顶部显示名称和状态，底部显示导航提示和行数

## 架构

### 数据来源

子 agent child session 是纯内存的 `AgentSession`，其输出通过两种方式获取：

1. **实时事件流**（子 agent 运行中）：
   - `child.subscribe()` 订阅 `AgentSessionEvent`
   - 事件类型：`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`agent_end`
   - 子 agent 完成后 `child.dispose()` 被调用，订阅自动结束

2. **结果数据**（子 agent 已完成）：
   - `SubagentRunResult.messages` 包含完整的 assistant 消息
   - `SubagentRunEvent[]` 包含运行过程中的事件摘要
   - `SubagentToolDetails.children` 在完成后被 `clear()`，无法再访问 child session

### 渲染方案

#### 方案 A：独立渲染容器 + 事件订阅（已选）

进入 alternate screen 后，创建独立的 `Container` 作为子 agent 的 chatContainer，订阅子 session 事件流，实时将消息渲染到这个容器中。

**优点**：
- 与主 agent 渲染逻辑一致，组件复用性好
- 实时更新体验最佳
- 不侵入主 chatContainer

**缺点**：
- 需要在 alt-screen 中维护独立的渲染循环
- 子 agent 完成后需要 fallback 到快照模式

### 核心数据流

```
/running-subagents → SubagentPickerComponent 选择子 agent
  → enterSubagentAlternateScreen(index)
    → 检查 children.get(index) 是否存在
      ├─ 存在（运行中）：
      │   → ui.suspendRendering()
      │   → terminal.enterAlternateScreen()  // \x1b[?1049h
      │   → 创建 subagentChatContainer (Container)
      │   → child.subscribe(handleSubagentEvent)
      │   → setupSubagentInputListener()
      │   → renderSubagentScreen()
      └─ 不存在（已完成）：
          → ui.suspendRendering()
          → terminal.enterAlternateScreen()
          → 创建 subagentChatContainer
          → rebuildFromResult(result, events)  // 快照模式
          → setupSubagentInputListener()
          → renderSubagentScreen()
  → 子 session 事件到达（运行中模式）
    → handleSubagentEvent(event)
      → 创建/更新组件
    → renderSubagentScreen()
  → 用户按 Esc/q/Ctrl+O
    → exitSubagentAlternateScreen()
      → unsubscribe()（如有）
      → terminal.exitAlternateScreen()  // \x1b[?1049l
      → ui.resumeRendering()
```

## 状态管理

### 新增字段

```typescript
// interactive-mode.ts

// Alt-screen 状态
private subagentAlternateScreenActive = false;
private subagentAlternateScrollOffset = 0;
private subagentAlternateViewIndex: number | null = null;

// 渲染容器和组件
private subagentChatContainer = new Container();
private subagentStreamingComponent: AssistantMessageComponent | null = null;
private subagentPendingTools = new Map<string, ToolExecutionComponent>();

// 订阅和监听器清理
private subagentUnsubscribe: (() => void) | null = null;
private subagentRemoveInputListener: (() => void) | null = null;

// 子 agent 信息（用于标题栏和状态栏）
private subagentAlternateName: string = "";
private subagentAlternateStatus: SubagentRunStatus = "running";
```

### 状态生命周期

```
enterSubagentAlternateScreen()
  → 设置 subagentAlternateScreenActive = true
  → 初始化 subagentChatContainer、subagentStreamingComponent、subagentPendingTools
  → 设置 subagentAlternateName、subagentAlternateStatus

exitSubagentAlternateScreen()
  → 设置 subagentAlternateScreenActive = false
  → 清理 subagentChatContainer.clear()
  → 清理 subagentUnsubscribe?.()
  → 清理 subagentRemoveInputListener?.()
  → 重置所有状态字段
```

## 事件处理

### `handleSubagentEvent(event: AgentSessionEvent)`

复用主 agent `handleEvent` 的核心逻辑，但写入 `subagentChatContainer`：

| 事件 | 操作 |
|------|------|
| `message_start` (assistant) | 创建 `AssistantMessageComponent(undefined, hideThinking, markdownTheme)`，设为 `subagentStreamingComponent`，加入 `subagentChatContainer` |
| `message_update` (assistant) | 更新 `subagentStreamingComponent?.updateContent(message)`；扫描 content 中的 toolCall 块，创建 `ToolExecutionComponent` 加入 `subagentPendingTools` 和 `subagentChatContainer` |
| `message_end` (assistant) | 最终更新 `subagentStreamingComponent?.updateContent()`；对 `subagentPendingTools` 中的工具调 `setArgsComplete()`；清空 `subagentStreamingComponent` |
| `tool_execution_start` | 从 `subagentPendingTools` 取或创建 `ToolExecutionComponent`，调 `markExecutionStarted()` |
| `tool_execution_update` | 从 `subagentPendingTools` 取组件，调 `updateResult({...event.partialResult, isError: false}, true)` |
| `tool_execution_end` | 从 `subagentPendingTools` 取组件，调 `updateResult({...event.result, isError: event.isError})`；从 `subagentPendingTools` 删除 |
| `agent_end` | 清除 `subagentStreamingComponent`，清空 `subagentPendingTools`；更新 `subagentAlternateStatus = "success" | "failed"` |

### 快照模式：`rebuildFromResult(result: SubagentRunResult, events: SubagentRunEvent[])`

子 agent 已完成时，从结果数据重建输出：

1. 遍历 `result.messages`：
   - assistant 消息 → 创建 `AssistantMessageComponent(message, ...)`
   - tool call 信息从 `message.content` 中提取：assistant 消息的 `content` 数组中 `type: "tool_call"` 的 block 包含 `toolCallId`、`toolName`、`args`
   - 对每个 tool call block → 创建 `ToolExecutionComponent(toolName, toolCallId, args, ...)`
   - tool result 信息从后续 `role: "toolResult"` 消息中提取，与 `toolCallId` 匹配后调 `updateResult()`
2. 设置 `subagentAlternateStatus = result.status`
3. 所有组件默认展开状态（`setExpanded(true)`），与 Ctrl+O 展开体验一致

## 渲染

### `renderSubagentScreen()`

不使用 TUI 的主渲染循环（已 suspend），独立渲染：

```typescript
private renderSubagentScreen(): void {
    if (!this.subagentAlternateScreenActive) return;
    
    const width = this.ui.terminal.columns;
    const height = this.ui.terminal.rows;
    
    // 1. 渲染标题栏（1 行）
    const headerLine = this.renderSubagentHeader();
    
    // 2. 渲染内容区域
    const contentLines = this.subagentChatContainer.render(width);
    
    // 3. 渲染状态栏（1 行）
    const footerLine = this.renderSubagentFooter(contentLines.length);
    
    // 4. 计算可见区域
    const contentHeight = height - 2;  // 减去标题栏和状态栏
    const maxOffset = Math.max(0, contentLines.length - contentHeight);
    this.subagentAlternateScrollOffset = Math.min(this.subagentAlternateScrollOffset, maxOffset);
    
    // 5. 组装最终输出
    const visibleLines = [
        headerLine,
        ...contentLines.slice(this.subagentAlternateScrollOffset, this.subagentAlternateScrollOffset + contentHeight),
        footerLine,
    ];
    
    // 6. 清屏并写入
    this.ui.terminal.write("\x1b[2J\x1b[H");  // 清屏 + 移动光标到左上角
    this.ui.terminal.write(visibleLines.join("\n"));
}
```

### 渲染触发时机

1. `enterSubagentAlternateScreen()` 后立即调用
2. 每个 `handleSubagentEvent()` 后调用
3. 输入事件（滚动）后调用
4. 终端 resize 时调用（通过 `InputListener` 监听 resize 事件）

### 标题栏格式

```
┌─ subagent: scout · running ───────────────────────────────────────────┐
```

- 左侧：子 agent 名称 + 状态（running/success/failed/aborted）
- 状态颜色：running=黄色，success=绿色，failed/aborted=红色

### 状态栏格式

```
└─ Lines 1-20 of 156 | ↑↓ j/k scroll · PgUp/PgDn · Home/End · q exit ───┘
```

- 显示当前可见行范围 / 总行数
- 按键提示

## 输入处理

### `setupSubagentInputListener()`

注册 `InputListener`，拦截所有输入：

```typescript
private setupSubagentInputListener(): void {
    this.subagentRemoveInputListener = this.ui.addInputListener((data) => {
        if (!this.subagentAlternateScreenActive) return undefined;
        
        // 滚动
        if (matchesKey(data, "up") || matchesKey(data, "k")) {
            this.scrollSubagentAlternateScreen(-1);
            return { consume: true };
        }
        if (matchesKey(data, "down") || matchesKey(data, "j")) {
            this.scrollSubagentAlternateScreen(1);
            return { consume: true };
        }
        if (matchesKey(data, "pageUp")) {
            const pageSize = this.ui.terminal.rows - 2;
            this.scrollSubagentAlternateScreen(-pageSize);
            return { consume: true };
        }
        if (matchesKey(data, "pageDown")) {
            const pageSize = this.ui.terminal.rows - 2;
            this.scrollSubagentAlternateScreen(pageSize);
            return { consume: true };
        }
        if (matchesKey(data, "home") || matchesKey(data, "g")) {
            this.subagentAlternateScrollOffset = 0;
            this.renderSubagentScreen();
            return { consume: true };
        }
        if (matchesKey(data, "end") || matchesKey(data, "G")) {
            // 跳到底部（需要知道总行数）
            this.renderSubagentScreen();  // 先渲染一次获取行数
            const contentLines = this.subagentChatContainer.render(this.ui.terminal.columns);
            const maxOffset = Math.max(0, contentLines.length - (this.ui.terminal.rows - 2));
            this.subagentAlternateScrollOffset = maxOffset;
            this.renderSubagentScreen();
            return { consume: true };
        }
        
        // 退出
        if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) {
            this.exitSubagentAlternateScreen();
            return { consume: true };
        }
        
        // 其他按键不处理，但 consume 防止传递到主 TUI
        return { consume: true };
    });
}
```

### `scrollSubagentAlternateScreen(delta: number)`

```typescript
private scrollSubagentAlternateScreen(delta: number): void {
    const contentLines = this.subagentChatContainer.render(this.ui.terminal.columns);
    const contentHeight = this.ui.terminal.rows - 2;
    const maxOffset = Math.max(0, contentLines.length - contentHeight);
    
    this.subagentAlternateScrollOffset = Math.max(0, Math.min(maxOffset, this.subagentAlternateScrollOffset + delta));
    this.renderSubagentScreen();
}
```

## 与 Ctrl+O 的关系

- **Ctrl+O（`toggleToolOutputExpansion`）**：控制主 agent 工具输出的展开/折叠，不涉及 alternate screen buffer
- **Subagent alt-screen**：使用终端 alternate screen buffer，完全独立的屏幕

两者不会同时激活。`subagentAlternateScreenActive` 为 true 时，主 TUI 渲染已暂停，Ctrl+O 的输入被 `InputListener` 拦截并触发退出 alt-screen。

## 边界情况

### 1. 子 agent 尚无消息

- 显示标题栏 + "[No output yet]" + 状态栏
- 事件到达后实时追加内容

### 2. 子 agent 运行中进入

- 实时流式渲染
- 状态栏显示 "running"
- 子 agent 完成后状态栏更新为 "success" 或 "failed"

### 3. 子 agent 已完成

- `children.get(index)` 返回 undefined
- 使用快照模式：`rebuildFromResult(result, events)`
- 状态栏显示最终状态

### 4. 子 agent 在 alt-screen 中完成

- `agent_end` 事件到达后更新 `subagentAlternateStatus`
- 状态栏更新为 "success" 或 "failed"
- 用户可继续滚动查看完整输出
- 按 q/Esc/Ctrl+O 退出

### 5. 终端 resize

- `InputListener` 不直接处理 resize，但 TUI 的 resize 逻辑会在 `resumeRendering` 时触发
- 需要在 alt-screen 中监听 `process.stdout.on("resize", ...)` 或在 `renderSubagentScreen` 中检测尺寸变化
- 简化方案：每次 `renderSubagentScreen` 都重新获取 `terminal.columns/rows`

### 6. 多个子 agent 同时运行

- 每次只能查看一个子 agent
- 退出 alt-screen 后可再次 `/running-subagents` 选择其他子 agent

## 关键文件修改

| 文件 | 修改内容 |
|------|----------|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 新增状态字段；新增 `enterSubagentAlternateScreen`、`exitSubagentAlternateScreen`、`handleSubagentEvent`、`rebuildFromResult`、`renderSubagentScreen`、`renderSubagentHeader`、`renderSubagentFooter`、`setupSubagentInputListener`、`scrollSubagentAlternateScreen`；修改 `showSubagentDetails` 的 `onSelect` 回调 |
| `packages/coding-agent/src/modes/interactive/components/subagent-details.ts` | 无需修改 |

## 验证方法

1. 启动 agent，触发子 agent 创建（如使用 Agent 工具）
2. 输入 `/running-subagents`
3. 选择一个正在运行的子 agent
4. 验证进入 alternate screen，内容实时更新，与主 agent 输出风格一致
5. 验证 j/k/方向键/PageUp/PageDown/Home/End 滚动正常
6. 验证 q/Esc/Ctrl+O 退出 alternate screen 回到主界面
7. 等待子 agent 完成后再次选择
8. 验证快照模式正常显示完整输出
