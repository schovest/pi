# 滚动底部提示（Scroll Down Hint）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户不在消息底部（scrollOffset > 0）时，在 working 行上方显示一行 `↓ 新消息` 提示；回到底部即消失。

**Architecture:** 两层改动。TUI 层：`doRender` 中 `scrollOffset` 被隐式修正（clamp / lineCountDelta 推挤）时补发 `onScrollOffsetChange` 通知。coding-agent 层：interactive-mode 新增独立 `Text` 组件 `scrollHint`，插在 `statusContainer` 之前的固定区域，监听 `onScrollOffsetChange` 更新文本（空文本渲染 0 行，无布局残留）。

**Tech Stack:** TypeScript、pi-tui（node:test 测试）、pi-coding-agent（vitest 测试）。

## Global Constraints

- 设计规格：`docs/superpowers/specs/2026-08-07-scroll-down-hint-design.md`
- 显示条件：任何 `scrollOffset > 0` 时显示，不限于 streaming；纯显示无交互
- 文字：`↓ 新消息`，`theme.fg("muted", …)`（与 working 文字一致）
- 箭头行必须在 working 行（`statusContainer`）**上方**
- 测试 runner：tui 包用 `node --test`（从 `packages/tui` 目录），coding-agent 包用 `npx vitest run --dir packages/coding-agent/test <pattern>`（从项目根）
- 每个功能 commit 必须同步更新对应包的 `CHANGELOG.md`（`[Unreleased]` 下），同 commit 提交
- 禁止 `any`；禁止 inline import；禁止 erasable syntax 违规

---

### Task 1: TUI doRender 补发 onScrollOffsetChange

**Files:**

- Modify: `packages/tui/src/tui.ts`（`doRender` 中 scrollOffset 修正段，约 1810-1818 行）
- Test: `packages/tui/test/tui-render.test.ts`（文件末尾追加 describe 块）
- Changelog: `packages/tui/CHANGELOG.md`（`[Unreleased]` → `### Added`）

**Interfaces:**

- Consumes: 无（TUI 自身行为）
- Produces: `TUI.onScrollOffsetChange` 现在在**所有** offset 变化后触发（用户滚动 + 渲染期修正）；Task 2 依赖此语义

- [ ] **Step 1: 写失败测试**

在 `packages/tui/test/tui-render.test.ts` 末尾追加（使用文件已有的 `TestComponent` / `VirtualTerminal`）：

