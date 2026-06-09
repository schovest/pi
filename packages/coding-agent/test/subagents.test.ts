import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { discoverSubagents } from "../src/core/subagents/discovery.ts";
import type { SubagentRunEvent, SubagentRunRequest } from "../src/core/subagents/types.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

describe("subagents discovery", () => {
	it("loads built-in, user, and project agents with project overriding user overriding built-in", async () => {
		const harness = await createHarness();
		try {
			const userAgentsDir = join(harness.tempDir, "subagents");
			const projectAgentsDir = join(harness.tempDir, ".pi", "subagents");
			mkdirSync(userAgentsDir, { recursive: true });
			mkdirSync(projectAgentsDir, { recursive: true });

			writeFileSync(
				join(userAgentsDir, "explorer.md"),
				"---\ndescription: User explorer\nmodel: faux/faux-fast\nthinking: high\ntools: [read]\n---\nUser explorer prompt",
			);
			writeFileSync(
				join(projectAgentsDir, "explorer.md"),
				"---\ndescription: Project explorer\nthinking: low\ntools: [grep]\n---\nProject explorer prompt",
			);
			writeFileSync(join(projectAgentsDir, "local.md"), "---\ndescription: Local only\n---\nLocal prompt");

			const userOnly = await discoverSubagents({ cwd: harness.tempDir, agentDir: harness.tempDir, scope: "user" });
			expect(userOnly.map((agent) => agent.name)).toContain("explorer");
			expect(userOnly.find((agent) => agent.name === "explorer")).toMatchObject({
				description: "User explorer",
				model: "faux/faux-fast",
				thinking: "high",
				tools: ["read"],
				prompt: "User explorer prompt",
				scope: "user",
			});
			expect(userOnly.map((agent) => agent.name)).not.toContain("local");

			const project = await discoverSubagents({ cwd: harness.tempDir, agentDir: harness.tempDir, scope: "project" });
			expect(project.find((agent) => agent.name === "explorer")).toMatchObject({
				description: "Project explorer",
				thinking: "low",
				tools: ["grep"],
				prompt: "Project explorer prompt",
				scope: "project",
			});
			expect(project.map((agent) => agent.name)).toContain("local");
		} finally {
			harness.cleanup();
		}
	});
});

