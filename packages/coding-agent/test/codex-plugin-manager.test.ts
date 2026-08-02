import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	normalizeCodexHookEventName,
	readCodexMarketplaceCatalog,
	readCodexPluginManifest,
} from "../src/core/codex-plugin-manager.ts";

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
