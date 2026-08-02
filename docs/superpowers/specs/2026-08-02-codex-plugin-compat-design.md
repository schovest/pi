# Codex 插件市场兼容设计

日期：2026-08-02
状态：已批准 → 已实施（2026-08-02 修订：hooks 桥接内置化 + 交互式命令）
范围：packages/coding-agent（core 内置，非可选扩展）

## 背景与目标

在 Pi 中兼容 OpenAI Codex CLI 的插件市场：用户可安装 codex 插件（市场 + hooks + skills + MCP），不经修改即在 Pi 中运行。核心是把 codex 插件声明"转译/桥接"为 Pi 原生机制：

- skills → Pi skills 加载
- mcpServers → mcp.json 注册
- hooks → Pi 扩展事件订阅（子进程协议保持不变）
- 旧格式 commands → Pi 斜杠命令（`/codex:<plugin>:<cmd>`）
- 交互式管理 → `/codex-plugin` 斜杠命令（与 `/claude-plugin` 对称）

目标格式（两者都兼容）：

- **新格式**（官方现行）：marketplace.json + `.codex-plugin/plugin.json` + `hooks/hooks.json`
- **旧格式**（大量现存市场仍使用）：marketplace.json + 插件根目录 `plugin.json`（内联 hooks/commands/mcp_servers）

## 架构

三层结构，hooks 桥接为**核心内置代码**（不依赖可选安装，随二进制内置、始终生效）：

1. **`core/codex-plugin-manager.ts`** — marketplace/manifest 解析、安装（git clone / 本地路径 / npm pack）、hooks/commands 物化到 settings、MCP→mcp.json 写入、skills 路径收集、settings 读写
2. **`core/codex-hooks-bridge.ts`** — 内置 hooks 桥接（`CodexHooksBridgeDeps { pluginManager, agentDir }` 依赖注入）：把已启用插件的 hooks 注册为 Pi 扩展事件 handler，执行子进程协议（stdin JSON / stdout JSON / exit 2=block / timeout / env 注入）；以 inline factory 经 `ResourceLoader.extensionFactories` 注入，随每次 reload 重新注册，与既有 inline factory（tps 等）同机制；不再自解析 settings 文件（经注入的 `CodexPluginManager.listConfiguredPlugins()` 实时读取，含 `installedPath`）
3. **CLI + 交互命令** — `package-manager-cli.ts` 新增 `codex-plugin` 子命令族；`interactive-mode.ts` 注册 `/codex-plugin` 打开 `CodexPluginManagerComponent`（与 `PluginManagerComponent` 对称）

### settings 新增

```ts
export interface InstalledCodexPluginSettings {
  name: string;
  source: string; // 安装源（url / 本地路径 / npm spec）
  marketplace?: string;
  enabled?: boolean;
  ref?: string;
  installedPath?: string; // 安装根（git/npm 来源落盘路径；扩展执行 hooks 时优先用它作为 PLUGIN_ROOT）
  hooks?: CodexHooksSpec; // 物化 hooks（已替换 ${PLUGIN_ROOT} 等为绝对路径）
  commands?: CodexPluginCommandSpec[]; // 物化旧格式 commands（供斜杠命令注册）
}

// Settings 新增字段（与 plugins/pluginMarketplaces 隔离）
codexPlugins?: InstalledCodexPluginSettings[];
codexPluginMarketplaces?: Record<string, PluginMarketplaceSettings>;
```

## 格式解析

### marketplace.json（新格式）

```json
{
  "name": "my-market",
  "plugins": [{
    "name": "my-plugin",
    "source": {
      "source": "local" | "git-subdir" | "npm",
      "path": "./plugins/my-plugin",   // local/git-subdir
      "url": "https://github.com/x/y.git", // git-subdir
      "ref": "main",                   // git-subdir
      "package": "@scope/plugin",      // npm
      "version": "^1.2.0",             // npm
      "registry": "https://registry.npmjs.org" // npm（可选）
    }
  }]
}
```

兼容旧格式：`source` 为字符串路径（如 `"./plugins/superpowers"`）。

