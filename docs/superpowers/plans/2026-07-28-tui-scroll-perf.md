# TUI 滚动性能优化计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复多次 open-websearch 调用后 pi agent 卡顿（滚轮卡顿、editor 输入延时、掉帧），纯缓存优化不改逻辑。

**架构分析见:** `docs/superpowers/plans/2026-07-28-tui-scroll-perf-analysis.md`（本计划的分析文档）

**Tech Stack:** TypeScript, TUI (packages/tui/src), coding-agent (packages/coding-agent/src)

## 全局约束

- `packages/tui/src/tui.ts` 的 `doRender()` 是核心渲染入口，修改需确保不破坏已有渲染（特别是 overlay、selection、kitty image）
- 所有修改必须是缓存优化，不改变渲染语义
- 修改后运行 `npm run check` 通过
- 修改后手动验证 TUI 交互正常

---

### Task 1: getMaxScrollOffset 缓存

**分析：** `getMaxScrollOffset()` 在每次滚轮事件时（`flushPendingScroll`）暴力遍历所有子组件调用 `child.render(width)`。`doRender()` 中已经做了同样的遍历，但结果不被复用。

**根因链：** 每次滚轮 tick → `flushPendingScroll` → `getMaxScrollOffset` → 遍历全部子组件 render → 事件循环阻塞 5-15ms → 下个 tick 延迟 → 滚轮卡顿 + input 队列堆积

**Files:**

- Modify: `packages/tui/src/tui.ts` (TUI 类)

**Interfaces:**

- Produces: `TUI.childLineCounts: number[]` — 每个子组件在最近一次 doRender 中的渲染行数
- Produces: `TUI.lastRenderWidthForScroll: number` — 缓存对应的 terminal width
- Consumes: `this.children`, `this.fixedBottomCount`

- [ ] **Step 1: 添加缓存字段**

在 TUI 类中添加：

```typescript
/** 每个子组件在最近一次 doRender 中的渲染行数，用于 getMaxScrollOffset 缓存 */
private childLineCounts: number[] = [];
/** childLineCounts 对应的 terminal width */
private lastRenderWidthForScroll = 0;
```

- [ ] **Step 2: doRender 中记录行数**

在 `doRender()` 中，`childLines` 计算完毕后立即存储：

```typescript
// 紧跟在 childLines 循环之后：
this.childLineCounts = childLines.map(cl => cl.length);
this.lastRenderWidthForScroll = width;
```

位置参考：`tui.ts:1682-1686`，在渲染完所有 children 后、任何 return 之前。

- [ ] **Step 3: 重写 getMaxScrollOffset**

```typescript
getMaxScrollOffset(): number {
    const width = this.terminal.columns;
    const height = this.terminal.rows;

    // Fast path: 使用缓存的行数（来自最近一次 doRender）
    if (this.childLineCounts.length > 0 && this.lastRenderWidthForScroll === width) {
        const fixedCount = this.fixedBottomCount;
        let scrollableLines = 0;
        let fixedLines = 0;
        for (let i = 0; i < this.childLineCounts.length; i++) {
            if (i >= this.childLineCounts.length - fixedCount) {
                fixedLines += this.childLineCounts[i];
            } else {
                scrollableLines += this.childLineCounts[i];
            }
        }
        const scrollableViewport = Math.max(0, height - fixedLines);
        return Math.max(0, scrollableLines - scrollableViewport);
    }

    // Fallback: 原逻辑（无缓存时兜底）
    const childLines: string[][] = [];
    for (const child of this.children) {
        childLines.push(child.render(width));
    }
    const fixedCount = this.fixedBottomCount;
    let scrollableLines = 0;
    let fixedLines = 0;
    for (let i = 0; i < childLines.length; i++) {
        if (i >= childLines.length - fixedCount) {
            fixedLines += childLines[i].length;
        } else {
            scrollableLines += childLines[i].length;
        }
    }
    const scrollableViewport = Math.max(0, height - fixedLines);
    return Math.max(0, scrollableLines - scrollableViewport);
}
```

- [ ] **Step 4: 验证编译**

运行 `npx tsgo --noEmit 2>&1 | grep -v "packages/ai/test/"`，确认无类型错误。

- [ ] **Step 5: 手动验证交互**

确保滚轮滚动、自动滚动、PageUp/PageDown 行为正常。

---

### Task 2: MCP 工具结果截断（formatToolExecution）

**分析：** MCP 工具（如 open-websearch）没有注册 `renderResult` 回调，走 fallback 路径 `formatToolExecution()`。该函数将工具结果全文拼接到渲染文本中。对比 bash 工具使用 `truncateToVisualLines` 截断为预览行数，MCP 工具全文渲染导致 chat 容器快速膨胀。

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

**Interfaces:**

- Consumes: `truncateToVisualLines(text, maxLines, width, paddingX)` from `./visual-truncate.ts`
- Produces: 截断后的渲染文本（含 "X lines hidden" 提示）

- [ ] **Step 1: 分析 formatToolExecution 当前行为**

确认 MCP 工具走的是 `contentText` fallback 路径：`updateDisplay()` 中 `else { this.contentText.setCustomBgFn(bgFn); this.contentText.setText(this.formatToolExecution()); }`。

`formatToolExecution()` 返回：

```
<toolName>
\n\n<args JSON>
\n<result text>
```

- [ ] **Step 2: 在 formatToolExecution 中对 tool 结果截断**

添加截断逻辑：当 tool 结果文本超过阈值时，只显示前 `MAX_PREVIEW_CHARS` 字符，末尾追加 `\n... (X more chars hidden)`。

```typescript
// tool-execution.ts 顶部
const MAX_PREVIEW_CHARS = 3_000;

private formatToolExecution(): string {
    let text = theme.fg("toolTitle", theme.bold(this.toolName));
    const content = JSON.stringify(this.args, null, 2);
    if (content) {
        text += `\n\n${content}`;
    }
    const output = this.getTextOutput();
    if (output) {
        // 对 tool 结果（output）做截断，args JSON 不截断
        const truncatedOutput = this.truncateOutput(output);
        text += `\n${truncatedOutput}`;
    }
    return text;
}

private truncateOutput(output: string): string {
    if (output.length <= MAX_PREVIEW_CHARS) return output;
    return output.slice(0, MAX_PREVIEW_CHARS) + 
        `\n${theme.fg("muted", `... (${(output.length - MAX_PREVIEW_CHARS).toLocaleString()} more chars hidden)`)}`;
}
```

注意：使用 `theme.fg("muted", ...)` 需要 import theme。

- [ ] **Step 3: 验证编译**

```bash
npx tsgo --noEmit 2>&1 | grep -v "packages/ai/test/"
```

- [ ] **Step 4: 手动验证 MCP 工具结果截断**

触发一次 open-websearch fetchWebContent，确认结果被截断且提示信息正确。

---

### Task 3: 运行 check 并验证

- [ ] **Step 1: 运行完整 check**

```bash
npm run check
```

修复所有 errors/warnings/infos。

- [ ] **Step 2: 确认 docs 无需更新**

自查 `packages/coding-agent/docs/` 各项文件，确认本次修改不涉及文档变更。

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/tui.ts packages/coding-agent/src/modes/interactive/components/tool-execution.ts
git commit -m "perf: 缓存 getMaxScrollOffset 避免滚轮重渲染所有子组件

- getMaxScrollOffset 现在复用 doRender 中的子组件行数缓存
- formatToolExecution 对 MCP 工具结果截断防止 chat 无限膨胀"
```
