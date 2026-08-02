import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createCodexHooksHandlers,
	matchHookMatcher,
	readEnabledCodexPlugins,
	runCodexHookCommand,
} from "../dist-assets/extensions/codex-hooks.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

describe("codex hooks extension primitives", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `codex-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});
	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads enabled codex plugins from user and project settings", () => {
		mkdirSync(join(agentDir), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ codexPlugins: [{ name: "a", source: "/x", enabled: true }] }),
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ codexPlugins: [{ name: "b", source: "/y", enabled: false }] }),
		);
		const plugins = readEnabledCodexPlugins(agentDir, cwd);
		expect(plugins.map((p) => p.name)).toEqual(["a"]);
	});

	it("matcher treats empty/star/omitted as match-all", () => {
		expect(matchHookMatcher(undefined, "Bash")).toBe(true);
		expect(matchHookMatcher("*", "Bash")).toBe(true);
		expect(matchHookMatcher("", "Bash")).toBe(true);
		expect(matchHookMatcher("^Bash$", "Bash")).toBe(true);
		expect(matchHookMatcher("^Bash$", "Read")).toBe(false);
	});

	it("runs a command hook with stdin JSON and parses JSON stdout", async () => {
		const script = join(tempDir, "echo-hook.js");
		writeFileSync(
			script,
			"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);process.stdout.write(JSON.stringify({continue:true,hookSpecificOutput:{additionalContext:'ctx:'+i.hook_event_name+' '+i.tool_name}}));});",
		);
		const result = await runCodexHookCommand(
			{ type: "command", command: process.execPath, args: [script] },
			{ hook_event_name: "PreToolUse", tool_name: "Bash" },
			{ pluginRoot: tempDir, pluginData: join(tempDir, "data"), cwd, timeoutFallback: 10 },
		);
		expect(result.ok).toBe(true);
		expect(result.additionalContext).toBe("ctx:PreToolUse Bash");
	});

	it("exit code 2 with stderr blocks with reason", async () => {
		const script = join(tempDir, "block.js");
		writeFileSync(script, "process.stderr.write('no way');process.exit(2);");
		const result = await runCodexHookCommand(
			{ type: "command", command: process.execPath, args: [script] },
			{},
			{ pluginRoot: tempDir, pluginData: join(tempDir, "data"), cwd, timeoutFallback: 10 },
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("no way");
	});

	it("registers Pi event handlers for all mapped codex events", () => {
		const registered: string[] = [];
		const registeredCommands: Array<{ name: string; description?: string }> = [];
		const fakePi = {
			on: (event: string) => {
				registered.push(event);
			},
			registerCommand: (name: string, opts: { description?: string }) => {
				registeredCommands.push({ name, description: opts.description });
			},
		};
		mkdirSync(join(agentDir), { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				codexPlugins: [
					{
						name: "legacy",
						source: tempDir,
						enabled: true,
						commands: [{ name: "review", description: "Review", command: "echo hi" }],
					},
				],
			}),
		);
		createCodexHooksHandlers(fakePi as never, { agentDir });
		for (const expected of [
			"session_start",
			"session_shutdown",
			"input",
			"tool_call",
			"tool_result",
			"session_before_compact",
			"session_compact",
			"agent_start",
			"agent_end",
			"turn_end",
			"turn_start",
			"before_agent_start",
		]) {
			expect(registered).toContain(expected);
		}
		expect(registeredCommands.map((c) => c.name)).toContain("codex:legacy:review");
	});
});
