# Codex 插件市场兼容 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Pi 中兼容 OpenAI Codex CLI 插件市场：安装 codex 插件（新格式 `.codex-plugin/plugin.json` 与旧格式根 `plugin.json`），把 skills / mcpServers / hooks / commands 转译为 Pi 原生机制，全部 11 个 hooks 事件含拦截语义。

**Architecture:** 四层：① `core/codex-plugin-manager.ts` 负责 marketplace/manifest 解析、安装、hooks 物化到 settings、MCP 写入 mcp.json、skills 收集；② `core/codex-hooks.ts` 只负责 hooks 配置归一化解析（物化用）；③ `dist-assets/extensions/codex-hooks.ts` 内置扩展（install.sh 复制到 `~/.pi/agent/extensions/`）把物化的 hooks 注册为 Pi 扩展事件 handler，执行子进程协议（stdin JSON / stdout JSON / exit 2=block）；④ `package-manager-cli.ts` 新增 `codex-plugin` 子命令族。钩子事件 → Pi 事件映射见 Task 5。

**Tech Stack:** TypeScript、vitest（`npx vitest run --dir packages/coding-agent/test <pattern>`）、node:child_process（spawn/execFile）、jiti（扩展加载）、Bun 二进制（dist-assets 扩展）。

## Global Constraints

- 禁止 `any`；禁止 inline import（`await import()`）；禁止 erasable syntax（参数属性、enum、namespace、`import =`、`export =`）
- 只改本计划列出的文件；改动后运行 `npm run check`（完整输出）修复 errors/warnings/infos
- 测试命令统一 `npx vitest run --dir packages/coding-agent/test <pattern>`（禁止直接传文件路径）
- 每个功能/修复 commit 同步更新 `packages/coding-agent/CHANGELOG.md`（`## [Unreleased]` 下）
- 完成后自查 `packages/coding-agent/docs/` 与 `docs/architecture.md` 是否需要更新
- 临时脚本放 `/tmp`，用后删除
- 不删除/降级现有功能；不跑 `npm test` 全量套件

---

### Task 1: settings 与共享类型扩展

**Files:**

- Modify: `packages/coding-agent/src/core/settings-manager.ts`（新增类型 + Settings 字段 + 方法，参考现有 `InstalledPluginSettings`/`getPlugins`/`setPlugins` 的写法，约 988-1015 行）
- Modify: `packages/coding-agent/src/core/package-manager.ts:47-52`（`PathMetadata.origin` 联合类型扩展）
- Test: `packages/coding-agent/test/settings-manager-codex.test.ts`（新建）

**Interfaces:**

- Produces（后续任务依赖的精确类型）：

```ts
// settings-manager.ts 顶部新增（放在 InstalledPluginSettings 之后）
export type CodexEventName =
 | "session_start" | "session_end" | "user_prompt_submit" | "pre_tool_use"
 | "permission_request" | "post_tool_use" | "pre_compact" | "post_compact"
 | "subagent_start" | "subagent_stop" | "stop";

export interface CodexHookHandlerSpec {
 type: "command";
 /** 新格式：完整命令行（shell 执行）；旧格式：可执行文件名 */
 command: string;
 /** 旧格式专用：argv 数组 */
 args?: string[];
 timeout?: number;
 statusMessage?: string;
 /** handler 级 matcher（归一化后保留） */
 matcher?: string;
}

export interface CodexHookGroupSpec {
 matcher?: string;
 handlers: CodexHookHandlerSpec[];
}

/** 旧格式 commands 条目（物化后存储于 settings，供扩展注册斜杠命令） */
export interface CodexPluginCommandSpec {
 name: string;
 description?: string;
 command: string;
 args?: string[];
 env?: Record<string, string>;
}

/** key = CodexEventName，value = matcher 分组列表（物化后存储于 settings） */
export type CodexHooksSpec = Partial<Record<CodexEventName, CodexHookGroupSpec[]>>;

export interface InstalledCodexPluginSettings {
 name: string;
 source: string;
 marketplace?: string;
 enabled?: boolean;
 ref?: string;
 /** 安装/更新时物化的 hooks 配置（已替换 ${PLUGIN_ROOT} 等为绝对路径） */
 hooks?: CodexHooksSpec;
 /** 安装/更新时物化的旧格式 commands（供斜杠命令注册） */
 commands?: CodexPluginCommandSpec[];
}

// Settings 接口新增两个字段（与 plugins/pluginMarketplaces 并列）：
codexPlugins?: InstalledCodexPluginSettings[];
codexPluginMarketplaces?: Record<string, PluginMarketplaceSettings>;

// 新增方法（对称 getPlugins/setPlugins/setProjectPlugins，参考 1005-1016 行）：
getCodexPlugins(): InstalledCodexPluginSettings[];             // global
getProjectCodexPlugins(): InstalledCodexPluginSettings[];      // project
setCodexPlugins(list: InstalledCodexPluginSettings[]): void;   // global + markModified("codexPlugins")
setProjectCodexPlugins(list: InstalledCodexPluginSettings[]): void;
getCodexPluginMarketplaces(): Record<string, PluginMarketplaceSettings>;
setCodexPluginMarketplaces(m: Record<string, PluginMarketplaceSettings>): void; // markModified("codexPluginMarketplaces")
```

- `PathMetadata.origin` 由 `"package" | "top-level"` 扩展为 `"package" | "top-level" | "codex-plugin"`（package-manager.ts:50）

- [ ] **Step 1: 写失败测试**

`packages/coding-agent/test/settings-manager-codex.test.ts`：