### 插件 manifest

- 新格式：`<root>/.codex-plugin/plugin.json`，字段：`name/version/description/skills/mcpServers/apps/hooks/interface`。`hooks` 可为路径字符串、路径数组、内联对象或对象数组。默认 hooks 文件 `hooks/hooks.json`（manifest 声明时优先）。
- 旧格式：`<root>/plugin.json`，字段：`name/description/hooks/commands/mcp_servers/suggestions`。hooks 为内联对象（键：`PromptHook`/`UserPromptHook`/`SessionStartHook`/`SessionEndHook`/`NotificationHook`/`AgentConversationHook` 等驼峰；值为 `{command, args, env}`）。`mcp_servers` 同 claude-plugin 的 `mcpServers`。
- 不兼容项（`apps`/.app.json）解析时产生 diagnostic 告警并跳过。

### hooks.json（新格式）

```json
{ "hooks": {
  "SessionStart": [ { "matcher": "startup|resume", "hooks": [ { "type": "command", "command": "python3 ${PLUGIN_ROOT}/hooks/x.py", "timeout": 5, "statusMessage": "..." } ] } ]
} }
```

`type` 仅支持 `"command"`（`prompt`/`agent` 跳过）。matcher 为正则字符串，匹配 tool_name / session source 等。

## hooks 事件映射（11 个事件全覆盖）

| codex hook | Pi 事件 | 语义转译 |
| --- | --- | --- |
| SessionStart | `session_start` + `before_agent_start` | Pi reason（startup/new/resume/fork）映射为 codex source 值后做 matcher 匹配；additionalContext 暂存 `pendingContext`，经 `before_agent_start` 拼入 systemPrompt 注入 |
| SessionEnd | `session_shutdown` | 通知类，忽略输出 |
| UserPromptSubmit | `input` | `decision: block` → `{action:"handled"}`；additionalContext 暂存注入 |
| PreToolUse | `tool_call` | deny → block+reason；`updatedInput` → 就地改写 input；additionalContext → 经 ctx.ui.notify 展示 |
| PermissionRequest | `tool_call`（PreToolUse 之后） | allow/deny → 放行或 block |
| PostToolUse | `tool_result` | `decision: block` → 替换 content 为 reason；continue:false 近似 |
| PreCompact | `session_before_compact` | continue:false → 取消压缩 |
| PostCompact | `session_compact` | 通知类 |
| SubagentStart | `agent_start` | additionalContext 暂存注入 |
| SubagentStop | `agent_end` | 通知类（block/continue 近似） |
| Stop | `turn_end` | `decision: block` → 经 `sendUserMessage` 触发延续；`stopContinued` 防递归（仅 `input` 事件 `source !== "extension"` 时重置） |
| turn_start（旧格式 AgentConversationHook） | `turn_start` | additionalContext 暂存注入 |

**子进程协议**：`sh -c <command>`（新格式命令行）/ `spawn(command, args)`（旧格式数组）；stdin 写 JSON（session_id/cwd/model/turn_id/tool_name/tool_input/tool_response/prompt/source/reason 等）；解析 stdout JSON（Common: continue/stopReason/systemMessage/suppressOutput + hookSpecificOutput: additionalContext/permissionDecision/updatedInput/decision）；exit 2 + stderr = block reason；超时默认 30s（SessionEnd 3s）；env 注入 `PLUGIN_ROOT`/`PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`；matcher 正则匹配。

## 安装与存储

