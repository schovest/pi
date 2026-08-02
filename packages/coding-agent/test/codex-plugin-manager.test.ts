import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CodexPluginManager,
	DEFAULT_CODEX_MARKETPLACE,
	normalizeCodexHookEventName,
	readCodexMarketplaceCatalog,
	readCodexPluginManifest,
} from "../src/core/codex-plugin-manager.ts";
import { type PluginMarketplaceSettings, SettingsManager } from "../src/core/settings-manager.ts";
import type { GitSource } from "../src/utils/git.ts";

const execFileAsync = promisify(execFile);

function initGitRepo(root: string): string {
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
}

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
					{
						name: "b",
						source: { source: "git-subdir", url: "https://github.com/x/y.git", path: "./plugins/b", ref: "main" },
					},
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

	it("falls back to .agents/plugins/marketplace.json (openai/plugins layout)", () => {
		mkdirSync(join(tempDir, ".agents", "plugins"), { recursive: true });
		writeFileSync(
			join(tempDir, ".agents", "plugins", "marketplace.json"),
			JSON.stringify({ name: "openai-curated", plugins: [{ name: "sp", source: "./plugins/sp" }] }),
		);
		const catalog = readCodexMarketplaceCatalog(tempDir);
		expect(catalog.name).toBe("openai-curated");
		expect(catalog.plugins).toEqual([{ name: "sp", source: { kind: "local", path: "./plugins/sp" } }]);
	});

	it("throws when no catalog file exists", () => {
		expect(() => readCodexMarketplaceCatalog(tempDir)).toThrow(/No marketplace\.json found/);
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
						{
							matcher: "startup",
							// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${PLUGIN_ROOT} placeholder, kept unreplaced by the parser
							hooks: [{ type: "command", command: "python3 ${PLUGIN_ROOT}/hooks/s.py", timeout: 5 }],
						},
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
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${PLUGIN_ROOT} placeholder, kept unreplaced by the parser
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
		expect(manifest.commands[0]).toEqual({
			name: "review",
			description: "Review",
			command: "python3",
			args: ["cmd/review.py"],
		});
	});

	it("reports apps field as unsupported diagnostic", () => {
		mkdirSync(join(tempDir, ".codex-plugin"), { recursive: true });
		writeFileSync(join(tempDir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "p", apps: "./.app.json" }));
		const manifest = readCodexPluginManifest(tempDir);
		expect(manifest.diagnostics.some((d) => d.field === "apps")).toBe(true);
	});

	it("falls back to default hooks/hooks.json when manifest omits the hooks field", () => {
		mkdirSync(join(tempDir, ".codex-plugin"), { recursive: true });
		mkdirSync(join(tempDir, "hooks"), { recursive: true });
		writeFileSync(join(tempDir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "p", skills: "./skills/" }));
		writeFileSync(
			join(tempDir, "hooks", "hooks.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							matcher: "startup",
							hooks: [{ type: "command", command: "echo default-hook" }],
						},
					],
				},
			}),
		);
		const manifest = readCodexPluginManifest(tempDir);
		expect(manifest.hooks.session_start).toEqual([
			{
				matcher: "startup",
				handlers: [{ type: "command", command: "echo default-hook" }],
			},
		]);
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

