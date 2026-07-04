# Overlay 选区复制修复 — 设计文档

**日期**: 2026-07-04
**范围**: `packages/tui/src/tui.ts`、`packages/coding-agent/src/modes/interactive/components/subagent-overlay.ts`、`packages/coding-agent/src/modes/interactive/interactive-mode.ts`
**关联 bug**: subagent overlay（`/running-subagents`）中选中文本复制得到错误内容；overlay 内部滚动后选区位置偏移
**前置修复**: [2026-07-04-selection-scroll-design.md](./2026-07-04-selection-scroll-design.md)（主视口选区改用缓冲区绝对坐标）

## 1. 问题分析

### 背景

前置修复将 `SelectionState` 的坐标从屏幕相对改为缓冲区绝对（`currentFullLines` 数组索引），解决了主视口滚动导致的选区错位。但引入了一个遗漏：`currentFullLines` 是 overlay 合成**之前**的缓冲区，不含 overlay 渲染内容。

subagent overlay 是全屏覆盖（`row:0, col:0, width:"100%"`），有 `selectionClip` 限制可选列范围到右面板，并有独立内部滚动 `detailScrollOffset`。

### Bug 1：复制提取错误文本

`extractSelectionText` 从 `currentFullLines[bufferRow]` 提取。当 overlay 覆盖该行时：

- 用户看到的是 overlay 渲染的 subagent 消息
- `currentFullLines[bufferRow]` 是 overlay 背后的主聊天内容
- 复制结果 = 主聊天内容片段（clip 到右面板列范围），而非 subagent 消息

同样的问题影响 `mouseDown`/`mouseMove` 中的 `snapColToGraphemeBoundary`——用错误的行做字素边界对齐。

### Bug 2：overlay 滚动后选区偏移

overlay 的 `detailScrollOffset` 是独立于 TUI 主滚动（`scrollOffset`）的滚动机制。当 overlay 滚动时：

- `currentFullLines` 不变（主内容不变）
- `bufferToScreenRow` 映射不变（主视口没滚）
- overlay 渲染的内容已偏移 → 选区高亮留在同一屏幕位置，指向不同的 overlay 内容

前置修复的设计文档第 7 节假设 "modal overlay 时滚动被禁用，不会触发此情况"——该假设对 subagent overlay **不成立**。

### 根因

overlay 内容不在 `currentFullLines` 中，overlay 内部滚动不参与 TUI 坐标映射系统。

## 2. 设计方案：混合提取 + 滚动清空选区

### 2.1 缓存合成行

新增 TUI 实例字段：

```typescript
// overlay 合成后、selection 高亮前的行缓存（供 overlay 区域文本提取和坐标 snap 使用）
private currentCompositedLines: string[] = [];
```

在 `doRender()` 中，`compositeOverlays` 之后、`applySelectionHighlight` 之前赋值：

```typescript
if (this.overlayStack.length > 0) {
    newLines = this.compositeOverlays([...newLines], width, height);
}

// 缓存合成行（纯净文本，无 selection 高亮）
this.currentCompositedLines = [...newLines];
```

**不用 `previousLines` 的原因**：`previousLines` 包含 selection 高亮的 `\x1b[7m` 反视频代码。虽然 `stripAnsi` 能处理，但在概念上不干净。`currentCompositedLines` 在高亮前缓存，是纯净的合成文本。

### 2.2 extractSelectionText 混合提取

对每行检查是否被 overlay 覆盖（`getSelectionClipForRow(screenRow)` 返回非 null）：

- **被 overlay 覆盖** → 从 `currentCompositedLines[screenRow]` 提取
- **未被覆盖** → 从 `currentFullLines[bufferRow]` 提取（不变）

```typescript
for (let bufferRow = startBufferRow; bufferRow <= endBufferRow; bufferRow++) {
    if (bufferRow < 0 || bufferRow >= lines.length) continue;
    const screenRow = this.bufferToScreenRow(bufferRow);
    const clip = screenRow >= 0 ? this.getSelectionClipForRow(screenRow) : null;

    // 选择文本源：overlay 覆盖的行用合成行，否则用全量缓冲区行
    const sourceLine =
        clip != null && screenRow >= 0 && screenRow < this.currentCompositedLines.length
            ? this.currentCompositedLines[screenRow]
            : lines[bufferRow]; // lines = currentFullLines

    const rowStartCol = bufferRow === startBufferRow ? startCol : 0;
    const rowEndCol = bufferRow === endBufferRow ? endCol : visibleWidth(sourceLine) - 1;
    let clipStart = rowStartCol;
    let clipEnd = rowEndCol;
    if (clip) {
        clipStart = Math.max(clipStart, clip.col);
        clipEnd = Math.min(clipEnd, clip.col + clip.width - 1);
    }
    if (clipStart > clipEnd) continue;
    parts.push(stripAnsi(sliceByColumn(sourceLine, clipStart, clipEnd - clipStart + 1)));
}
```

关键变更：
- `sourceLine` 根据 overlay 覆盖情况选择数据源
- `visibleWidth` 改用 `sourceLine`（overlay 行和主内容行宽度可能不同）
- 未被 overlay 覆盖的行行为完全不变（向后兼容）

