import { Container, getKeybindings, Spacer, Text, truncateToWidth } from "@schovest/pi-tui";
import type { SubagentDefinition, SubagentRunEvent, SubagentRunResult } from "../../../core/subagents/types.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import type { SubagentDetailsData } from "./subagent-details.ts";

interface SubagentsPanelOptions {
	subagents: SubagentDefinition[];
	subagentDetails?: SubagentDetailsData;
	onClose: () => void;
}

interface AgentRunState {
	status: string;
	task: string;
	currentTool?: string;
	currentToolArgs?: string;
	totalTokens?: number;
	error?: string;
	events: SubagentRunEvent[];
}

function statusColor(status: string): "success" | "error" | "warning" | "muted" {
	if (status === "success") return "success";
	if (status === "failed" || status === "aborted") return "error";
	if (status === "running") return "warning";
	return "muted";
}

function latestDefined<T>(
	events: SubagentRunEvent[],
	select: (event: SubagentRunEvent) => T | undefined,
): T | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const value = select(events[index]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function eventText(event: SubagentRunEvent): string {
	const parts: string[] = [event.status];
	if (event.currentTool) {
		const args = event.currentToolArgs ? ` ${event.currentToolArgs}` : "";
		parts.push(`tool=${event.currentTool}${args}`);
	}
	if (event.toolResultSummary) parts.push(`result=${event.toolResultSummary}`);
	if (event.outputSummary) parts.push(`output=${event.outputSummary}`);
	if (event.error) parts.push(`error=${event.error}`);
	if (event.usage?.totalTokens !== undefined) parts.push(`tokens=${event.usage.totalTokens}`);
	return parts.join(" ");
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function promptSummary(prompt: string): string {
	const summary = oneLine(prompt);
	return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
}

function latestResultForAgent(result: SubagentRunResult | undefined, agent: string): AgentRunState | undefined {
	if (!result) {
		return undefined;
	}
	const matches = result.results.filter((item) => item.agent === agent);
	const latest = matches.at(-1);
	if (!latest) {
		return undefined;
	}
	const events = latest.events;
	return {
		status: latest.status,
		task: latest.task,
		currentTool: latestDefined(events, (event) => event.currentTool),
		currentToolArgs: latestDefined(events, (event) => event.currentToolArgs),
		totalTokens: latest.usage?.totalTokens,
		error: latest.error,
		events,
	};
}

function latestEventRunForAgent(events: SubagentRunEvent[], agent: string): AgentRunState | undefined {
	const matches = events.filter((event) => event.agent === agent);
	const latest = matches.at(-1);
	if (!latest) {
		return undefined;
	}
	return {
		status: latest.status,
		task: latest.task,
		currentTool: latestDefined(matches, (event) => event.currentTool),
		currentToolArgs: latestDefined(matches, (event) => event.currentToolArgs),
		totalTokens: latest.usage?.totalTokens,
		error: latest.error,
		events: matches,
	};
}

function latestRunForAgent(data: SubagentDetailsData | undefined, agent: string): AgentRunState | undefined {
	if (!data) {
		return undefined;
	}
	return latestResultForAgent(data.result, agent) ?? latestEventRunForAgent(data.events, agent);
}

export class SubagentsPanelComponent extends Container {
	private subagents: SubagentDefinition[];
	private subagentDetails: SubagentDetailsData | undefined;
	private selectedIndex = 0;
	private onClose: () => void;

	constructor(options: SubagentsPanelOptions) {
		super();
		this.subagents = options.subagents;
		this.subagentDetails = options.subagentDetails;
		this.onClose = options.onClose;
		this.rebuild();
	}

	updateSubagentDetails(data: SubagentDetailsData): void {
		this.subagentDetails = data;
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.rebuild();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.subagents.length - 1, this.selectedIndex + 1);
			this.rebuild();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onClose();
		}
	}

	private rebuild(): void {
		this.clear();
		this.selectedIndex = this.subagents.length === 0 ? 0 : Math.min(this.selectedIndex, this.subagents.length - 1);
		const selected = this.subagents[this.selectedIndex];

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
		this.addChild(new Spacer(1));

		if (this.subagents.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No subagent definitions are available."), 1, 0));
		} else {
			for (let index = 0; index < this.subagents.length; index++) {
				const agent = this.subagents[index];
				const run = latestRunForAgent(this.subagentDetails, agent.name);
				const pointer = index === this.selectedIndex ? theme.fg("accent", "-> ") : "   ";
				const status = run?.status ?? "idle";
				const description = oneLine(agent.description);
				const location = agent.sourcePath ?? "builtin";
				this.addChild(
					new Text(
						`${pointer}${agent.name} ${theme.fg("muted", `[${agent.scope}]`)} ${theme.fg(
							statusColor(status),
							status,
						)} ${theme.fg("muted", `${description} @ ${location}`)}`,
						1,
						0,
					),
				);
			}
		}

		this.addChild(new Spacer(1));
		if (selected) {
			this.addDefinitionDetails(selected);
			this.addChild(new Spacer(1));
			this.addRunDetails(selected);
			this.addChild(new Spacer(1));
		}

		this.addChild(new Text(`${rawKeyHint("↑↓/j/k", "navigate")}  ${keyHint("tui.select.cancel", "close")}`, 1, 0));
		this.addChild(new DynamicBorder());
	}

	private addDefinitionDetails(agent: SubagentDefinition): void {
		this.addChild(new Text(theme.bold("Definition"), 1, 0));
		this.addChild(new Text(`${theme.bold("Description")} ${agent.description}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Prompt")} ${promptSummary(agent.prompt)}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Scope")} ${agent.scope}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Location")} ${agent.sourcePath ?? "builtin"}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Model")} ${agent.model ?? "default"}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Thinking")} ${agent.thinking ?? "default"}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Included tools")} ${agent.includedTools?.join(", ") ?? "all"}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Excluded tools")} ${agent.excludedTools?.join(", ") ?? "none"}`, 1, 0));
		const lifecycle =
			agent.scope === "builtin"
				? "Builtin definitions are compiled into this Pi distribution."
				: "User and project definitions are loaded from markdown files and override lower-priority definitions by name.";
		this.addChild(new Text(`${theme.bold("Lifecycle")} ${lifecycle}`, 1, 0));
	}

	private addRunDetails(agent: SubagentDefinition): void {
		this.addChild(new Text(theme.bold("Latest Run"), 1, 0));
		const run = latestRunForAgent(this.subagentDetails, agent.name);
		if (!run) {
			this.addChild(new Text(theme.fg("muted", `No subagent run captured for ${agent.name}.`), 1, 0));
			return;
		}

		this.addChild(new Text(`${theme.bold("Status")} ${theme.fg(statusColor(run.status), run.status)}`, 1, 0));
		this.addChild(new Text(`${theme.bold("Task")} ${run.task}`, 1, 0));
		if (run.currentTool) {
			const args = run.currentToolArgs ? ` ${run.currentToolArgs}` : "";
			this.addChild(new Text(`${theme.bold("Tool")} ${run.currentTool}${args}`, 1, 0));
		}
		if (run.totalTokens !== undefined) {
			this.addChild(new Text(`${theme.bold("Tokens")} ${run.totalTokens}`, 1, 0));
		}
		if (run.error) {
			this.addChild(new Text(theme.fg("error", `${theme.bold("Error")} ${run.error}`), 1, 0));
		}

		this.addChild(new Text(theme.bold("Recent Events"), 1, 0));
		for (const event of run.events.slice(-8)) {
			this.addChild(new Text(theme.fg("muted", `- ${eventText(event)}`), 1, 0));
		}
	}

	render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(line, width, "..."));
	}
}
