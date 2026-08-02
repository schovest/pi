import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME } from "../config.ts";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import { resolvePath } from "../utils/paths.ts";
import type { PluginDiagnostic } from "./claude-plugin-manager.ts";
import type { PathMetadata } from "./package-manager.ts";
import type {
	CodexEventName,
	CodexHookGroupSpec,
	CodexHookHandlerSpec,
	CodexHooksSpec,
	CodexPluginCommandSpec,
	InstalledCodexPluginSettings,
	PluginMarketplaceSettings,
	SettingsManager,
	SettingsScope,
} from "./settings-manager.ts";

const execFileAsync = promisify(execFile);

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

interface CodexPluginManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}

function readRawConfigObject(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) {
		return {};
	}
	try {
		return readJsonObject(filePath);
	} catch {
		return {};
	}
}

function writeRawConfigObject(filePath: string, raw: Record<string, unknown>): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}

function getServersObject(raw: Record<string, unknown>): Record<string, unknown> {
	const servers = raw.mcpServers;
	return isRecord(servers) ? servers : {};
}

function replacePluginRootVars(value: string, root: string): string {
	return value.replace(/\$\{PLUGIN_ROOT\}/g, root).replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root);
}

function replaceCodexVars(value: string, root: string, dataDir: string): string {
	return replacePluginRootVars(value, root)
		.replace(/\$\{PLUGIN_DATA\}/g, dataDir)
		.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir);
}

function materializeHooks(hooks: CodexHooksSpec, pluginRoot: string, dataDir: string): CodexHooksSpec {
	const result: CodexHooksSpec = {};
	for (const [event, groups] of Object.entries(hooks)) {
		if (groups === undefined) {
			continue;
		}
		result[event as CodexEventName] = groups.map((group) => ({
			...(group.matcher ? { matcher: group.matcher } : {}),
			handlers: group.handlers.map((handler) => ({
				...handler,
				command: replaceCodexVars(handler.command, pluginRoot, dataDir),
				...(handler.args !== undefined
					? { args: handler.args.map((arg) => replaceCodexVars(arg, pluginRoot, dataDir)) }
					: {}),
			})),
		}));
	}
	return result;
}

function materializeCommands(commands: CodexPluginCommand[], pluginRoot: string): CodexPluginCommandSpec[] {
	return commands.map((command) => {
		const entry: CodexPluginCommandSpec = {
			name: command.name,
			command: replacePluginRootVars(command.command, pluginRoot),
		};
		if (command.description !== undefined) {
			entry.description = command.description;
		}
		if (command.args !== undefined) {
			entry.args = command.args.map((arg) => replacePluginRootVars(arg, pluginRoot));
		}
		if (command.env !== undefined) {
			entry.env = Object.fromEntries(
				Object.entries(command.env).map(([key, value]) => [key, replacePluginRootVars(value, pluginRoot)]),
			);
		}
		return entry;
	});
}

function convertCodexMcpServer(server: CodexMcpServer, root: string): CodexMcpServer {
	return {
		...server,
		...(server.command ? { command: replacePluginRootVars(server.command, root) } : {}),
		...(server.args ? { args: server.args.map((arg) => replacePluginRootVars(arg, root)) } : {}),
		...(server.env
			? {
					env: Object.fromEntries(
						Object.entries(server.env).map(([key, value]) => [key, replacePluginRootVars(value, root)]),
					),
				}
			: {}),
	};
}