### 2.3 mouseDown/mouseMove snap 修正

overlay 覆盖的行用 `currentCompositedLines[screenRow]` 做 `snapColToGraphemeBoundary`：

```typescript
// mouseDown / mouseMove
const screenRow = event.row - 1;
const rawCol = event.col - 1;
const bufferRow = this.screenToBufferRow(screenRow);
const clip = this.getSelectionClipForRow(screenRow);
const sourceLine =
    clip != null && screenRow < this.currentCompositedLines.length
        ? this.currentCompositedLines[screenRow]
        : this.currentFullLines[bufferRow];
const col = sourceLine != null ? snapColToGraphemeBoundary(sourceLine, rawCol) : rawCol;
```

### 2.4 TUI 暴露 clearSelection 方法

```typescript
clearSelection(): void {
    this.clearAutoScrollTimer();
    this.selection = null;
    this.requestRender();
}
```

### 2.5 overlay 滚动时清空选区

`SubagentOverlayOptions` 新增：

```typescript
clearSelection?: () => void;
```

在所有修改 `detailScrollOffset` 的地方（`handleInput` 中的 scrollUp/scrollDown/pageUp/pageDown/home/end），调用 `this.clearSelection?.()`。

`interactive-mode.ts` 在创建 overlay 时传入 `clearSelection: () => this.ui.clearSelection()`。

## 3. 涉及文件与改动清单

| 文件 | 位置 | 改动 |
|------|------|------|
| `packages/tui/src/tui.ts` | 实例字段 | 新增 `currentCompositedLines: string[]` |
| | `doRender` | overlay 合成后缓存 `currentCompositedLines` |
| | `extractSelectionText` | 混合提取逻辑 |
| | `handleMouseEvent` mouseDown/mouseMove | snap 用 `currentCompositedLines` |
| | 公开方法 | 新增 `clearSelection()` |
| `packages/coding-agent/src/modes/interactive/components/subagent-overlay.ts` | `SubagentOverlayOptions` | 新增 `clearSelection?: () => void` |
| | `handleInput` | scrollUp/scrollDown/pageUp/pageDown/home/end 调用 `this.clearSelection?.()` |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | overlay 创建 | 传入 `clearSelection` 回调 |

## 4. 行为对比

### 4.1 overlay 中复制（Bug 1 修复）

| 步骤 | 改造前 | 改造后 |
|------|--------|--------|
| mouseDown overlay 右面板第 5 行 | snap 用 `currentFullLines`（主内容） | snap 用 `currentCompositedLines`（overlay 内容） |
| mouseMove 拖选 | 同上 | 同上 |
| mouseUp extractSelectionText | 从 `currentFullLines` 提取 → 主聊天内容 | 从 `currentCompositedLines` 提取 → subagent 消息 |
| 结果 | **错误文本** | **正确文本** |

### 4.2 overlay 滚动后选区（Bug 2 修复）

| 步骤 | 改造前 | 改造后 |
|------|--------|--------|
| mouseDown 选中 overlay 文本 | selection 锚定 | selection 锚定 |
| 用户 PgDn 滚动 overlay | selection 留在旧屏幕位置，指向偏移内容 | **selection 清空**，无错误高亮 |
| 结果 | **选区偏移** | **干净状态** |

### 4.3 主内容选择（无 overlay，向后兼容）

不受影响——所有 overlay 相关分支在 `clip == null` 时回退到原有逻辑。

## 5. 测试计划

扩展 `packages/tui/test/selection-scroll.test.ts`：

1. **overlay 覆盖行文本提取**：mock overlay + selectionClip，验证 `extractSelectionText` 从合成行提取
2. **混合提取**：部分行 overlay 覆盖、部分不覆盖，验证各取正确数据源
3. **overlay 行 snap**：mouseDown 在 overlay 区域，验证列对齐用合成行
4. **clearSelection**：调用后 `selection` 为 null，`autoScrollTimer` 清除
5. **无 overlay 回归**：验证现有 selection-scroll 测试全部通过

## 6. 风险与限制

1. **`currentCompositedLines` 与 `currentFullLines` 行数不同**：`currentFullLines` 是全量缓冲区（含视口外行），`currentCompositedLines` 是屏幕可见行。overlay 覆盖行只在视口内有意义，所以用 `screenRow` 索引 `currentCompositedLines` 是正确的。
2. **跨滚动页选择不支持**：overlay 滚动清空选区，用户无法选择跨越多个 overlay 滚动页的文本。这是有意的简化。
3. **`currentCompositedLines` 首次渲染前为空数组**：mouseDown/mouseMove 中的边界检查（`screenRow < this.currentCompositedLines.length`）防止越界。
4. **其他 overlay**：如果未来有其他 overlay 也带 `selectionClip`，本修复自动适用（基于 `getSelectionClipForRow` 判断，不硬编码 subagent overlay）。

## 7. 不做的事

- 不改 overlay 合成逻辑（`compositeOverlays`）
- 不改 `bufferToScreenRow` / `screenToBufferRow` 映射
- 不改 `applySelectionHighlight`（高亮已正确应用于 `newLines[screenRow]`）
- 不支持 overlay 跨滚动页选择
- 不改 `selectionClip` 设计（限制列范围到右面板是有意行为）