- 存储根：用户级 `~/.pi/agent/codex-plugins/<name>/`，项目级 `.pi/codex-plugins/<name>/`（`-l`）
- 市场：git clone 到 `~/.pi/agent/codex-plugin-marketplaces/<name>/`；本地路径直接读取
- 插件来源：marketplace 条目（local / git-subdir / npm）或直接安装源；npm 用 `npm pack --ignore-scripts` + `tar -xzf`（不跑 lifecycle scripts）；本地路径就地使用，git/npm 复制到存储根
- 安装后：写入 settings `codexPlugins[]`（含 `installedPath`/物化 `hooks`/物化 `commands`）；MCP 经 mcp.json 注册（复用 `convertMcpServer` 模式，替换 `${PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}`）；skills 目录经 `PathMetadata`（`origin: "codex-plugin"`）合并进 resource-loader（metadataByPath + skillPaths）
- hooks 物化：`${PLUGIN_ROOT}`→pluginRoot、`${PLUGIN_DATA}`→`agentDir/codex-plugin-data/<name>`、`${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` 同步替换
- 旧格式 `commands` → 桥接注册斜杠命令 `/codex:<plugin>:<cmd>`（handler 内子进程执行，stdout 经 ctx.ui.notify 展示）
- 默认 `hooks/hooks.json` 回退：manifest 不声明 `hooks` 字段或声明为空时，回退加载插件根 `hooks/hooks.json`

## 信任与安全

- 安装即信任（与 claude-plugin 一致）：`install` 时打印 hooks 摘要（事件 + command）供确认
- 子进程受 timeout 限制（默认 30s，SessionEnd 3s）；stdin/stdout/stderr 挂 error 监听防 EPIPE 崩溃；exit≠0/2 且无有效 JSON 输出视为失败并告警
- `pi codex-plugin hooks list/disable/enable <plugin>` 管理 hooks 开关（不做 hash 信任持久化）

## CLI 汇总

```
pi codex-plugin marketplace add <name> <repo|url>
pi codex-plugin marketplace list
pi codex-plugin marketplace remove <name>
pi codex-plugin search [query] [--marketplace <name>]
pi codex-plugin install <name@marketplace|git-url|local-path> [-l]
pi codex-plugin list
pi codex-plugin remove <plugin> [-l]
pi codex-plugin update [plugin]
pi codex-plugin hooks list
pi codex-plugin hooks disable <plugin> [-l]
pi codex-plugin hooks enable <plugin> [-l]
```

marketplace 仅全局存储（与 claude-plugin 的 `addMarketplace` 一致，不区分用户/项目作用域）。

**交互式命令**：交互模式输入 `/codex-plugin` 打开 `CodexPluginManagerComponent`（搜索市场 → 安装（User/Project 作用域）→ 已安装插件 Update/Remove → 市场 Add/Remove → Update all），行为与 `/claude-plugin` 对称。

## 边界与近似（明示）

- Stop 的"自动继续"为近似实现（Pi 无原生 continue 语义）
- PermissionRequest 不深度联动 Pi 权限模式（dontAsk 等），仅 allow/deny 决策
- 新格式 `apps`（.app.json 注册的 MCP 连接，需 OpenAI 云连接）不兼容，告警跳过
- 不实现 codex 的 cloud/managed hooks、`--dangerously-bypass-hook-trust` 等企业特性

## 测试

单测（vitest，`--dir packages/coding-agent/test`）：

1. 新/旧 marketplace.json 解析、新/旧 manifest 解析、hooks.json 解析（matcher/timeout/内联/数组、apps 告警、默认 hooks/hooks.json 回退）
2. hook 执行器：假脚本回显 JSON / exit 2 + stderr / 超时 / EPIPE 大 payload → 断言 stdin 字段、env 注入（PLUGIN_ROOT 经 installedPath）、block 语义
3. 桥接映射：tool_call deny/updatedInput、input handled、before_agent_start pendingContext 注入清空、stop 防递归（source!=="extension" 不重置）、commands 斜杠命令注册
4. CodexPluginManager：安装（local/git-subdir/npm tarball）、物化、mcp.json 写入/清理、skills 收集（origin:"codex-plugin"）
5. CLI 命令解析（fake SettingsManager）；交互命令 `/codex-plugin`（BUILTIN 注册 + prototype call + 组件 mutation）

完整验证：`npm run check` 全绿 + `npm test`（输出重定向 /tmp/pi-test.txt）无失败。

## 文档

- `docs/architecture.md` 扩展点表新增"codex 插件兼容"行
- `packages/coding-agent/CHANGELOG.md` Unreleased 下新增条目
