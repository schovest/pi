import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { PluginDiagnostic } from "./claude-plugin-manager.ts";
import type { CodexEventName, CodexHookGroupSpec, CodexHookHandlerSpec, CodexHooksSpec } from "./settings-manager.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function getStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			result[key] = entry;
		}
	}
	return result;
}

function normalizePluginName(name: string): string {
	return (
		name
			.trim()
			.replace(/[^A-Za-z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "plugin"
	);
}

function readJsonObject(path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`Failed to parse JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Expected JSON object in ${path}`);
	}
	return parsed;
}

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

/**
 * Normalize a marketplace entry source (object or string) into a CodexPluginSource.
 */
function normalizeMarketplaceSource(src: unknown): CodexPluginSource | undefined {
	if (isRecord(src)) {
		const kind = typeof src.source === "string" ? src.source : "local";
		if (kind === "git-subdir") {
			const source: CodexPluginSource = {
				kind: "git",
				url: typeof src.url === "string" ? src.url : "",
			};
			if (typeof src.path === "string") source.path = src.path;
			if (typeof src.ref === "string") source.ref = src.ref;
			return source;
		}
		if (kind === "npm") {
			const source: CodexPluginSource = {
				kind: "npm",
				package: typeof src.package === "string" ? src.package : "",
			};
			if (typeof src.version === "string") source.version = src.version;
			if (typeof src.registry === "string") source.registry = src.registry;
			return source;
		}
		return { kind: "local", path: typeof src.path === "string" ? src.path : "" };
	}
	if (typeof src === "string") {
		return { kind: "local", path: src };
	}
	return undefined;
}

export function readCodexMarketplaceCatalog(root: string): CodexMarketplaceCatalog {
	const raw = readJsonObject(join(root, "marketplace.json"));
	const plugins: CodexMarketplaceEntry[] = [];
	if (Array.isArray(raw.plugins)) {
		for (const entry of raw.plugins) {
			if (!isRecord(entry) || typeof entry.name !== "string") continue;
			const source = normalizeMarketplaceSource(entry.source);
			if (source === undefined) continue;
			plugins.push({ name: entry.name, source });
		}
	}
	return {
		...(typeof raw.name === "string" ? { name: raw.name } : {}),
		plugins,
	};
}

const EVENT_NAME_MAP: Record<string, CodexEventName> = {
	// New-format PascalCase event names
	SessionStart: "session_start",
	SessionEnd: "session_end",
	UserPromptSubmit: "user_prompt_submit",
	PreToolUse: "pre_tool_use",
	PermissionRequest: "permission_request",
	PostToolUse: "post_tool_use",
	PreCompact: "pre_compact",
	PostCompact: "post_compact",
	SubagentStart: "subagent_start",
	SubagentStop: "subagent_stop",
	Stop: "stop",
	// Legacy camelCase hook keys
	SessionStartHook: "session_start",
	SessionEndHook: "session_end",
	UserPromptHook: "user_prompt_submit",
	PromptHook: "user_prompt_submit",
	NotificationHook: "post_tool_use",
	AgentConversationHook: "turn_start",
};

/** Old-format hook keys (camelCase) mapped to standard event names; unknown keys return undefined. */
export function normalizeCodexHookEventName(key: string): CodexEventName | undefined {
	return EVENT_NAME_MAP[key];
}

/**
 * Normalize a raw hooks object (new format `{hooks: {Event: [...]}}` or legacy
 * inline `{EventHook: {command, args}}`) into a CodexHooksSpec. ${PLUGIN_ROOT}
 * placeholders are left untouched here; they are materialized in Task 3.
 */