```ts
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("codex plugin settings", () => {
 let tempDir: string;
 let sm: SettingsManager;

 beforeEach(() => {
  tempDir = join(tmpdir(), `settings-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "agent"), { recursive: true });
  mkdirSync(join(tempDir, "project"), { recursive: true });
  sm = SettingsManager.create(join(tempDir, "project"), join(tempDir, "agent"));
 });

 afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
 });

 it("round-trips codexPlugins across flush/reload", async () => {
  sm.setCodexPlugins([{ name: "my-plugin", source: "https://github.com/x/y", enabled: true }]);
  await sm.flush();
  const reloaded = SettingsManager.create(join(tempDir, "project"), join(tempDir, "agent"));
  expect(reloaded.getCodexPlugins()).toEqual([
   { name: "my-plugin", source: "https://github.com/x/y", enabled: true },
  ]);
 });

 it("keeps codex marketplaces separate from claude marketplaces", async () => {
  sm.setCodexPluginMarketplaces({ codex-mkt: { source: "/tmp/mkt" } });
  sm.setPluginMarketplaces({ claude-mkt: { source: "/tmp/claude" } });
  expect(sm.getCodexPluginMarketplaces()).toEqual({ "codex-mkt": { source: "/tmp/mkt" } });
  expect(sm.getPluginMarketplaces()).toEqual({ "claude-mkt": { source: "/tmp/claude" } });
 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --dir packages/coding-agent/test settings-manager-codex`
Expected: FAIL（`setCodexPlugins` is not a function）

- [ ] **Step 3: 实现**

在 `settings-manager.ts` 的 `InstalledPluginSettings` 之后加入上面 Interfaces 中的类型；`Settings` 接口加入 `codexPlugins`/`codexPluginMarketplaces` 字段；在 `getPluginMarketplaces`/`setPlugins` 方法附近加入 6 个新方法，实现照抄 `getPlugins`/`setPlugins`/`setProjectPlugins`/`getPluginMarketplaces`/`setPluginMarketplaces`（988-1001 行）的模式：读 `this.settings.globalSettings.codexPlugins ?? []`，写 `this.globalSettings.codexPlugins = list` 后 `this.markModified("codexPlugins")`。`getCodexPlugins` 读 global，`getProjectCodexPlugins` 读 projectSettings。

修改 `package-manager.ts:50`：`origin: "package" | "top-level" | "codex-plugin";`

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --dir packages/coding-agent/test settings-manager-codex`
Expected: PASS（2 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/settings-manager.ts packages/coding-agent/src/core/package-manager.ts packages/coding-agent/test/settings-manager-codex.test.ts
git commit -m "feat(codex-plugin): settings 支持 codex 插件与市场配置"
```

---

### Task 2: codex-plugin-manager.ts 解析层（marketplace / manifest / hooks 归一化）

**Files:**

- Create: `packages/coding-agent/src/core/codex-plugin-manager.ts`（本任务只写顶部解析函数与类型，约 260 行；CodexPluginManager 类留到 Task 3）
- Test: `packages/coding-agent/test/codex-plugin-manager.test.ts`（新建，本任务只测解析函数）

**Interfaces:**

- Consumes: Task 1 的 `CodexHooksSpec`/`CodexHookGroupSpec`/`CodexHookHandlerSpec`/`CodexEventName`、`InstalledCodexPluginSettings`、`PluginDiagnostic`（来自 `./claude-plugin-manager.ts`，已导出）
- Produces：

```ts
export type CodexPluginSource =
 | { kind: "local"; path: string }
 | { kind: "git"; url: string; path?: string; ref?: string }
 | { kind: "npm"; package: string; version?: string; registry?: string };

export interface CodexMarketplaceEntry {
 name: string;
 source: CodexPluginSource;
}
export interface CodexMarketplaceCatalog {
 name?: string;
 plugins: CodexMarketplaceEntry[];
}

export interface CodexMcpServer {
 command?: string;
 args?: string[];
 env?: Record<string, string>;
 [key: string]: unknown;
}
export interface CodexPluginCommand {
 name: string;
 description?: string;
 command: string;
 args?: string[];
 env?: Record<string, string>;
}
export interface CodexPluginManifest {
 name: string;
 skills: string[];
 commands: CodexPluginCommand[];
 mcpServers: Record<string, CodexMcpServer>;
 hooks: CodexHooksSpec;
 diagnostics: PluginDiagnostic[];
 root: string;
}

export function readCodexMarketplaceCatalog(root: string): CodexMarketplaceCatalog;
export function readCodexPluginManifest(root: string): CodexPluginManifest;
export function normalizeCodexHooks(raw: unknown): CodexHooksSpec;
/** 旧格式 hook 键（驼峰）→ 标准事件名；未知键返回 undefined */
export function normalizeCodexHookEventName(key: string): CodexEventName | undefined;
export function parseCodexInstallSpec(input: string): { type: "marketplace"; name: string; marketplace: string } | { type: "source"; source: string };
```

**解析规则（实现必须遵守）：**

- `readCodexMarketplaceCatalog(root)`：读 `<root>/marketplace.json`。`plugins[]` 每项：`source` 为对象时按 `{source, path, url, ref, package, version, registry}` 归一化（`source==="git-subdir"` → `{kind:"git", url, path, ref}`；`"npm"` → `{kind:"npm", package, version, registry}`；其余/`"local"` → `{kind:"local", path}`）；`source` 为字符串时 → `{kind:"local", path: str}`。跳过无 `name` 的项。
- `readCodexPluginManifest(root)`：先查 `<root>/.codex-plugin/plugin.json`（新格式），不存在则查 `<root>/plugin.json`（旧格式），都没有 → 抛 `Error`。`name` 取 manifest.name（缺失时 `basename(root)`），归一化用 `normalizePluginName` 同款逻辑（从 `./claude-plugin-manager.ts` 复制一个私有版本，不导出）。
  - 新格式：`skills`（字符串或字符串数组 → 统一字符串数组）、`mcpServers`（路径字符串指向 `.mcp.json`/`mcp_servers` 对象，或内联对象）、`hooks`（可能是路径字符串/数组/内联对象/对象数组：路径则解析对应 JSON 文件；内联则直接用）、`commands`（旧格式才有）。`apps` 字段存在 → diagnostics 加 `{field:"apps", message:"codex plugin field \"apps\" (.app.json registered MCP connections) is not supported by Pi"}`。
  - 旧格式：`mcp_servers` → `mcpServers`；`commands`（数组，每项 `{name, description, command, args?, env?}`）；`hooks` 为内联对象（键为 `PromptHook`/`UserPromptHook`/`SessionStartHook`/`SessionEndHook`/`NotificationHook`/`AgentConversationHook` 等驼峰，值为 `{command, args?, env?}`）。
- `normalizeCodexHooks(raw)`：输入为已解析的 hooks 原始对象（新格式 `{hooks: {Event: [ {matcher?, hooks:[...]} ]}}` 或旧格式 `{EventHook: {command,args}}`）。输出 `CodexHooksSpec`。归一化规则：
  - 新格式事件名（`SessionStart` 等 PascalCase）→ 标准名（`SessionStart`→`session_start`，`PreToolUse`→`pre_tool_use`，`PermissionRequest`→`permission_request`，`PostToolUse`→`post_tool_use`，`PreCompact`→`pre_compact`，`PostCompact`→`post_compact`，`UserPromptSubmit`→`user_prompt_submit`，`SubagentStart`→`subagent_start`，`SubagentStop`→`subagent_stop`，`Stop`→`stop`，`SessionEnd`→`session_end`）；只保留 `type==="command"` 的 handler，`prompt`/`agent` 跳过。
  - 旧格式键经 `normalizeCodexHookEventName` 映射：`SessionStartHook`→`session_start`、`SessionEndHook`→`session_end`、`UserPromptHook`→`user_prompt_submit`、`PromptHook`→`user_prompt_submit`、`NotificationHook`→`post_tool_use`、`AgentConversationHook`→`turn_start`（**Task 2 Step 3 时把 `turn_start` 追加到 Task 1 的 `CodexEventName` 联合类型**）；值为 `{command, args?}` → handler `{type:"command", command, args, matcher: undefined}`。
  - handler 的 `command` 中 `${PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}` 在本层**不替换**（Task 3 物化时替换）。
  - 组级 matcher 与 handler 级 matcher 都保留；若组无 matcher 且 handler 无 matcher → 匹配所有。

- [ ] **Step 1: 写失败测试**

`packages/coding-agent/test/codex-plugin-manager.test.ts`（本任务先测解析；Task 3 再追加类测试）：

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
 normalizeCodexHookEventName,
 normalizeCodexHooks,
 readCodexMarketplaceCatalog,
 readCodexPluginManifest,
} from "../src/core/codex-plugin-manager.ts";

describe("codex marketplace catalog", () => {
 let tempDir: string;
 beforeEach(() => {
  tempDir = join(tmpdir(), `codex-mkt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
 });
 afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

 it("parses new-format sources (local/git-subdir/npm)", () => {
  writeFileSync(
   join(tempDir, "marketplace.json"),
   JSON.stringify({
    name: "mkt",
    plugins: [
     { name: "a", source: { source: "local", path: "./plugins/a" } },
     { name: "b", source: { source: "git-subdir", url: "https://github.com/x/y.git", path: "./plugins/b", ref: "main" } },
     { name: "c", source: { source: "npm", package: "@scope/p", version: "^1.0.0" } },
    ],
   }),
  );
  const catalog = readCodexMarketplaceCatalog(tempDir);
  expect(catalog.name).toBe("mkt");
  expect(catalog.plugins).toHaveLength(3);
  expect(catalog.plugins[0]).toEqual({ name: "a", source: { kind: "local", path: "./plugins/a" } });
  expect(catalog.plugins[1]).toEqual({
   name: "b",
   source: { kind: "git", url: "https://github.com/x/y.git", path: "./plugins/b", ref: "main" },
  });
  expect(catalog.plugins[2]).toEqual({
   name: "c",
   source: { kind: "npm", package: "@scope/p", version: "^1.0.0" },
  });
 });

 it("parses legacy string-path sources", () => {
  writeFileSync(
   join(tempDir, "marketplace.json"),
   JSON.stringify({ plugins: [{ name: "sp", source: "./plugins/sp" }] }),
  );
  const catalog = readCodexMarketplaceCatalog(tempDir);
  expect(catalog.plugins).toEqual([{ name: "sp", source: { kind: "local", path: "./plugins/sp" } }]);
 });
});