describe("AgentSession subagents", () => {
	afterEach(() => {
		// Harness cleanup unregisters faux providers per test.
	});

	it("runs a single subagent with agent model/thinking and task overrides clamped to the target model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "parent", reasoning: true },
				{ id: "limited", reasoning: true },
			],
		});
		try {
			const agentDir = join(harness.tempDir, "agent");
			const agentsDir = join(agentDir, "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "worker.md"),
				"---\ndescription: Plans work\nmodel: faux/limited\nthinking: xhigh\ntools: []\n---\nPlan carefully.",
			);

			harness.faux.setResponses([
				(context, options, _state, model) => {
					expect(model.id).toBe("parent");
					expect((options as unknown as { reasoning?: string } | undefined)?.reasoning).toBe("high");
					expect(context.messages.at(-1)?.role).toBe("user");
					return fauxAssistantMessage("single result");
				},
			]);

			const result = await harness.session.runSubagents(
				{
					tasks: [{ agent: "worker", task: "make a plan", model: "faux/parent", thinking: "xhigh" }],
					subagentScope: "user",
				},
				{ agentDir },
			);

			expect(result.mode).toBe("parallel");
			expect(result.results).toHaveLength(1);
			expect(result.results[0]).toMatchObject({
				agent: "worker",
				task: "make a plan",
				status: "success",
				output: "single result",
				model: "faux/parent",
				thinking: "high",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("runs parallel tasks with concurrency limit and preserves input result order", async () => {
		const harness = await createHarness();
		try {
			let active = 0;
			let maxActive = 0;
			harness.faux.setResponses(
				Array.from({ length: 6 }, (_, index) => async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, index === 0 ? 25 : 5));
					active--;
					return fauxAssistantMessage(`parallel ${index}`);
				}),
			);

			const result = await harness.session.runSubagents({
				tasks: Array.from({ length: 6 }, (_, index) => ({
					agent: "worker",
					task: `task ${index}`,
					tools: [],
				})),
			});

			expect(maxActive).toBeLessThanOrEqual(4);
			expect(result.results.map((item) => item.task)).toEqual([
				"task 0",
				"task 1",
				"task 2",
				"task 3",
				"task 4",
				"task 5",
			]);
			expect(result.results.every((item) => item.status === "success")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("runs a chain with previous substitution and stops after a failed step", async () => {
		const harness = await createHarness();
		try {
			harness.faux.setResponses([
				fauxAssistantMessage("first"),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
				fauxAssistantMessage("unreached"),
			]);

			const result = await harness.session.runSubagents({
				chain: [
					{ agent: "worker", task: "one", tools: [] },
					{ agent: "worker", task: "review {previous}", tools: [] },
					{ agent: "worker", task: "three", tools: [] },
				],
			});

			expect(result.results).toHaveLength(2);
			expect(result.results[0].output).toBe("first");
			expect(result.results[1]).toMatchObject({
				task: "review first",
				status: "failed",
				error: "boom",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("aborts child runs when the parent signal is aborted", async () => {
		const harness = await createHarness();
		try {
			harness.faux.setResponses([
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 100));
					return fauxAssistantMessage("too late");
				},
			]);

			const controller = new AbortController();
			const promise = harness.session.runSubagents(
				{ tasks: [{ agent: "worker", task: "slow", tools: [] }] },
				{ signal: controller.signal },
			);
			controller.abort();

			const result = await promise;
			expect(result.results[0].status).toBe("aborted");
		} finally {
			harness.cleanup();
		}
	});

	it("registers the subagent tool by default and omits it when disabled", async () => {
		const harness = await createHarness();
		try {
			const model = harness.getModel();
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(model.provider, "faux-key");
			const modelRegistry = ModelRegistry.inMemory(authStorage);
			modelRegistry.registerProvider(model.provider, {
				api: harness.faux.api,
				baseUrl: model.baseUrl,
				apiKey: "faux-key",
				models: [
					{
						id: model.id,
						name: model.name,
						api: model.api,
						reasoning: model.reasoning,
						input: model.input,
						cost: model.cost,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
					},
				],
			});
			const agentsDir = join(harness.tempDir, "subagents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "architect.md"),
				"---\ndescription: Architecture review\n---\nReview architecture.",
			);

			const baseOptions = {
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				model,
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory(),
			};

			const enabled = await createAgentSession(baseOptions);
			expect(enabled.session.getAllTools().map((tool) => tool.name)).toContain("subagent");
			expect(enabled.session.systemPrompt).toContain("Available subagents for the subagent tool");
			expect(enabled.session.systemPrompt).toContain("architect (user) - Architecture review");
			expect(enabled.session.systemPrompt).toContain("Always use tasks[] even for a single subagent");
			expect(enabled.session.getToolDefinition("subagent")?.description).toContain(
				"agent must be one of: architect",
			);
			enabled.session.dispose();

			const disabled = await createAgentSession({ ...baseOptions, enableSubagents: false });
			expect(disabled.session.getAllTools().map((tool) => tool.name)).not.toContain("subagent");
			disabled.session.dispose();
		} finally {
			harness.cleanup();
		}
	});

	it("subagent tool executes the runner and emits live run updates", async () => {
		const captureParameters = Type.Object({ path: Type.String() });
		const captureTool: AgentTool<typeof captureParameters, undefined> = {
			name: "capture",
			label: "capture",
			description: "capture",
			parameters: captureParameters,
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `captured ${params.path}` }],
				details: undefined,
			}),
		};
		const harness = await createHarness({ tools: [captureTool] });
		try {
			harness.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("capture", { path: "/tmp/report.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("tool result"),
			]);
			const events: SubagentRunEvent[] = [];

			const result = await harness.session.runSubagents(
				{ tasks: [{ agent: "worker", task: "via api", tools: ["capture"] }] } satisfies SubagentRunRequest,
				{ onEvent: (event) => events.push(event) },
			);

			expect(result.results[0].output).toBe("tool result");
			expect(events.map((event) => event.status)).toContain("running");
			expect(events.map((event) => event.currentTool)).toContain("capture");
			expect(events.map((event) => event.currentToolArgs)).toContain('{"path":"/tmp/report.txt"}');
			expect(events.map((event) => event.toolResultSummary)).toContain("captured /tmp/report.txt");
			expect(events.map((event) => event.status)).toContain("success");
			expect(getMessageText(harness.session.messages[0])).toBe("");
		} finally {
			harness.cleanup();
		}
	});

	it("allows separate subagent tool calls in one assistant turn to execute concurrently", async () => {
		const harness = await createHarness();
		try {
			let active = 0;
			let maxActive = 0;
			let childCallCount = 0;
			const childResponse = async () => {
				const callNumber = childCallCount;
				childCallCount++;
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 25));
				active--;
				return fauxAssistantMessage(`child ${callNumber}`);
			};

			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall(
							"subagent",
							{ tasks: [{ agent: "worker", task: "first", tools: [] }] },
							{ id: "subagent-1" },
						),
						fauxToolCall(
							"subagent",
							{ tasks: [{ agent: "worker", task: "second", tools: [] }] },
							{ id: "subagent-2" },
						),
					],
					{ stopReason: "toolUse" },
				),
				childResponse,
				childResponse,
				(context) =>
					fauxAssistantMessage(
						`done ${context.messages.filter((message) => message.role === "toolResult").length}`,
					),
			]);

			await harness.session.prompt("run two independent subagents");

			expect(maxActive).toBe(2);
			expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		} finally {
			harness.cleanup();
		}
	});
});
