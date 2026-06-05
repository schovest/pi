# Ctrl+J 和 Alt+Enter 换行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TUI Editor 和 Input 组件中，新增 Ctrl+J 和 Alt+Enter 作为换行快捷键

**Architecture:** 扩展 `tui.input.newLine` 的 keybinding 定义，让快捷键匹配系统自动处理新键。清理 Editor 和 Input 中相关硬编码条件，统一依赖 keybinding 匹配。

**Tech Stack:** TypeScript, Pi TUI keybinding system

---

### Task 1: 扩展 keybinding 定义

**Files:**
- Modify: `packages/tui/src/keybindings.ts:118`

- [ ] **Step 1: 修改 `tui.input.newLine` 的 `defaultKeys`**

将第 118 行从：
```typescript
"tui.input.newLine": { defaultKeys: "shift+enter", description: "Insert newline" },
```
改为：
```typescript
"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j", "alt+enter"], description: "Insert newline" },
```

- [ ] **Step 2: 运行类型检查确认无错误**

Run: `npm run check`
Expected: 无新增 errors/warnings/infos

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/keybindings.ts
git commit -m "feat: add ctrl+j and alt+enter to newLine keybinding"
```

---

### Task 2: 清理 Editor 中 newLine 分支硬编码

**Files:**
- Modify: `packages/tui/src/components/editor.ts:722-738`

- [ ] **Step 1: 移除 `data === "\n"` 硬编码条件**

当前 newLine 分支（第 722-738 行）：
```typescript
// New line
if (
    kb.matches(data, "tui.input.newLine") ||
    (data.charCodeAt(0) === 10 && data.length > 1) ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~" ||
    (data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
    (data === "\n" && data.length === 1)
) {
```

改为：
```typescript
// New line
if (
    kb.matches(data, "tui.input.newLine") ||
    (data.charCodeAt(0) === 10 && data.length > 1) ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~" ||
    (data.length > 1 && data.includes("\x1b") && data.includes("\r"))
) {
```

移除 `(data === "\n" && data.length === 1)`，因为：
- Ctrl+J 发送 `\n`，现在被 `kb.matches(data, "tui.input.newLine")` 通过 `ctrl+j` 路径匹配
- Kitty 模式下 `\n` 被解析为 `shift+enter`，也被 keybinding 匹配覆盖

- [ ] **Step 2: 同时移除 submit 分支中 `data === "\n"` 的隐式处理**

检查 submit 分支（第 740-755 行），确认 `\n` 不会被 submit 分支错误匹配。`kb.matches(data, "tui.input.submit")` 匹配 `enter`（`\r`），不匹配 `\n`，所以安全。

- [ ] **Step 3: 运行类型检查**

Run: `npm run check`
Expected: 无新增 errors/warnings/infos

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/components/editor.ts
git commit -m "refactor: remove hardcoded \\n match from Editor newLine branch"
```

---

### Task 3: Input 组件新增 newLine 支持

**Files:**
- Modify: `packages/tui/src/components/input.ts:100-104`

- [ ] **Step 1: 在 submit 判断之前添加 newLine 分支，移除 `data === "\n"` 硬编码**

当前代码（第 100-104 行）：
```typescript
// Submit
if (kb.matches(data, "tui.input.submit") || data === "\n") {
    if (this.onSubmit) this.onSubmit(this.value);
    return;
}
```

改为：
```typescript
// New line
if (kb.matches(data, "tui.input.newLine")) {
    this.value = this.value.slice(0, this.cursor) + "\n" + this.value.slice(this.cursor);
    this.cursor += 1;
    return;
}

// Submit
if (kb.matches(data, "tui.input.submit")) {
    if (this.onSubmit) this.onSubmit(this.value);
    return;
}
```

关键改动：
1. 新增 `tui.input.newLine` 匹配分支，在光标位置插入 `\n`
2. 移除 submit 分支中的 `data === "\n"` 硬编码（`\n` 现在被 newLine 分支捕获）

- [ ] **Step 2: 运行类型检查**

Run: `npm run check`
Expected: 无新增 errors/warnings/infos

- [ ] **Step 3: Commit**

```bash
git add packages/tui/src/components/input.ts
git commit -m "feat: add newLine support to Input component"
```

---

### Task 4: 更新帮助文本显示

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

- [ ] **Step 1: 确认 hotkey 帮助中 `tui.input.newLine` 显示逻辑**

搜索 `getEditorKeyDisplay` 和 `tui.input.newLine` 相关代码，确认多键绑定的显示格式正确。`getEditorKeyDisplay` 应调用 `KeybindingsManager.getKeys()`，返回 `KeyId[]`。

- [ ] **Step 2: 如果显示逻辑只展示第一个键，修改为展示所有键**

找到帮助文本中 New line 的显示行（类似 `| ${newLine} | New line |`），确认是否需要调整格式以展示所有绑定键。例如改为 `${newLine.join("/")}` 或保持只显示首选键。

- [ ] **Step 3: 运行类型检查**

Run: `npm run check`
Expected: 无新增 errors/warnings/infos

- [ ] **Step 4: Commit（如有改动）**

```bash
git add packages/coding-agent/src/modes/interactive/interactive-mode.ts
git commit -m "fix: update hotkey help display for multi-key newLine binding"
```

---

### Task 5: 验证

- [ ] **Step 1: 运行完整类型检查**

Run: `npm run check`
Expected: 无 errors/warnings/infos

- [ ] **Step 2: 运行 Editor 测试**

Run: `node ../../node_modules/vitest/dist/cli.js --run packages/tui/test/editor.test.ts`
Expected: 所有测试通过

- [ ] **Step 3: 运行 Input 测试**

Run: `node ../../node_modules/vitest/dist/cli.js --run packages/tui/test/input.test.ts`
Expected: 所有测试通过（如有）

- [ ] **Step 4: 运行 keybindings 测试**

Run: `node ../../node_modules/vitest/dist/cli.js --run packages/tui/test/keybindings.test.ts`
Expected: 所有测试通过（如有）