describe("codex plugin manifest", () => {
 let tempDir: string;
 beforeEach(() => {
  tempDir = join(tmpdir(), `codex-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
 });
 afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

 it("reads new-format .codex-plugin/plugin.json with hooks file path", () => {
  mkdirSync(join(tempDir, ".codex-plugin"), { recursive: true });
  mkdirSync(join(tempDir, "hooks"), { recursive: true });
  mkdirSync(join(tempDir, "skills", "hello"), { recursive: true });
  writeFileSync(
   join(tempDir, ".codex-plugin", "plugin.json"),
   JSON.stringify({
    name: "my-plugin",
    version: "1.0.0",
    skills: "./skills/",
    hooks: "./hooks/hooks.json",
    mcpServers: "./.mcp.json",
   }),
  );
  writeFileSync(
   join(tempDir, "hooks", "hooks.json"),
   JSON.stringify({
    hooks: {
     SessionStart: [
      { matcher: "startup", hooks: [{ type: "command", command: "python3 ${PLUGIN_ROOT}/hooks/s.py", timeout: 5 }] },
     ],
    },
   }),
  );
  writeFileSync(join(tempDir, ".mcp.json"), JSON.stringify({ docs: { command: "docs-mcp", args: ["--stdio"] } }));
  const manifest = readCodexPluginManifest(tempDir);
  expect(manifest.name).toBe("my-plugin");
  expect(manifest.skills).toEqual([join(tempDir, "skills")]);
  expect(manifest.mcpServers.docs).toEqual({ command: "docs-mcp", args: ["--stdio"] });
  expect(manifest.hooks.session_start).toEqual([
   {
    matcher: "startup",
    handlers: [{ type: "command", command: "python3 ${PLUGIN_ROOT}/hooks/s.py", timeout: 5 }],
   },
  ]);
  expect(manifest.diagnostics).toEqual([]);
 });

 it("reads legacy root plugin.json with inline camelCase hooks and mcp_servers", () => {
  writeFileSync(
   join(tempDir, "plugin.json"),
   JSON.stringify({
    name: "legacy",
    hooks: {
     SessionStartHook: { command: "python3", args: ["hooks/start.py"] },
     PromptHook: { command: "python3", args: ["hooks/prompt.py"] },
    },
    mcp_servers: { fs: { command: "npx", args: ["-y", "@modelcontext/server-fs"] } },
    commands: [{ name: "review", description: "Review", command: "python3", args: ["cmd/review.py"] }],
   }),
  );
  const manifest = readCodexPluginManifest(tempDir);
  expect(manifest.hooks.session_start).toEqual([
   { handlers: [{ type: "command", command: "python3", args: ["hooks/start.py"] }] },
  ]);
  expect(manifest.hooks.user_prompt_submit).toBeDefined();
  expect(manifest.mcpServers.fs.command).toBe("npx");
  expect(manifest.commands[0]).toEqual({ name: "review", description: "Review", command: "python3", args: ["cmd/review.py"] });
 });

 it("reports apps field as unsupported diagnostic", () => {
  mkdirSync(join(tempDir, ".codex-plugin"), { recursive: true });
  writeFileSync(
   join(tempDir, ".codex-plugin", "plugin.json"),
   JSON.stringify({ name: "p", apps: "./.app.json" }),
  );
  const manifest = readCodexPluginManifest(tempDir);
  expect(manifest.diagnostics.some((d) => d.field === "apps")).toBe(true);
 });
});

describe("hook name normalization", () => {
 it("maps pascal and legacy names to standard event names", () => {
  expect(normalizeCodexHookEventName("SessionStart")).toBe("session_start");
  expect(normalizeCodexHookEventName("PreToolUse")).toBe("pre_tool_use");
  expect(normalizeCodexHookEventName("SessionStartHook")).toBe("session_start");
  expect(normalizeCodexHookEventName("PromptHook")).toBe("user_prompt_submit");
  expect(normalizeCodexHookEventName("UnknownHook")).toBeUndefined();
 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --dir packages/coding-agent/test codex-plugin-manager`
Expected: FAIL（模块不存在 / 函数 undefined）

- [ ] **Step 3: 实现 `codex-plugin-manager.ts` 解析层**

创建文件，顶部 imports（`node:fs` 的 existsSync/readFileSync、`node:path` 的 basename/join/resolve、`./claude-plugin-manager.ts` 的 `type PluginDiagnostic`）。私有复制 `isRecord`/`getStringArray`/`getStringRecord`/`normalizePluginName`/`readJsonObject`（从 `claude-plugin-manager.ts` 同款实现）。然后按 Interfaces 定义类型与函数，核心实现：

```ts
const EVENT_NAME_MAP: Record<string, CodexEventName> = {
 SessionStart: "session_start", SessionEnd: "session_end",
 UserPromptSubmit: "user_prompt_submit", PreToolUse: "pre_tool_use",
 PermissionRequest: "permission_request", PostToolUse: "post_tool_use",
 PreCompact: "pre_compact", PostCompact: "post_compact",
 SubagentStart: "subagent_start", SubagentStop: "subagent_stop", Stop: "stop",
 SessionStartHook: "session_start", SessionEndHook: "session_end",
 UserPromptHook: "user_prompt_submit", PromptHook: "user_prompt_submit",
 NotificationHook: "post_tool_use", AgentConversationHook: "turn_start",
};

export function normalizeCodexHookEventName(key: string): CodexEventName | undefined {
 return EVENT_NAME_MAP[key];
}
```

`normalizeCodexHooks(raw)`：`raw` 为对象；取 `isRecord(raw.hooks) ? raw.hooks : raw`（兼容 `{hooks:{...}}` 与直接内联）；遍历 key/value：

- `normalizeCodexHookEventName(key)` 为 undefined → 跳过；
- value 为数组（新格式分组）：每组 `isRecord(g)`，`matcher = typeof g.matcher === "string" ? g.matcher : undefined`，从 `g.hooks`（数组）过滤 `isRecord(h) && h.type === "command"` 得到 handler：`{type:"command", command: String(h.command), ...(Array.isArray(h.args) ? {args: h.args.filter(x=>typeof x==="string")} : {}), ...(typeof h.timeout === "number" ? {timeout: h.timeout} : {}), ...(typeof h.statusMessage === "string" ? {statusMessage: h.statusMessage} : {}), ...(typeof h.matcher === "string" ? {matcher: h.matcher} : {})}`；分组非空则 push 进 `spec[event]`；
- value 为对象（旧格式单 handler）：`isRecord(v) && typeof v.command === "string"` → push `{handlers: [{type:"command", command: v.command, ...(Array.isArray(v.args) ? {args: 字符串数组} : {})}]}`；
- 返回只含非空事件的 `Partial<Record<CodexEventName, CodexHookGroupSpec[]>>`。

`readCodexPluginManifest(root)` 实现要点：

```ts
export function readCodexPluginManifest(root: string): CodexPluginManifest {
 const newManifestPath = join(root, ".codex-plugin", "plugin.json");
 const legacyManifestPath = join(root, "plugin.json");
 const newFormat = existsSync(newManifestPath);
 const manifestPath = newFormat ? newManifestPath : legacyManifestPath;
 if (!existsSync(manifestPath)) {
  throw new Error(`No codex plugin manifest found in ${root}`);
 }
 const raw = readJsonObject(manifestPath);
 const diagnostics: PluginDiagnostic[] = [];
 const name = normalizePluginName(typeof raw.name === "string" ? raw.name : basename(root));

 const mcpServers: Record<string, CodexMcpServer> = {};
 if (newFormat) {
  const mcpRef = raw.mcpServers;
  if (typeof mcpRef === "string") {
   const mcpPath = join(root, mcpRef.replace(/^\.\//, ""));
   if (existsSync(mcpPath)) {
    const mcpRaw = readJsonObject(mcpPath);
    const servers = isRecord(mcpRaw.mcp_servers) ? mcpRaw.mcp_servers : mcpRaw;
    for (const [serverName, value] of Object.entries(servers)) {
     if (isRecord(value)) mcpServers[serverName] = value as CodexMcpServer;
    }
   }
  } else if (isRecord(mcpRef)) {
   for (const [serverName, value] of Object.entries(mcpRef)) {
    if (isRecord(value)) mcpServers[serverName] = value as CodexMcpServer;
   }
  }
 } else if (isRecord(raw.mcp_servers)) {
  for (const [serverName, value] of Object.entries(raw.mcp_servers)) {
   if (isRecord(value)) mcpServers[serverName] = value as CodexMcpServer;
  }
 }

 const skills: string[] = [];
 if (newFormat) {
  const skillRef = raw.skills;
  const refs = typeof skillRef === "string"
   ? [skillRef]
   : Array.isArray(skillRef) ? skillRef.filter((s): s is string => typeof s === "string") : [];
  for (const ref of refs) {
   const dir = join(root, ref.replace(/^\.\//, ""));
   if (existsSync(dir)) skills.push(dir);
  }
 }

 const commands: CodexPluginCommand[] = [];
 if (!newFormat && Array.isArray(raw.commands)) {
  for (const c of raw.commands) {
   if (!isRecord(c) || typeof c.name !== "string" || typeof c.command !== "string") continue;
   commands.push({
    name: c.name,
    ...(typeof c.description === "string" ? { description: c.description } : {}),
    command: c.command,
    ...(Array.isArray(c.args) ? { args: c.args.filter((a): a is string => typeof a === "string") } : {}),
    ...(isRecord(c.env) ? { env: getStringRecord(c.env) } : {}),
   });
  }
 }

 let hooksRaw: unknown;
 if (newFormat) {
  if (typeof raw.hooks === "string" || (Array.isArray(raw.hooks) && raw.hooks.every((h) => typeof h === "string"))) {
   const paths = (Array.isArray(raw.hooks) ? raw.hooks : [raw.hooks]) as string[];
   const merged: CodexHooksSpec = {};
   for (const p of paths) {
    const hookPath = join(root, p.replace(/^\.\//, ""));
    if (existsSync(hookPath)) {
     const parsed = normalizeCodexHooks(readJsonObject(hookPath));
     for (const [event, groups] of Object.entries(parsed)) {
      (merged[event as CodexEventName] ??= []).push(...(groups ?? []));
     }
    }
   }
   hooksRaw = Object.keys(merged).length > 0 ? { hooks: merged } : undefined;
  } else {
   hooksRaw = raw.hooks;
  }
  if (hooksRaw === undefined && existsSync(join(root, "hooks", "hooks.json"))) {
   hooksRaw = readJsonObject(join(root, "hooks", "hooks.json"));
  }
 } else {
  hooksRaw = raw.hooks;
 }
 const hooks = hooksRaw === undefined ? {} : normalizeCodexHooks(hooksRaw);

 if (newFormat && "apps" in raw) {
  diagnostics.push({ field: "apps", message: 'codex plugin field "apps" (.app.json registered MCP connections) is not supported by Pi', path: manifestPath });
 }

 return { name, skills, commands, mcpServers, hooks, diagnostics, root };
}

export function parseCodexInstallSpec(input: string): { type: "marketplace"; name: string; marketplace: string } | { type: "source"; source: string } {
 const trimmed = input.trim();
 const match = trimmed.match(/^([^@\s/]+)@([^@\s/]+)$/);
 if (match) return { type: "marketplace", name: match[1] ?? "", marketplace: match[2] ?? "" };
 return { type: "source", source: trimmed };
}
```

同时把 `turn_start` 追加到 `settings-manager.ts` 的 `CodexEventName` 联合类型。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --dir packages/coding-agent/test codex-plugin-manager`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/codex-plugin-manager.ts packages/coding-agent/src/core/settings-manager.ts packages/coding-agent/test/codex-plugin-manager.test.ts
git commit -m "feat(codex-plugin): marketplace/manifest/hooks 解析层"
```

---

### Task 3: CodexPluginManager 类（安装 / 物化 / MCP / skills）

**Files:**

- Modify: `packages/coding-agent/src/core/codex-plugin-manager.ts`（在解析函数后追加 `CodexPluginManager` 类，参考 `claude-plugin-manager.ts` 300-660 行）
- Test: `packages/coding-agent/test/codex-plugin-manager.test.ts`（追加 describe）

**Interfaces:**

- Consumes: Task 1 类型、Task 2 解析函数、`resolvePath`（`../utils/paths.ts`）、`parseGitUrl`/`GitSource`（`../utils/git.ts`）、`SettingsManager`/`SettingsScope`、`CONFIG_DIR_NAME`（`../config.ts`）、`PathMetadata`（`./package-manager.ts`）、`PluginDiagnostic`
- Produces：

```ts
export interface ConfiguredCodexPlugin extends InstalledCodexPluginSettings {
 enabled: boolean;
 scope: Exclude<SettingsScope, "global"> | "user";
 installedPath?: string;
}
export interface CodexPluginSearchResult {
 name: string;
 marketplace: string;
 source: string;
 installed: boolean;
}
export interface CodexPluginResources {
 skills: Array<{ path: string; metadata: PathMetadata }>;
 diagnostics: PluginDiagnostic[];
}
export class CodexPluginManager {
 constructor(options: { cwd: string; agentDir: string; settingsManager: SettingsManager });
 addMarketplace(name: string, source: string): void;
 removeMarketplace(name: string): boolean;
 listMarketplaces(): Array<{ name: string; source: string }>;
 searchMarketplaces(query?: string, options?: { marketplace?: string }): Promise<CodexPluginSearchResult[]>;
 install(spec: string, options?: { local?: boolean }): Promise<ConfiguredCodexPlugin>;
 listConfiguredPlugins(): ConfiguredCodexPlugin[];
 remove(name: string, options?: { local?: boolean }): boolean;
 update(name?: string): Promise<void>;
 resolveEnabledPluginResources(): CodexPluginResources;
}
```

**安装流程（`install`）**：`parseCodexInstallSpec(spec)` → marketplace 则从 `getCodexPluginMarketplaces()` 找市场 → `prepareMarketplaceRoot`（本地路径 `resolvePath(source, cwd)` 存在则用；否则 `parseGitUrl` clone 到 `agentDir/codex-plugin-marketplaces/<name>/`，`git clone` + 可选 `git checkout ref`，参照 claude-plugin-manager 的 `cloneOrUpdate`）→ `readCodexMarketplaceCatalog` 找插件条目 → 得 `CodexPluginSource`。非 marketplace 裸源（git url / 本地路径）构造 `{kind:"git"|"local"}`。然后 `preparePluginRoot(source)`：

- `kind:"local"`：`resolvePath(source.path, cwd, {trim:true})` 存在则用；否则相对 marketplace root resolve。
- `kind:"git"`：clone `url`（`ref` 则 checkout）到临时目录；`path` 为仓库内子目录则取该子目录。
- `kind:"npm"`：`npm pack <package>[@<version>]`（`execFileAsync("npm", ["pack", ...], {cwd: tmpDir})`，不跑 lifecycle）→ 解压 `.tgz`（`tar -xzf`）到临时目录。
- 目标目录 `{local ? cwd/.pi/codex-plugins : agentDir/codex-plugins}/<name>/`（name 取 manifest.name），git 直接 clone 到目标；本地/npm 用 `cp -R`（`execFileAsync("cp", ["-R", src, dest])`，dest 已存在先 `rmSync`）。
- `readCodexPluginManifest(pluginRoot)` → 物化 hooks：把 manifest.hooks 每个 handler 的 command 做替换：`${PLUGIN_ROOT}`→pluginRoot、`${PLUGIN_DATA}`→`agentDir/codex-plugin-data/<name>`、`${CLAUDE_PLUGIN_ROOT}`→pluginRoot、`${CLAUDE_PLUGIN_DATA}`→`agentDir/codex-plugin-data/<name>`（字符串 replace 全部出现），结果存 `hooks` 字段；物化 commands：manifest.commands 逐项映射为 `CodexPluginCommandSpec`（command 中同样替换 `${PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}`），存 `commands` 字段。
- `writeMcpServers(manifest, scope)`：`scope==="project"` 写 `cwd/.pi/mcp.json`，否则 `agentDir/mcp.json`；读 `mcpServers` 对象，每个 server 以 `${manifest.name}-${serverName}` 前缀写入（command/args/env 中 `${PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}` 替换为 pluginRoot）。
- `upsertCodexPluginSettings`：从 `getCodexPlugins()`（或 project 版）过滤同名同源后 push `{name, source, marketplace?, ref?, enabled: true, hooks, commands}`，set 回 + 由调用方 flush。
- 返回 `{...entry, enabled: true, scope, installedPath: pluginRoot}`。

**其他方法**：`remove` 按 name/source 过滤、删 mcp servers（前缀 `${name}-`）、`rmSync` 目标目录；`update` 遍历重新 prepare + 重新物化 + 重写 mcp；`resolveEnabledPluginResources` 遍历 `listConfiguredPlugins()`，enabled 且 installedPath 存在 → `readCodexPluginManifest`，skills（manifest.skills 或默认 `<root>/skills`）收集为 `{path, metadata: {source: plugin.source, scope: plugin.scope, origin: "codex-plugin", baseDir: installedPath}}`，diagnostics 汇总。

- [ ] **Step 1: 写失败测试（追加到 codex-plugin-manager.test.ts）**

```ts
function writeCodexPlugin(root: string, name: string, options?: { hooks?: boolean; mcp?: boolean }): void {
 mkdirSync(join(root, ".codex-plugin"), { recursive: true });
 mkdirSync(join(root, "skills", "helper"), { recursive: true });
 writeFileSync(
  join(root, ".codex-plugin", "plugin.json"),
  JSON.stringify({ name, skills: "./skills/" }),
 );
 writeFileSync(join(root, "skills", "helper", "SKILL.md"), `---\nname: helper\ndescription: Helper skill\n---\nBody`);
 if (options?.hooks) {
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(
   join(root, ".codex-plugin", "plugin.json"),
   JSON.stringify({ name, skills: "./skills/", hooks: "./hooks/hooks.json" }),
  );
  writeFileSync(
   join(root, "hooks", "hooks.json"),
   JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo '${PLUGIN_ROOT}'" }] }] } }),
  );
 }
 if (options?.mcp) {
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ docs: { command: "docs-mcp" } }));
 }
}

describe("CodexPluginManager", () => {
 let tempDir: string;
 let agentDir: string;
 let cwd: string;
 let sm: SettingsManager;
 let manager: CodexPluginManager;

 beforeEach(() => {
  tempDir = join(tmpdir(), `codex-pm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  agentDir = join(tempDir, "agent");
  cwd = join(tempDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  sm = SettingsManager.create(cwd, agentDir);
  manager = new CodexPluginManager({ cwd, agentDir, settingsManager: sm });
 });
 afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

 it("installs a local plugin, materializes hooks with PLUGIN_ROOT replaced, and writes mcp.json", async () => {
  const pluginRoot = join(tempDir, "plugin-src");
  writeCodexPlugin(pluginRoot, "demo", { hooks: true, mcp: true });
  const installed = await manager.install(pluginRoot);
  expect(installed.name).toBe("demo");
  const stored = sm.getCodexPlugins()[0];
  expect(stored).toBeDefined();
  expect(stored?.hooks?.pre_tool_use?.[0]?.handlers[0]?.command).toBe(`echo '${installed.installedPath}'`);
  const mcpRaw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8"));
  expect(mcpRaw.mcpServers["demo-docs"]).toEqual({ command: "docs-mcp" });
  expect(existsSync(join(installed.installedPath!, ".codex-plugin", "plugin.json"))).toBe(true);
 });

 it("collects enabled plugin skills with codex-plugin origin metadata", async () => {
  const pluginRoot = join(tempDir, "plugin-src");
  writeCodexPlugin(pluginRoot, "skills-plugin");
  await manager.install(pluginRoot);
  const resources = manager.resolveEnabledPluginResources();
  expect(resources.skills).toHaveLength(1);
  expect(resources.skills[0]?.metadata.origin).toBe("codex-plugin");
  expect(resources.skills[0]?.path).toBe(join(pluginRoot, "skills"));
 });

 it("removes plugin and its mcp servers", async () => {
  const pluginRoot = join(tempDir, "plugin-src");
  writeCodexPlugin(pluginRoot, "gone", { mcp: true });
  await manager.install(pluginRoot);
  expect(manager.remove("gone")).toBe(true);
  const mcpRaw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8"));
  expect(mcpRaw.mcpServers["gone-docs"]).toBeUndefined();
  expect(sm.getCodexPlugins()).toHaveLength(0);
 });
});
```

（测试文件头部 import 增加 `readFileSync` 与 `SettingsManager`，并从 `../src/core/codex-plugin-manager.ts` import `CodexPluginManager`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --dir packages/coding-agent/test codex-plugin-manager`
Expected: FAIL（CodexPluginManager undefined）

- [ ] **Step 3: 实现 CodexPluginManager 类**

在 `codex-plugin-manager.ts` 解析函数后追加，参照 `claude-plugin-manager.ts` 对应方法逐段实现（git clone/checkout、mcp.json 读写、storage root、installedPath 解析）。不同点：存储根 `codex-plugins`（用户）/ `.pi/codex-plugins`（项目）；市场根 `codex-plugin-marketplaces`；settings 用 Task 1 的 codex 方法；MCP 前缀 `${pluginName}-`；`resolveEnabledPluginResources` 的 metadata.origin 为 `"codex-plugin"`；npm 来源 `npm pack` + `tar -xzf`（临时目录用 `os.tmpdir()` 随机子目录，处理后删除）；`install` 时 hooks 物化后写入 settings 的 `hooks` 字段。需要 `import { tmpdir } from "node:os"` 与 `execFileAsync`（`node:child_process` promisify，同 claude-plugin-manager）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --dir packages/coding-agent/test codex-plugin-manager`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/codex-plugin-manager.ts packages/coding-agent/test/codex-plugin-manager.test.ts
git commit -m "feat(codex-plugin): 安装/物化/MCP/skills 管理"
```

---

### Task 4: CLI codex-plugin 子命令

**Files:**

- Modify: `packages/coding-agent/src/package-manager-cli.ts`（新增 `printCodexPluginCommandHelp` + `export async function handleCodexPluginCommand(args)`，并在 CLI 主分发处（`handlePluginCommand` 被调用的位置）并列注册）
- Test: `packages/coding-agent/test/package-manager-cli-codex.test.ts`（新建，参照 `package-manager-cli-plugins.test.ts` 的 ENV_AGENT_DIR + cwd mock 模式）

**Interfaces:**

- Consumes: `CodexPluginManager`（Task 3）、`SettingsManager`、`getAgentDir`、`parseProjectTrustOverride`
- Produces: 新 CLI 子命令：

```
pi codex-plugin marketplace add <name> <repo-or-url>
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

**hooks list/disable/enable 语义：** `hooks list` 遍历 `listConfiguredPlugins()`，打印插件名、enabled 状态、每个事件的 handler command（`name  event: command`）；`hooks disable <plugin>` / `enable <plugin>` 修改 settings 中该插件的 `enabled` 字段（读 `getCodexPlugins`/`getProjectCodexPlugins` 对应 scope，改后 set 回并 flush）。**install 后打印 hooks 摘要：** install 成功分支在 `console.log(chalk.green("Installed plugin ${name}"))` 后，遍历 `installed.hooks` 打印 `chalk.dim("  hooks: <event> <command>")` 每行（无 hooks 则打印 `chalk.dim("  hooks: none")`），以向用户披露已安装插件的挂钩命令。

- [ ] **Step 1: 写失败测试**

`packages/coding-agent/test/package-manager-cli-codex.test.ts`：

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { handleCodexPluginCommand } from "../src/package-manager-cli.ts";

function writeLocalCodexPlugin(root: string): void {
 mkdirSync(join(root, ".codex-plugin"), { recursive: true });
 writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "demo", skills: "./skills/" }));
}

describe("codex-plugin CLI", () => {
 let tempDir: string; let cwd: string; let agentDir: string;
 let originalAgentDir: string | undefined;
 let cwdSpy: ReturnType<typeof vi.spyOn>;
 let logSpy: ReturnType<typeof vi.spyOn>;
 let errorSpy: ReturnType<typeof vi.spyOn>;

 beforeEach(() => {
  tempDir = join(tmpdir(), `codex-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cwd = join(tempDir, "project"); agentDir = join(tempDir, "agent");
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
  originalAgentDir = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = agentDir;
  process.exitCode = undefined;
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
 });
 afterEach(() => {
  cwdSpy.mockRestore(); logSpy.mockRestore(); errorSpy.mockRestore();
  if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
  else process.env[ENV_AGENT_DIR] = originalAgentDir;
  process.exitCode = undefined;
  rmSync(tempDir, { recursive: true, force: true });
 });

 it("lists a configured codex marketplace", async () => {
  const marketplaceRoot = join(tempDir, "mkt");
  mkdirSync(marketplaceRoot, { recursive: true });
  writeFileSync(join(marketplaceRoot, "marketplace.json"), JSON.stringify({ plugins: [{ name: "demo", source: { source: "local", path: "./plugins/demo" } }] }));
  const sm = SettingsManager.create(cwd, agentDir);
  sm.setCodexPluginMarketplaces({ mkt: { source: marketplaceRoot } });
  await sm.flush();

  expect(await handleCodexPluginCommand(["codex-plugin", "marketplace", "list"])).toBe(true);
  expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("mkt"));
 });

 it("installs a local plugin via codex-plugin install", async () => {
  const pluginRoot = join(tempDir, "plugin-src");
  writeLocalCodexPlugin(pluginRoot);
  const result = await handleCodexPluginCommand(["codex-plugin", "install", pluginRoot]);
  expect(result).toBe(true);
  expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Installed plugin demo"));
  const sm = SettingsManager.create(cwd, agentDir);
  expect(sm.getCodexPlugins()).toHaveLength(1);
 });

 it("disables and re-enables plugin hooks via hooks command", async () => {
  const pluginRoot = join(tempDir, "plugin-src");
  writeLocalCodexPlugin(pluginRoot);
  await handleCodexPluginCommand(["codex-plugin", "install", pluginRoot]);
  expect(await handleCodexPluginCommand(["codex-plugin", "hooks", "disable", "demo"])).toBe(true);
  const sm = SettingsManager.create(cwd, agentDir);
  expect(sm.getCodexPlugins()[0]?.enabled).toBe(false);
  await handleCodexPluginCommand(["codex-plugin", "hooks", "enable", "demo"]);
  expect(sm.getCodexPlugins()[0]?.enabled).toBe(true);
 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --dir packages/coding-agent/test package-manager-cli-codex`
Expected: FAIL（handleCodexPluginCommand undefined）

- [ ] **Step 3: 实现**

在 `package-manager-cli.ts` 中 `printPluginCommandHelp` 附近新增 `printCodexPluginCommandHelp()`；新增 `export async function handleCodexPluginCommand(args: string[]): Promise<boolean>`，结构照抄 `handlePluginCommand`（514-660 行）：`args[0] !== "codex-plugin"` 返回 false；`-h/--help` 打印帮助；`SettingsManager.create(cwd, agentDir)` + `new CodexPluginManager({cwd, agentDir, settingsManager})`；`marketplace add/list/remove`、`search`（`-m/--marketplace`）、`install/list/remove/update`（`-l/--local`）照 claude-plugin 分支实现；新增 `hooks` 子命令（list/disable/enable 按 Interfaces 语义）。在 CLI 主分发处（找到调用 `handlePluginCommand` 的位置，`cli.ts` 或同文件函数）并列加入 `handleCodexPluginCommand` 调用。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --dir packages/coding-agent/test package-manager-cli-codex`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/package-manager-cli.ts packages/coding-agent/test/package-manager-cli-codex.test.ts
git commit -m "feat(codex-plugin): CLI codex-plugin 子命令族"
```

---

### Task 5: 内置桥接扩展（dist-assets/extensions/codex-hooks.ts）

**Files:**

- Create: `packages/coding-agent/dist-assets/extensions/codex-hooks.ts`（自包含，~300 行）
- Modify: `packages/coding-agent/src/index.ts`（导出 Task 1 的 codex 类型，供扩展 import）
- Test: `packages/coding-agent/test/codex-hooks-extension.test.ts`（新建，直接 import dist-assets 文件）

**Interfaces:**

- Consumes: `InstalledCodexPluginSettings`/`CodexHooksSpec`/`CodexHookGroupSpec`/`CodexHookHandlerSpec`/`CodexEventName`、`getAgentDir`、`ExtensionAPI`/`ExtensionContext`（全部 from `@schovest/pi-coding-agent`）
- Produces（扩展导出，供测试 import）：

```ts
export interface HookRunResult {
 ok: boolean;
 blocked: boolean;
 reason?: string;
 systemMessage?: string;
 continue: boolean;
 stopReason?: string;
 additionalContext?: string;
 permissionDecision?: "allow" | "deny" | "ask";
 permissionDecisionReason?: string;
 updatedInput?: Record<string, unknown>;
}
/** 读取 agentDir/settings.json + <cwd>/.pi/settings.json 中 codexPlugins，合并后过滤 enabled!==false */
export function readEnabledCodexPlugins(agentDir: string, cwd: string): InstalledCodexPluginSettings[];
/** matcher 正则匹配；matcher 为空/* 省略 → true */
export function matchHookMatcher(matcher: string | undefined, value: string | undefined): boolean;
/** 执行单个 hook handler（子进程协议） */
export function runCodexHookCommand(
 handler: CodexHookHandlerSpec,
 input: Record<string, unknown>,
 opts: { pluginRoot: string; pluginData: string; cwd: string; timeoutFallback: number },
): Promise<HookRunResult>;
/** 注册全部 Pi 事件 handler（工厂入口） */
export function createCodexHooksHandlers(pi: ExtensionAPI, opts?: { agentDir?: string }): void;
export default function codexHooksPlugin(pi: ExtensionAPI): void; // 调用 createCodexHooksHandlers
```

**子进程执行协议（`runCodexHookCommand` 实现必须遵守）：**

- 无 `args` → `spawn("sh", ["-c", handler.command], {cwd, env, stdio: ["pipe","pipe","pipe"]})`；有 `args` → `spawn(handler.command, handler.args, {...})`。`env = {...process.env, PLUGIN_ROOT, PLUGIN_DATA, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PLUGIN_DATA: pluginData}`
- stdin 写 `JSON.stringify(input)` + `\n` 后 end
- 超时：`setTimeout(() => child.kill("SIGKILL"), (handler.timeout ?? timeoutFallback) * 1000)`，触发则返回 `{ok:false, blocked:false, reason:"codex hook timed out"}`
- exit 0：stdout 尝试 JSON.parse（`parseHookOutput`）；纯文本 → `{ok:true, blocked:false, continue:true, additionalContext: trimmed || undefined}`（仅 session_start/user_prompt_submit/subagent_start/turn_start 事件；其他事件纯文本忽略为 `{ok:true, blocked:false, continue:true}`）
- exit 2：`{ok:false, blocked:true, reason: stderr.trim() || "blocked by codex hook"}`
- 其他非 0：`{ok:false, blocked:false, reason: stderr.trim() || "codex hook exited " + code}`
- `parseHookOutput(json)`：合并顶层与 `hookSpecificOutput`；`decision === "block"` 或 `hookSpecificOutput.decision?.behavior === "deny"` → blocked；`permissionDecision`（allow/deny/ask）+ `permissionDecisionReason`；`updatedInput`（对象）；`additionalContext`（字符串）；`continue === false` → continue:false；`systemMessage`/`stopReason` 透传

**事件映射（`createCodexHooksHandlers` 注册，`pi` 用 `as` 断言扩展事件类型，参照 dist-assets/extensions/tps.ts 的 RichExtensionAPI 模式）：**

| codex 事件 | Pi 事件 | 语义转译 |
| --- | --- | --- |
| session_start | `session_start` | Pi reason 映射 source（startup/new→startup，resume/fork→resume，reload→startup）；跑匹配 hooks（matcher 匹配 source）；additionalContext push 进模块级 `pendingContext` |
| session_end | `session_shutdown` | 跑 hooks（reason 恒 "other"），忽略输出 |
| user_prompt_submit | `input` | 跑 hooks（matcher 忽略，`prompt=event.text`）；任一 blocked → 返回 `{action:"handled"}`；additionalContext push `pendingContext` |
| pre_tool_use | `tool_call` | 跑 hooks（`tool_name=event.toolName`，`tool_input=event.input`）；deny → `{block:true, reason}`；`updatedInput` → `Object.assign(event.input, updatedInput)`；blocked → `{block:true, reason}`；additionalContext 经 `ctx.ui.notify(..., "info")` 展示 |
| permission_request | `tool_call`（pre_tool_use 之后） | 仅当 pre_tool_use 未 deny 时跑（同输入）；allow → 放行；deny → `{block:true, reason: message}` |
| post_tool_use | `tool_result` | 跑 hooks（`tool_name`、`tool_input=event.input`、`tool_response=event.content`）；blocked → 返回 `{content: [{type:"text", text: reason}], isError: true}`；additionalContext 附加进 content 尾部 |
| pre_compact | `session_before_compact` | 跑 hooks（`trigger = reason==="manual" ? "manual" : "auto"`）；continue:false → `{cancel:true}` |
| post_compact | `session_compact` | 跑 hooks（trigger 同上），忽略输出 |
| subagent_start | `agent_start` | 跑 hooks（`agent_type = 无/undefined`，matcher 为空才触发）；additionalContext push `pendingContext` |
| subagent_stop | `agent_end` | 跑 hooks（`last_assistant_message` 从 event.messages 取最后 assistant 文本），忽略 block |
| stop | `turn_end` | 跑 hooks（`stop_hook_active`=模块级 `stopContinued` 标志）；block 且 !stopContinued → `pi.sendUserMessage(reason)` + stopContinued=true；`input` 事件里重置 stopContinued=false |
| turn_start（旧格式 AgentConversationHook） | `turn_start` | 跑 hooks，additionalContext push `pendingContext` |

**additionalContext 注入：** `pendingContext` 为模块级 `string[]`。`before_agent_start` handler 中：若 `pendingContext.length > 0`，返回 `{systemPrompt: ctx.getSystemPrompt() + "\n\n" + pendingContext.join("\n\n")}` 并清空数组（实现时用 `opts.agentDir ?? getAgentDir()` 与 `ctx.cwd` 读取插件）。

**hooks 读取：** 每个 handler 触发时调用 `readEnabledCodexPlugins(agentDir, ctx.cwd)`（实时读 settings，disable 即时生效），过滤出 `plugins[i].hooks?.[event]` 的 handlers（插件根路径 = 插件 source 的本地解析：settings 中 `source` 为本地路径时直接用；否则不可用则跳过）。为避免 settings 文件 I/O 过频，模块级缓存 `{agentDir, cwd, mtimeMs, plugins}`，文件 mtime 变化才重读。

- [ ] **Step 1: 写失败测试**

`packages/coding-agent/test/codex-hooks-extension.test.ts`：

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
 createCodexHooksHandlers,
 matchHookMatcher,
 readEnabledCodexPlugins,
 runCodexHookCommand,
} from "../dist-assets/extensions/codex-hooks.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

describe("codex hooks extension primitives", () => {
 let tempDir: string;
 let agentDir: string;
 let cwd: string;
 let originalAgentDir: string | undefined;

 beforeEach(() => {
  tempDir = join(tmpdir(), `codex-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  agentDir = join(tempDir, "agent");
  cwd = join(tempDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  originalAgentDir = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = agentDir;
 });
 afterEach(() => {
  if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
  else process.env[ENV_AGENT_DIR] = originalAgentDir;
  rmSync(tempDir, { recursive: true, force: true });
 });

 it("reads enabled codex plugins from user and project settings", () => {
  mkdirSync(join(agentDir), { recursive: true });
  writeFileSync(
   join(agentDir, "settings.json"),
   JSON.stringify({ codexPlugins: [{ name: "a", source: "/x", enabled: true }] }),
  );
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
   join(cwd, ".pi", "settings.json"),
   JSON.stringify({ codexPlugins: [{ name: "b", source: "/y", enabled: false }] }),
  );
  const plugins = readEnabledCodexPlugins(agentDir, cwd);
  expect(plugins.map((p) => p.name)).toEqual(["a"]);
 });

 it("matcher treats empty/star/omitted as match-all", () => {
  expect(matchHookMatcher(undefined, "Bash")).toBe(true);
  expect(matchHookMatcher("*", "Bash")).toBe(true);
  expect(matchHookMatcher("", "Bash")).toBe(true);
  expect(matchHookMatcher("^Bash$", "Bash")).toBe(true);
  expect(matchHookMatcher("^Bash$", "Read")).toBe(false);
 });

 it("runs a command hook with stdin JSON and parses JSON stdout", async () => {
  const script = join(tempDir, "echo-hook.js");
  writeFileSync(
   script,
   "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);process.stdout.write(JSON.stringify({continue:true,hookSpecificOutput:{additionalContext:'ctx:'+i.hook_event_name+' '+i.tool_name}}));});",
  );
  const result = await runCodexHookCommand(
   { type: "command", command: process.execPath, args: [script] },
   { hook_event_name: "PreToolUse", tool_name: "Bash" },
   { pluginRoot: tempDir, pluginData: join(tempDir, "data"), cwd, timeoutFallback: 10 },
  );
  expect(result.ok).toBe(true);
  expect(result.additionalContext).toBe("ctx:PreToolUse Bash");
 });

 it("exit code 2 with stderr blocks with reason", async () => {
  const script = join(tempDir, "block.js");
  writeFileSync(script, "process.stderr.write('no way');process.exit(2);");
  const result = await runCodexHookCommand(
   { type: "command", command: process.execPath, args: [script] },
   {},
   { pluginRoot: tempDir, pluginData: join(tempDir, "data"), cwd, timeoutFallback: 10 },
  );
  expect(result.blocked).toBe(true);
  expect(result.reason).toBe("no way");
 });

 it("registers Pi event handlers for all mapped codex events", () => {
  const registered: string[] = [];
  const registeredCommands: Array<{ name: string; description?: string }> = [];
  const fakePi = {
   on: (event: string) => {
    registered.push(event);
   },
   registerCommand: (name: string, opts: { description?: string }) => {
    registeredCommands.push({ name, description: opts.description });
   },
  };
  mkdirSync(join(agentDir), { recursive: true });
  writeFileSync(
   join(agentDir, "settings.json"),
   JSON.stringify({
    codexPlugins: [
     { name: "legacy", source: tempDir, enabled: true, commands: [{ name: "review", description: "Review", command: "echo hi" }] },
    ],
   }),
  );
  createCodexHooksHandlers(fakePi as never, { agentDir });
  for (const expected of ["session_start", "session_shutdown", "input", "tool_call", "tool_result", "session_before_compact", "session_compact", "agent_start", "agent_end", "turn_end", "turn_start", "before_agent_start"]) {
   expect(registered).toContain(expected);
  }
  expect(registeredCommands.map((c) => c.name)).toContain("codex:legacy:review");
 });
});
```

（test 目录下 import `../dist-assets/extensions/codex-hooks.ts` 的路径从测试文件位置解析：`packages/coding-agent/test/` → `../dist-assets/extensions/codex-hooks.ts`。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run --dir packages/coding-agent/test codex-hooks-extension`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现扩展与 index 导出**

