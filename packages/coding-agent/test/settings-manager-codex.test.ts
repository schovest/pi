import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
		sm.setCodexPluginMarketplaces({ "codex-mkt": { source: "/tmp/mkt" } });
		sm.setClaudePluginMarketplaces({ "claude-mkt": { source: "/tmp/claude" } });
		expect(sm.getCodexPluginMarketplaces()).toEqual({ "codex-mkt": { source: "/tmp/mkt" } });
		expect(sm.getClaudePluginMarketplaces()).toEqual({ "claude-mkt": { source: "/tmp/claude" } });
	});

	it("migrates legacy pluginMarketplaces/plugins field names to claude* on load", async () => {
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({
				pluginMarketplaces: { "claude-mkt": { source: "/tmp/claude" } },
				plugins: [{ name: "old-plugin", source: "/tmp/plugin" }],
			}),
		);
		const migrated = SettingsManager.create(join(tempDir, "project"), agentDir);
		expect(migrated.getClaudePluginMarketplaces()).toEqual({ "claude-mkt": { source: "/tmp/claude" } });
		expect(migrated.getClaudePlugins()).toEqual([{ name: "old-plugin", source: "/tmp/plugin" }]);

		// New field names win when both exist
		writeFileSync(
			settingsPath,
			JSON.stringify({
				pluginMarketplaces: { "old-mkt": { source: "/tmp/old" } },
				claudePluginMarketplaces: { "new-mkt": { source: "/tmp/new" } },
			}),
		);
		const withNew = SettingsManager.create(join(tempDir, "project"), agentDir);
		expect(withNew.getClaudePluginMarketplaces()).toEqual({ "new-mkt": { source: "/tmp/new" } });
	});
});
