# Working 状态动态 Token 指示器 — 设计

日期：2026-08-21
范围：`packages/tui`（LoadGenerator 通用扩展点）+ `packages/coding-agent`（interactive-mode 接线）
状态：已与用户确认设计

## 1. 背景与目标

用户希望 Agent 处于 `Working...`（streaming）状态时，能像 Claude Code 一样看到**动态变化的 token 数**，并获得「它在工作、有产出」的实时反馈。

目标产出：Working 那一行显示「当前提问累计的输出 token 数（估算）+ 本次提问已耗时」，每秒刷新。

## 2. 现状

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` 在 streaming 期间向 `statusContainer` 挂一个 `Loader`（`packages/tui/src/components/loader.ts`），默认 message 为 `"Working..."`，自带 80ms 旋转动画（内部 `setInterval` → `updateDisplay()` → `requestRender()`）。
- `Loader` 目前只支持静态 `message` + 颜色函数 + indicator 帧；没有动态追加能力。
- 流式事件已在 interactive-mode 全套接线：run 开始（创建 working loader 的 case）→ `message_update`（逐 chunk 更新 `streamingMessage`）→ `message_end`（assistant 消息结束，清空 streamingMessage）。
- `pi-agent-core` 提供 `estimateTokens(message)`：对 assistant 消息按 text/thinking/toolCall 块做 `chars/4` 估算 —— 正好覆盖「思考+正文+工具调用参数」。
- 现有 footer（`footer.ts`）已用 `↑input · ↓output · R/W · CH% · $cost · context%` 展示**整场会话累计**真实 usage；私有 `formatTokens` 做 1.2k/12k/1.2M 缩写。

结论：流中无 provider 增量 usage，但可结合 `estimateTokens`（本地估算）实现平滑/每秒动态数字。这与 Claude Code 的客户端本地估算做法一致。

## 3. 需求（已确认）

- **语义**：每次提问累计的输出 token 数（估算值，含思考+正文+工具调用参数）。提问开始归零；同一提问内多次工具调用产生的输出持续累加；空闲后下一次提问重新归零。
- **位置**：Working loader 同一行，message 之后。
- **展示格式**：`⠋ Working... · ↓3.4k · 0:42`
  - `↓{n}`：当前提问累计输出，缩写规则同 footer `formatTokens`（<1000 原数，否则 1.2k/12k/1.2M）。
  - `· {mm:ss}`：本次提问已耗时（<1h 显示 `m:ss`，如 `0:12`、`1:34`；≥1h 显示 `h:mm:ss`，如 `1:02:33`）。
  - 数字为 0（尚未有输出）时只显示时间：`⠋ Working... · 0:00`。
  - 每次 `agent_start` 清零（含错误自动重试场景，用户已确认）。
- **刷新频率**：每秒更新一次（输出数值 + 时间）。不需要逐 chunk 高频刷新。
- 扩展 `setWorkingMessage` / `setWorkingVisible` 行为不变：suffix 追加在 message 之后，loader 隐藏时一并隐藏。

## 4. 方案（用户已选定：方案 A）

### 4.1 tui `Loader` 通用动态后缀

`packages/tui/src/components/loader.ts`：

- 新增可选字段 `suffixProvider?: () => string`。
- 新增方法 `setSuffixProvider(provider?: () => string): void`（传 `undefined` 清除）。
- 在 `updateDisplay()` 末尾追加：`this.setText(text + (this.suffixProvider?.() ?? ""))`。
  理由：`updateDisplay()` 由 80ms 帧刷新、`setMessage()`、`setIndicator()` 共同驱动，是「活跃时反复重绘」的唯一收口点。
- 通用性：任何 Loader 都能挂动态尾部；本功能只消费其中秒级变化。

### 4.2 coding-agent 数据流

`packages/coding-agent/src/modes/interactive/interactive-mode.ts`：

- 新增字段：
  - `runOutputTokens = 0` —— 当前提问累计输出（估算值）。
  - `runStartTime = 0`（`performance.now()`）—— 本次提问起表。
  - `lastSuffixRefresh = 0` —— 1s 节流用。
- **清零/起表**：run 开始处（当前 `stopWorkingLoader()` + `createWorkingLoader()` 的那个 dispatch case）：
  `this.runOutputTokens = 0; this.runStartTime = performance.now();`。
  retry 视为新一轮（与「每次提问累计」一致）。
- **累加**：`message_end`（assistant 消息结束）时 `this.runOutputTokens += estimateTokens(event.message)`。此时消息完整，一次算一整波（含思考+正文+工具参数），开销仅每波一次。
- **实时 suffix**：`createWorkingLoader()` 构造 `Loader` 后调用
  `loader.setSuffixProvider(this.getWorkingSuffix.bind(this))`。

### 4.3 suffix 计算（抽成纯函数便于测试）

新模块 `packages/coding-agent/src/modes/interactive/working-token-stats.ts`：

```ts
export interface WorkingTokenStats {
  runOutputTokens: number;      // 已结束波次累计
  partialMessage?: AgentMessage | null;  // 当前 streamingMessage
}
// 返回 "· ↓3.4k · 0:42"（含前导 " · "），无输出时 "· 0:42"
export function formatWorkingTokenSuffix(
  stats: WorkingTokenStats,
  elapsedMs: number,
): string;
```

- 内部：`total = runOutputTokens + (partial ? estimateTokens(partial) : 0)`；
  `outPart = total > 0 ?`↓${formatTokenCount(total)}` : ""`；
  `timePart = mm:ss / h:mm:ss"`；
  `parts = [outPart, timePart].filter(Boolean)`，返回 `parts.length ? ` · ${parts.join(" · ")}`` : `""`。
