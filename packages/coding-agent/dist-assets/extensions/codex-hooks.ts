/**
 * Codex 插件兼容桥接扩展：把已安装 codex 插件的 hooks 配置桥接到 Pi 事件系统，
 * 并注册 `/codex:<plugin>:<command>` 斜杠命令。
 *
 * 自包含：只依赖 node 内置模块与 `@schovest/pi-coding-agent`。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	getAgentDir,
	type CodexEventName,
	type CodexHookGroupSpec,
	type CodexHookHandlerSpec,
	type CodexPluginCommandSpec,
	type ExtensionAPI,
	type ExtensionContext,
	type InstalledCodexPluginSettings,
} from "@schovest/pi-coding-agent";

/** 单个 codex hook 的执行结果。 */
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

/** codex 事件名（PascalCase），写入 hook 输入的 `hook_event_name` 字段。 */
const CODEX_EVENT_NAME: Record<CodexEventName, string> = {
	session_start: "SessionStart",
	session_end: "SessionEnd",
	user_prompt_submit: "UserPromptSubmit",
	pre_tool_use: "PreToolUse",
	permission_request: "PermissionRequest",
	post_tool_use: "PostToolUse",
	pre_compact: "PreCompact",
	post_compact: "PostCompact",
	subagent_start: "SubagentStart",
	subagent_stop: "SubagentStop",
	turn_start: "TurnStart",
	stop: "Stop",
};

/** 纯文本 stdout 作为 additionalContext 注入的事件；其余事件纯文本忽略。 */
const TEXT_CONTEXT_EVENTS: ReadonlySet<CodexEventName> = new Set([
	"session_start",
	"user_prompt_submit",
	"subagent_start",
	"turn_start",
]);

/** 待注入下一轮 systemPrompt 的 additionalContext（模块级，跨 handler 传递）。 */
let pendingContext: string[] = [];

/** stop hook 防递归标志；`input` 事件里重置。 */
let stopContinued = false;

interface SettingsCacheEntry {
	agentDir: string;
	cwd: string;
	mtimeMs: number;
	plugins: InstalledCodexPluginSettings[];
}

/** settings 文件 mtime 缓存，避免每个事件都重读磁盘。 */
let settingsCache: SettingsCacheEntry | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getFileMtime(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

function appendPluginsFromSettings(target: InstalledCodexPluginSettings[], file: string): void {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isRecord(raw) || !Array.isArray(raw.codexPlugins)) return;
		for (const entry of raw.codexPlugins) {
			if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.source !== "string") continue;
			target.push(entry as unknown as InstalledCodexPluginSettings);
		}
	} catch {
		// 缺失或非法的 settings 文件直接忽略
	}
}

/** 读取 agentDir/settings.json 与 <cwd>/.pi/settings.json 中 codexPlugins，项目覆盖同名，过滤 enabled!==false。 */
export function readEnabledCodexPlugins(agentDir: string, cwd: string): InstalledCodexPluginSettings[] {
	const all: InstalledCodexPluginSettings[] = [];
	appendPluginsFromSettings(all, join(agentDir, "settings.json"));
	appendPluginsFromSettings(all, join(cwd, ".pi", "settings.json"));
	const byName = new Map<string, InstalledCodexPluginSettings>();
	for (const plugin of all) {
		// 项目级同名插件覆盖用户级
		byName.set(plugin.name, plugin);
	}
	return [...byName.values()].filter((plugin) => plugin.enabled !== false);
}

/** 带 mtime 缓存的插件读取（handler 每事件调用，settings 变更才重读）。 */
function readPluginsCached(agentDir: string, cwd: string): InstalledCodexPluginSettings[] {
	const mtimeMs = Math.max(
		getFileMtime(join(agentDir, "settings.json")),
		getFileMtime(join(cwd, ".pi", "settings.json")),
	);
	const cached = settingsCache;
	if (cached !== null && cached.agentDir === agentDir && cached.cwd === cwd && cached.mtimeMs === mtimeMs) {
		return cached.plugins;
	}
	const plugins = readEnabledCodexPlugins(agentDir, cwd);
	settingsCache = { agentDir, cwd, mtimeMs, plugins };
	return plugins;
}

/** matcher 正则匹配；matcher 为空、* 或省略 → true（正则非法返回 false）。 */
export function matchHookMatcher(matcher: string | undefined, value: string | undefined): boolean {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	try {
		return new RegExp(matcher).test(value ?? "");
	} catch {
		return false;
	}
}

