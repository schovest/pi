# Selection 跨屏滚动修复 — 设计文档

**日期**: 2026-07-04
**范围**: `packages/tui/src/tui.ts`
**关联 bug**: 复制时选中内容后滚动，选区跟随 viewport 错位，导致跨屏复制失败和已复制内容错乱

## 1. 问题分析

### 当前实现

`SelectionState` 的 `anchorRow`/`focusRow` 是 **viewport 屏幕坐标**（`previousLines` 索引）。

- `mouseDown` (tui.ts:779-785)：`anchorRow = event.row - 1`（屏幕行号）
- `mouseMove` (tui.ts:792-793)：更新 `focusRow` 为当前屏幕行号
- `extractSelectionText` (tui.ts:907-942)：从 `previousLines[anchorRow..focusRow]` 提取
- `applySelectionHighlight` (tui.ts:965-1005)：在 `newLines[anchorRow..focusRow]` 上加反视频

`previousLines` 和 `newLines` 都是 viewport 切片（仅可见行），由 `scrollableLines.slice(viewportTop, viewportTop + viewportHeight)` 产生。

### 错位的根本原因

用户滚动改变 `scrollOffset` → `scrollableViewportTop` 改变 → 下一次 `doRender()` 产生的 `newLines` 内容变化（指向不同的 scrollableLines 切片），但 `selection.anchorRow/focusRow` 是**上次渲染时的屏幕索引**，**不随滚动更新**。

后果：
1. **滚动后选区错位**：`anchorRow=5` 现在指向新 viewport 的第 5 行（不同内容），高亮和复制都错乱。
2. **无法跨屏选择**：`previousLines` 只含 viewport 内的行，滚出视口的内容根本不在数组中。
3. **autoScroll 半残**：`startAutoScroll` (tui.ts:884-898) 每 100ms 滚动 3 行，但只更新 `focusRow=0`（视口顶行），不更新 `anchorRow`，且滚动后 `anchorRow` 指向的行已偏移。

## 2. 设计目标

- 选区在滚动期间保持稳定且正确
- 支持跨屏选择：拖动到屏幕边缘触发自动滚动，选区扩展到滚出视口的内容
- autoScroll 双向：拖到顶滚向旧内容，拖到底滚向新内容
- 向后兼容：单屏内选择的现有行为不变

## 3. 设计方案

### 3.1 核心变更：selection 改用缓冲区绝对坐标

`SelectionState.anchorRow` / `focusRow` 改为 `currentFullLines` 数组的绝对索引（"缓冲区行号"）。

```typescript
// 新增实例字段（tui.ts）
private currentFullLines: string[] = [];   // [scrollableLines, fixedLines] 拼接，渲染前内容
private currentScrollableLinesLength: number = 0;  // scrollable 部分长度
```

`currentFullLines` 在 `doRender()` 中赋值（L1589-1597 区域），保存拼接后的全量行数组。该数组内容**未经 overlay 合成、未经 selection 高亮处理**，是纯净的原始文本——适合作为文本提取的数据源。

缓冲区行号编码：
- `[0, currentScrollableLinesLength)`：scrollable 行（滚动稳定）
- `[currentScrollableLinesLength, currentFullLines.length)`：fixed 行

### 3.2 坐标换算辅助函数

```typescript
// 屏幕行号 → 缓冲区绝对行号（mouseDown/mouseMove 使用）
private screenToBufferRow(screenRow: number): number {
  const svp = this.lastScrollableViewport;
  if (screenRow < svp) {
    // scrollable 区域
    return this.currentScrollableViewportTop + screenRow;
  }
  // fixed 区域
  return this.currentScrollableLinesLength + (screenRow - svp);
}

// 缓冲区绝对行号 → 屏幕行号（渲染高亮、overlay clip 匹配使用）
// 返回 -1 表示该缓冲区行当前不在视口内
private bufferToScreenRow(bufferRow: number): number {
  const scrollableLen = this.currentScrollableLinesLength;
  if (bufferRow < scrollableLen) {
    // scrollable 行
    const screenRow = bufferRow - this.currentScrollableViewportTop;
    if (screenRow < 0 || screenRow >= this.lastScrollableViewport) return -1;
    return screenRow;
  }
  // fixed 行：永远可见，屏幕行号 = lastScrollableViewport + (bufferRow - scrollableLen)
  return this.lastScrollableViewport + (bufferRow - scrollableLen);
}
```

### 3.3 mouseDown/mouseMove 改动

