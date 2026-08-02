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
		sm.setCodexPluginMarketplaces({ "codex-mkt": { source: "/tmp/mkt" } });
		sm.setPluginMarketplaces({ "claude-mkt": { source: "/tmp/claude" } });
		expect(sm.getCodexPluginMarketplaces()).toEqual({ "codex-mkt": { source: "/tmp/mkt" } });
		expect(sm.getPluginMarketplaces()).toEqual({ "claude-mkt": { source: "/tmp/claude" } });
	});
});