/**
 * 解析 hook 的 JSON stdout：合并顶层与 hookSpecificOutput 字段。
 * 非 JSON 或非对象返回 undefined（由调用方按纯文本处理）。
 */
function parseHookOutput(json: string): HookRunResult | undefined {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;

	const specific = isRecord(value.hookSpecificOutput) ? value.hookSpecificOutput : {};
	const topDecision = value.decision;
	const specificDecision = isRecord(specific.decision) ? specific.decision : {};
	const blocked =
		topDecision === "block" ||
		(isRecord(topDecision) && (topDecision.behavior === "block" || topDecision.behavior === "deny")) ||
		specificDecision.behavior === "deny";

	const pickString = (...candidates: unknown[]): string | undefined => {
		for (const candidate of candidates) {
			if (typeof candidate === "string") return candidate;
		}
		return undefined;
	};

	const result: HookRunResult = {
		ok: true,
		blocked,
		continue: value.continue === false ? false : true,
	};

	const reason = pickString(value.reason, specific.reason, specificDecision.reason);
	if (reason !== undefined) result.reason = reason;
	if (typeof value.systemMessage === "string") result.systemMessage = value.systemMessage;
	if (typeof value.stopReason === "string") result.stopReason = value.stopReason;

	const permissionDecision = value.permissionDecision ?? specific.permissionDecision;
	if (permissionDecision === "allow" || permissionDecision === "deny" || permissionDecision === "ask") {
		result.permissionDecision = permissionDecision;
	}
	const permissionDecisionReason = pickString(value.permissionDecisionReason, specific.permissionDecisionReason);
	if (permissionDecisionReason !== undefined) result.permissionDecisionReason = permissionDecisionReason;

	let updatedInput: Record<string, unknown> | undefined;
	if (isRecord(value.updatedInput)) {
		updatedInput = value.updatedInput;
	} else if (isRecord(specific.updatedInput)) {
		updatedInput = specific.updatedInput;
	}
	if (updatedInput !== undefined) result.updatedInput = updatedInput;

	const additionalContext = pickString(value.additionalContext, specific.additionalContext);
	if (additionalContext !== undefined) result.additionalContext = additionalContext;

	return result;
}

function eventNameToCodexEvent(name: string | undefined): CodexEventName | undefined {
	if (name === undefined) return undefined;
	for (const [event, codexName] of Object.entries(CODEX_EVENT_NAME)) {
		if (codexName === name) return event as CodexEventName;
	}
	return undefined;
}

/**
 * 子进程执行协议：无 `args` → `sh -c` 完整命令行；有 `args` → spawn(command, args)。
 * stdin 写 JSON + `\n`；超时 kill；exit 0 解析 stdout；exit 2 = block；其余非 0 = 失败。
 */
export function runCodexHookCommand(
	handler: CodexHookHandlerSpec,
	input: Record<string, unknown>,
	opts: { pluginRoot: string; pluginData: string; cwd: string; timeoutFallback: number },
): Promise<HookRunResult> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PLUGIN_ROOT: opts.pluginRoot,
			PLUGIN_DATA: opts.pluginData,
			CLAUDE_PLUGIN_ROOT: opts.pluginRoot,
			CLAUDE_PLUGIN_DATA: opts.pluginData,
		};

		const child: ChildProcess =
			handler.args !== undefined && handler.args.length > 0
				? spawn(handler.command, handler.args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] })
				: spawn("sh", ["-c", handler.command], { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		// 流级 error 监听：子进程在读完 stdin 前退出（如 `sh -c 'exit 2'`）时，
		// 写 stdin 或读 stdout/stderr 会触发 EPIPE；无监听器会以未捕获异常崩溃整个进程。
		child.stdin?.on("error", () => {});
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});

		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolve({ ok: false, blocked: false, reason: "codex hook timed out", continue: true });
		}, (handler.timeout ?? opts.timeoutFallback) * 1000);

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, blocked: false, reason: error.message, continue: true });
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				const trimmed = stdout.trim();
				if (trimmed === "") {
					resolve({ ok: true, blocked: false, continue: true });
					return;
				}
				const parsed = parseHookOutput(trimmed);
				if (parsed !== undefined) {
					resolve(parsed);
					return;
				}
				// 纯文本输出：仅上下文类事件注入 additionalContext
				const codexEvent = eventNameToCodexEvent(
					typeof input.hook_event_name === "string" ? input.hook_event_name : undefined,
				);
				if (codexEvent !== undefined && TEXT_CONTEXT_EVENTS.has(codexEvent)) {
					resolve({ ok: true, blocked: false, continue: true, additionalContext: trimmed });
				} else {
					resolve({ ok: true, blocked: false, continue: true });
				}
				return;
			}
			if (code === 2) {
				resolve({ ok: false, blocked: true, reason: stderr.trim() || "blocked by codex hook", continue: true });
				return;
			}
			resolve({ ok: false, blocked: false, reason: stderr.trim() || `codex hook exited ${code}`, continue: true });
		});

		child.stdin?.write(JSON.stringify(input) + "\n");
		child.stdin?.end();
	});
}