- `formatTokenCount`（1.2k/12k/1.2M 缩写）：从 footer 抽出共享。
  迁移：`footer.ts` 私有 `formatTokens` → 抽到共享 util（如下），footer 改为 import，删除本地副本。同名迁移，纯重构，不影响 footer 输出。

```ts
// packages/coding-agent/src/utils/format-token-count.ts
export function formatTokenCount(count: number): string { ... }
```

### 4.4 节流（每秒刷新）

- `getWorkingSuffix()`：

  ```ts
  private getWorkingSuffix(): string {
    const now = performance.now();
    if (now - this.lastSuffixRefresh < 1000) return this.lastSuffixText;
    this.lastSuffixRefresh = now;
    this.lastSuffixText = formatWorkingTokenSuffix(
      { runOutputTokens: this.runOutputTokens, partialMessage: this.session.state.streamingMessage },
      now - this.runStartTime,
    );
    return this.lastSuffixText;
  }
  ```

  - 注意 `runStartTime === 0`（未起表，不应出现）时 elapsed 置 0。
  - `session.state.streamingMessage` 在波次间隙为 `undefined` → 返回已累计值。
- 节流后：Loader 80ms 帧刷新仍在跑（旋转动画），但 suffix 字符串每秒才变一次 → 视觉上数字/时间每秒跳一次，符合要求；`estimateTokens` 每秒至多调用一次。

## 5. 边界与取舍

- **工具执行间隙**：`streamingMessage` 为空 → 显示 `runOutputTokens` 累计值，数字保持不动，时间继续走。符合「跨轮累加」。
- **估算 vs 真实**：流中是 `chars/4` 本地估算；结束空闲后 footer 仍显示 provider 真实 usage（累计统计没变）。两者数值可能略有差异，属预期（Claude Code 同样是本地估算）。
- **runOutputTokens 语义**：仅用于 Working 行展示，不写入 session、不参与任何成本/统计逻辑；footer 不变。
- **最小请求后无输出（如只调工具不返回文本）**：`message_end` 仍会累加工具参数波次，数字体现工具调用消耗。
- **aborted/error**：`message_end` 仍走累加（已发送即计入消费）。
- 不为「本轮」做 per-burst 归零（用户已选每次提问累计）。

