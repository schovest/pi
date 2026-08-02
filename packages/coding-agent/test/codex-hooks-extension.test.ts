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

	it("fast-exiting sh hook (command 'exit 2') does not crash on stdin EPIPE", async () => {
		// C1 回归：`sh -c 'exit 2'` 在读 stdin 前就退出，大 payload 写 stdin 必然触发 EPIPE。
		// 修复前未捕获的 EPIPE 会崩溃整个进程；修复后正常返回 block。
		const result = await runCodexHookCommand(
			{ type: "command", command: "exit 2" },
			{ hook_event_name: "PreToolUse", payload: "x".repeat(1024 * 1024) },
			{ pluginRoot: tempDir, pluginData: join(tempDir, "data"), cwd, timeoutFallback: 10 },
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe("blocked by codex hook");
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

	describe("event mapping behavior", () => {
		const writeScript = (name: string, body: string): string => {
			const script = join(tempDir, name);
			writeFileSync(script, body);
			return script;
		};

		const writePlugins = (settings: Record<string, unknown>): void => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		};

		const makeFakePi = (handlers: Map<string, (event: unknown, ctx: unknown) => unknown>) => ({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
			},
			registerCommand: () => {},
			sendUserMessage: () => {},
		});

		const makeFakeCtx = () => ({
			cwd,
			sessionManager: { getSessionId: () => "sess-1" },
			model: { id: "test-model" },
			ui: { notify: () => {} },
			getSystemPrompt: () => "BASE_SYSTEM_PROMPT",
		});

		it("tool_call handler blocks on pre_tool_use deny with reason", async () => {
			const denyScript = writeScript("deny-hook.js", "process.stderr.write('tool not allowed');process.exit(2);");
			writePlugins({
				codexPlugins: [
					{
						name: "guard",
						source: tempDir,
						enabled: true,
						hooks: {
							pre_tool_use: [
								{
									matcher: "^Bash$",
									handlers: [{ type: "command", command: process.execPath, args: [denyScript] }],
								},
							],
						},
					},
				],
			});
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			createCodexHooksHandlers(makeFakePi(handlers) as never, { agentDir });
			const toolCall = handlers.get("tool_call");
			expect(toolCall).toBeDefined();

			const event = { toolName: "Bash", input: { original: true } };
			const result = await toolCall!(event, makeFakeCtx());
			expect(result).toEqual({ block: true, reason: "tool not allowed" });
			expect(event.input).toEqual({ original: true });
		});

		it("tool_call handler rewrites event.input in place from updatedInput", async () => {
			const updateScript = writeScript(
				"update-hook.js",
				"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({updatedInput:{injected:'yes'}}));});",
			);
			writePlugins({
				codexPlugins: [
					{
						name: "editor",
						source: tempDir,
						enabled: true,
						hooks: {
							pre_tool_use: [
								{ handlers: [{ type: "command", command: process.execPath, args: [updateScript] }] },
							],
						},
					},
				],
			});
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			createCodexHooksHandlers(makeFakePi(handlers) as never, { agentDir });
			const toolCall = handlers.get("tool_call");
			expect(toolCall).toBeDefined();

			const event = { toolName: "Bash", input: { original: true } };
			const result = await toolCall!(event, makeFakeCtx());
			expect(result).toBeUndefined();
			expect(event.input).toEqual({ original: true, injected: "yes" });
		});

		it("input handler returns handled when user_prompt_submit blocks", async () => {
			const blockScript = writeScript("block-prompt.js", "process.stderr.write('prompt rejected');process.exit(2);");
			writePlugins({
				codexPlugins: [
					{
						name: "filter",
						source: tempDir,
						enabled: true,
						hooks: {
							user_prompt_submit: [
								{ handlers: [{ type: "command", command: process.execPath, args: [blockScript] }] },
							],
						},
					},
				],
			});
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			createCodexHooksHandlers(makeFakePi(handlers) as never, { agentDir });
			const inputHandler = handlers.get("input");
			expect(inputHandler).toBeDefined();

			const result = await inputHandler!({ text: "do the thing" }, makeFakeCtx());
			expect(result).toEqual({ action: "handled" });
		});

		it("before_agent_start injects pendingContext and clears the queue", async () => {
			const contextScript = writeScript(
				"context-hook.js",
				"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({additionalContext:'injected context'}));});",
			);
			writePlugins({
				codexPlugins: [
					{
						name: "ctx",
						source: tempDir,
						enabled: true,
						hooks: {
							session_start: [
								{ handlers: [{ type: "command", command: process.execPath, args: [contextScript] }] },
							],
						},
					},
				],
			});
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			createCodexHooksHandlers(makeFakePi(handlers) as never, { agentDir });
			const sessionStart = handlers.get("session_start");
			const beforeAgentStart = handlers.get("before_agent_start");
			expect(sessionStart).toBeDefined();
			expect(beforeAgentStart).toBeDefined();

			await sessionStart!({ reason: "startup" }, makeFakeCtx());
			const injected = await beforeAgentStart!({}, makeFakeCtx());
			expect(injected).toEqual({ systemPrompt: "BASE_SYSTEM_PROMPT\n\ninjected context" });
			// 队列已清空：再次触发不再注入
			const second = await beforeAgentStart!({}, makeFakeCtx());
			expect(second).toBeUndefined();
		});

		it("runs hooks for non-local source plugins via installedPath with PLUGIN_ROOT env", async () => {
			const envScript = writeScript(
				"env-hook.js",
				"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({additionalContext:'root='+process.env.PLUGIN_ROOT}));});",
			);
			writePlugins({
				codexPlugins: [
					{
						name: "remote",
						source: "https://github.com/example/remote-plugin.git",
						enabled: true,
						installedPath: tempDir,
						hooks: {
							user_prompt_submit: [
								{ handlers: [{ type: "command", command: process.execPath, args: [envScript] }] },
							],
						},
					},
				],
			});
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			createCodexHooksHandlers(makeFakePi(handlers) as never, { agentDir });
			const inputHandler = handlers.get("input");
			const beforeAgentStart = handlers.get("before_agent_start");
			expect(inputHandler).toBeDefined();
			expect(beforeAgentStart).toBeDefined();

			await inputHandler!({ text: "hi" }, makeFakeCtx());
			const injected = await beforeAgentStart!({}, makeFakeCtx());
			expect(injected).toEqual({ systemPrompt: `BASE_SYSTEM_PROMPT\n\nroot=${tempDir}` });
		});
	});
});