interface CollectedHookHandler {
	plugin: InstalledCodexPluginSettings;
	pluginRoot: string;
	handler: CodexHookHandlerSpec;
}

/**
 * 插件根目录：优先 settings 中物化时持久化的 installedPath（git/npm 来源的存储副本），
 * 回退到 source 为绝对本地路径时直接使用；两者都不可用时跳过该插件。
 */
function resolvePluginRoot(plugin: InstalledCodexPluginSettings): string | undefined {
	if (plugin.installedPath !== undefined && existsSync(plugin.installedPath)) {
		return plugin.installedPath;
	}
	if (isAbsolute(plugin.source) && existsSync(plugin.source)) {
		return plugin.source;
	}
	return undefined;
}

/** 读取插件并过滤出组/处理级 matcher 都匹配的 handlers。 */
function collectHookHandlers(
	agentDir: string,
	cwd: string,
	eventName: CodexEventName,
	matcherValue: string | undefined,
): CollectedHookHandler[] {
	const collected: CollectedHookHandler[] = [];
	for (const plugin of readPluginsCached(agentDir, cwd)) {
		const pluginRoot = resolvePluginRoot(plugin);
		if (pluginRoot === undefined) continue;
		const groups: CodexHookGroupSpec[] | undefined = plugin.hooks?.[eventName];
		if (groups === undefined) continue;
		for (const group of groups) {
			if (!matchHookMatcher(group.matcher, matcherValue)) continue;
			for (const handler of group.handlers) {
				if (!matchHookMatcher(handler.matcher, matcherValue)) continue;
				collected.push({ plugin, pluginRoot, handler });
			}
		}
	}
	return collected;
}

/** 组装 hook 输入的公共字段。 */
function buildHookInput(
	ctx: ExtensionContext,
	eventName: CodexEventName,
	extra: Record<string, unknown>,
): Record<string, unknown> {
	return {
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		hook_event_name: CODEX_EVENT_NAME[eventName],
		model: ctx.model?.id,
		...extra,
	};
}

/** 跑匹配事件的所有 hooks，返回各 hook 结果（按 settings 顺序）。 */
function runCodexHooks(
	agentDir: string,
	ctx: ExtensionContext,
	eventName: CodexEventName,
	matcherValue: string | undefined,
	inputExtra: Record<string, unknown>,
	timeoutFallback: number,
): Promise<HookRunResult[]> {
	const collected = collectHookHandlers(agentDir, ctx.cwd, eventName, matcherValue);
	return Promise.all(
		collected.map(({ plugin, pluginRoot, handler }) =>
			runCodexHookCommand(handler, buildHookInput(ctx, eventName, inputExtra), {
				pluginRoot,
				pluginData: join(agentDir, "codex-plugin-data", plugin.name),
				cwd: ctx.cwd,
				timeoutFallback,
			}),
		),
	);
}

/** 执行斜杠命令（与 hooks 相同的子进程协议；env 再合并命令自身的 env）。 */
function runPluginCommand(
	command: CodexPluginCommandSpec,
	opts: { pluginRoot: string; pluginData: string; cwd: string },
): Promise<void> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PLUGIN_ROOT: opts.pluginRoot,
			PLUGIN_DATA: opts.pluginData,
			CLAUDE_PLUGIN_ROOT: opts.pluginRoot,
			CLAUDE_PLUGIN_DATA: opts.pluginData,
			...(command.env ?? {}),
		};
		const child =
			command.args !== undefined && command.args.length > 0
				? spawn(command.command, command.args, { cwd: opts.cwd, env, stdio: "inherit" })
				: spawn("sh", ["-c", command.command], { cwd: opts.cwd, env, stdio: "inherit" });
		child.on("error", () => resolve());
		child.on("close", () => resolve());
	});
}

