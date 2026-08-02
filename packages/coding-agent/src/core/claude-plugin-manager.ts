import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CONFIG_DIR_NAME } from "../config.ts";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import { resolvePath } from "../utils/paths.ts";
import type { PathMetadata } from "./package-manager.ts";
import type {
	InstalledClaudePluginSettings,
	PluginMarketplaceSettings,
	SettingsManager,
	SettingsScope,
} from "./settings-manager.ts";

const execFileAsync = promisify(execFile);

export type PluginInstallSpec =
	| { type: "marketplace"; name: string; marketplace: string }
	| { type: "source"; source: string };

export interface MarketplacePluginEntry {
	name: string;
	source: {
		url: string;
		ref?: string;
	};
}

export interface MarketplaceCatalog {
	plugins: MarketplacePluginEntry[];
}

export interface PluginDiagnostic {
	field: string;
	message: string;
	path?: string;
}

export interface ClaudePluginManifest {
	name: string;
	skills: string[];
	commands: string[];
	mcpServers: Record<string, ClaudeMcpServer>;
	diagnostics: PluginDiagnostic[];
	root: string;
}

interface ClaudeMcpServer {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	[key: string]: unknown;
}

interface PluginManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}

interface PluginInstallOptions {
	local?: boolean;
}

export interface ConfiguredPlugin {
	name: string;
	source: string;
	marketplace?: string;
	enabled: boolean;
	ref?: string;
	scope: Exclude<SettingsScope, "global"> | "user";
	installedPath?: string;
}

export interface PluginSearchResult {
	name: string;
	marketplace: string;
	source: string;
	ref?: string;
	installed: boolean;
}

export interface PluginResourcePaths {
	skills: Array<{ path: string; metadata: PathMetadata }>;
	prompts: Array<{ path: string; metadata: PathMetadata }>;
	diagnostics: PluginDiagnostic[];
}

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
	const parsed = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(parsed)) {
		throw new Error(`Expected JSON object in ${path}`);
	}
	return parsed;
}

function collectMarkdownFiles(dir: string): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) {
		return files;
	}
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) {
			continue;
		}
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectMarkdownFiles(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(fullPath);
		}
	}
	return files;
}

function resolveEntries(root: string, entries: string[], fallbackDirs: string[]): string[] {
	const resolved: string[] = [];
	if (entries.length > 0) {
		for (const entry of entries) {
			const path = resolve(root, entry);
			if (!existsSync(path)) {
				continue;
			}
			const stats = statSync(path);
			if (stats.isDirectory() && (entry.includes("commands") || basename(dirname(path)) === "commands")) {
				resolved.push(...collectMarkdownFiles(path));
			} else {
				resolved.push(path);
			}
		}
		return resolved;
	}

	for (const dir of fallbackDirs) {
		const path = join(root, dir);
		if (existsSync(path)) {
			resolved.push(...collectMarkdownFiles(path));
		}
	}
	return resolved;
}

export function parsePluginInstallSpec(input: string): PluginInstallSpec {
	const trimmed = input.trim();
	const marketplaceMatch = trimmed.match(/^([^@\s/]+)@([^@\s/]+)$/);
	if (marketplaceMatch) {
		return {
			type: "marketplace",
			name: marketplaceMatch[1] ?? "",
			marketplace: marketplaceMatch[2] ?? "",
		};
	}
	return { type: "source", source: trimmed };
}

const DEFAULT_CLAUDE_MARKETPLACE_SOURCE = "https://github.com/anthropics/claude-plugins-official";

/**
 * Default Claude plugin marketplace (Anthropic official catalog:
 * github.com/anthropics/claude-plugins-official). Merged lazily into user-configured
 * marketplaces; a same-named user entry overrides it.
 */
export const DEFAULT_CLAUDE_MARKETPLACE: Record<string, PluginMarketplaceSettings> = {
	"claude-plugins-official": { source: DEFAULT_CLAUDE_MARKETPLACE_SOURCE },
};

export function readMarketplaceCatalog(root: string): MarketplaceCatalog {
	const path = join(root, ".claude-plugin", "marketplace.json");
	const raw = readJsonObject(path);
	const rawPlugins = Array.isArray(raw.plugins) ? raw.plugins : [];
	const plugins: MarketplacePluginEntry[] = [];
	for (const rawPlugin of rawPlugins) {
		if (!isRecord(rawPlugin) || typeof rawPlugin.name !== "string" || !isRecord(rawPlugin.source)) {
			continue;
		}
		const url = rawPlugin.source.url;
		if (typeof url !== "string") {
			continue;
		}
		const ref = rawPlugin.source.ref;
		plugins.push({
			name: rawPlugin.name,
			source: {
				url,
				...(typeof ref === "string" ? { ref } : {}),
			},
		});
	}
	return { plugins };
}