function writeCodexPlugin(root: string, name: string, options?: { hooks?: boolean; mcp?: boolean }): void {
	mkdirSync(join(root, ".codex-plugin"), { recursive: true });
	mkdirSync(join(root, "skills", "helper"), { recursive: true });
	writeFileSync(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name, skills: "./skills/" }));
	writeFileSync(join(root, "skills", "helper", "SKILL.md"), `---\nname: helper\ndescription: Helper skill\n---\nBody`);
	if (options?.hooks) {
		mkdirSync(join(root, "hooks"), { recursive: true });
		writeFileSync(
			join(root, ".codex-plugin", "plugin.json"),
			JSON.stringify({ name, skills: "./skills/", hooks: "./hooks/hooks.json" }),
		);
		writeFileSync(
			join(root, "hooks", "hooks.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							// biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${PLUGIN_ROOT} placeholder, materialized at install
							hooks: [{ type: "command", command: "echo '${PLUGIN_ROOT}'" }],
						},
					],
				},
			}),
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
		const mcpRaw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8")) as {
			mcpServers: Record<string, unknown>;
		};
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
		const mcpRaw = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(mcpRaw.mcpServers["gone-docs"]).toBeUndefined();
		expect(sm.getCodexPlugins()).toHaveLength(0);
	});

	it("installs an npm plugin from a local tarball, materializing hooks into the storage copy", async () => {
		const pluginSrc = join(tempDir, "npm-plugin-src");
		writeCodexPlugin(pluginSrc, "npm-demo", { hooks: true });
		writeFileSync(join(pluginSrc, "package.json"), JSON.stringify({ name: "npm-demo", version: "1.0.0" }));

		const tarballDir = join(tempDir, "tarball");
		mkdirSync(tarballDir, { recursive: true });
		await execFileAsync("npm", ["pack", pluginSrc, "--pack-destination", tarballDir, "--ignore-scripts"], {
			cwd: tempDir,
		});
		const tarball = join(tarballDir, "npm-demo-1.0.0.tgz");
		expect(existsSync(tarball)).toBe(true);

		const marketplaceDir = join(tempDir, "npm-marketplace");
		mkdirSync(marketplaceDir, { recursive: true });
		writeFileSync(
			join(marketplaceDir, "marketplace.json"),
			JSON.stringify({
				name: "npm-mkt",
				plugins: [{ name: "npm-demo", source: { source: "npm", package: tarball } }],
			}),
		);
		manager.addMarketplace("npm-mkt", marketplaceDir);

		const installed = await manager.install("npm-demo@npm-mkt");
		expect(installed.name).toBe("npm-demo");
		expect(installed.installedPath).toBeDefined();
		expect(installed.installedPath).not.toBe(pluginSrc);
		expect(existsSync(join(installed.installedPath!, ".codex-plugin", "plugin.json"))).toBe(true);
		const stored = sm.getCodexPlugins()[0];
		expect(stored?.hooks?.pre_tool_use?.[0]?.handlers[0]?.command).toBe(`echo '${installed.installedPath}'`);
	});

	it("persists git-subdir path in settings and restores it on update", async () => {
		const pluginRepo = join(tempDir, "git-repo");
		const subdir = join(pluginRepo, "plugins", "demo");
		mkdirSync(subdir, { recursive: true });
		writeCodexPlugin(subdir, "git-demo", { hooks: true });
		writeFileSync(join(pluginRepo, "package.json"), JSON.stringify({ name: "git-repo", version: "0.0.0" }));
		initGitRepo(pluginRepo);

		const marketplaceDir = join(tempDir, "git-marketplace");
		mkdirSync(marketplaceDir, { recursive: true });
		writeFileSync(
			join(marketplaceDir, "marketplace.json"),
			JSON.stringify({
				name: "git-mkt",
				plugins: [
					{
						name: "git-demo",
						source: {
							source: "git-subdir",
							url: "https://example.invalid/user/git-demo.git",
							path: "./plugins/demo",
						},
					},
				],
			}),
		);
		manager.addMarketplace("git-mkt", marketplaceDir);

		// CodexPluginManager clones via network; spy on the private cloneOrUpdate to
		// clone the local fixture repo instead, keeping the subdir/materialize flow real.
		const cloneSpy = vi.spyOn(
			manager as unknown as { cloneOrUpdate(source: GitSource, target: string): Promise<void> },
			"cloneOrUpdate",
		);
		cloneSpy.mockImplementation(async (_source, target) => {
			await execFileAsync("git", ["clone", pluginRepo, target]);
		});

		const installed = await manager.install("git-demo@git-mkt");
		expect(installed.name).toBe("git-demo");
		const stored = sm.getCodexPlugins()[0];
		expect(stored?.path).toBe("./plugins/demo");

		await manager.update("git-demo");
		const after = sm.getCodexPlugins()[0];
		expect(after?.path).toBe("./plugins/demo");
		expect(cloneSpy).toHaveBeenCalledTimes(2);
	});

	it("lists the built-in openai default marketplace when none are configured", () => {
		expect(DEFAULT_CODEX_MARKETPLACE.openai).toEqual({ source: "https://github.com/openai/plugins" });
		expect(manager.listMarketplaces()).toEqual([
			{ name: "openai", source: DEFAULT_CODEX_MARKETPLACE.openai!.source },
		]);
	});

	it("merges user-configured marketplaces with the default, user wins on name collision", async () => {
		const marketplaceDir = join(tempDir, "mkt");
		mkdirSync(marketplaceDir, { recursive: true });
		writeFileSync(
			join(marketplaceDir, "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "p1", source: { source: "local", path: "./plugins/p1" } }] }),
		);

		manager.addMarketplace("openai", marketplaceDir); // override the default source
		manager.addMarketplace("team", marketplaceDir);

		const listed = manager.listMarketplaces();
		expect(listed).toHaveLength(2);
		expect(listed.find((m) => m.name === "openai")?.source).toBe(marketplaceDir);

		const results = await manager.searchMarketplaces();
		expect(
			results
				.filter((r) => r.name === "p1")
				.map((r) => r.marketplace)
				.sort(),
		).toEqual(["openai", "team"]);
	});

	it("searches the built-in openai marketplace without explicit configuration", async () => {
		const marketplaceDir = join(tempDir, "openai-mkt");
		mkdirSync(marketplaceDir, { recursive: true });
		writeFileSync(
			join(marketplaceDir, "marketplace.json"),
			JSON.stringify({ name: "openai-curated", plugins: [{ name: "demo", source: "./plugins/demo" }] }),
		);
		// The default source is a git URL; stub the clone step to read a local fixture catalog.
		const rootSpy = vi.spyOn(
			manager as unknown as {
				prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
			},
			"prepareMarketplaceRoot",
		);
		rootSpy.mockResolvedValue(marketplaceDir);

		const results = await manager.searchMarketplaces("demo");
		expect(results).toEqual([expect.objectContaining({ name: "demo", marketplace: "openai", installed: false })]);
	});

	it("installs from the built-in openai marketplace without explicit configuration", async () => {
		const pluginRoot = join(tempDir, "plugin-src");
		writeCodexPlugin(pluginRoot, "demo");
		const marketplaceDir = join(tempDir, "openai-mkt");
		mkdirSync(marketplaceDir, { recursive: true });
		writeFileSync(
			join(marketplaceDir, "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "demo", source: { source: "local", path: pluginRoot } }] }),
		);
		const rootSpy = vi.spyOn(
			manager as unknown as {
				prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
			},
			"prepareMarketplaceRoot",
		);
		rootSpy.mockResolvedValue(marketplaceDir);

		const installed = await manager.install("demo@openai");
		expect(installed.name).toBe("demo");
		expect(installed.marketplace).toBe("openai");
		expect(installed.installedPath).toBe(pluginRoot);
	});
});
