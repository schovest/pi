import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { handlePluginCommand } from "../src/package-manager-cli.ts";

function writeMarketplace(root: string): void {
	mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(root, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			plugins: [{ name: "superpowers", source: { url: "https://github.com/example/superpowers", ref: "v1" } }],
		}),
	);
}

describe("plugin CLI search", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalAgentDir: string | undefined;
	let cwdSpy: ReturnType<typeof vi.spyOn>;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `plugin-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("prints matching marketplace search results", async () => {
		const marketplaceRoot = join(tempDir, "marketplace");
		writeMarketplace(marketplaceRoot);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setPluginMarketplaces({ claude: { source: marketplaceRoot } });
		await settingsManager.flush();

		await handlePluginCommand(["plugins", "search", "super"]);

		const output = logSpy.mock.calls.flat().join("\n");
		expect(output).toContain("superpowers@claude");
		expect(output).toContain("https://github.com/example/superpowers");
		expect(output).toContain("v1");
		expect(process.exitCode).toBeUndefined();
	});

	it("prints a clear message when no plugin marketplaces are configured", async () => {
		await handlePluginCommand(["plugins", "search", "super"]);

		expect(logSpy.mock.calls.flat().join("\n")).toContain("No plugin marketplaces configured.");
		expect(process.exitCode).toBeUndefined();
	});

	it("prints a clear message when search has no matches", async () => {
		const marketplaceRoot = join(tempDir, "marketplace");
		writeMarketplace(marketplaceRoot);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		settingsManager.setPluginMarketplaces({ claude: { source: marketplaceRoot } });
		await settingsManager.flush();

		await handlePluginCommand(["plugins", "search", "missing"]);

		expect(logSpy.mock.calls.flat().join("\n")).toContain("No matching plugins found.");
		expect(process.exitCode).toBeUndefined();
	});
});