export function readClaudePluginManifest(root: string): ClaudePluginManifest {
	const path = join(root, ".claude-plugin", "plugin.json");
	const raw = readJsonObject(path);
	const manifestName = typeof raw.name === "string" ? raw.name : basename(root);
	const diagnostics: PluginDiagnostic[] = [];
	for (const field of ["hooks", "agents", "session", "sessionHooks"]) {
		if (field in raw) {
			diagnostics.push({
				field,
				message: `Claude plugin field "${field}" is not supported by Pi`,
				path,
			});
		}
	}

	const mcpServers: Record<string, ClaudeMcpServer> = {};
	if (isRecord(raw.mcpServers)) {
		for (const [name, value] of Object.entries(raw.mcpServers)) {
			if (!isRecord(value)) {
				continue;
			}
			mcpServers[name] = {
				...value,
				...(typeof value.command === "string" ? { command: value.command } : {}),
				...(Array.isArray(value.args)
					? { args: value.args.filter((arg): arg is string => typeof arg === "string") }
					: {}),
				...(value.env ? { env: getStringRecord(value.env) } : {}),
			};
		}
	}

	return {
		name: normalizePluginName(manifestName),
		skills: getStringArray(raw.skills),
		commands: getStringArray(raw.commands),
		mcpServers,
		diagnostics,
		root,
	};
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

function replaceClaudePluginRoot(value: string, root: string): string {
	return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root);
}

