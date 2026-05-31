# /running-subagents 备用屏幕重构设计

## 背景

当前 `/running-subagents` 命令流程：
1. 用户输入 `/running-subagents` → 显示 `SubagentPickerComponent`（列表选择器）
2. 用户选择一个子agent → `enterSubagentRunView` 替换整个 TUI 为 `SubagentRunViewComponent`
3. `SubagentRunViewComponent` 显示摘要信息（状态、任务、工具、输出摘要、事件日志），不是真正的 agent 输出

问题：摘要式显示无法呈现子agent的真实工作过程（工具调用、文件读写、bash 执行等），可读性差。

## 目标

- 选择子agent后进入备用屏幕（alternate screen buffer），用与主agent相同的组件渲染子agent的输出
- 按键逻辑与 Ctrl+O 备用屏幕一致（j/k/方向键/PageUp/PageDown/Home/End/q/Esc/Ctrl+O）
- 子agent顶部显示名称和状态，底部显示导航提示和行数

## 架构

### 数据来源

子agent child session 是纯内存的 `AgentSession`，没有 `chatContainer`。其输出通过事件流传递：

- `SubagentRunEvent`（来自 `child.subscribe`）包含实时事件：`message_delta`、`tool_execution` 等
- `SubagentTaskResult.messages` 包含完整的 assistant 消息和 tool 调用信息

### 渲染方案

新建 `renderSubagentOutput(details: SubagentDetails)` 函数：
1. 创建临时 `Container`
2. 遍历 `details.messages`，对每条消息根据类型创建对应的渲染组件：
   - assistant text → `StreamingTextComponent`（只读）
   - tool call → `ToolExecutionComponent`（展开状态）
   - bash execution → `BashExecutionComponent`（展开状态）
3. 调用 `container.render(width)` 获取文本行
4. 写入备用屏幕

### 状态管理

新增字段：

```typescript
private subagentAlternateScreenActive = false;
private subagentAlternateScrollOffset = 0;
private subagentAlternateViewIndex: number | null = null;
```

### 流程

```
/running-subagents → SubagentPickerComponent
  → 用户选择 agent[index]
    → enterSubagentAlternateScreen(index)
      → ui.suspendRendering()
      → terminal.write("\x1b[?1049h")
      → renderSubagentOutput(details)
      → setupSubagentAlternateScreenInput()
    → 用户按 Esc/q/Ctrl+O
      → exitSubagentAlternateScreen()
        → terminal.write("\x1b[?1049l")
        → ui.resumeRendering()
```

### 输入处理

`setupSubagentAlternateScreenInput()` 注册 `InputListener`，按键映射：

| 按键 | 动作 |
|------|------|
| ↑ / k | 上滚 1 行 |
| ↓ / j | 下滚 1 行 |
| PageUp | 上翻一页 |
| PageDown | 下翻一页 |
| Home / g | 跳到顶部 |
| End / G | 跳到底部 |
| q / Esc / Ctrl+O | 退出备用屏幕 |

所有按键使用 `matchesKey()` 匹配，兼容各种终端序列格式。

### 状态栏

备用屏幕底部显示状态栏：

```
[subagent-name · running/completed] Lines 1-N of M | ↑↓ j/k scroll · PgUp/PgDn · Home/End · q exit
```

## 关键文件修改

| 文件 | 修改内容 |
|------|----------|
| `interactive-mode.ts` | 新增 `enterSubagentAlternateScreen`、`exitSubagentAlternateScreen`、`renderSubagentOutput`、`setupSubagentAlternateScreenInput`、`scrollSubagentAlternateScreen`；修改 `showSubagentDetails` 回调 |
| `subagent-details.ts` | 无需修改，保留为摘要信息的数据源 |

## 与 Ctrl+O 备用屏幕的关系

两者使用相同的底层机制（alternate screen buffer + InputListener + matchesKey），但状态独立：
- Ctrl+O 备用屏幕：`alternateScreenActive`，渲染主 agent 的 chatContainer
- 子agent备用屏幕：`subagentAlternateScreenActive`，渲染选中子agent的输出

两者不会同时激活。`toggleToolOutputExpansion` 中检查 `subagentAlternateScreenActive` 互斥，反之亦然。

## 边界情况

- 子agent尚无消息时：显示"[No output yet]"和子agent名称/状态
- 子agent正在运行中：可以定期刷新（通过已有的 `SubagentDetails` 订阅机制），但不在 v1 实现；v1 只渲染选择时刻的快照
- 子agent已退出：正常显示完整输出

## 验证方法

1. 启动 agent，触发子agent创建（如使用 Agent 工具）
2. 输入 `/running-subagents`
3. 选择一个子agent
4. 验证进入备用屏幕，内容与主agent输出风格一致
5. 验证 j/k/方向键/PageUp/PageDown/Home/End 滚动正常
6. 验证 q/Esc/Ctrl+O 退出备用屏幕回到主界面
