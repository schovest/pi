import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentSession } from "../agent-session.ts";
import { defineTool } from "../extensions/types.ts";
import { discoverSubagentsSync } from "./discovery.ts";
import type { SubagentRunEvent, SubagentRunResult } from "./types.ts";

const ThinkingSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);

function createSubagentNameSchema(subagentNames: string[]) {
	const description = `Subagent name. Available values: ${subagentNames.join(", ")}`;
	return Type.String({ description, enum: subagentNames });
}

function createTaskSchema(subagentNames: string[]) {
	return Type.Object({
		agent: createSubagentNameSchema(subagentNames),
		task: Type.String(),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(ThinkingSchema),
		tools: Type.Optional(Type.Array(Type.String())),
	});
}

function createSubagentToolSchema(subagentNames: string[]) {
	const taskSchema = createTaskSchema(subagentNames);
	return Type.Object({
		agent: Type.Optional(createSubagentNameSchema(subagentNames)),
		task: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(ThinkingSchema),
		tools: Type.Optional(Type.Array(Type.String())),
		tasks: Type.Optional(Type.Array(taskSchema)),
		chain: Type.Optional(Type.Array(taskSchema)),
		subagentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
	});
}

type SubagentToolInput = {
	agent?: string;
	task?: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	tools?: string[];
	tasks?: Array<{
		agent: string;
		task: string;
		model?: string;
		thinking?: SubagentToolInput["thinking"];
		tools?: string[];
	}>;
	chain?: Array<{
		agent: string;
		task: string;
		model?: string;
		thinking?: SubagentToolInput["thinking"];
		tools?: string[];
	}>;
	subagentScope?: "user" | "project" | "both";
};

interface SubagentToolDetails {
	result?: SubagentRunResult;
	events: SubagentRunEvent[];
}

function validateMode(input: SubagentToolInput): void {
	const selected = [
		input.agent && input.task ? "single" : undefined,
		input.tasks ? "tasks" : undefined,
		input.chain ? "chain" : undefined,
	].filter((mode) => mode !== undefined);
	if (selected.length !== 1) {
		throw new Error("subagent expects exactly one of agent/task, tasks, or chain");
	}
}

function resultText(result: SubagentRunResult): string {
	return result.results
		.map((item) => {
			const heading = `${item.index + 1}. ${item.agent} ${item.status}`;
			const model = item.model ? ` [${item.model}, thinking=${item.thinking ?? "default"}]` : "";
			const body = item.error ? `Error: ${item.error}` : item.output;
			return `${heading}${model}\n${body}`.trim();
		})
		.join("\n\n");
}

function renderDetails(details: SubagentToolDetails | undefined, expanded: boolean): string {
	if (!details) {
		return "";
	}
	if (details.result) {
		const lines = details.result.results.map((result) => {
			const usage = result.usage ? ` tokens=${result.usage.totalTokens}` : "";
			return `${result.index + 1}. ${result.agent}: ${result.status} ${result.model ?? ""} thinking=${result.thinking ?? "default"}${usage}`;
		});
		if (expanded) {
			for (const event of details.events) {
				lines.push(
					`event ${event.index + 1} ${event.agent}: ${event.status}${event.currentTool ? ` tool=${event.currentTool}` : ""}`,
				);
			}
		}
		return lines.join("\n");
	}
	const latest = new Map<number, SubagentRunEvent>();
	for (const event of details.events) {
		latest.set(event.index, event);
	}
	return Array.from(latest.values())
		.sort((a, b) => a.index - b.index)
		.map(
			(event) =>
				`${event.index + 1}. ${event.agent}: ${event.status} ${event.model ?? ""} thinking=${event.thinking ?? "default"}`,
		)
		.join("\n");
}

export function createSubagentToolDefinition(session: AgentSession) {
	const availableAgents = discoverSubagentsSync({
		cwd: session.cwd,
		agentDir: session.agentDir,
		scope: "both",
	});
	const subagentNames = availableAgents.map((agent) => agent.name);
	const agentSummary = availableAgents
		.map((agent) => `${agent.name} (${agent.scope}) - ${agent.description}`)
		.join("; ");
	const parameterSummary = `agent must be one of: ${subagentNames.join(", ")}. Use subagentScope="project" or "both" for project-defined subagents.`;
	const parallelGuidance =
		"For 2 or more independent subagents, use one subagent call with tasks[] so they run concurrently. Use multiple separate subagent tool calls only when tasks cannot be expressed in one tasks[] batch.";

	return defineTool({
		name: "subagent",
		label: "subagent",
		description: `Run one or more specialized in-memory subagents. ${parameterSummary} ${parallelGuidance} Use agent/task for one task, tasks[] for parallel work, or chain[] for sequential dependent work.`,
		promptSnippet:
			"subagent - run specialized in-memory subagents for scouting, planning, reviewing, or focused work.",
		promptGuidelines: [
			`Available subagents for the subagent tool: ${agentSummary}`,
			`Subagent parameter options: ${parameterSummary}`,
			parallelGuidance,
			"Use subagent for independent subtasks that benefit from a focused agent role.",
			"Do not use subagent recursively from inside subagents.",
		],
		parameters: createSubagentToolSchema(subagentNames),
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal, onUpdate) => {
			validateMode(params);
			const details: SubagentToolDetails = { events: [] };
			const result = await session.runSubagents(
				params.tasks
					? { tasks: params.tasks, subagentScope: params.subagentScope }
					: params.chain
						? { chain: params.chain, subagentScope: params.subagentScope }
						: {
								agent: params.agent ?? "",
								task: params.task ?? "",
								model: params.model,
								thinking: params.thinking,
								tools: params.tools,
								subagentScope: params.subagentScope,
							},
				{
					signal,
					onEvent: (event) => {
						details.events.push(event);
						onUpdate?.({ content: [{ type: "text", text: renderDetails(details, false) }], details });
					},
				},
			);
			details.result = result;
			return {
				content: [{ type: "text", text: resultText(result) }],
				details,
			};
		},
		renderCall: (args) => {
			const title = args.tasks
				? `parallel ${args.tasks.length}`
				: args.chain
					? `chain ${args.chain.length}`
					: args.agent;
			return new Text(theme.fg("toolTitle", theme.bold(`subagent ${title ?? ""}`)), 0, 0);
		},
		renderResult: (result, options) => {
			const details = result.details as SubagentToolDetails | undefined;
			const lines = renderDetails(details, options.expanded);
			const fallback = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", lines || fallback), 0, 0);
		},
	});
}
