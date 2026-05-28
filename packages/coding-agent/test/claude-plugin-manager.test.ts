import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PluginManager,
	parsePluginInstallSpec,
	readClaudePluginManifest,
	readMarketplaceCatalog,
} from "../src/core/claude-plugin-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

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
		expect(globalSettings.plugins?.[0]).toMatchObject({
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
});