实现 `packages/coding-agent/dist-assets/extensions/codex-hooks.ts`（自包含，仅 import `node:child_process`/`node:fs`/`node:path`/`node:os` 与 `@schovest/pi-coding-agent` 的类型 + `getAgentDir`）。关键实现：

- `readEnabledCodexPlugins(agentDir, cwd)`：读 `<agentDir>/settings.json` 与 `<cwd>/.pi/settings.json` 的 `codexPlugins` 数组（JSON.parse，容错返回空数组），合并（项目覆盖同名），过滤 `enabled !== false`
- `matchHookMatcher`：matcher 为 undefined/""/"*" → true；否则 `new RegExp(matcher).test(value ?? "")`（正则非法时返回 false）
- `runCodexHookCommand`：按协议实现（见上），用 `node:child_process` 的 spawn + 手动 Promise 封装
- `parseHookOutput(json)`：内部函数
- `createCodexHooksHandlers(pi, opts)`：`const agentDir = opts?.agentDir ?? getAgentDir()`；模块级 `pendingContext: string[]`、`stopContinued: boolean`、`settingsCache: {agentDir,cwd,mtimeMs,plugins} | null`；按映射表注册 handler。每个 handler 内：`collectHandlers(agentDir, ctx.cwd, eventName)` 返回 `Array<{plugin: InstalledCodexPluginSettings, handler: CodexHookHandlerSpec}>`（从缓存读插件，遍历 `plugin.hooks?.[eventName]` 的分组，组 matcher 与 handler matcher 都通过 `matchHookMatcher` 检查，`plugin.source` 为绝对本地路径时作为 pluginRoot，否则跳过该插件）；`runCodexHookCommand(handler, input, {pluginRoot, pluginData: join(agentDir,"codex-plugin-data",plugin.name), cwd: ctx.cwd, timeoutFallback: eventName==="session_end" ? 3 : 30})`；`input` 公共字段：`session_id: ctx.sessionManager.getSessionId()`、`cwd: ctx.cwd`、`hook_event_name: <codex事件名>`、`model: ctx.model?.id`
- `before_agent_start` handler：`pendingContext` 非空时拼接 systemPrompt（`ctx.getSystemPrompt()` 前缀）并清空
- `input` handler：跑 user_prompt_submit hooks，重置 `stopContinued=false`；blocked → 返回 `{action:"handled"}`
- `tool_call` handler：跑 pre_tool_use + permission_request（permission 仅 pre 未 deny 时），返回 `{block, reason}`，`updatedInput` 就地 `Object.assign(event.input, updatedInput)`
- `tool_result` handler：跑 post_tool_use，blocked → 返回替换 content；additionalContext 追加为 text 消息
- `turn_end` handler：跑 stop hooks，block 且 !stopContinued → `pi.sendUserMessage(reason)` + `stopContinued=true`
- default 导出调用 `createCodexHooksHandlers(pi)`

