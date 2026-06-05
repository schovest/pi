# 新增 Ctrl+J 和 Alt+Enter 换行

## 目标

在 TUI 输入框（Editor 和 Input）中，新增 Ctrl+J 和 Alt+Enter 作为换行快捷键，与现有 Shift+Enter 并列。

## 背景

当前换行仅通过 `tui.input.newLine`（默认 Shift+Enter）触发。部分终端不支持 Shift+Enter，需要更多换行入口。Ctrl+J 在终端中发送 LF（`\n`），天然适合换行；Alt+Enter 也是常见换行快捷键。

## 改动

### 1. 扩展 keybinding 定义

**文件**: `packages/tui/src/keybindings.ts`

将 `tui.input.newLine` 的 `defaultKeys` 从 `"shift+enter"` 改为 `["shift+enter", "ctrl+j", "alt+enter"]`。

`keys.ts` 中 `matchesKey()` 已完整支持 `ctrl+j`（通过 Ctrl+letter 路径匹配 `\x0a`）和 `alt+enter`（通过 enter+alt 路径匹配 `\x1b\r` 及 Kitty/modifyOtherKeys 序列），无需修改。

### 2. 清理 Editor 中 newLine 分支的硬编码条件

**文件**: `packages/tui/src/components/editor.ts`

当前 newLine 分支（~第 722-738 行）有硬编码条件：
- `data.charCodeAt(0) === 10 && data.length > 1`
- `data === "\x1b\r"`
- `data === "\x1b[13;2~"`
- `data.length > 1 && data.includes("\x1b") && data.includes("\r")`
- `data === "\n" && data.length === 1`

这些是为不支持 Kitty 协议的终端捕获 Shift+Enter 和 Alt+Enter 的兼容逻辑。将 `ctrl+j` 和 `alt+enter` 加入 keybinding 后，`kb.matches(data, "tui.input.newLine")` 可以匹配它们。

移除 `data === "\n" && data.length === 1` 条件，因为：
- 在非 Kitty 终端，Ctrl+J 发送 `\n`，`kb.matches(data, "tui.input.newLine")` 通过 `ctrl+j` 匹配路径覆盖
- 在 Kitty 终端，`\n` 被 `parseKey` 解析为 `shift+enter`，也被 `kb.matches` 覆盖

保留其他兼容条件作为 fallback（某些终端可能发送非标准序列）。

### 3. Input 组件新增 newLine 支持

**文件**: `packages/tui/src/components/input.ts`

当前 Input 中 submit 判断（第 101 行）为：
```typescript
if (kb.matches(data, "tui.input.submit") || data === "\n") { ... }
```

问题：`data === "\n"` 会让 Ctrl+J 触发 submit 而非 newLine。

修改：
- 在 submit 判断之前，增加 `kb.matches(data, "tui.input.newLine")` 判断
- 匹配时在光标位置插入 `\n` 字符到 value 中
- 移除 submit 分支中的 `data === "\n"` 硬编码（`kb.matches` 已覆盖）

### 4. 帮助文本更新

**文件**: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

hotkey 帮助中 `tui.input.newLine` 的显示会自动反映新的 keybinding，无需手动修改。但需确认显示逻辑正确处理多键绑定。

## 不改动

- `keys.ts` — `matchesKey` 已支持，无需修改
- `KeybindingsManager` — 已支持 `KeyId[]`，无需修改
- `CustomEditor` / `ExtensionEditorComponent` / `ExtensionInputComponent` — 它们继承/包装底层组件，自动获得新行为

## 风险

- Ctrl+J 在非 Kitty 终端发送 `\n`，与纯 LF 输入重叠。移除 `data === "\n"` 硬编码后，`kb.matches` 统一处理，行为一致。
- Alt+Enter 在 Kitty 模式下发送 CSI-u 序列，在非 Kitty 模式下可能发送 `\x1b\r`。后者在 Kitty 模式中被解析为 `shift+enter`（非 `alt+enter`），这是已有行为，不受本次改动影响。
