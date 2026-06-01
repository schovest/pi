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
		tasks: Type.Optional(Type.Array(taskSchema)),
		chain: Type.Optional(Type.Array(taskSchema)),
		subagentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
	});
}

type SubagentTaskInput = {
	agent: string;
	task: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	tools?: string[];
};

type SubagentToolInput = {
	tasks?: SubagentTaskInput[];
	chain?: SubagentTaskInput[];
	subagentScope?: "user" | "project" | "both";
};

interface SubagentToolDetails {
	result?: SubagentRunResult;
	events: SubagentRunEvent[];
	children: Map<number, AgentSession>;
}

function validateMode(input: SubagentToolInput): void {
	const hasTasks = !!input.tasks && input.tasks.length > 0;
	const hasChain = !!input.chain && input.chain.length > 0;
	if (hasTasks === hasChain) {
		throw new Error("subagent expects exactly one of tasks or chain");
	}
}

function formatToolArgs(toolName: string, argsJson: string | undefined): string {
	if (!argsJson) return "";
	try {
		const args: Record<string, unknown> = JSON.parse(argsJson);
		switch (toolName) {
			case "bash":
				return typeof args.command === "string" ? truncate(args.command, 80) : truncate(argsJson, 80);
			case "read":
				return truncate(String(args.file_path ?? args.path ?? argsJson), 80);
			case "edit":
				return truncate(String(args.path ?? args.file_path ?? argsJson), 80);
			case "write":
				return truncate(String(args.path ?? args.file_path ?? argsJson), 80);
			case "ls":
				return truncate(String(args.path ?? args.dir ?? "."), 80);
			case "grep": {
				const pattern = String(args.pattern ?? "");
				const searchPath = args.path ? ` in ${args.path}` : "";
				const include = args.glob ? ` (${args.glob})` : "";
				return truncate(`/${pattern}/${searchPath}${include}`, 80);
			}
			case "find": {
				const pattern = String(args.pattern ?? args.glob ?? "");
				const searchPath = args.path ? ` in ${args.path}` : "";
				return truncate(`${pattern}${searchPath}`, 80);
			}
			default:
				return truncate(argsJson, 80);
		}
	} catch {
		return truncate(argsJson, 80);
	}
}

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toolCallCount(events: SubagentRunEvent[]): number {
	return events.filter((e) => e.currentTool && e.currentToolArgs).length;
}

function recentToolCalls(events: SubagentRunEvent[], max: number): string {
	const toolEvents = events.filter((e) => e.currentTool && e.currentToolArgs);
	return toolEvents
		.slice(-max)
		.map((e) => {
			const args = formatToolArgs(e.currentTool!, e.currentToolArgs);
			return `--${e.currentTool}${args ? ` ${args}` : ""}`;
		})
		.join("\n");
}

function eventText(event: SubagentRunEvent): string {
	const parts: string[] = [`${event.index + 1} ${event.agent}: ${event.status}`];
	if (event.currentTool) {
		parts.push(`tool=${event.currentTool}`);
	}
	if (event.outputSummary) {
		parts.push(`output=${event.outputSummary}`);
	}
	if (event.error) {
		parts.push(`error=${event.error}`);
	}
	return parts.join(" ");
}

function compactEventTexts(events: SubagentRunEvent[]): Array<{ text: string; count: number }> {
	const compacted: Array<{ text: string; count: number }> = [];
	for (const event of events) {
		const text = eventText(event);
		const previous = compacted.at(-1);
		if (previous?.text === text) {
			previous.count++;
		} else {
			compacted.push({ text, count: 1 });
		}
	}
	return compacted;
}

function resultText(result: SubagentRunResult): string {
	return result.results
		.map((item) => {
			const tokens = item.usage ? ` tokens=${item.usage.totalTokens}` : "";
			const tools = ` tools=${toolCallCount(item.events)}`;
			const heading = `${item.index + 1}. ${item.agent}: ${item.status} ${item.model ?? ""} thinking=${item.thinking ?? "default"}${tokens}${tools}`;
			const recent = recentToolCalls(item.events, 3);
			const body = item.error ? `Error: ${item.error}` : item.output;
			const parts = [heading];
			if (recent) parts.push(recent);
			if (body) parts.push(body);
			return parts.join("\n");
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
			const tools = ` tools=${toolCallCount(result.events)}`;
			const base = `${result.index + 1}. ${result.agent}: ${result.status} ${result.model ?? ""} thinking=${result.thinking ?? "default"}${usage}${tools}`;
			const recent = recentToolCalls(result.events, 3);
			return recent ? `${base}\n${recent}` : base;
		});
		if (expanded) {
			const compacted = compactEventTexts(details.events);
			for (const entry of compacted) {
				const repeated = entry.count > 1 ? ` (repeated ${entry.count}x)` : "";
				lines.push(`event ${entry.text}${repeated}`);
			}
		}
		return lines.join("\n\n");
	}
	const latest = new Map<number, SubagentRunEvent>();
	for (const event of details.events) {
		latest.set(event.index, event);
	}
	return Array.from(latest.values())
		.sort((a, b) => a.index - b.index)
		.map((event) => {
			const itemEvents = details.events.filter((e) => e.index === event.index);
			const tools = ` tools=${toolCallCount(itemEvents)}`;
			const base = `${event.index + 1}. ${event.agent}: ${event.status} ${event.model ?? ""} thinking=${event.thinking ?? "default"}${tools}`;
			const recent = recentToolCalls(itemEvents, 3);
			return recent ? `${base}\n${recent}` : base;
		})
		.join("\n\n");
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
	const usageGuidance =
		"Always use tasks[] even for a single subagent. For 2+ independent subagents, use one subagent call with tasks[] so they run concurrently. Use chain[] for sequential dependent work where each step references {previous}.";

	return defineTool({
		name: "subagent",
		label: "subagent",
		description: `Run one or more specialized in-memory subagents. ${parameterSummary} ${usageGuidance}`,
		promptSnippet:
			"subagent - run specialized in-memory subagents for scouting, planning, reviewing, or focused work.",
		promptGuidelines: [
			`Available subagents for the subagent tool: ${agentSummary}`,
			`Subagent parameter options: ${parameterSummary}`,
			usageGuidance,
			"Use subagent for independent subtasks that benefit from a focused agent role.",
			"Do not use subagent recursively from inside subagents.",
		],
		parameters: createSubagentToolSchema(subagentNames),
		executionMode: "parallel",
		execute: async (_toolCallId, params, signal, onUpdate) => {
			validateMode(params);
			const details: SubagentToolDetails = { events: [], children: new Map() };
			const result = await session.runSubagents(
				params.chain
					? { chain: params.chain, subagentScope: params.subagentScope }
					: { tasks: params.tasks!, subagentScope: params.subagentScope },
				{
					signal,
					onEvent: (event, child) => {
						details.events.push(event);
						details.children.set(event.index, child);
						onUpdate?.({ content: [{ type: "text", text: renderDetails(details, false) }], details });
					},
				},
			);
			details.result = result;
			details.children.clear();
			return {
				content: [{ type: "text", text: resultText(result) }],
				details,
			};
		},
		renderCall: (args) => {
			const title = args.chain ? `chain ${args.chain.length}` : `parallel ${args.tasks?.length ?? 0}`;
			return new Text(theme.fg("toolTitle", theme.bold(`subagent ${title}`)), 0, 0);
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
