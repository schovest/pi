# Working 状态动态 Token 指示器 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 interactive 模式的 `Working...` 状态行尾部动态显示「本提问累计输出 tokens（估算）＋已耗时」，每秒刷新。

**Architecture:** tui `Loader` 增加通用动态后缀 `suffixProvider`（可选、默认无副作用）；coding-agent 新增纯函数模块 `working-token-stats.ts`（累加/格式化，可单测）＋共享 `formatTokenCount`；`interactive-mode.ts` 在 `agent_start` 清零起表、`message_end` 累加、给 Working loader 挂 suffix。

**Tech Stack:** TypeScript（workspace `@schovest/pi-tui` 与 `@earendil-works/pi-agent-core`）、Node 原生 test（tui）+ vitest（coding-agent）。

## Global Constraints

- tui 包测试用 `node:test` + `node:assert/strict`（`import assert from "node:assert"`）；coding-agent 用 vitest（`import { describe, expect, it } from "vitest"`）。禁止混用。限制测试目录用 `--dir`（vitest）或从包目录 `node --test`（tui）。
- 相对导入一律带 `.ts` 后缀（仓库既有约定，`check:ts-imports` 强制）。
- 禁止 `any`；`Loader` 的 `suffixProvider` 为可选参数，不得改变现有消费方行为。
- 不手改生成物；`formatTokenCount` 迁移不改 `cli/list-models.ts` 的私有副本。
- 每个功能/修复 commit 同步更新 `packages/coding-agent/CHANGELOG.md`（`## [Unreleased]` → `### Added`）。
- 变更完成后自查 `packages/coding-agent/docs/` 是否有需要同步的文档；不需要时在提交信息/回复中明确「已自查」。

---

### Task 1: tui `Loader` 支持动态后缀

**Files:**

- Modify: `packages/tui/src/components/loader.ts`
- Test: `packages/tui/test/loader.test.ts`（新增）

**Interfaces:**

- Consumes: 无（独立）。
- Produces: `Loader.setSuffixProvider(provider?: () => string): void`。Task 3 通过 `createWorkingLoader()` 消费。

- [ ] **Step 1: 写失败测试**

新建 `packages/tui/test/loader.test.ts`：

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

/** Loader 构造要求 TUI 且启动 80ms 帧动画；测试用最小 stub，并在 finally 中 stop 释放定时器。 */
function makeLoader(message: string): Loader {
 return new Loader(
  undefined as unknown as TUI,
  (s) => s,
  (s) => s,
  message,
 );
}