```typescript
// mouseDown
const screenRow = event.row - 1;
const rawCol = event.col - 1;
const bufferRow = this.screenToBufferRow(screenRow);
const line = this.currentFullLines[bufferRow];
const col = line != null ? snapColToGraphemeBoundary(line, rawCol) : rawCol;
this.selection = {
  active: true,
  anchorRow: bufferRow,
  anchorCol: col,
  focusRow: bufferRow,
  focusCol: col,
};

// mouseMove
const screenRow = event.row - 1;
const bufferRow = this.screenToBufferRow(screenRow);
const line = this.currentFullLines[bufferRow];
const col = line != null ? snapColToGraphemeBoundary(line, rawCol) : rawCol;
this.selection.focusRow = bufferRow;
this.selection.focusCol = col;
if (event.row <= 1) {
  this.startAutoScroll(-1);   // 向上滚（向旧内容）
} else if (event.row >= this.terminal.rows) {
  this.startAutoScroll(+1);   // 向下滚（向新内容）
} else {
  this.clearAutoScrollTimer();
}
```

### 3.4 startAutoScroll 改为双向

```typescript
private startAutoScroll(direction: -1 | 1): void {
  if (this.autoScrollTimer && this.autoScrollDirection === direction) return;
  this.clearAutoScrollTimer();
  this.autoFollow = false;
  this.autoScrollDirection = direction;
  this.autoScrollTimer = setInterval(() => {
    if (direction < 0) {
      // 向上滚：视口顶向上扩展
      const maxOffset = this.getMaxScrollOffset();
      if (this.scrollOffset < maxOffset) {
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + AUTO_SCROLL_ROWS);
        if (this.selection) {
          // focus 指向新出现的视口顶行（更旧的内容）
          this.selection.focusRow = this.currentScrollableViewportTop;
        }
      }
    } else {
      // 向下滚：视口顶向下收缩（向新内容）
      if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - AUTO_SCROLL_ROWS);
        if (this.selection) {
          // focus 指向视口底行（最新的可见行）
          const bottomScreenRow = this.lastScrollableViewport - 1;
          this.selection.focusRow = this.currentScrollableViewportTop + bottomScreenRow;
        }
      }
    }
    this.onScrollOffsetChange?.(this.scrollOffset);
    this.requestRender();
  }, AUTO_SCROLL_INTERVAL_MS);
}
```

新增字段 `private autoScrollDirection: -1 | 1 = -1`。

**注意**：autoScroll 修改 `scrollOffset` 触发下一次 `doRender`，`doRender` 会更新 `currentScrollableViewportTop`。但 autoScroll 定时器内引用的 `this.currentScrollableViewportTop` 是**上一次渲染**的值——这正是我们想要的（focus 指向即将滚出/进入的行）。下一次 mouseMove 事件会读取更新后的 `currentScrollableViewportTop`，重设 focus。

### 3.5 applySelectionHighlight 改动