## 5.1 后续影响评估（2026-08-21 确认）

- **清零边界（用户已定）**：每次 `agent_start` 都清零。已知代价：临时错误自动重试会重新 `agent_start` → 同一次提问中途计数归零；用户接受（实现简单）。auto-compaction 不走 `agent_start`（独立 `compact()`，只发 `compaction_start/end`，interactive-mode 会 clear statusContainer），不影响计数。
- **`session.state.streamingMessage` 可用性（已证实）**：pi-agent-core 的 `Agent` 在流式事件写入、结束时清空；与 interactive-mode 事件同源，无双算窗口（累加只在 `message_end` 后、此时 streamingMessage 已清空）。
- **Loader 消费方（5+ 处 + CancellableLoader extends Loader）**：`suffixProvider` 为可选、默认 undefined → 零行为变化，其余消费方无感。
- **已知限制：隐藏 spinner 的扩展 indicator**：`setWorkingIndicator({ frames: [] })` 会停掉 80ms 帧刷新 → suffix 冻结在首帧。默认 Working loader 不受影响；不做独立定时器（YAGNI），代码注释说明。
- **formatTokens 迁移**：只动 footer（私有 → 共享 util），`cli/list-models.ts` 的独立缩写函数保持不动。无测试锁定 footer 统计串。
- **Working 行超宽会 wrap**：suffix 最长约 18 字符，仅极窄终端 + 超长自定义 workingMessage 时才折行；接受，不额外 truncate。
- **性能**：1s 节流后 `estimateTokens` 每秒至多 1 次，80ms 帧刷新只返回缓存串，可忽略。
- **惯例**：实现 commit 同步 CHANGELOG；变更后自查 `packages/coding-agent/docs/`（预计无需更新，纯展示性行为）。

## 6. 不做的事（YAGNI）

- 不显示 cost、不显示 context% 实况、不做多行状态面板。
- 不把动态数字接到 session 统计或持久化。
- 不追求逐 chunk 高频刷新。
- 不做用户配置项（需求未要求）。

## 7. 测试计划

### 7.1 纯逻辑（vitest，coding-agent）

- `working-token-stats` 单测（`test/working-token-stats.test.ts`）：
  - 无输出时返回 `" · 0:12"` 之类仅时间；`runOutputTokens=0` 且无 partial → `" · 0:00"`。
  - 有输出 → 含 `↓` 与缩写（342 → `↓342`，1234 → `↓1.2k`）。
  - partial 合并：`runOutputTokens + estimateTokens(partial)` 正确。
  - 时间格式：59s → `0:59`，60s → `1:00`，3600s → `1:00:00`。
- `formatTokenCount` 迁移：footer 现有输出保持不变（覆盖 342/1234/12345/1234567）。

### 7.2 tui（node:test，tui/test）

- `loader.test.ts` 新增：`setSuffixProvider` 后 `render` 输出包含 suffix；未设置时输出不含额外内容；设回 `undefined` 清除。suffix 变化会触发新的渲染文本。

### 7.3 接线（suite，faux provider）

- run 开始清零、`message_end` 后累加、跨波次不归零、空闲后再 run 重新归零。若现有 harness 不便直接断言 UI 字段，则退化为对 `formatWorkingTokenSuffix` 的输入构造测试 + handler 赋值点单测；接线点保持轻量。

## 8. 验证

- `npm run check`（biome + ts-imports + shrinkwrap + tsgo）零 errors/warnings/infos。
- `npm test` 全绿（含新增两个包的测试）。
- 手工：发起一次提问，观察 Working 行出现 `⠋ Working... · 0:00`（随后出现 `↓{n}` 并与时间同行）且每秒变化；工具执行间隙数字冻结、时间继续；空闲后该行消失，footer 累计不变；第二次提问重新归零。
- docs 自查：若实现产生文档/行为说明变更，更新 `packages/coding-agent/docs/` 对应文件；否则记录「已自查，docs 无需更新」。
