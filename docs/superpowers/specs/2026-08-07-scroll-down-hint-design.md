# 滚动底部提示（Scroll Down Hint）设计

## 概述

当用户向上滚动消息（不在消息底部）时，在 working 行（`statusContainer` 中的 Loader）上方新增一行提示：显示箭头 + 文字（如 `↓ 新消息`），表明当前视图不在消息底部。

- **显示条件**：任何时刻只要 `scrollOffset > 0`（用户不在消息底部）就显示，不限于 streaming 中
- **交互**：纯显示，无点击/按键行为
- **形式**：带文字的提示，`↓ 新消息`（`theme.fg("muted", …)`，与 working 文字一致）

## 技术实现

### 1. TUI 层小改动：`packages/tui/src/tui.ts` doRender

现状：`doRender` 中 `scrollOffset` 会被隐式修正，但不触发 `onScrollOffsetChange`：

- `lineCountDelta > 0` 且 `autoFollow === false` 且 `offset > 0` 时：`offset += lineCountDelta`（保持相对阅读位置）
- `offset > maxScroll` 时：clamp 到 `maxScroll`（`/clear`、compaction、终端变大时可能 clamp 到 0）

改法：记录调整前的 offset，若调整后值变化则补发 `this.onScrollOffsetChange?.(this.scrollOffset)`。

必要性：不补发的话，`/clear` 等场景 offset 被 clamp 到 0 后箭头行会残留显示（回调驱动方案无感知）。该回调当前无任何消费者，安全。

### 2. interactive-mode.ts（主体）

| 改动 | 内容 |
| ------ | ------ |
| 字段 | 新增 `private scrollHint: Text`（构造器初始化，paddingX=0, paddingY=0） |
| 布局 | `init()` 中在 `statusContainer` **之前** `addChild(this.scrollHint)`（保证箭头行位于 working 行上方）；`setFixedBottomCount(5)` → `6` |
| 挂接 | `this.ui.onScrollOffsetChange = (offset) => this.updateScrollHint(offset)`（init 中，`ui.start()` 前后均可，放在布局 setup 之后） |
| 更新 | `updateScrollHint(offset)`：`offset > 0` 时 `setText(theme.fg("muted", "↓ 新消息"))`，否则 `setText("")`；仅当文本变化时 `requestRender()` |

Text 组件空文本时 `render` 返回 `[]`（0 行），非滚动状态下布局零残留；滚动时渲染 1 行，位于固定区域顶部。

布局顺序（fixedBottomCount = 6）：

```text
[chatContainer, pendingMessagesContainer, scrollHint, statusContainer,
 widgetContainerAbove, editorContainer, widgetContainerBelow, footer]
```

### 3. 边界场景

| 场景 | 行为 |
| ------ | ------ |
| 用户滚动（滚轮/按键/PgUp/PgDn） | `flushPendingScroll` / `setScrollOffset` 触发回调 → 显示箭头 |
| streaming 中新消息到达（用户停在 offset>0） | `offset += lineCountDelta` 后补发回调；offset 仍 > 0，文本不变，无额外渲染 |
| `/clear`、compaction、终端变大 | offset clamp 到 0，补发回调 → 箭头消失 |
| 回到底部（offset=0） | `setScrollOffset(0)` / `resetScrollOffset` / `setAutoFollow(true)` 触发回调 → 箭头消失 |
| 内容不足一屏 | `maxScroll = 0`，offset 恒为 0 → 永不显示 |

## 测试

### TUI 层（`packages/tui/test/tui-render.test.ts`）

- doRender 中 offset 被 clamp 时触发 `onScrollOffsetChange`
- `lineCountDelta` 调整 offset 时触发 `onScrollOffsetChange`

### coding-agent 层（新增 `packages/coding-agent/test/interactive-mode-scroll-hint.test.ts`，vitest）

参照 `interactive-mode-status.test.ts` 的 fakeThis 模式，直接调用 prototype 方法：

- `updateScrollHint(0)` → scrollHint 文本为空（渲染 0 行）
- `updateScrollHint(5)` → 文本包含 `↓` 与 `新消息`
- `updateScrollHint(5)` 后再 `updateScrollHint(0)` → 文本清空
- init 布局断言：`ui.children` 中 scrollHint 位于 statusContainer 之前；`setFixedBottomCount(6)`
- 真实 TUI + VirtualTerminal 集成：`setScrollOffset(3)` 后渲染输出含提示行；`setScrollOffset(0)` 后消失

## 不做的事

- 不做点击/按键回到底部交互（TODO 只要求显示）
- 不改 `statusContainer` 结构（会被多处 `clear()`，无法承载独立状态行）
- 不新增可配置项
