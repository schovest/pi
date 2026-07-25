import { Text } from "@schovest/pi-tui";
import { minimatch } from "minimatch";
import { Type } from "typebox";
import { statusColor } from "../../modes/interactive/components/subagent-details.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentSession } from "../agent-session.ts";
import { defineTool } from "../extensions/types.ts";
import type { Skill } from "../skills.ts";
import { discoverSubagentsSync } from "./discovery.ts";
import type { SubagentDefinition, SubagentRunEvent, SubagentRunResult } from "./types.ts";

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
		title: Type.String({ description: "Short display title summarizing this subagent task, 2-6 words" }),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(ThinkingSchema),
		includedTools: Type.Optional(Type.Array(Type.String())),
		excludedTools: Type.Optional(Type.Array(Type.String())),
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
	title: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	includedTools?: string[];
	excludedTools?: string[];
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

function formatSubagentDescription(def: SubagentDefinition, availableSkills: Skill[]): string {
	let desc = def.description;
	if (def.skills && def.skills.length > 0) {
		const matchedNames = availableSkills
			.filter((s) => def.skills!.some((p) => minimatch(s.name, p, { nocase: true })))
			.map((s) => s.name);
		if (matchedNames.length > 0) {
			desc += `\n\nAvailable skills: ${matchedNames.join(", ")}`;
		}
	}
	return desc;
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

function displayTitle(item: { title?: string; task: string }): string {
	return item.title ?? item.task.slice(0, 7);
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
			return `> ${e.currentTool}${args ? ` ${args}` : ""}`;
		})
		.join("\n");
}

/**
 * Build a colored heading line for TUI display.
 * Format: `{index}.({agent}) {title}: {status} {model} thinking=… tokens=… tools=…`
 * Status uses statusColor, agent tag uses accent, metadata uses muted.
 */
function coloredHeading(parts: {
	index: number;
	agent: string;
	title: string;
	status: string;
	model?: string;
	thinking?: string;
	totalTokens?: number;
	toolCount: number;
}): string {
	const metaBits: string[] = [];
	if (parts.model) metaBits.push(parts.model);
	metaBits.push(`thinking=${parts.thinking ?? "default"}`);
	if (parts.totalTokens !== undefined) metaBits.push(`tokens=${parts.totalTokens}`);
	metaBits.push(`tools=${parts.toolCount}`);
	return (
		`${parts.index + 1}.` +
		theme.fg("accent", `(${parts.agent})`) +
		` ${parts.title}: ` +
		theme.fg(statusColor(parts.status), parts.status) +
		theme.fg("muted", ` ${metaBits.join(" ")}`)
	);
}

function resultText(result: SubagentRunResult): string {
	return result.results
		.map((item) => {
			const heading = `${item.index + 1}.(${item.agent}) ${displayTitle(item)}: ${item.status} ${item.model ?? ""} thinking=${item.thinking ?? "default"}${item.usage ? ` tokens=${item.usage.totalTokens}` : ""} tools=${toolCallCount(item.events)}`;
			const recent = recentToolCalls(item.events, 3);
			const body = item.error ? `Error: ${item.error}` : item.output;
			const parts = [heading];
			if (recent) parts.push(recent);
			if (body) parts.push(body);
			return parts.join("\n");
		})
		.join("\n\n");
}

function renderDetails(details: SubagentToolDetails | undefined, _expanded: boolean): string {
	if (!details) {
		return "";
	}
	if (details.result) {
		const lines = details.result.results.map((result) => {
			const base = coloredHeading({
				index: result.index,
				agent: result.agent,
				title: displayTitle(result),
				status: result.status,
				model: result.model,
				thinking: result.thinking,
				totalTokens: result.usage?.totalTokens,
				toolCount: toolCallCount(result.events),
			});
			const recent = recentToolCalls(result.events, 3);
			const coloredRecent = recent ? theme.fg("muted", recent) : "";
			const body = result.error
				? theme.fg("error", `Error: ${result.error}`)
				: result.output
					? theme.fg("toolOutput", result.output)
					: "";
			const parts = [base];
			if (coloredRecent) parts.push(coloredRecent);
			if (body) parts.push(body);
			return parts.join("\n");
		});
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
			const base = coloredHeading({
				index: event.index,
				agent: event.agent,
				title: displayTitle(event),
				status: event.status,
				model: event.model,
				thinking: event.thinking,
				toolCount: toolCallCount(itemEvents),
			});
			const recent = recentToolCalls(itemEvents, 3);
			const coloredRecent = recent ? theme.fg("muted", recent) : "";
			const parts = [base];
			if (coloredRecent) parts.push(coloredRecent);
			return parts.join("\n");
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
	const availableSkills = session.resourceLoader.getSkills().skills;
	const agentSummary = availableAgents
		.map((agent) => {
			const desc = formatSubagentDescription(agent, availableSkills);
			return `${agent.name} (${agent.scope}) - ${desc}`;
		})
		.join("; ");
	const parameterSummary = `agent must be one of: ${subagentNames.join(", ")}. Use subagentScope="project" or "both" for project-defined subagents.`;
	const usageGuidance =
		"Always use tasks[] even for a single subagent. For 2+ independent subagents, use one subagent call with tasks[] so they run concurrently. Use chain[] for sequential dependent work where each step references {previous}.";

	return defineTool({
		name: "subagent",
		label: "subagent",
		description: `Run one or more specialized in-memory subagents. ${parameterSummary} ${usageGuidance}`,
		promptSnippet:
			"subagent - run specialized in-memory subagents: explorer for fast search/discovery, worker for unit-scoped execution.",
		promptGuidelines: [
			`Available subagents for the subagent tool: ${agentSummary}`,
			`Subagent parameter options: ${parameterSummary}`,
			usageGuidance,
			"Use subagent for independent subtasks that benefit from a focused agent role.",
			"Do not use subagent recursively from inside subagents.",
			"Each task must include a concise title (2-6 words) summarizing what it does, e.g. '搜索数据库配置' or 'fix login CSS'. The title is displayed in the UI to identify subagent runs.",
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
			return new Text(lines || theme.fg("toolOutput", fallback), 0, 0);
		},
	});
}