在 `packages/coding-agent/src/index.ts` 的导出列表中追加 Task 1 的类型导出：`export type { InstalledCodexPluginSettings, CodexHooksSpec, CodexHookGroupSpec, CodexHookHandlerSpec, CodexPluginCommandSpec, CodexEventName } from "./core/settings-manager.ts";`（`getAgentDir` 已导出，确认存在）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run --dir packages/coding-agent/test codex-hooks-extension`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/dist-assets/extensions/codex-hooks.ts packages/coding-agent/src/index.ts packages/coding-agent/test/codex-hooks-extension.test.ts
git commit -m "feat(codex-plugin): 内置 hooks 桥接扩展（事件映射+子进程协议）"
```

---

### Task 6: resource-loader 集成 + install.sh + 文档

**Files:**

- Modify: `packages/coding-agent/src/core/resource-loader.ts`（构造注入 CodexPluginManager 并合并 codex skills 到资源解析，参考现有 `pluginManager` 的 225 行与 384 行）
- Modify: `packages/coding-agent/dist-assets/install.sh`（EXT_NAMES/EXT_DESCS/EXT_DEFAULTS/EXT_INSTALLS 增加 codex-hooks 项）
- Modify: `docs/architecture.md`（扩展点表新增行）
- Modify: `packages/coding-agent/CHANGELOG.md`（Unreleased 条目）