/** 注册 `/codex:<plugin>:<command>` 斜杠命令。 */
function registerCodexCommands(pi: ExtensionAPI, agentDir: string): void {
	for (const plugin of readPluginsCached(agentDir, process.cwd())) {
		const pluginRoot = resolvePluginRoot(plugin);
		if (pluginRoot === undefined || plugin.commands === undefined) continue;
		const pluginData = join(agentDir, "codex-plugin-data", plugin.name);
		for (const command of plugin.commands) {
			pi.registerCommand(`codex:${plugin.name}:${command.name}`, {
				...(command.description !== undefined ? { description: command.description } : {}),
				handler: async (_args, ctx) => {
					await runPluginCommand(command, { pluginRoot, pluginData, cwd: ctx.cwd });
				},
			});
		}
	}
}

/** 取 event.messages 中最后一条 assistant 消息的文本内容。 */
function getLastAssistantText(messages: unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isRecord(message) || message.role !== "assistant") continue;
		const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : undefined;
		if (blocks === undefined) continue;
		for (let j = blocks.length - 1; j >= 0; j--) {
			const block = blocks[j];
			if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
			const text = block.text.trim();
			if (text.length > 0) return text;
		}
	}
	return undefined;
}

/** Runtime ExtensionAPI 的事件比类型声明更宽；参照 tps.ts 用 as 断言。 */
type RichExtensionAPI = ExtensionAPI & {
	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
};

/**
 * 注册全部 Pi 事件 handler（事件映射见计划简报）与 `/codex:<plugin>:<command>` 斜杠命令。
 * `opts.agentDir` 缺省时用 getAgentDir()。
 */