function convertMcpServer(server: ClaudeMcpServer, root: string): ClaudeMcpServer {
	return {
		...server,
		...(server.command ? { command: replaceClaudePluginRoot(server.command, root) } : {}),
		...(server.args ? { args: server.args.map((arg) => replaceClaudePluginRoot(arg, root)) } : {}),
		...(server.env
			? {
					env: Object.fromEntries(
						Object.entries(server.env).map(([key, value]) => [key, replaceClaudePluginRoot(value, root)]),
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

export class PluginManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;

	constructor(options: PluginManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	addMarketplace(name: string, source: string): void {
		const marketplaces = this.settingsManager.getClaudePluginMarketplaces();
		marketplaces[name] = { source };
		this.settingsManager.setClaudePluginMarketplaces(marketplaces);
	}

	removeMarketplace(name: string): boolean {
		const marketplaces = this.settingsManager.getClaudePluginMarketplaces();
		if (!marketplaces[name]) {
			return false;
		}
		delete marketplaces[name];
		this.settingsManager.setClaudePluginMarketplaces(marketplaces);
		return true;
	}

	/**
	 * Merged view of configured + default marketplaces. User-configured entries
	 * win over the built-in default when names collide.
	 */
	private getAllMarketplaces(): Record<string, PluginMarketplaceSettings> {
		return { ...DEFAULT_CLAUDE_MARKETPLACE, ...this.settingsManager.getClaudePluginMarketplaces() };
	}

	listMarketplaces(): Array<{ name: string; source: string }> {
		return Object.entries(this.getAllMarketplaces()).map(([name, value]) => ({
			name,
			source: value.source,
		}));
	}

	async searchMarketplaces(query?: string, options?: { marketplace?: string }): Promise<PluginSearchResult[]> {
		const marketplaces = this.getAllMarketplaces();
		const normalizedQuery = query?.trim().toLowerCase();
		const installedPlugins = this.listConfiguredPlugins();
		const results: PluginSearchResult[] = [];

		for (const [marketplaceName, marketplace] of Object.entries(marketplaces)) {
			if (options?.marketplace && marketplaceName !== options.marketplace) {
				continue;
			}
			const marketplaceRoot = await this.prepareMarketplaceRoot(marketplaceName, marketplace);
			const catalog = readMarketplaceCatalog(marketplaceRoot);
			for (const entry of catalog.plugins) {
				const haystack = [entry.name, entry.source.url, marketplaceName].join(" ").toLowerCase();
				if (normalizedQuery && !haystack.includes(normalizedQuery)) {
					continue;
				}
				results.push({
					name: entry.name,
					marketplace: marketplaceName,
					source: entry.source.url,
					...(entry.source.ref ? { ref: entry.source.ref } : {}),
					installed: installedPlugins.some(
						(plugin) =>
							(plugin.marketplace === marketplaceName && plugin.name === entry.name) ||
							plugin.source === entry.source.url,
					),
				});
			}
		}

		return results;
	}

	async install(spec: string, options?: PluginInstallOptions): Promise<ConfiguredPlugin> {
		const parsed = parsePluginInstallSpec(spec);
		const source =
			parsed.type === "marketplace"
				? await this.resolveMarketplaceSource(parsed.name, parsed.marketplace)
				: { url: parsed.source };
		const requestedName = parsed.type === "marketplace" ? parsed.name : undefined;
		const pluginRoot = await this.preparePluginRoot(source.url, source.ref, options, requestedName);
		const manifest = readClaudePluginManifest(pluginRoot);
		const scope = options?.local ? "project" : "global";
		this.writeMcpServers(manifest, scope);
		const storedSource = source.url;
		const settingsEntry: InstalledClaudePluginSettings = {
			name: manifest.name,
			source: storedSource,
			enabled: true,
			...(parsed.type === "marketplace" ? { marketplace: parsed.marketplace } : {}),
			...(source.ref ? { ref: source.ref } : {}),
		};
		this.upsertPluginSettings(settingsEntry, options);
		return {
			...settingsEntry,
			enabled: true,
			scope: options?.local ? "project" : "user",
			installedPath: pluginRoot,
		};
	}

	listConfiguredPlugins(): ConfiguredPlugin[] {
		const plugins: ConfiguredPlugin[] = [];
		for (const plugin of this.settingsManager.getGlobalSettings().claudePlugins ?? []) {
			plugins.push({
				...plugin,
				enabled: plugin.enabled !== false,
				scope: "user",
				installedPath: this.getInstalledPluginPath(plugin, "user"),
			});
		}
		for (const plugin of this.settingsManager.getProjectSettings().claudePlugins ?? []) {
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
			const pluginRoot = await this.preparePluginRoot(plugin.source, plugin.ref, { local }, plugin.name);
			const manifest = readClaudePluginManifest(pluginRoot);
			this.writeMcpServers(manifest, local ? "project" : "global");
			this.upsertPluginSettings(
				{
					name: manifest.name,
					source: plugin.source,
					enabled: plugin.enabled,
					...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}),
					...(plugin.ref ? { ref: plugin.ref } : {}),
				},
				{ local },
			);
		}
		if (name && !matched) {
			throw new Error(`No matching plugin found for ${name}`);
		}
	}

	remove(name: string, options?: PluginInstallOptions): boolean {
		const scope = options?.local ? "project" : "global";
		const settings =
			scope === "project"
				? (this.settingsManager.getProjectSettings().claudePlugins ?? [])
				: (this.settingsManager.getGlobalSettings().claudePlugins ?? []);
		const removedPlugins = settings.filter((plugin) => plugin.name === name || plugin.source === name);
		const next = settings.filter((plugin) => plugin.name !== name && plugin.source !== name);
		if (next.length === settings.length) {
			return false;
		}
		for (const plugin of removedPlugins) {
			this.removeMcpServers(plugin.name, scope);
		}
		if (scope === "project") {
			this.settingsManager.setProjectClaudePlugins(next);
		} else {
			this.settingsManager.setClaudePlugins(next);
		}
		const root = this.getPluginStorageRoot(options);
		const target = join(root, normalizePluginName(name));
		if (isInside(target, root)) {
			rmSync(target, { recursive: true, force: true });
		}
		return true;
	}

	resolveEnabledPluginResources(): PluginResourcePaths {
		const skills: Array<{ path: string; metadata: PathMetadata }> = [];
		const prompts: Array<{ path: string; metadata: PathMetadata }> = [];
		const diagnostics: PluginDiagnostic[] = [];
		for (const plugin of this.listConfiguredPlugins()) {
			if (!plugin.enabled || !plugin.installedPath || !existsSync(plugin.installedPath)) {
				continue;
			}
			const manifest = readClaudePluginManifest(plugin.installedPath);
			diagnostics.push(...manifest.diagnostics);
			const metadata: PathMetadata = {
				source: plugin.source,
				scope: plugin.scope,
				origin: "package",
				baseDir: plugin.installedPath,
			};
			for (const path of this.getSkillPaths(manifest)) {
				skills.push({ path, metadata });
			}
			for (const path of this.getPromptPaths(manifest)) {
				prompts.push({ path, metadata });
			}
		}
		return { skills, prompts, diagnostics };
	}

	private async resolveMarketplaceSource(
		pluginName: string,
		marketplaceName: string,
	): Promise<{ url: string; ref?: string }> {
		const marketplace = this.getAllMarketplaces()[marketplaceName];
		if (!marketplace) {
			throw new Error(`Unknown plugin marketplace: ${marketplaceName}`);
		}
		const marketplaceRoot = await this.prepareMarketplaceRoot(marketplaceName, marketplace);
		const catalog = readMarketplaceCatalog(marketplaceRoot);
		const entry = catalog.plugins.find((plugin) => plugin.name === pluginName);
		if (!entry) {
			throw new Error(`Plugin ${pluginName} was not found in marketplace ${marketplaceName}`);
		}
		return entry.source;
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
		const target = join(this.agentDir, "plugin-marketplaces", normalizePluginName(name));
		await this.cloneOrUpdate(parsed, target);
		return target;
	}

	private async preparePluginRoot(
		source: string,
		ref: string | undefined,
		options: PluginInstallOptions | undefined,
		requestedName: string | undefined,
	): Promise<string> {
		const resolvedLocal = resolvePath(source, this.cwd, { trim: true });
		const shouldCloneLocalGit = existsSync(join(resolvedLocal, ".git")) && ref;
		const parsedGit = parseGitUrl(source);
		const parsed =
			parsedGit ??
			(shouldCloneLocalGit
				? ({
						type: "git",
						repo: resolvedLocal,
						host: "local",
						path: normalizePluginName(requestedName ?? basename(resolvedLocal)),
						ref,
						pinned: Boolean(ref),
					} satisfies GitSource)
				: null);
		if (!parsed && existsSync(resolvedLocal)) {
			return resolvedLocal;
		}
		if (!parsed) {
			throw new Error(`Unsupported plugin source: ${source}`);
		}
		const provisionalName = normalizePluginName(requestedName ?? basename(parsed.path));
		const provisionalTarget = join(this.getPluginStorageRoot(options), provisionalName);
		await this.cloneOrUpdate({ ...parsed, ...(ref ? { ref, pinned: true } : {}) }, provisionalTarget);
		const manifest = readClaudePluginManifest(provisionalTarget);
		const finalTarget = join(this.getPluginStorageRoot(options), manifest.name);
		if (finalTarget !== provisionalTarget) {
			rmSync(finalTarget, { recursive: true, force: true });
			renameSync(provisionalTarget, finalTarget);
		}
		return finalTarget;
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

	private upsertPluginSettings(entry: InstalledClaudePluginSettings, options?: PluginInstallOptions): void {
		const current = options?.local
			? (this.settingsManager.getProjectSettings().claudePlugins ?? [])
			: (this.settingsManager.getGlobalSettings().claudePlugins ?? []);
		const next = current.filter((plugin) => plugin.name !== entry.name && plugin.source !== entry.source);
		next.push(entry);
		if (options?.local) {
			this.settingsManager.setProjectClaudePlugins(next);
		} else {
			this.settingsManager.setClaudePlugins(next);
		}
	}

	private writeMcpServers(manifest: ClaudePluginManifest, scope: SettingsScope): void {
		if (Object.keys(manifest.mcpServers).length === 0) {
			return;
		}
		const path = scope === "project" ? join(this.cwd, CONFIG_DIR_NAME, "mcp.json") : join(this.agentDir, "mcp.json");
		const raw = readRawConfigObject(path);
		const servers = getServersObject(raw);
		for (const [serverName, server] of Object.entries(manifest.mcpServers)) {
			servers[`${manifest.name}-${serverName}`] = convertMcpServer(server, manifest.root);
		}
		raw.mcpServers = servers;
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

	private getPluginStorageRoot(options?: PluginInstallOptions): string {
		return options?.local ? join(this.cwd, CONFIG_DIR_NAME, "plugins") : join(this.agentDir, "plugins");
	}

	private getInstalledPluginPath(
		plugin: InstalledClaudePluginSettings,
		scope: "user" | "project",
	): string | undefined {
		const storageRoot =
			scope === "project" ? join(this.cwd, CONFIG_DIR_NAME, "plugins") : join(this.agentDir, "plugins");
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

	private getSkillPaths(manifest: ClaudePluginManifest): string[] {
		if (manifest.skills.length > 0) {
			return manifest.skills.map((entry) => resolve(manifest.root, entry)).filter((path) => existsSync(path));
		}
		const convention = join(manifest.root, "skills");
		return existsSync(convention) ? [convention] : [];
	}

	private getPromptPaths(manifest: ClaudePluginManifest): string[] {
		return resolveEntries(manifest.root, manifest.commands, ["commands", join(".claude", "commands")]);
	}
}
