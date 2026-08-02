import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_CLAUDE_MARKETPLACE,
	PluginManager,
	parsePluginInstallSpec,
	readClaudePluginManifest,
	readMarketplaceCatalog,
} from "../src/core/claude-plugin-manager.ts";
import { type PluginMarketplaceSettings, SettingsManager } from "../src/core/settings-manager.ts";

function writePlugin(root: string, options?: { mcp?: boolean; unsupported?: boolean }): void {
	const claudePluginRoot = "${" + "CLAUDE_PLUGIN_ROOT}";
	mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	mkdirSync(join(root, "skills", "planner"), { recursive: true });
	mkdirSync(join(root, "commands"), { recursive: true });
	writeFileSync(
		join(root, ".claude-plugin", "plugin.json"),
		JSON.stringify(
			{
				name: "superpowers-chrome",
				skills: ["skills/planner"],
				commands: ["commands/review.md"],
				...(options?.mcp
					? {
							mcpServers: {
								chrome: {
									command: `${claudePluginRoot}/bin/chrome-mcp`,
									args: ["--root", claudePluginRoot, "$UNTOUCHED"],
								},
							},
						}
					: {}),
				...(options?.unsupported ? { hooks: {}, agents: [{ name: "worker" }] } : {}),
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(root, "skills", "planner", "SKILL.md"),
		`---
name: planner
description: Planning support
---
Skill body`,
	);
	writeFileSync(join(root, "commands", "review.md"), "Review prompt");
}

function initGitRepo(root: string): string {
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
}

describe("Claude PluginManager", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let settingsManager: SettingsManager;
	let manager: PluginManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `claude-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		settingsManager = SettingsManager.create(cwd, agentDir);
		manager = new PluginManager({ cwd, agentDir, settingsManager });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses marketplace and URL install specs", () => {
		expect(parsePluginInstallSpec("superpowers@claude")).toEqual({
			type: "marketplace",
			name: "superpowers",
			marketplace: "claude",
		});
		expect(parsePluginInstallSpec("https://github.com/user/plugin")).toEqual({
			type: "source",
			source: "https://github.com/user/plugin",
		});
	});

	it("reads marketplace catalog entries by name", () => {
		const marketplaceRoot = join(tempDir, "marketplace");
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				plugins: [
					{
						name: "superpowers",
						source: { url: "https://github.com/example/superpowers", ref: "v1" },
					},
				],
			}),
		);

		const catalog = readMarketplaceCatalog(marketplaceRoot);

		expect(catalog.plugins[0]).toEqual({
			name: "superpowers",
			source: { url: "https://github.com/example/superpowers", ref: "v1" },
		});
	});

	it("searches configured marketplaces by query across name, source, and marketplace", async () => {
		const firstMarketplace = join(tempDir, "first-marketplace");
		const secondMarketplace = join(tempDir, "second-marketplace");
		for (const marketplaceRoot of [firstMarketplace, secondMarketplace]) {
			mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		}
		// Stub the default marketplace clone to a local empty catalog to avoid network.
		const emptyMarketplace = join(tempDir, "empty-marketplace");
		mkdirSync(join(emptyMarketplace, ".claude-plugin"), { recursive: true });
		writeFileSync(join(emptyMarketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [] }));
		const managerPrivate = manager as unknown as {
			prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
		};
		const originalPrepare = managerPrivate.prepareMarketplaceRoot.bind(manager);
		vi.spyOn(managerPrivate, "prepareMarketplaceRoot").mockImplementation((name, marketplace) =>
			name === "claude-plugins-official" ? Promise.resolve(emptyMarketplace) : originalPrepare(name, marketplace),
		);
		writeFileSync(
			join(firstMarketplace, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				plugins: [
					{ name: "superpowers", source: { url: "https://github.com/example/superpowers", ref: "v1" } },
					{ name: "browser-tools", source: { url: "https://github.com/example/browser-tools" } },
				],
			}),
		);
		writeFileSync(
			join(secondMarketplace, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				plugins: [{ name: "docs", source: { url: "https://github.com/example/context-helper" } }],
			}),
		);
		manager.addMarketplace("claude", firstMarketplace);
		manager.addMarketplace("context", secondMarketplace);

		const byName = await manager.searchMarketplaces("super");
		const bySource = await manager.searchMarketplaces("context-helper");
		const byMarketplace = await manager.searchMarketplaces("context");

		expect(byName.results).toEqual([
			{
				name: "superpowers",
				marketplace: "claude",
				source: "https://github.com/example/superpowers",
				ref: "v1",
				installed: false,
			},
		]);
		expect(bySource.results.map((result) => result.name)).toEqual(["docs"]);
		expect(byMarketplace.results.map((result) => `${result.name}@${result.marketplace}`)).toEqual(["docs@context"]);
	});

	it("returns all catalog entries when marketplace search has no query", async () => {
		const marketplaceRoot = join(tempDir, "marketplace");
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		// Stub the default marketplace clone to a local empty catalog to avoid network.
		const emptyMarketplace = join(tempDir, "empty-marketplace");
		mkdirSync(join(emptyMarketplace, ".claude-plugin"), { recursive: true });
		writeFileSync(join(emptyMarketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [] }));
		const managerPrivate = manager as unknown as {
			prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
		};
		const originalPrepare = managerPrivate.prepareMarketplaceRoot.bind(manager);
		vi.spyOn(managerPrivate, "prepareMarketplaceRoot").mockImplementation((name, marketplace) =>
			name === "claude-plugins-official" ? Promise.resolve(emptyMarketplace) : originalPrepare(name, marketplace),
		);
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				plugins: [
					{ name: "alpha", source: { url: "https://github.com/example/alpha" } },
					{ name: "beta", source: { url: "https://github.com/example/beta" } },
				],
			}),
		);
		manager.addMarketplace("claude", marketplaceRoot);

		const results = await manager.searchMarketplaces();

		expect(results.results.map((result) => `${result.name}@${result.marketplace}`)).toEqual([
			"alpha@claude",
			"beta@claude",
		]);
	});

	it("marks marketplace search results as installed when a configured plugin uses the same source", async () => {
		const marketplaceRoot = join(tempDir, "marketplace");
		const pluginRoot = join(tempDir, "plugin");
		writePlugin(pluginRoot);
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		// Stub the default marketplace clone to a local empty catalog to avoid network.
		const emptyMarketplace = join(tempDir, "empty-marketplace");
		mkdirSync(join(emptyMarketplace, ".claude-plugin"), { recursive: true });
		writeFileSync(join(emptyMarketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [] }));
		const managerPrivate = manager as unknown as {
			prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
		};
		const originalPrepare = managerPrivate.prepareMarketplaceRoot.bind(manager);
		vi.spyOn(managerPrivate, "prepareMarketplaceRoot").mockImplementation((name, marketplace) =>
			name === "claude-plugins-official" ? Promise.resolve(emptyMarketplace) : originalPrepare(name, marketplace),
		);
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				plugins: [{ name: "superpowers", source: { url: pluginRoot } }],
			}),
		);
		manager.addMarketplace("claude", marketplaceRoot);
		await manager.install("superpowers@claude");

		const results = await manager.searchMarketplaces("superpowers");

		expect(results.results[0]?.installed).toBe(true);
	});

	it("searches only the selected marketplace when requested", async () => {
		const firstMarketplace = join(tempDir, "first-marketplace");
		const secondMarketplace = join(tempDir, "second-marketplace");
		for (const marketplaceRoot of [firstMarketplace, secondMarketplace]) {
			mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
			writeFileSync(
				join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
				JSON.stringify({
					plugins: [{ name: "superpowers", source: { url: `https://example.com/${marketplaceRoot}` } }],
				}),
			);
		}
		manager.addMarketplace("claude", firstMarketplace);
		manager.addMarketplace("internal", secondMarketplace);

		const results = await manager.searchMarketplaces("super", { marketplace: "internal" });

		expect(results.results.map((result) => result.marketplace)).toEqual(["internal"]);
	});

	it("reads manifest resources and unsupported diagnostics", () => {
		const pluginRoot = join(tempDir, "plugin");
		writePlugin(pluginRoot, { unsupported: true });

		const manifest = readClaudePluginManifest(pluginRoot);

		expect(manifest.name).toBe("superpowers-chrome");
		expect(manifest.skills).toEqual(["skills/planner"]);
		expect(manifest.commands).toEqual(["commands/review.md"]);
		expect(manifest.diagnostics.map((d) => d.field)).toEqual(["hooks", "agents"]);
	});

	it("installs a marketplace git plugin without touching package settings", async () => {
		const pluginRepo = join(tempDir, "plugin-repo");
		mkdirSync(pluginRepo, { recursive: true });
		writePlugin(pluginRepo);
		const ref = initGitRepo(pluginRepo);

		const marketplaceRoot = join(tempDir, "marketplace");
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				plugins: [{ name: "superpowers", source: { url: pluginRepo, ref } }],
			}),
		);

		manager.addMarketplace("claude", marketplaceRoot);
		await manager.install("superpowers@claude");
		await settingsManager.flush();

		const globalSettings = settingsManager.getGlobalSettings();
		expect(globalSettings.packages).toBeUndefined();
		expect(globalSettings.claudePlugins?.[0]).toMatchObject({
			name: "superpowers-chrome",
			source: pluginRepo,
			marketplace: "claude",
			enabled: true,
		});
		expect(existsSync(join(agentDir, "plugins", "superpowers-chrome", ".claude-plugin", "plugin.json"))).toBe(true);
	});

	it("writes prefixed MCP servers with plugin root substitutions", async () => {
		const pluginRoot = join(tempDir, "mcp-plugin");
		writePlugin(pluginRoot, { mcp: true });

		await manager.install(pluginRoot, { local: true });
		await settingsManager.flush();

		const raw = JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf-8")) as {
			mcpServers: Record<string, { command: string; args: string[] }>;
		};
		expect(raw.mcpServers["superpowers-chrome-chrome"]).toEqual({
			command: join(pluginRoot, "bin", "chrome-mcp"),
			args: ["--root", pluginRoot, "$UNTOUCHED"],
		});
	});

	it("removes plugin-owned MCP servers", async () => {
		const pluginRoot = join(tempDir, "mcp-plugin");
		writePlugin(pluginRoot, { mcp: true });
		await manager.install(pluginRoot, { local: true });

		const removed = manager.remove("superpowers-chrome", { local: true });
		await settingsManager.flush();

		const raw = JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf-8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(removed).toBe(true);
		expect(raw.mcpServers["superpowers-chrome-chrome"]).toBeUndefined();
	});

	it("lists the built-in claude-plugins-official default marketplace when none are configured", () => {
		expect(DEFAULT_CLAUDE_MARKETPLACE["claude-plugins-official"]).toEqual({
			source: "https://github.com/anthropics/claude-plugins-official",
		});
		expect(manager.listMarketplaces()).toEqual([
			{ name: "claude-plugins-official", source: DEFAULT_CLAUDE_MARKETPLACE["claude-plugins-official"]!.source },
		]);
	});

	it("merges user-configured marketplaces with the default, user wins on name collision", async () => {
		const marketplaceRoot = join(tempDir, "mkt");
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "p1", source: { url: "https://example.com/p1" } }] }),
		);

		manager.addMarketplace("claude-plugins-official", marketplaceRoot); // override the default source
		manager.addMarketplace("team", marketplaceRoot);

		const listed = manager.listMarketplaces();
		expect(listed).toHaveLength(2);
		expect(listed.find((m) => m.name === "claude-plugins-official")?.source).toBe(marketplaceRoot);

		const results = await manager.searchMarketplaces();
		expect(
			results.results
				.filter((r) => r.name === "p1")
				.map((r) => r.marketplace)
				.sort(),
		).toEqual(["claude-plugins-official", "team"]);
	});

	it("searches the built-in claude-plugins-official marketplace without explicit configuration", async () => {
		const marketplaceRoot = join(tempDir, "official-mkt");
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "demo", source: { url: "https://example.com/demo" } }] }),
		);
		// The default source is a git URL; stub the clone step to read a local fixture catalog.
		const rootSpy = vi.spyOn(
			manager as unknown as {
				prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
			},
			"prepareMarketplaceRoot",
		);
		rootSpy.mockResolvedValue(marketplaceRoot);

		const results = await manager.searchMarketplaces("demo");
		expect(results.results).toEqual([
			expect.objectContaining({ name: "demo", marketplace: "claude-plugins-official", installed: false }),
		]);
		expect(results.failures).toEqual([]);
	});

	it("skips failed marketplaces and reports them as failures", async () => {
		const marketplaceRoot = join(tempDir, "good-marketplace");
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "good", source: { url: "https://github.com/example/good" } }] }),
		);
		manager.addMarketplace("good", marketplaceRoot);
		const brokenRoot = join(tempDir, "broken-marketplace");
		mkdirSync(join(brokenRoot, ".claude-plugin"), { recursive: true }); // exists but no marketplace.json
		manager.addMarketplace("broken", brokenRoot);
		// Stub the default marketplace clone to a local empty catalog to avoid network.
		const emptyMarketplace = join(tempDir, "empty-marketplace");
		mkdirSync(join(emptyMarketplace, ".claude-plugin"), { recursive: true });
		writeFileSync(join(emptyMarketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [] }));
		const managerPrivate = manager as unknown as {
			prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
		};
		const originalPrepare = managerPrivate.prepareMarketplaceRoot.bind(manager);
		vi.spyOn(managerPrivate, "prepareMarketplaceRoot").mockImplementation((name, marketplace) =>
			name === "claude-plugins-official" ? Promise.resolve(emptyMarketplace) : originalPrepare(name, marketplace),
		);

		const { results, failures } = await manager.searchMarketplaces();
		expect(results.map((r) => r.name)).toEqual(["good"]);
		expect(failures).toEqual([{ marketplace: "broken", message: expect.stringContaining("marketplace.json") }]);
	});

	it("installs from the built-in claude-plugins-official marketplace without explicit configuration", async () => {
		const pluginRoot = join(tempDir, "plugin-src");
		writePlugin(pluginRoot);
		const marketplaceRoot = join(tempDir, "official-mkt");
		mkdirSync(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "demo", source: { url: pluginRoot } }] }),
		);
		const rootSpy = vi.spyOn(
			manager as unknown as {
				prepareMarketplaceRoot(name: string, marketplace: PluginMarketplaceSettings): Promise<string>;
			},
			"prepareMarketplaceRoot",
		);
		rootSpy.mockResolvedValue(marketplaceRoot);

		const installed = await manager.install("demo@claude-plugins-official");
		expect(installed.name).toBe("superpowers-chrome");
		expect(installed.marketplace).toBe("claude-plugins-official");
	});
});
