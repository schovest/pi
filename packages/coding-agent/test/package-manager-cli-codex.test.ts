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
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalAgentDir: string | undefined;
	let cwdSpy: ReturnType<typeof vi.spyOn>;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `codex-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		logSpy.mockRestore();
		errorSpy.mockRestore();
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		process.exitCode = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists a configured codex marketplace", async () => {
		const marketplaceRoot = join(tempDir, "mkt");
		mkdirSync(marketplaceRoot, { recursive: true });
		writeFileSync(
			join(marketplaceRoot, "marketplace.json"),
			JSON.stringify({ plugins: [{ name: "demo", source: { source: "local", path: "./plugins/demo" } }] }),
		);
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
		expect(SettingsManager.create(cwd, agentDir).getCodexPlugins()[0]?.enabled).toBe(true);
	});
});