```typescript
private applySelectionHighlight(newLines: string[], viewportTop: number, height: number): void {
  if (!this.selection) return;
  const sel = this.selection;
  const startBufferRow = Math.min(sel.anchorRow, sel.focusRow);
  const endBufferRow = Math.max(sel.anchorRow, sel.focusRow);
  // 计算 startCol/endCol（同现有逻辑，取自 anchor/focus 中对应方向的一侧）
  let startCol: number;
  let endCol: number;
  if (startBufferRow === endBufferRow) {
    startCol = Math.min(sel.anchorCol, sel.focusCol);
    endCol = Math.max(sel.anchorCol, sel.focusCol);
  } else {
    startCol = startBufferRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
    endCol = endBufferRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
  }

  for (let bufferRow = startBufferRow; bufferRow <= endBufferRow; bufferRow++) {
    const screenRow = this.bufferToScreenRow(bufferRow);
    if (screenRow < 0 || screenRow >= height) continue;  // 视口外，不绘制
    if (bufferRow < 0 || bufferRow >= this.currentFullLines.length) continue;
    const line = this.currentFullLines[bufferRow];
    // 注意：渲染时 newLines[screenRow] 是已 overlay 合成的版本，
    // 但 currentFullLines[bufferRow] 是合成前版本——这里用于计算 visibleWidth
    // 和 selectionClip 时换算，实际高亮应用在 newLines[screenRow] 上。
    // 当 overlay 覆盖该行时，newLines[screenRow] 已含 overlay；否则两者相同。
    if (isImageLine(newLines[screenRow])) continue;
    const lineForWidth = newLines[screenRow];
    const lineVisibleWidth = visibleWidth(lineForWidth);
    let colStart = bufferRow === startBufferRow ? Math.min(startCol, lineVisibleWidth) : 0;
    let colEnd = bufferRow === endBufferRow ? Math.min(endCol, lineVisibleWidth - 1) : lineVisibleWidth - 1;
    // overlay clip：使用 screenRow 匹配屏幕固定的 overlay 布局
    const clip = this.getSelectionClipForRow(screenRow);
    if (clip) {
      colStart = Math.max(colStart, clip.col);
      colEnd = Math.min(colEnd, clip.col + clip.width - 1);
    }
    if (colStart > colEnd) continue;
    // 反视频应用（同现有逻辑）
    const targetLine = newLines[screenRow];
    const before = sliceByColumn(targetLine, 0, colStart, true);
    const highlighted = sliceByColumn(targetLine, colStart, colEnd - colStart + 1);
    const after = colEnd + 1 < lineVisibleWidth
      ? sliceByColumn(targetLine, colEnd + 1, lineVisibleWidth - colEnd - 1)
      : "";
    const preservedHighlight = highlighted.replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m");
    newLines[screenRow] = `${before}\x1b[7m${preservedHighlight}\x1b[27m${after}`;
  }
}
```

关键变化：`viewportTop` 参数保持 0（newLines 是 viewport），但循环变量改为 bufferRow，通过 `bufferToScreenRow` 映射到屏幕行。

### 3.6 extractSelectionText 改动

```typescript
private extractSelectionText(): string {
  if (!this.selection) return "";
  const sel = this.selection;
  const lines = this.currentFullLines;
  if (lines.length === 0) return "";
  const startBufferRow = Math.min(sel.anchorRow, sel.focusRow);
  const endBufferRow = Math.max(sel.anchorRow, sel.focusRow);
  let startCol: number;
  let endCol: number;
  if (startBufferRow === endBufferRow) {
    startCol = Math.min(sel.anchorCol, sel.focusCol);
    endCol = Math.max(sel.anchorCol, sel.focusCol);
  } else {
    startCol = startBufferRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
    endCol = endBufferRow === sel.anchorRow ? sel.anchorCol : sel.focusCol;
  }

  const parts: string[] = [];
  for (let bufferRow = startBufferRow; bufferRow <= endBufferRow; bufferRow++) {
    if (bufferRow < 0 || bufferRow >= lines.length) continue;
    const line = lines[bufferRow];
    // overlay clip：换算为屏幕行再匹配
    const screenRow = this.bufferToScreenRow(bufferRow);
    const clip = screenRow >= 0 ? this.getSelectionClipForRow(screenRow) : null;
    const rowStartCol = bufferRow === startBufferRow ? startCol : 0;
    const rowEndCol = bufferRow === endBufferRow ? endCol : visibleWidth(line) - 1;
    let clipStart = rowStartCol;
    let clipEnd = rowEndCol;
    if (clip) {
      clipStart = Math.max(clipStart, clip.col);
      clipEnd = Math.min(clipEnd, clip.col + clip.width - 1);
    }
    if (clipStart > clipEnd) continue;
    parts.push(stripAnsi(sliceByColumn(line, clipStart, clipEnd - clipStart + 1)));
  }
  return parts.join("\n");
}
```

关键变化：从 `currentFullLines`（全量）而非 `previousLines`（viewport）提取——支持跨屏。

### 3.7 doRender 中缓存全量行

在 `doRender()` L1589-1597 构建完 `scrollableLines` 和 `fixedLines` 后：

```typescript
// 缓存全量行（供 selection 使用）
this.currentFullLines = [...scrollableLines, ...fixedLines];
this.currentScrollableLinesLength = scrollableLines.length;
```

放在 `this.previousScrollableLineCount = scrollableLines.length` (L1615) 之后即可。

### 3.8 mouseWheel 处理不变

滚轮事件不修改 selection（用户答案确认）。`flushPendingScroll`、`setScrollOffset`、`resetScrollOffset`、`setAutoFollow` 均不动 selection。

### 3.9 删除 currentScrollableViewportTop 的 biome-ignore

L320-321 已有 `currentScrollableViewportTop` 字段（带 biome-ignore 注释说"reserved for future mouse coordinate mapping"）。本次重构正是这个预留用途的实现——注释可更新。

## 4. 涉及文件与改动清单

仅一个文件：`packages/tui/src/tui.ts`

| 位置 | 改动 |
|------|------|
| SelectionState (L103-109) | 不变（字段名沿用，语义从屏幕→缓冲区） |
| 实例字段 (~L322) | 新增 `currentFullLines`、`currentScrollableLinesLength`、`autoScrollDirection` |
| `screenToBufferRow` / `bufferToScreenRow` | **新增** |
| `handleMouseEvent` mouseDown (L774-785) | 用 `screenToBufferRow` 转换 |
| `handleMouseEvent` mouseMove (L787-798) | 用 `screenToBufferRow` 转换；新增向下 autoScroll 触发 |
| `startAutoScroll` (L884-898) | 改为接收 direction，双向滚动；focus 更新指向视口顶/底 |
| `applySelectionHighlight` (L965-1005) | 循环变量改 bufferRow，用 `bufferToScreenRow` 映射 |
| `extractSelectionText` (L907-942) | 从 `currentFullLines` 提取，overlay clip 用 bufferToScreenRow 换算 |
| `doRender` (~L1615) | 新增 `currentFullLines` / `currentScrollableLinesLength` 赋值 |

## 5. 行为对比

### 5.1 单屏内选择（向后兼容）

| 步骤 | 改造前 | 改造后 |
|------|--------|--------|
| mouseDown 第 5 行 | anchor=5（屏幕） | anchor=viewportTop+5（缓冲区） |
| mouseMove 第 8 行 | focus=8（屏幕） | focus=viewportTop+8（缓冲区） |
| extractSelectionText | 取 previousLines[5..8] | 取 currentFullLines[viewportTop+5 .. viewportTop+8] |
| 结果 | 相同（两数组在 viewport 区域内容一致） | 相同 |

### 5.2 滚动后复制（bug 修复）

| 步骤 | 改造前 | 改造后 |
|------|--------|--------|
| mouseDown 第 5 行（viewportTop=20） | anchor=5 | anchor=25 |
| 用户滚轮向上滚 10 行（viewportTop=10） | previousLines 变化 | currentFullLines 不变（缓冲区没变） |
| mouseUp（鼠标已不在按下，selection 可能为 null，或假设 mouseDown→move→up 全程无滚轮） | 错位：anchor=5 指向新 viewport 第 5 行 | 正确：anchor=25 仍指向缓冲区第 25 行 |

### 5.3 跨屏拖选（新功能）

| 步骤 | 改造前 | 改造后 |
|------|--------|--------|
| mouseDown 第 10 行（viewportTop=30，缓冲区行号 40） | anchor=10 | anchor=40 |
| 拖到屏幕顶（row=1）触发 autoScroll 向上 | scrollOffset 增加，focusRow=0（屏幕），但 anchor=10 指向旧内容错位 | scrollOffset 增加，focusRow=currentViewportTop（不断变小） |
| 滚动到 viewportTop=5 | focus=0 仍是屏幕顶，但缓冲区行号 5 | focus=5（缓冲区） |
| 滚动到 viewportTop=0（最旧） | 错乱 | focus=0，anchor=40，选中缓冲区 [0..40] |
| mouseUp 提取 | 截断到 viewport（仅可见行） | 从 currentFullLines[0..40] 提取，跨屏完整 |

## 6. 测试计划

现有测试 `packages/tui/test/selection-text.test.ts` 不直接调用 `applySelectionHighlight`/`extractSelectionText`（只测试纯函数 `sliceByColumn`、`stripAnsi`、`snapColToGraphemeBoundary`），不受影响。

需新增测试（单元级，mock TUI 实例）：
1. `screenToBufferRow` / `bufferToScreenRow` 的基本映射与边界
2. mouseDown→mouseMove→mouseUp 在无滚动情况下的端到端（回归）
3. mouseDown→mouseMove→wheelScroll→mouseUp：选区不变、复制正确
4. mouseDown→拖到顶→autoScroll 向上→mouseUp：跨屏选择
5. mouseDown→拖到底→autoScroll 向下→mouseUp：跨屏选择（新功能）
6. applySelectionHighlight 在 selection 部分超出视口时不绘制越界
7. fixed 区域 selection（输入框复制）向后兼容

## 7. 风险与限制

1. **scrollableLines 全量约束**：跨屏选择的上限是 `currentFullLines.length`，即所有子组件当前 render 输出的总行数。如果子组件内部 truncate 旧行（当前 none do），则无法选中——这是固有限制。
2. **overlay 与滚动的交互**：overlay 是屏幕固定遮罩。selection 跨屏滚动后，原本被 overlay 覆盖的行可能不再被覆盖（overlay 滚走了）—— 但实际场景中 modal overlay 时滚动被禁用，不会触发此情况。
3. **autoScroll 期间的 focusRow 计算**：依赖 `currentScrollableViewportTop`，该值在下一次 doRender 才更新。autoScroll 定时器内用的是上一次渲染的值——这是期望行为（指向正在滚动的方向）。mouseMove 事件到来时会用最新值重设 focus。
4. **Editor.render 副作用**：Editor 的 `render()` 修改自身 `scrollOffset`。本次重构不在渲染外调用 `child.render()`，仅缓存渲染结果，不引入新副作用。

## 8. 不做的事

- 不改 `stdin-buffer.ts`（鼠标解析无关）
- 不改组件级 selection（Editor 无内部 selection）
- 不改 overlay 合成逻辑
- 不改滚动防抖
- 不添加"持久选区"（mouseUp 后 selection 立即清空，符合现有行为）