**Interfaces:**

- Consumes: `CodexPluginManager`（Task 3）
- Produces: 资源加载自动包含已启用 codex 插件的 skills；install.sh 默认安装 codex-hooks 扩展

- [ ] **Step 1: 实现 resource-loader 集成**

在 `resource-loader.ts`：顶部 `import { CodexPluginManager } from "./codex-plugin-manager.ts";`；类字段声明区（`private pluginManager: PluginManager;` 旁）加 `private codexPluginManager: CodexPluginManager;`；构造器（225 行 `this.pluginManager = new PluginManager({...})` 之后）新增（构造器已有 `options.agentDir`，见 `DefaultResourceLoaderOptions`）：

```ts
this.codexPluginManager = new CodexPluginManager({
 cwd: this.cwd,
 agentDir: this.agentDir,
 settingsManager: this.settingsManager,
});
```

在 `reload()` 的 `pluginResources` 处理块（384-391 行）之后追加：

```ts
const codexResources = this.codexPluginManager.resolveEnabledPluginResources();
for (const entry of codexResources.skills) {
 if (!metadataByPath.has(entry.path)) {
  metadataByPath.set(entry.path, entry.metadata);
 }
}
this.skillDiagnostics.push(
 ...codexResources.diagnostics.map((diagnostic) => ({
  type: "warning" as const,
  message: diagnostic.message,
  path: diagnostic.path,
 })),
);
```