export function normalizeCodexHooks(raw: unknown): CodexHooksSpec {
	const result: CodexHooksSpec = {};
	if (!isRecord(raw)) return result;
	const input = isRecord(raw.hooks) ? raw.hooks : raw;
	for (const [key, value] of Object.entries(input)) {
		const event = normalizeCodexHookEventName(key);
		if (event === undefined) continue;
		if (Array.isArray(value)) {
			// New format: matcher groups, keep only type === "command" handlers.
			const groups: CodexHookGroupSpec[] = [];
			for (const g of value) {
				if (!isRecord(g)) continue;
				const matcher = typeof g.matcher === "string" ? g.matcher : undefined;
				const handlers: CodexHookHandlerSpec[] = [];
				if (Array.isArray(g.hooks)) {
					for (const h of g.hooks) {
						if (!isRecord(h) || h.type !== "command") continue;
						const handler: CodexHookHandlerSpec = { type: "command", command: String(h.command) };
						if (Array.isArray(h.args)) handler.args = getStringArray(h.args);
						if (typeof h.timeout === "number") handler.timeout = h.timeout;
						if (typeof h.statusMessage === "string") handler.statusMessage = h.statusMessage;
						if (typeof h.matcher === "string") handler.matcher = h.matcher;
						handlers.push(handler);
					}
				}
				if (handlers.length > 0) {
					groups.push(matcher === undefined ? { handlers } : { matcher, handlers });
				}
			}
			if (groups.length > 0) {
				result[event] = (result[event] ?? []).concat(groups);
			}
		} else if (isRecord(value) && typeof value.command === "string") {
			// Legacy format: single {command, args?} handler per event key.
			const handler: CodexHookHandlerSpec = { type: "command", command: value.command };
			if (Array.isArray(value.args)) handler.args = getStringArray(value.args);
			result[event] = (result[event] ?? []).concat([{ handlers: [handler] }]);
		}
	}
	return result;
}

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
		const refs =
			typeof skillRef === "string"
				? [skillRef]
				: Array.isArray(skillRef)
					? skillRef.filter((s): s is string => typeof s === "string")
					: [];
		for (const ref of refs) {
			const dir = resolve(root, ref.replace(/^\.\//, ""));
			if (existsSync(dir)) skills.push(dir);
		}
	}

	const commands: CodexPluginCommand[] = [];
	if (!newFormat && Array.isArray(raw.commands)) {
		for (const c of raw.commands) {
			if (!isRecord(c) || typeof c.name !== "string" || typeof c.command !== "string") continue;
			const entry: CodexPluginCommand = { name: c.name, command: c.command };
			if (typeof c.description === "string") entry.description = c.description;
			if (Array.isArray(c.args)) entry.args = c.args.filter((a): a is string => typeof a === "string");
			if (isRecord(c.env)) {
				const env = getStringRecord(c.env);
				if (env !== undefined) entry.env = env;
			}
			commands.push(entry);
		}
	}

	let hooks: CodexHooksSpec = {};
	if (newFormat) {
		const hooksRef = raw.hooks;
		if (typeof hooksRef === "string" || (Array.isArray(hooksRef) && hooksRef.every((h) => typeof h === "string"))) {
			const paths = (Array.isArray(hooksRef) ? hooksRef : [hooksRef]) as string[];
			for (const p of paths) {
				const hookPath = join(root, p.replace(/^\.\//, ""));
				if (existsSync(hookPath)) {
					const parsed = normalizeCodexHooks(readJsonObject(hookPath));
					for (const event of Object.keys(parsed)) {
						const groups = parsed[event as CodexEventName];
						if (groups !== undefined) {
							hooks[event as CodexEventName] = [...(hooks[event as CodexEventName] ?? []), ...groups];
						}
					}
				}
			}
			if (Object.keys(hooks).length === 0 && existsSync(join(root, "hooks", "hooks.json"))) {
				hooks = normalizeCodexHooks(readJsonObject(join(root, "hooks", "hooks.json")));
			}
		} else {
			hooks = normalizeCodexHooks(hooksRef);
		}
	} else {
		hooks = normalizeCodexHooks(raw.hooks);
	}

	if (newFormat && "apps" in raw) {
		diagnostics.push({
			field: "apps",
			message: 'codex plugin field "apps" (.app.json registered MCP connections) is not supported by Pi',
			path: manifestPath,
		});
	}

	return { name, skills, commands, mcpServers, hooks, diagnostics, root };
}

export function parseCodexInstallSpec(
	input: string,
): { type: "marketplace"; name: string; marketplace: string } | { type: "source"; source: string } {
	const trimmed = input.trim();
	const match = trimmed.match(/^([^@\s/]+)@([^@\s/]+)$/);
	if (match) return { type: "marketplace", name: match[1] ?? "", marketplace: match[2] ?? "" };
	return { type: "source", source: trimmed };
}