describe("Loader suffix provider", () => {
 it("appends the suffix provider output to the rendered line", () => {
  const loader = makeLoader("Working");
  try {
   loader.setSuffixProvider(() => " · ↓1.2k");
   const lines = loader.render(60);
   assert.ok(lines.join("\n").includes("Working · ↓1.2k"), "suffix should follow the message");
  } finally {
   loader.stop();
  }
 });

 it("renders nothing extra when no suffix provider is set", () => {
  const loader = makeLoader("Working");
  try {
   const lines = loader.render(60);
   assert.ok(lines.join("\n").includes("Working"));
   assert.ok(!lines.join("\n").includes("↓"), "no suffix when provider unset");
  } finally {
   loader.stop();
  }
 });

 it("clears the suffix when set to undefined", () => {
  const loader = makeLoader("Working");
  try {
   loader.setSuffixProvider(() => " · ↓1.2k");
   loader.setSuffixProvider(undefined);
   const lines = loader.render(60);
   assert.ok(!lines.join("\n").includes("↓1.2k"), "suffix cleared after setSuffixProvider(undefined)");
  } finally {
   loader.stop();
  }
 });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd packages/tui && node --test test/loader.test.ts
```

Expected: FAIL —— `Package subpath './tui.ts' is not defined` 是因为 `TUI` 类型导入尚不存在？不，`tui.ts` 存在。真正原因：`Loader` 尚无可调用的 `setSuffixProvider` 方法 → 报 `TypeError: loader.setSuffixProvider is not a function`。任何失败即符合预期（TODO）。

- [ ] **Step 3: 实现 `suffixProvider`**

修改 `packages/tui/src/components/loader.ts`：

在字段区（`private message: string = "Loading...";` 附近）新增：

```ts
private suffixProvider: (() => string) | undefined = undefined;
```

在类中新增方法（放在 `setMessage` 附近）：

```ts
setSuffixProvider(provider?: () => string): void {
 this.suffixProvider = provider;
 this.updateDisplay();
}
```

修改 `updateDisplay()`：

```ts
private updateDisplay(): void {
 const frame = this.frames[this.currentFrame] ?? "";
 const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
 const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
 const suffix = this.suffixProvider ? this.suffixProvider() : "";
 this.setText(`${indicator}${this.messageColorFn(this.message)}${suffix}`);
 if (this.ui) {
  this.ui.requestRender();
 }
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd packages/tui && node --test test/loader.test.ts
```

Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/tui/src/components/loader.ts packages/tui/test/loader.test.ts
git commit -m "feat(tui): Loader 支持动态 suffix（suffixProvider 可选后缀）"
```

---

### Task 2: 纯函数模块 `working-token-stats` + `formatTokenCount` 共享化

**Files:**

- Create: `packages/coding-agent/src/utils/format-token-count.ts`
- Create: `packages/coding-agent/src/modes/interactive/working-token-stats.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/footer.ts`（`formatTokens` 改为 import 共享函数）
- Test: `packages/coding-agent/test/working-token-stats.test.ts`（新增）

**Interfaces:**

- Consumes: `estimateTokens`、`AgentMessage` 来自 `@earendil-works/pi-agent-core`（包根已导出，agent-session.ts 已在用）。
- Produces（Task 3 消费）：
  - `formatTokenCount(count: number): string`（footer 与 Working suffix 共用）。
  - `accumulateBurst(runOutputTokens: number, message: AgentMessage): number`
  - `formatWorkingTokenSuffix(stats: { runOutputTokens: number; partialMessage?: AgentMessage | null }, elapsedMs: number): string` —— 返回含前导 `" · "` 的串。

- [ ] **Step 1: 写失败测试**

新建 `packages/coding-agent/test/working-token-stats.test.ts`：

```ts
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
 accumulateBurst,
 formatElapsedTime,
 formatWorkingTokenSuffix,
} from "../src/modes/interactive/working-token-stats.ts";
import { formatTokenCount } from "../src/utils/format-token-count.ts";

const zeroUsage: Usage = {
 input: 0,
 output: 0,
 cacheRead: 0,
 cacheWrite: 0,
 totalTokens: 0,
 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 构造一个 assistant 波次消息；content：单 4-char text 时 estimateTokens 恰为 1。 */
function burst(content: AgentMessage["content"]): AgentMessage {
 return {
  role: "assistant",
  content,
  api: "faux",
  provider: "faux",
  model: "faux",
  usage: zeroUsage,
  stopReason: "stop",
  timestamp: Date.now(),
 } as AgentMessage;
}

const singleTextBurst = burst([{ type: "text", text: "abcd" }]);

describe("formatTokenCount", () => {
 it("mirrors the footer abbreviation behavior", () => {
  expect(formatTokenCount(342)).toBe("342");
  expect(formatTokenCount(1234)).toBe("1.2k");
  expect(formatTokenCount(12345)).toBe("12k");
  expect(formatTokenCount(1234567)).toBe("1.2M");
 });
});

describe("formatElapsedTime", () => {
 it("formats mm:ss under an hour", () => {
  expect(formatElapsedTime(0)).toBe("0:00");
  expect(formatElapsedTime(12000)).toBe("0:12");
  expect(formatElapsedTime(59000)).toBe("0:59");
  expect(formatElapsedTime(60000)).toBe("1:00");
  expect(formatElapsedTime(3599000)).toBe("59:59");
 });
 it("formats h:mm:ss from an hour on", () => {
  expect(formatElapsedTime(3600000)).toBe("1:00:00");
  expect(formatElapsedTime(3723000)).toBe("1:02:03");
 });
});

describe("accumulateBurst", () => {
 it("adds the estimated tokens of a completed assistant burst", () => {
  expect(accumulateBurst(0, singleTextBurst)).toBe(1);
  expect(accumulateBurst(5, singleTextBurst)).toBe(6);
 });
});

describe("formatWorkingTokenSuffix", () => {
 it("shows only the elapsed time when there is no output", () => {
  expect(formatWorkingTokenSuffix({ runOutputTokens: 0, partialMessage: null }, 12000)).toBe(" · 0:12");
 });
 it("includes the accumulated output with the ↓ arrow", () => {
  expect(formatWorkingTokenSuffix({ runOutputTokens: 342, partialMessage: undefined }, 0)).toBe(" · ↓342 · 0:00");
 });
 it("merges the currently-streaming partial message", () => {
  // 已累计 342 + 当前 partial("abcd" → 估算 1) = 343
  expect(formatWorkingTokenSuffix({ runOutputTokens: 342, partialMessage: singleTextBurst }, 0)).toBe(
   " · ↓343 · 0:00",
  );
 });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run --dir packages/coding-agent/test working-token-stats
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现两个模块**

新建 `packages/coding-agent/src/utils/format-token-count.ts`（内容从 footer 的私有 `formatTokens` 原样迁移，仅改名）：

```ts
/**
 * Format a token count for compact display: 342 → "342", 1234 → "1.2k",
 * 12345 → "12k", 1234567 → "1.2M".
 */
export function formatTokenCount(count: number): string {
 if (count < 1000) return count.toString();
 if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
 if (count < 1000000) return `${Math.round(count / 1000)}k`;
 if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
 return `${Math.round(count / 1000000)}M`;
}
```

新建 `packages/coding-agent/src/modes/interactive/working-token-stats.ts`：

```ts
import { estimateTokens } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { formatTokenCount } from "../../utils/format-token-count.ts";

export interface WorkingTokenStats {
 /** 已结束输出波次累计的本提问输出估算值。 */
 runOutputTokens: number;
 /** 当前正在生成的 partial assistant 消息（空闲/波次间隙为 undefined）。 */
 partialMessage?: AgentMessage | null;
}

/** 将一整波 assistant 消息的估算输出累加到 run 累计值。 */
export function accumulateBurst(runOutputTokens: number, message: AgentMessage): number {
 return runOutputTokens + estimateTokens(message);
}

/** 将毫秒格式化为 mm:ss（<1h）或 h:mm:ss（≥1h）。 */
export function formatElapsedTime(ms: number): string {
 const totalSec = Math.max(0, Math.floor(ms / 1000));
 const h = Math.floor(totalSec / 3600);
 const m = Math.floor((totalSec % 3600) / 60);
 const s = totalSec % 60;
 const ss = String(s).padStart(2, "0");
 if (h > 0) {
  return `${h}:${String(m).padStart(2, "0")}:${ss}`;
 }
 return `${m}:${ss}`;
}

/**
 * Working 行尾随 suffix：` · ↓3.4k · 0:42`；无输出时仅时间 ` · 0:42`。
 * 返回串含前导 " · "，由调用方着色。
 */
export function formatWorkingTokenSuffix(stats: WorkingTokenStats, elapsedMs: number): string {
 const partial = stats.partialMessage;
 const total = stats.runOutputTokens + (partial ? estimateTokens(partial) : 0);
 const outPart = total > 0 ? `↓${formatTokenCount(total)}` : "";
 const timePart = formatElapsedTime(elapsedMs);
 return outPart ? ` · ${outPart} · ${timePart}` : ` · ${timePart}`;
}
```

修改 `packages/coding-agent/src/modes/interactive/components/footer.ts`：

- 在 import 区（`import { keyText } from "./keybinding-hints.ts";` 之后）新增：

```ts
import { formatTokenCount } from "../../../utils/format-token-count.ts";
```

- 删除本地私有函数 `formatTokens`（约 line 24-32：从 `/**` 注释到函数结束），并把 5 处调用 `formatTokens(` 改为 `formatTokenCount(`（line 298、299、300、301、328）。

- [ ] **Step 4: 运行测试 + 全量检查**

```bash
npx vitest run --dir packages/coding-agent/test working-token-stats
npm run check
```

Expected: vitest PASS（4 组全绿）；`npm run check`（biome + pinned-deps + ts-imports + shrinkwrap + tsgo + browser-smoke）零 errors/warnings/infos。

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/src/utils/format-token-count.ts \
        packages/coding-agent/src/modes/interactive/working-token-stats.ts \
        packages/coding-agent/src/modes/interactive/components/footer.ts \
        packages/coding-agent/test/working-token-stats.test.ts
git commit -m "feat: Working 动态 suffix 纯函数模块 + formatTokenCount 共享化"
```

---

### Task 3: interactive-mode 接线——清零/起表/累加/挂 suffix

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `packages/coding-agent/CHANGELOG.md`（`### Added` 条目）

**Interfaces:**

- Consumes: Task 1 `Loader.setSuffixProvider`；Task 2 `accumulateBurst` / `formatWorkingTokenSuffix`（同目录 `./working-token-stats.ts`）。
- Produces: 行为——Working 行显示 `⠋ Working... · ↓3.4k · 0:42`，每秒刷新，每次 `agent_start` 归零。

- [ ] **Step 1: 修改（3 处 + 2 个新方法）**

`packages/coding-agent/src/modes/interactive/interactive-mode.ts`：

**(a) import**（第 13 行 `import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";` 之后）：

```ts
import { accumulateBurst, formatWorkingTokenSuffix } from "./working-token-stats.ts";
```

**(b) 字段**（`private loadingAnimation: Loader | undefined = undefined;` 之后）：

```ts
/** 本提问累计输出 tokens（估算），Working 行动态展示用；agent_start 时清零。 */
private runOutputTokens = 0;
/** 本提问起始时间戳（performance.now()），agent_start 时起表。 */
private runStartTime = 0;
/** Working suffix 每秒节流：上次刷新时刻。 */
private lastSuffixRefresh = 0;
/** Working suffix 缓存文本。 */
private lastSuffixText = "";
```

**(c) `createWorkingLoader()`** 修改为：

```ts
private createWorkingLoader(): Loader {
 const loader = new Loader(
  this.ui,
  (spinner) => theme.fg("accent", spinner),
  (text) => theme.fg("muted", text),
  this.getWorkingLoaderMessage(),
  this.workingIndicatorOptions,
 );
 loader.setSuffixProvider(this.getWorkingSuffix.bind(this));
 return loader;
}
```

**(d) 新增 `getWorkingSuffix()`**（放在 `createWorkingLoader()` 之后）：

```ts
/** Working 行动态 suffix：每秒刷新一次，显示本提问累计输出 tokens（估算）与已耗时。 */
private getWorkingSuffix(): string {
 const now = performance.now();
 if (now - this.lastSuffixRefresh < 1000) {
  return this.lastSuffixText;
 }
 this.lastSuffixRefresh = now;
 const elapsedMs = this.runStartTime > 0 ? now - this.runStartTime : 0;
 this.lastSuffixText = theme.fg(
  "muted",
  formatWorkingTokenSuffix(
   {
    runOutputTokens: this.runOutputTokens,
    partialMessage: this.session.state.streamingMessage,
   },
   elapsedMs,
  ),
 );
 return this.lastSuffixText;
}
```

**(e) `agent_start` case**（`this.pendingTools.clear();` 之后插入四行）：

```ts
case "agent_start":
 this.pendingTools.clear();
 this.runOutputTokens = 0;
 this.runStartTime = performance.now();
 this.lastSuffixRefresh = 0;
 this.lastSuffixText = "";
 if (this.settingsManager.getShowTerminalProgress()) {
```

**(f) `message_end` case**（在 `if (event.message.role === "user") break;` 之后插入）：

```ts
case "message_end":
 if (event.message.role === "user") break;
 if (event.message.role === "assistant") {
  this.runOutputTokens = accumulateBurst(this.runOutputTokens, event.message);
 }
 if (this.streamingComponent && event.message.role === "assistant") {
```

- [ ] **Step 2: 类型检查**

```bash
npx tsgo --noEmit
```

Expected: 零错误。

- [ ] **Step 3: 更新 CHANGELOG**

`packages/coding-agent/CHANGELOG.md`，在 `## [Unreleased]` 下新增 `### Added` 段（当前 Unreleased 只有 `### Fixed`，在其上方插入）：

```markdown
### Added

- Working 状态行动态显示本提问累计输出 tokens（估算，`↓` 缩写）与已耗时（`mm:ss`），每秒刷新，每次 `agent_start` 归零
```

- [ ] **Step 4: 全量检查 + 全测试**

```bash
npm run check
npm test > /tmp/pi-test.txt
```

Expected: `npm run check` 零 errors/warnings/infos；`npm test` 全绿（tail /tmp/pi-test.txt 确认）。重点留意 `interactive-mode-*`、`tui` loader 相关测试不回归。

- [ ] **Step 5: docs 自查**

`packages/coding-agent/docs/` 无 working 行细节描述（rpc.md 仅提 contextUsage），此改动为纯展示性 UI 行为 → **已自查，docs 无需更新**。

- [ ] **Step 6: 提交**

```bash
git add packages/coding-agent/src/modes/interactive/interactive-mode.ts packages/coding-agent/CHANGELOG.md
git commit -m "feat: Working 状态行动态显示本提问输出 tokens 与耗时（每秒刷新）"
```

---

## 自审清单（执行前对照）

- [ ] spec §3 需求全落到 Task 1-3（展示位置/格式/1s刷新/每次 agent_start 归零/累计跨波次）。
- [ ] 无占位符：每一步都有实际代码与期望输出。
- [ ] 类型一致性：`setSuffixProvider`（Task 1）、`accumulateBurst`/`formatWorkingTokenSuffix`（Task 2）与 Task 3 消费方签名一致。