```ts
describe("TUI scroll offset change notification", () => {
 it("notifies when the offset is clamped during render", async () => {
  const terminal = new VirtualTerminal(40, 10);
  const tui = new TUI(terminal);
  const component = new TestComponent();
  tui.addChild(component);
  const offsets: number[] = [];
  tui.onScrollOffsetChange = (offset) => offsets.push(offset);
  tui.start();

  // 30 行内容 → maxScroll = 20（终端高 10）
  component.lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
  tui.requestRender(true);
  await terminal.waitForRender();
  tui.setScrollOffset(10);
  assert.equal(tui.getScrollOffset(), 10);

  // 内容缩短到 1 行 → maxScroll = 0，offset 被 clamp 到 0，必须通知
  offsets.length = 0;
  component.lines = ["only-line"];
  tui.requestRender(true);
  await terminal.waitForRender();

  assert.equal(tui.getScrollOffset(), 0);
  assert.deepEqual(offsets, [0]);
 });

 it("notifies when growing content pushes the offset while scrolled up", async () => {
  const terminal = new VirtualTerminal(40, 10);
  const tui = new TUI(terminal);
  const component = new TestComponent();
  tui.addChild(component);
  const offsets: number[] = [];
  tui.onScrollOffsetChange = (offset) => offsets.push(offset);
  tui.start();

  component.lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
  tui.requestRender(true);
  await terminal.waitForRender();
  tui.setScrollOffset(5);
  assert.equal(tui.getScrollOffset(), 5);

  // 内容 30 → 40 行（delta 10），autoFollow=false 且 offset>0 → offset 被推到 15，必须通知
  offsets.length = 0;
  component.lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  tui.requestRender(true);
  await terminal.waitForRender();

  assert.equal(tui.getScrollOffset(), 15);
  assert.deepEqual(offsets, [15]);
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

从项目根运行：

```bash
cd packages/tui && node --test test/tui-render.test.ts
```

Expected: 两个新用例 FAIL（`offsets` 为空数组，`deepEqual` 不匹配）。

- [ ] **Step 3: 实现**

修改 `packages/tui/src/tui.ts` `doRender` 中的 offset 修正段：

```ts
  // Apply scrollOffset to scrollable content only
  const maxScroll = Math.max(0, scrollableLines.length - scrollableViewport);
  const prevScrollOffset = this.scrollOffset;
  const lineCountDelta = scrollableLines.length - this.previousScrollableLineCount;
  if (lineCountDelta > 0) {
   if (this.autoFollow) {
    this.scrollOffset = 0;
   } else if (this.scrollOffset > 0) {
    this.scrollOffset += lineCountDelta;
   }
  }
  if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
  this.previousScrollableLineCount = scrollableLines.length;
  if (this.scrollOffset !== prevScrollOffset) {
   this.onScrollOffsetChange?.(this.scrollOffset);
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/tui && node --test test/tui-render.test.ts
```

Expected: 全部 PASS（含新增 2 个用例）。

- [ ] **Step 5: 更新 tui CHANGELOG**

`packages/tui/CHANGELOG.md` `[Unreleased]` 下 `### Added` 追加：

```markdown
### Added

- `TUI.doRender` 渲染期 `scrollOffset` 被隐式修正（内容缩短 clamp、滚动中内容增长推挤）时补发 `onScrollOffsetChange` 通知，回调语义统一为"offset 变化即通知"
```

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/tui.ts packages/tui/test/tui-render.test.ts packages/tui/CHANGELOG.md
git commit -m "feat(tui): doRender 渲染期 scrollOffset 修正时补发 onScrollOffsetChange"
```

---

### Task 2: interactive-mode 滚动提示行

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（字段声明 ~315 行、构造器 ~463 行、init 布局 ~783-813 行、updateScrollHint 新方法 ~1850 行区域）
- Create: `packages/coding-agent/test/interactive-mode-scroll-hint.test.ts`
- Changelog: `packages/coding-agent/CHANGELOG.md`（`[Unreleased]` → `### Added`）

**Interfaces:**

- Consumes: Task 1 的 `TUI.onScrollOffsetChange`（渲染期修正也通知）；`TUI.setFixedBottomCount`；`Text.setText`（空文本 render 返回 `[]`）
- Produces: `InteractiveMode.updateScrollHint(offset: number): void`（私有方法，Task 3 不依赖；测试经 `Reflect.get(prototype, "updateScrollHint")` 调用）

- [ ] **Step 1: 写失败测试**

创建 `packages/coding-agent/test/interactive-mode-scroll-hint.test.ts`（参照 `interactive-mode-status.test.ts` 的 fakeThis + `interactive-mode-compaction.test.ts` 的 `Reflect.get` 模式）：

```ts
import { describe, expect, test, vi } from "vitest";
import { Text } from "../../tui/src/components/text.ts";
import { type Component, Container, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
 tui.requestRender(true);
 await Promise.resolve();
 await terminal.waitForRender();
}

type HintThis = {
 scrollHint: Text;
 scrollHintVisible: boolean;
 ui: { requestRender: () => void };
};

const updateScrollHint = Reflect.get(InteractiveMode.prototype, "updateScrollHint") as (
 this: HintThis,
 offset: number,
) => void;

describe("InteractiveMode scroll down hint", () => {
 beforeAll(() => {
  initTheme("dark");
 });

 test("updateScrollHint shows the hint when scrolled away from bottom", () => {
  const scrollHint = new Text("", 0, 0);
  const ui = { requestRender: vi.fn() };
  const fakeThis: HintThis = { scrollHint, scrollHintVisible: false, ui };

  updateScrollHint.call(fakeThis, 5);

  expect(fakeThis.scrollHintVisible).toBe(true);
  const rendered = scrollHint.render(120).join("\n");
  expect(rendered).toContain("↓");
  expect(rendered).toContain("新消息");
  expect(ui.requestRender).toHaveBeenCalledTimes(1);

  // 幂等：offset 变化但状态未变，不重复渲染
  updateScrollHint.call(fakeThis, 8);
  expect(ui.requestRender).toHaveBeenCalledTimes(1);
 });

 test("updateScrollHint clears the hint when back at the bottom", () => {
  const scrollHint = new Text("", 0, 0);
  const ui = { requestRender: vi.fn() };
  const fakeThis: HintThis = { scrollHint, scrollHintVisible: true, ui };

  updateScrollHint.call(fakeThis, 0);

  expect(fakeThis.scrollHintVisible).toBe(false);
  expect(scrollHint.render(120)).toEqual([]);
  expect(ui.requestRender).toHaveBeenCalledTimes(1);
 });

 test("end-to-end: scroll offset drives the hint line in rendered output", async () => {
  const terminal = new VirtualTerminal(80, 24);
  const ui = new TUI(terminal);
  const scrollHint = new Text("", 0, 0);
  const fakeThis: HintThis = { scrollHint, scrollHintVisible: false, ui };

  // 模拟 init() 中的挂接
  ui.onScrollOffsetChange = (offset) => updateScrollHint.call(fakeThis, offset);

  const content = new Container();
  content.addChild({
   render: () => Array.from({ length: 40 }, (_, i) => `line-${i}`),
   invalidate: () => {},
  });
  ui.addChild(content);
  ui.addChild(scrollHint);
  ui.setFixedBottomCount(1);
  ui.start();
  try {
   await flushTui(ui, terminal);
   expect(terminal.getViewport().join("\n")).not.toContain("新消息");

   ui.setScrollOffset(5);
   await flushTui(ui, terminal);
   expect(terminal.getViewport().join("\n")).toContain("新消息");

   ui.setScrollOffset(0);
   await flushTui(ui, terminal);
   expect(terminal.getViewport().join("\n")).not.toContain("新消息");
  } finally {
   ui.stop();
  }
 });
});
```

- [ ] **Step 2: 运行测试确认失败**

从项目根运行：

```bash
npx vitest run --dir packages/coding-agent/test interactive-mode-scroll-hint
```

Expected: FAIL（`updateScrollHint` 未定义在 prototype 上）。

- [ ] **Step 3: 实现**

`packages/coding-agent/src/modes/interactive/interactive-mode.ts` 三处改动：

**3a. 字段**（`private statusContainer: Container;` 声明附近）：

```ts
 private scrollHint: Text;
 private scrollHintVisible = false;
```

**3b. 构造器**（`this.statusContainer = new Container();` 附近）：

```ts
  this.scrollHint = new Text("", 0, 0);
```

**3c. init() 布局**（`this.ui.addChild(this.chatContainer);` 起始的布局段）：

```ts
  this.ui.addChild(this.chatContainer);
  this.ui.addChild(this.pendingMessagesContainer);
  this.ui.addChild(this.scrollHint);
  this.ui.addChild(this.statusContainer);
```

（在 `this.ui.onCopySelection = async ...` 块后、`this.ui.start();` 前挂接：）

```ts
  this.ui.onScrollOffsetChange = (offset) => this.updateScrollHint(offset);
```

（`this.ui.start();` 后的 `setFixedBottomCount` 5 → 6：）

```ts
  this.ui.setFixedBottomCount(6);
```

**3d. 新方法**（`setWorkingIndicator` 方法后）：

```ts
 private updateScrollHint(offset: number): void {
  const visible = offset > 0;
  if (visible === this.scrollHintVisible) return;
  this.scrollHintVisible = visible;
  this.scrollHint.setText(visible ? theme.fg("muted", "↓ 新消息") : "");
  this.ui.requestRender();
 }
```

确认 `Text` 已从 `../components/text.ts` 导入（interactive-mode.ts 已多处使用 `new Text(...)`）；`theme` 是模块级全局。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run --dir packages/coding-agent/test interactive-mode-scroll-hint
```

Expected: 3 个用例 PASS。

- [ ] **Step 5: 更新 coding-agent CHANGELOG**

`packages/coding-agent/CHANGELOG.md` `[Unreleased]` 下 `### Added` 追加：

```markdown
### Added

- 滚动底部提示：用户不在消息底部（向上滚动过）时，在 working 行上方显示 `↓ 新消息` 提示行，回到底部自动消失（纯显示，无交互）
```

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/interactive-mode.ts packages/coding-agent/test/interactive-mode-scroll-hint.test.ts packages/coding-agent/CHANGELOG.md
git commit -m "feat(interactive): working 上方滚动底部提示行（不在消息底部时显示 ↓ 新消息）"
```

---

### Task 3: 全量验证与文档自查

**Files:**

- 无代码改动（仅验证）
- 自查：`packages/coding-agent/docs/` 下文档是否需更新

- [ ] **Step 1: 跑相关包全量测试**

```bash
cd packages/tui && node --test test/ 2>&1 | tail -5
cd /data/mine/pi && npx vitest run --dir packages/coding-agent/test interactive-mode 2>&1 | tail -10
```

Expected: tui 全绿（含新增 2 用例）；interactive-mode 相关测试全绿（含新增 3 用例）。

- [ ] **Step 2: 全量 check**

```bash
npm run check
```

Expected: 无 errors/warnings（完整输出，不 tail）。

- [ ] **Step 3: 文档自查**

对照改动逐项检查 `packages/coding-agent/docs/` 与 `packages/tui` 的公开文档（tui.md / extensions.md 等）：

- `onScrollOffsetChange` 是既有公开回调字段，本次只是补全触发语义 → 检查 tui.md 是否描述了该回调的触发语义，若有描述则同步更新
- 交互式 UI 布局不在文档逐行描述范围内 → 预期无需更新

若无需更新，在最终回复中明确说明"已自查，docs 无需更新"。

- [ ] **Step 4: 提交收尾**

无新文件改动则跳过 commit（Task 1/2 已提交）；若 Step 3 有文档改动：

```bash
git add <改动文件>
git commit -m "docs: ..."
```