并把 codex skills 并入 `skillPaths`（在 428 行 `pluginResources.skills.map((entry) => entry.path)` 所在数组后追加 `...codexResources.skills.map((entry) => entry.path)`）。运行现有相关测试确认不回归：`npx vitest run --dir packages/coding-agent/test claude-plugin-manager extensions-discovery`。

- [ ] **Step 2: install.sh 增加默认扩展**

`dist-assets/install.sh` 的 EXT_NAMES 数组末尾加 `"codex-hooks"`，EXT_DESCS 加 `"Codex 插件 hooks 桥接"`，EXT_DEFAULTS 加 `1`，EXT_INSTALLS 加 `"file:codex-hooks"`（表示复制 `dist-assets/extensions/codex-hooks.ts`，参照 358-364 行文件复制分支的 src_file 命名约定）。若 install.sh 的复制逻辑按 `extensions/$src_file` 取文件，需确认 `src_file` 与文件名一致。

- [ ] **Step 3: 更新文档**

`docs/architecture.md` 扩展点表新增一行：`| Codex 插件兼容 | core/codex-plugin-manager.ts + dist-assets/extensions/codex-hooks.ts | codexPlugins/codexPluginMarketplaces settings + pi codex-plugin CLI | marketplace.json/.codex-plugin/plugin.json/hooks.json |`；同步更新 AGENTS.md 的架构索引摘要列（如表格行变化）。`packages/coding-agent/CHANGELOG.md` `## [Unreleased]` 的 `### Added` 下加：`- 新增 codex 插件市场兼容（cli codex-plugin，含 hooks/skills/MCP 桥接与旧格式插件支持）`。

- [ ] **Step 4: 运行检查**

Run: `npm run check`（完整输出）
Expected: 无 errors/warnings/infos

- [ ] **Step 5: 自查 docs 并 Commit**

自查 `packages/coding-agent/docs/` 下各文件是否需要同步更新（对照变更逐项检查，不需要则明确说明）。然后：

```bash
git add packages/coding-agent/src/core/resource-loader.ts packages/coding-agent/dist-assets/install.sh docs/architecture.md packages/coding-agent/CHANGELOG.md
git commit -m "feat(codex-plugin): resource-loader 集成 + 默认安装 + 文档"
```