export function createCodexHooksHandlers(pi: ExtensionAPI, opts?: { agentDir?: string }): void {
	const agentDir = opts?.agentDir ?? getAgentDir();
	const api = pi as RichExtensionAPI;

	registerCodexCommands(pi, agentDir);

	// session_start：source 映射（startup/new/reload → startup，resume/fork → resume）
	api.on("session_start", async (event: unknown, ctx) => {
		const reason = (event as { reason?: string }).reason;
		const source = reason === "resume" || reason === "fork" ? "resume" : "startup";
		const results = await runCodexHooks(agentDir, ctx, "session_start", source, { source }, 30);
		for (const result of results) {
			if (result.additionalContext !== undefined) pendingContext.push(result.additionalContext);
		}
	});

	// session_end：reason 恒 "other"，忽略输出，超时 3s
	api.on("session_shutdown", async (_event: unknown, ctx) => {
		await runCodexHooks(agentDir, ctx, "session_end", undefined, { reason: "other" }, 3);
	});

	// user_prompt_submit：matcher 忽略；blocked → handled；additionalContext 注入 pendingContext；仅真实用户输入（非扩展注入）重置 stopContinued
	api.on("input", async (event: unknown, ctx) => {
		if ((event as { source?: string }).source !== "extension") stopContinued = false;
		const text = (event as { text?: string }).text ?? "";
		const results = await runCodexHooks(agentDir, ctx, "user_prompt_submit", undefined, { prompt: text }, 30);
		let blocked = false;
		for (const result of results) {
			if (result.additionalContext !== undefined) pendingContext.push(result.additionalContext);
			if (result.blocked) blocked = true;
		}
		if (blocked) return { action: "handled" };
		return undefined;
	});

	// pre_tool_use + permission_request
	api.on("tool_call", async (event: unknown, ctx) => {
		const e = event as { toolName: string; input: Record<string, unknown> };
		const inputExtra: Record<string, unknown> = { tool_name: e.toolName, tool_input: e.input };

		const preResults = await runCodexHooks(agentDir, ctx, "pre_tool_use", e.toolName, inputExtra, 30);
		for (const result of preResults) {
			if (result.updatedInput !== undefined) Object.assign(e.input, result.updatedInput);
			if (result.additionalContext !== undefined) ctx.ui.notify(result.additionalContext, "info");
			if (result.systemMessage !== undefined) ctx.ui.notify(result.systemMessage, "info");
		}
		const preBlocked = preResults.find((r) => r.blocked || r.permissionDecision === "deny");
		if (preBlocked !== undefined) {
			return {
				block: true,
				reason: preBlocked.permissionDecisionReason ?? preBlocked.reason ?? "blocked by codex hook",
			};
		}

		// permission_request 仅在 pre_tool_use 未 deny 时跑（同输入）
		const permissionResults = await runCodexHooks(agentDir, ctx, "permission_request", e.toolName, inputExtra, 30);
		for (const result of permissionResults) {
			if (result.updatedInput !== undefined) Object.assign(e.input, result.updatedInput);
			if (result.additionalContext !== undefined) ctx.ui.notify(result.additionalContext, "info");
			if (result.systemMessage !== undefined) ctx.ui.notify(result.systemMessage, "info");
		}
		const denied = permissionResults.find((r) => r.blocked || r.permissionDecision === "deny");
		if (denied !== undefined) {
			return { block: true, reason: denied.permissionDecisionReason ?? denied.reason ?? "blocked by codex hook" };
		}
		return undefined;
	});

	// post_tool_use：blocked → 替换 content 为错误；additionalContext 附加进 content 尾部
	api.on("tool_result", async (event: unknown, ctx) => {
		const e = event as { toolName: string; input: Record<string, unknown>; content: Array<Record<string, unknown>> };
		const results = await runCodexHooks(
			agentDir,
			ctx,
			"post_tool_use",
			e.toolName,
			{ tool_name: e.toolName, tool_input: e.input, tool_response: e.content },
			30,
		);
		let blockedResult: HookRunResult | undefined;
		const extraContext: Array<{ type: "text"; text: string }> = [];
		for (const result of results) {
			if (result.blocked && blockedResult === undefined) blockedResult = result;
			if (result.additionalContext !== undefined) {
				extraContext.push({ type: "text", text: result.additionalContext });
			}
		}
		if (blockedResult !== undefined) {
			return {
				content: [{ type: "text", text: blockedResult.reason ?? "blocked by codex hook" }, ...extraContext],
				isError: true,
			};
		}
		if (extraContext.length > 0) {
			return { content: [...e.content, ...extraContext] };
		}
		return undefined;
	});

	// pre_compact：trigger = manual/auto；continue:false → cancel
	api.on("session_before_compact", async (event: unknown, ctx) => {
		const reason = (event as { reason?: string }).reason;
		const trigger = reason === "manual" ? "manual" : "auto";
		const results = await runCodexHooks(agentDir, ctx, "pre_compact", trigger, { trigger }, 30);
		if (results.some((r) => r.continue === false)) {
			return { cancel: true };
		}
		return undefined;
	});

	// post_compact：trigger 同上，忽略输出
	api.on("session_compact", async (event: unknown, ctx) => {
		const reason = (event as { reason?: string }).reason;
		const trigger = reason === "manual" ? "manual" : "auto";
		await runCodexHooks(agentDir, ctx, "post_compact", trigger, { trigger }, 30);
	});

	// subagent_start：agent_type 无；matcher 为空才触发；additionalContext 注入 pendingContext
	api.on("agent_start", async (_event: unknown, ctx) => {
		const results = await runCodexHooks(agentDir, ctx, "subagent_start", undefined, { agent_type: undefined }, 30);
		for (const result of results) {
			if (result.additionalContext !== undefined) pendingContext.push(result.additionalContext);
		}
	});

	// subagent_stop：last_assistant_message；忽略 block
	api.on("agent_end", async (event: unknown, ctx) => {
		const messages = (event as { messages?: unknown[] }).messages ?? [];
		const extra: Record<string, unknown> = {};
		const lastAssistant = getLastAssistantText(messages);
		if (lastAssistant !== undefined) extra.last_assistant_message = lastAssistant;
		await runCodexHooks(agentDir, ctx, "subagent_stop", undefined, extra, 30);
	});

	// stop：stop_hook_active = stopContinued；block 且未继续 → sendUserMessage + 防递归
	api.on("turn_end", async (_event: unknown, ctx) => {
		const results = await runCodexHooks(agentDir, ctx, "stop", undefined, { stop_hook_active: stopContinued }, 30);
		const blockedResult = results.find((r) => r.blocked);
		if (blockedResult !== undefined && !stopContinued) {
			stopContinued = true;
			pi.sendUserMessage(blockedResult.reason ?? "stop requested by codex hook");
		}
	});

	// turn_start（旧格式 AgentConversationHook）：additionalContext 注入 pendingContext
	api.on("turn_start", async (_event: unknown, ctx) => {
		const results = await runCodexHooks(agentDir, ctx, "turn_start", undefined, {}, 30);
		for (const result of results) {
			if (result.additionalContext !== undefined) pendingContext.push(result.additionalContext);
		}
	});

	// before_agent_start：pendingContext 拼入 systemPrompt 并清空
	api.on("before_agent_start", (_event: unknown, ctx) => {
		if (pendingContext.length === 0) return undefined;
		const context = pendingContext;
		pendingContext = [];
		return { systemPrompt: ctx.getSystemPrompt() + "\n\n" + context.join("\n\n") };
	});
}

/** 扩展入口。 */
export default function codexHooksPlugin(pi: ExtensionAPI): void {
	createCodexHooksHandlers(pi);
}