function isInside(target: string, root: string): boolean {
	const resolvedTarget = resolve(target);
	const resolvedRoot = resolve(root);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

/**
 * Manage Codex-compatible plugins: marketplace aliases, installation (local/git/npm),
 * hooks/commands materialization, MCP server registration and skill path resolution.
 */
export class CodexPluginManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;

	constructor(options: CodexPluginManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	addMarketplace(name: string, source: string): void {
		const marketplaces = this.settingsManager.getCodexPluginMarketplaces();
		marketplaces[name] = { source };
		this.settingsManager.setCodexPluginMarketplaces(marketplaces);
	}

	removeMarketplace(name: string): boolean {
		const marketplaces = this.settingsManager.getCodexPluginMarketplaces();
		if (!marketplaces[name]) {
			return false;
		}
		delete marketplaces[name];
		this.settingsManager.setCodexPluginMarketplaces(marketplaces);
		return true;
	}

	listMarketplaces(): Array<{ name: string; source: string }> {
		return Object.entries(this.settingsManager.getCodexPluginMarketplaces()).map(([name, value]) => ({
			name,
			source: value.source,
		}));
	}

	async searchMarketplaces(query?: string, options?: { marketplace?: string }): Promise<CodexPluginSearchResult[]> {
		const marketplaces = this.settingsManager.getCodexPluginMarketplaces();
		const normalizedQuery = query?.trim().toLowerCase();
		const installedPlugins = this.listConfiguredPlugins();
		const results: CodexPluginSearchResult[] = [];

		for (const [marketplaceName, marketplace] of Object.entries(marketplaces)) {
			if (options?.marketplace && marketplaceName !== options.marketplace) {
				continue;
			}
			const marketplaceRoot = await this.prepareMarketplaceRoot(marketplaceName, marketplace);
			const catalog = readCodexMarketplaceCatalog(marketplaceRoot);
			for (const entry of catalog.plugins) {
				const sourceDescription = this.describeSource(entry.source, marketplaceRoot);
				const haystack = [entry.name, sourceDescription, marketplaceName].join(" ").toLowerCase();
				if (normalizedQuery && !haystack.includes(normalizedQuery)) {
					continue;
				}
				results.push({
					name: entry.name,
					marketplace: marketplaceName,
					source: sourceDescription,
					installed: installedPlugins.some(
						(plugin) =>
							(plugin.marketplace === marketplaceName && plugin.name === entry.name) ||
							plugin.source === sourceDescription,
					),
				});
			}
		}

		return results;
	}

	async install(spec: string, options?: { local?: boolean }): Promise<ConfiguredCodexPlugin> {
		const parsed = parseCodexInstallSpec(spec);
		let source: CodexPluginSource;
		let marketplaceRoot: string | undefined;
		if (parsed.type === "marketplace") {
			const resolved = await this.resolveMarketplaceSource(parsed.name, parsed.marketplace);
			source = resolved.source;
			marketplaceRoot = resolved.marketplaceRoot;
		} else {
			source = this.parseBareSource(parsed.source);
		}
		const requestedName = parsed.type === "marketplace" ? parsed.name : undefined;
		const scope: SettingsScope = options?.local ? "project" : "global";
		const pluginRoot = await this.preparePluginRoot(source, scope, requestedName, marketplaceRoot);
		const manifest = readCodexPluginManifest(pluginRoot);
		const dataDir = join(this.agentDir, "codex-plugin-data", manifest.name);
		const settingsEntry: InstalledCodexPluginSettings = {
			name: manifest.name,
			source: this.describeSource(source, marketplaceRoot),
			enabled: true,
			...(parsed.type === "marketplace" ? { marketplace: parsed.marketplace } : {}),
			...(source.kind === "git" && source.ref ? { ref: source.ref } : {}),
			hooks: materializeHooks(manifest.hooks, pluginRoot, dataDir),
			commands: materializeCommands(manifest.commands, pluginRoot),
		};
		this.writeMcpServers(manifest, scope);
		this.upsertCodexPluginSettings(settingsEntry, options);
		return {
			...settingsEntry,
			enabled: true,
			scope: options?.local ? "project" : "user",
			installedPath: pluginRoot,
		};
	}

	listConfiguredPlugins(): ConfiguredCodexPlugin[] {
		const plugins: ConfiguredCodexPlugin[] = [];
		for (const plugin of this.settingsManager.getCodexPlugins()) {
			plugins.push({
				...plugin,
				enabled: plugin.enabled !== false,
				scope: "user",
				installedPath: this.getInstalledPluginPath(plugin, "user"),
			});
		}
		for (const plugin of this.settingsManager.getProjectCodexPlugins()) {
			plugins.push({
				...plugin,
				enabled: plugin.enabled !== false,
				scope: "project",
				installedPath: this.getInstalledPluginPath(plugin, "project"),
			});
		}
		return plugins;
	}

	async update(name?: string): Promise<void> {
		let matched = false;
		for (const plugin of this.listConfiguredPlugins()) {
			if (name && plugin.name !== name) {
				continue;
			}
			matched = true;
			const local = plugin.scope === "project";
			const scope: SettingsScope = local ? "project" : "global";
			const pluginRoot = await this.preparePluginRoot(
				this.parseConfiguredSource(plugin),
				scope,
				plugin.name,
				undefined,
			);
			const manifest = readCodexPluginManifest(pluginRoot);
			const dataDir = join(this.agentDir, "codex-plugin-data", manifest.name);
			const settingsEntry: InstalledCodexPluginSettings = {
				name: manifest.name,
				source: plugin.source,
				enabled: plugin.enabled,
				...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}),
				...(plugin.ref ? { ref: plugin.ref } : {}),
				hooks: materializeHooks(manifest.hooks, pluginRoot, dataDir),
				commands: materializeCommands(manifest.commands, pluginRoot),
			};
			this.writeMcpServers(manifest, scope);
			this.upsertCodexPluginSettings(settingsEntry, { local });
		}
		if (name && !matched) {
			throw new Error(`No matching plugin found for ${name}`);
		}
	}

	remove(name: string, options?: { local?: boolean }): boolean {
		const scope: SettingsScope = options?.local ? "project" : "global";
		const settings =
			scope === "project" ? this.settingsManager.getProjectCodexPlugins() : this.settingsManager.getCodexPlugins();
		const removedPlugins = settings.filter((plugin) => plugin.name === name || plugin.source === name);
		const next = settings.filter((plugin) => plugin.name !== name && plugin.source !== name);
		if (next.length === settings.length) {
			return false;
		}
		for (const plugin of removedPlugins) {
			this.removeMcpServers(plugin.name, scope);
		}
		if (scope === "project") {
			this.settingsManager.setProjectCodexPlugins(next);
		} else {
			this.settingsManager.setCodexPlugins(next);
		}
		const root = this.getPluginStorageRoot(scope);
		const target = join(root, normalizePluginName(name));
		if (isInside(target, root)) {
			rmSync(target, { recursive: true, force: true });
		}
		return true;
	}

	resolveEnabledPluginResources(): CodexPluginResources {
		const skills: Array<{ path: string; metadata: PathMetadata }> = [];
		const diagnostics: PluginDiagnostic[] = [];
		for (const plugin of this.listConfiguredPlugins()) {
			if (!plugin.enabled || !plugin.installedPath || !existsSync(plugin.installedPath)) {
				continue;
			}
			const manifest = readCodexPluginManifest(plugin.installedPath);
			diagnostics.push(...manifest.diagnostics);
			const metadata: PathMetadata = {
				source: plugin.source,
				scope: plugin.scope,
				origin: "codex-plugin",
				baseDir: plugin.installedPath,
			};
			for (const path of this.getSkillPaths(manifest)) {
				skills.push({ path, metadata });
			}
		}
		return { skills, diagnostics };
	}

	private async resolveMarketplaceSource(
		pluginName: string,
		marketplaceName: string,
	): Promise<{ source: CodexPluginSource; marketplaceRoot: string }> {
		const marketplace = this.settingsManager.getCodexPluginMarketplaces()[marketplaceName];
		if (!marketplace) {
			throw new Error(`Unknown plugin marketplace: ${marketplaceName}`);
		}
		const marketplaceRoot = await this.prepareMarketplaceRoot(marketplaceName, marketplace);
		const catalog = readCodexMarketplaceCatalog(marketplaceRoot);
		const entry = catalog.plugins.find((plugin) => plugin.name === pluginName);
		if (!entry) {
			throw new Error(`Plugin ${pluginName} was not found in marketplace ${marketplaceName}`);
		}
		return { source: entry.source, marketplaceRoot };
	}

	private async prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string> {
		const source = marketplace.source;
		if (existsSync(resolvePath(source, this.cwd, { trim: true }))) {
			return resolvePath(source, this.cwd, { trim: true });
		}
		const parsed = parseGitUrl(source);
		if (!parsed) {
			throw new Error(`Unsupported marketplace source: ${source}`);
		}
		const target = join(this.agentDir, "codex-plugin-marketplaces", normalizePluginName(name));
		await this.cloneOrUpdate(parsed, target);
		return target;
	}

	private async preparePluginRoot(
		source: CodexPluginSource,
		scope: SettingsScope,
		requestedName: string | undefined,
		marketplaceRoot: string | undefined,
	): Promise<string> {
		if (source.kind === "local") {
			const resolved = resolvePath(source.path, this.cwd, { trim: true });
			if (existsSync(resolved)) {
				return resolved;
			}
			if (marketplaceRoot && existsSync(resolvePath(source.path, marketplaceRoot, { trim: true }))) {
				return resolvePath(source.path, marketplaceRoot, { trim: true });
			}
			throw new Error(`Local codex plugin path does not exist: ${source.path}`);
		}
		if (source.kind === "git") {
			return await this.prepareGitPlugin(source, scope, requestedName);
		}
		return await this.prepareNpmPlugin(source, scope);
	}

	private async prepareGitPlugin(
		source: { kind: "git"; url: string; path?: string; ref?: string },
		scope: SettingsScope,
		requestedName: string | undefined,
	): Promise<string> {
		const parsed = parseGitUrl(source.url);
		if (!parsed) {
			throw new Error(`Unsupported codex plugin git source: ${source.url}`);
		}
		const gitSource: GitSource = {
			...parsed,
			...(source.ref ? { ref: source.ref, pinned: true } : {}),
		};
		if (source.path) {
			const subdir = source.path.replace(/^\.\//, "").replace(/\/+$/, "");
			const tempDir = this.getTemporaryDir("codex-plugin-git");
			try {
				const cloneTarget = join(tempDir, "repo");
				await this.cloneOrUpdate(gitSource, cloneTarget);
				const subdirRoot = join(cloneTarget, subdir);
				if (!existsSync(subdirRoot)) {
					throw new Error(`Plugin subdirectory ${source.path} not found in ${source.url}`);
				}
				const manifest = readCodexPluginManifest(subdirRoot);
				const target = join(this.getPluginStorageRoot(scope), manifest.name);
				await this.copyTree(subdirRoot, target);
				return target;
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
		const provisionalName = normalizePluginName(requestedName ?? basename(parsed.path));
		const provisionalTarget = join(this.getPluginStorageRoot(scope), provisionalName);
		await this.cloneOrUpdate(gitSource, provisionalTarget);
		const manifest = readCodexPluginManifest(provisionalTarget);
		const finalTarget = join(this.getPluginStorageRoot(scope), manifest.name);
		if (finalTarget !== provisionalTarget) {
			rmSync(finalTarget, { recursive: true, force: true });
			renameSync(provisionalTarget, finalTarget);
		}
		return finalTarget;
	}

	private async prepareNpmPlugin(
		source: { kind: "npm"; package: string; version?: string; registry?: string },
		scope: SettingsScope,
	): Promise<string> {
		const tempDir = this.getTemporaryDir("codex-plugin-npm");
		try {
			const spec = source.version ? `${source.package}@${source.version}` : source.package;
			const packArgs = ["pack", spec];
			if (source.registry) {
				packArgs.push("--registry", source.registry);
			}
			await execFileAsync("npm", packArgs, { cwd: tempDir });
			const tarball = readdirSync(tempDir).find((entry) => entry.endsWith(".tgz"));
			if (tarball === undefined) {
				throw new Error(`npm pack produced no tarball for ${spec}`);
			}
			await execFileAsync("tar", ["-xzf", tarball, "-C", tempDir]);
			const extracted = join(tempDir, "package");
			const pluginRoot = existsSync(extracted) ? extracted : tempDir;
			const manifest = readCodexPluginManifest(pluginRoot);
			const target = join(this.getPluginStorageRoot(scope), manifest.name);
			await this.copyTree(pluginRoot, target);
			return target;
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	private async copyTree(src: string, dest: string): Promise<void> {
		if (existsSync(dest)) {
			rmSync(dest, { recursive: true, force: true });
		}
		mkdirSync(dirname(dest), { recursive: true });
		await execFileAsync("cp", ["-R", src, dest]);
	}

	private async cloneOrUpdate(source: GitSource, target: string): Promise<void> {
		if (!existsSync(target)) {
			mkdirSync(dirname(target), { recursive: true });
			await execFileAsync("git", ["clone", source.repo, target]);
		} else {
			await execFileAsync("git", ["fetch", "origin"], { cwd: target });
		}
		if (source.ref) {
			await execFileAsync("git", ["checkout", source.ref], { cwd: target });
		}
	}

	private getTemporaryDir(prefix: string): string {
		const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	private describeSource(source: CodexPluginSource, marketplaceRoot?: string): string {
		if (source.kind === "local") {
			const resolved = resolvePath(source.path, this.cwd, { trim: true });
			if (existsSync(resolved)) {
				return resolved;
			}
			if (marketplaceRoot && existsSync(resolvePath(source.path, marketplaceRoot, { trim: true }))) {
				return resolvePath(source.path, marketplaceRoot, { trim: true });
			}
			return resolved;
		}
		return source.kind === "git" ? source.url : source.package;
	}

	private parseBareSource(source: string): CodexPluginSource {
		const parsedGit = parseGitUrl(source);
		if (parsedGit) {
			return { kind: "git", url: parsedGit.repo, ref: parsedGit.ref ?? undefined };
		}
		if (existsSync(resolvePath(source, this.cwd, { trim: true }))) {
			return { kind: "local", path: source };
		}
		throw new Error(`Unsupported codex plugin source: ${source}`);
	}

	private parseConfiguredSource(plugin: ConfiguredCodexPlugin): CodexPluginSource {
		const parsedGit = parseGitUrl(plugin.source);
		if (parsedGit) {
			return { kind: "git", url: parsedGit.repo, ref: plugin.ref ?? parsedGit.ref ?? undefined };
		}
		if (existsSync(resolvePath(plugin.source, this.cwd, { trim: true }))) {
			return { kind: "local", path: plugin.source };
		}
		return { kind: "npm", package: plugin.source };
	}

	private upsertCodexPluginSettings(entry: InstalledCodexPluginSettings, options?: { local?: boolean }): void {
		const current = options?.local
			? this.settingsManager.getProjectCodexPlugins()
			: this.settingsManager.getCodexPlugins();
		const next = current.filter((plugin) => plugin.name !== entry.name && plugin.source !== entry.source);
		next.push(entry);
		if (options?.local) {
			this.settingsManager.setProjectCodexPlugins(next);
		} else {
			this.settingsManager.setCodexPlugins(next);
		}
	}

	private writeMcpServers(manifest: CodexPluginManifest, scope: SettingsScope): void {
		const servers = this.getEffectiveMcpServers(manifest);
		if (Object.keys(servers).length === 0) {
			return;
		}
		const path = scope === "project" ? join(this.cwd, CONFIG_DIR_NAME, "mcp.json") : join(this.agentDir, "mcp.json");
		const raw = readRawConfigObject(path);
		const existing = getServersObject(raw);
		for (const [serverName, server] of Object.entries(servers)) {
			existing[`${manifest.name}-${serverName}`] = convertCodexMcpServer(server, manifest.root);
		}
		raw.mcpServers = existing;
		writeRawConfigObject(path, raw);
	}

	private removeMcpServers(pluginName: string, scope: SettingsScope): void {
		const path = scope === "project" ? join(this.cwd, CONFIG_DIR_NAME, "mcp.json") : join(this.agentDir, "mcp.json");
		if (!existsSync(path)) {
			return;
		}
		const raw = readRawConfigObject(path);
		const servers = getServersObject(raw);
		const prefix = `${pluginName}-`;
		let changed = false;
		for (const serverName of Object.keys(servers)) {
			if (serverName.startsWith(prefix)) {
				delete servers[serverName];
				changed = true;
			}
		}
		if (!changed) {
			return;
		}
		raw.mcpServers = servers;
		writeRawConfigObject(path, raw);
	}

	private getEffectiveMcpServers(manifest: CodexPluginManifest): Record<string, CodexMcpServer> {
		if (Object.keys(manifest.mcpServers).length > 0) {
			return manifest.mcpServers;
		}
		const mcpPath = join(manifest.root, ".mcp.json");
		if (!existsSync(mcpPath)) {
			return {};
		}
		const mcpRaw = readJsonObject(mcpPath);
		const servers = isRecord(mcpRaw.mcp_servers) ? mcpRaw.mcp_servers : mcpRaw;
		const result: Record<string, CodexMcpServer> = {};
		for (const [serverName, value] of Object.entries(servers)) {
			if (isRecord(value)) {
				result[serverName] = value as CodexMcpServer;
			}
		}
		return result;
	}

	private getPluginStorageRoot(scope: SettingsScope): string {
		return scope === "project"
			? join(this.cwd, CONFIG_DIR_NAME, "codex-plugins")
			: join(this.agentDir, "codex-plugins");
	}

	private getInstalledPluginPath(plugin: InstalledCodexPluginSettings, scope: "user" | "project"): string | undefined {
		const storageRoot =
			scope === "project" ? join(this.cwd, CONFIG_DIR_NAME, "codex-plugins") : join(this.agentDir, "codex-plugins");
		const stored = join(storageRoot, plugin.name);
		if (existsSync(stored)) {
			return stored;
		}
		const resolvedSource = resolvePath(
			plugin.source,
			scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir,
			{
				trim: true,
			},
		);
		return existsSync(resolvedSource) ? resolvedSource : undefined;
	}

	private getSkillPaths(manifest: CodexPluginManifest): string[] {
		if (manifest.skills.length > 0) {
			return manifest.skills.filter((path) => existsSync(path));
		}
		const convention = join(manifest.root, "skills");
		return existsSync(convention) ? [convention] : [];
	}
}
