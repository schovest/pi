import { Container, getKeybindings, Spacer, Text, truncateToWidth } from "@schovest/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { SubagentRunEvent, SubagentRunResult, SubagentTaskResult } from "../../../core/subagents/types.ts";
import type { SubagentRunEntry } from "../../../core/types/subagent-entry.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface SubagentDetailsData {
	result?: SubagentRunResult;
	events: SubagentRunEvent[];
	children?: Map<number, AgentSession>;
	/** Historical subagent run entries loaded from session persistence */
	historicalEntries?: SubagentRunEntry[];
}

export interface SubagentDetailsItem {
	index: number;
	agent: string;
	task: string;
	title?: string;
	status: string;
	model?: string;
	thinking?: string;
	output?: string;
	error?: string;
	totalTokens?: number;
	toolCount: number;
	recentTools: string[];
	outputSummary?: string;
	events: SubagentRunEvent[];
	runId?: string;
	subagentEntryId?: string; // SubagentRunEntry.id，用于 getSubagentMessages
	timestamp?: string; // ISO timestamp for chronological sorting
}

function formatToolArgs(toolName: string, argsJson: string | undefined): string {
	if (!argsJson) return "";
	try {
		const args: Record<string, unknown> = JSON.parse(argsJson);
		switch (toolName) {
			case "bash":
				return typeof args.command === "string" ? truncate(args.command, 60) : truncate(argsJson, 60);
			case "read":
				return truncate(String(args.file_path ?? args.path ?? argsJson), 60);
			case "edit":
				return truncate(String(args.path ?? args.file_path ?? argsJson), 60);
			case "write":
				return truncate(String(args.path ?? args.file_path ?? argsJson), 60);
			case "ls":
				return truncate(String(args.path ?? args.dir ?? "."), 60);
			case "grep": {
				const pattern = String(args.pattern ?? "");
				const searchPath = args.path ? ` in ${args.path}` : "";
				const include = args.glob ? ` (${args.glob})` : "";
				return truncate(`/${pattern}/${searchPath}${include}`, 60);
			}
			case "find": {
				const pattern = String(args.pattern ?? args.glob ?? "");
				const searchPath = args.path ? ` in ${args.path}` : "";
				return truncate(`${pattern}${searchPath}`, 60);
			}
			default:
				return truncate(argsJson, 60);
		}
	} catch {
		return truncate(argsJson, 60);
	}
}

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function displayTitle(item: { title?: string; task: string }): string {
	return item.title ?? item.task.slice(0, 7);
}

function countToolCalls(events: SubagentRunEvent[]): number {
	return events.filter((e) => e.currentTool && e.currentToolArgs).length;
}

function extractRecentTools(events: SubagentRunEvent[], max: number): string[] {
	return events
		.filter((e) => e.currentTool && e.currentToolArgs)
		.slice(-max)
		.map((e) => {
			const args = formatToolArgs(e.currentTool!, e.currentToolArgs);
			return `${e.currentTool}${args ? ` ${args}` : ""}`;
		});
}

function latestByIndex(events: SubagentRunEvent[]): Map<number, SubagentRunEvent> {
	const byIndex = new Map<number, SubagentRunEvent>();
	for (const event of events) {
		byIndex.set(event.index, event);
	}
	return byIndex;
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

function latestEvents(events: SubagentRunEvent[]): SubagentDetailsItem[] {
	const byIndex = latestByIndex(events);
	return Array.from(byIndex.values())
		.sort((a, b) => a.index - b.index)
		.map((event) => {
			const itemEvents = events.filter((candidate) => candidate.index === event.index);
			// Use earliest event timestamp as creation time (stable across status updates)
			const startTimestamp = new Date(Math.min(...itemEvents.map((e) => e.timestamp))).toISOString();
			return {
				index: event.index,
				agent: event.agent,
				title: event.title,
				task: event.task,
				status: event.status,
				model: event.model,
				thinking: event.thinking,
				error: event.error,
				totalTokens: event.usage?.totalTokens,
				toolCount: countToolCalls(itemEvents),
				recentTools: extractRecentTools(itemEvents, 3),
				outputSummary: latestDefined(itemEvents, (candidate) => candidate.outputSummary),
				events: itemEvents,
				runId: event.runId,
				timestamp: startTimestamp,
			};
		});
}

export function resultItems(data: SubagentDetailsData): SubagentDetailsItem[] {
	const latest = latestByIndex(data.events);
	let items: SubagentDetailsItem[];

	if (!data.result) {
		items = latestEvents(data.events);
	} else {
		items = data.result.results.map((result: SubagentTaskResult) => {
			const latestEvent = latest.get(result.index);
			const resultEvents =
				result.events.length > 0 ? result.events : data.events.filter((event) => event.index === result.index);
			// Extract runId from events (all events in one call share the same runId prefix)
			const eventRunId = resultEvents.length > 0 ? resultEvents[0].runId : undefined;
			// Use earliest event timestamp as the start time
			const startTimestamp =
				resultEvents.length > 0
					? new Date(Math.min(...resultEvents.map((e) => e.timestamp))).toISOString()
					: undefined;
			return {
				index: result.index,
				agent: result.agent,
				title: result.title,
				task: result.task,
				status: latestEvent?.status ?? result.status,
				model: latestEvent?.model ?? result.model,
				thinking: latestEvent?.thinking ?? result.thinking,
				output: result.output,
				error: latestEvent?.error ?? result.error,
				totalTokens: latestEvent?.usage?.totalTokens ?? result.usage?.totalTokens,
				toolCount: countToolCalls(resultEvents),
				recentTools: extractRecentTools(resultEvents, 3),
				outputSummary: latestDefined(resultEvents, (event) => event.outputSummary),
				events: resultEvents,
				runId: eventRunId,
				timestamp: startTimestamp,
			};
		});
	}

	// Add historical entries not already covered by live data.
	// Use runId:index for dedup: different subagent calls have different runIds,
	// so entries from previous calls are not mistakenly skipped by matching on
	// the non-unique task index alone. Same runId + same index = same subagent run.
	if (data.historicalEntries && data.historicalEntries.length > 0) {
		const liveKeys = new Set(
			items.filter((item) => item.runId !== undefined).map((item) => `${item.runId}:${item.index}`),
		);
		for (const entry of data.historicalEntries) {
			const key = `${entry.runId}:${entry.index}`;
			if (!liveKeys.has(key)) {
				items.push({
					index: entry.index,
					agent: entry.agent,
					title: entry.title,
					task: entry.task,
					status: entry.status,
					model: entry.model,
					thinking: entry.thinking,
					error: entry.error,
					totalTokens: entry.totalTokens,
					toolCount: entry.toolCount,
					recentTools: [],
					outputSummary: entry.outputSummary,
					events: [],
					runId: entry.runId,
					subagentEntryId: entry.id,
					timestamp: entry.timestamp,
				});
			}
		}
	}

	// Preserve insertion order: live items first (by index), then historical entries.
	// Do NOT sort by timestamp — sorting mixes live and historical items with the
	// same task index, causing getChildSession(index) to return the wrong session.
	return items;
}

export function statusColor(status: string): "success" | "error" | "warning" | "muted" {
	if (status === "success") return "success";
	if (status === "failed" || status === "aborted") return "error";
	if (status === "running") return "warning";
	return "muted";
}

function clampSelectedIndex(selectedIndex: number, itemCount: number): number {
	if (itemCount === 0) return 0;
	return Math.max(0, Math.min(selectedIndex, itemCount - 1));
}

function eventText(event: SubagentRunEvent): string {
	const parts: string[] = [event.status];
	if (event.currentTool) {
		const args = event.currentToolArgs ? ` ${event.currentToolArgs}` : "";
		parts.push(`tool=${event.currentTool}${args}`);
	}
	if (event.toolResultSummary) parts.push(`result=${event.toolResultSummary}`);
	if (event.outputSummary) {
		parts.push(
			event.currentTool || event.toolResultSummary || event.error
				? `output=${event.outputSummary}`
				: "assistant output update",
		);
	}
	if (event.error) parts.push(`error=${event.error}`);
	if (event.usage?.totalTokens !== undefined) parts.push(`tokens=${event.usage.totalTokens}`);
	return parts.join(" ");
}

export function compactEventTexts(events: SubagentRunEvent[]): Array<{ text: string; count: number }> {
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

export class SubagentPickerComponent extends Container {
	private data: SubagentDetailsData;
	private selectedIndex = 0;
	private onSelect: (index: number) => void;
	private onCancel: () => void;

	constructor(data: SubagentDetailsData, onSelect: (index: number) => void, onCancel: () => void) {
		super();
		this.data = data;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.rebuild();
	}

	update(data: SubagentDetailsData): void {
		this.data = data;
		this.selectedIndex = clampSelectedIndex(this.selectedIndex, resultItems(data).length);
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const items = resultItems(this.data);
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.rebuild();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
			this.rebuild();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = items[this.selectedIndex];
			if (selected) this.onSelect(selected.index);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	private rebuild(): void {
		this.clear();
		const items = resultItems(this.data);
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Select a subagent")), 1, 0));
		this.addChild(new Spacer(1));

		if (items.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No subagent runs captured yet."), 1, 0));
		} else {
			for (let index = 0; index < items.length; index++) {
				const item = items[index];
				const selected = index === this.selectedIndex;
				const pointer = selected ? theme.fg("accent", "-> ") : "   ";
				const status = theme.fg(statusColor(item.status), item.status);
				const usage = item.totalTokens === undefined ? "" : theme.fg("muted", ` tokens=${item.totalTokens}`);
				const tools = theme.fg("muted", ` tools=${item.toolCount}`);
				const lastTool = item.recentTools.length > 0 ? theme.fg("muted", ` → ${item.recentTools.at(-1)}`) : "";
				this.addChild(
					new Text(
						`${pointer}${item.index + 1}.${theme.fg("accent", `(${item.agent})`)} ${displayTitle(item)} ${status}${usage}${tools}${lastTool}`,
						1,
						0,
					),
				);
			}
		}

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${rawKeyHint("↑↓/j/k", "navigate")}  ${keyHint("tui.select.confirm", "enter")}  ${keyHint("tui.select.cancel", "close")}`,
				1,
				0,
			),
		);
		this.addChild(new DynamicBorder());
	}
}

export class SubagentRunViewComponent {
	private data: SubagentDetailsData;
	private selectedIndex: number;
	private onCancel: () => void;

	constructor(data: SubagentDetailsData, selectedIndex: number, onCancel: () => void) {
		this.data = data;
		this.selectedIndex = selectedIndex;
		this.onCancel = onCancel;
	}

	update(data: SubagentDetailsData): void {
		this.data = data;
	}

	getAgentName(): string | undefined {
		return this.getSelectedItem()?.agent;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const item = this.getSelectedItem();
		const lines: string[] = [];
		lines.push(theme.fg("accent", theme.bold(`Subagent ${item ? displayTitle(item) : ""}`)).trimEnd());
		lines.push(theme.fg("muted", "Esc returns to the main Agent"));
		lines.push("");

		if (!item) {
			lines.push(theme.fg("muted", "No subagent run is selected."));
			return lines.map((line) => truncateToWidth(line, width, "..."));
		}

		const status = theme.fg(statusColor(item.status), item.status);
		const usage = item.totalTokens === undefined ? "" : ` tokens=${item.totalTokens}`;
		lines.push(`${theme.bold("Status")} ${status}${theme.fg("muted", usage)}`);
		lines.push(
			theme.fg(
				"muted",
				`model=${item.model ?? "default"} thinking=${item.thinking ?? "default"} index=${item.index + 1} tools=${item.toolCount}`,
			),
		);
		lines.push(`${theme.bold("Task")} ${item.task}`);

		lines.push(theme.bold("Recent Tools") + theme.fg("muted", ` (${item.toolCount} total)`));
		if (item.recentTools.length > 0) {
			for (const tool of item.recentTools) {
				lines.push(theme.fg("muted", `  --${tool}`));
			}
		} else {
			lines.push(theme.fg("muted", "  (no tool calls)"));
		}

		if (item.outputSummary) {
			lines.push(`${theme.bold("Latest Output")} ${item.outputSummary}`);
		}
		if (item.error) {
			lines.push(theme.fg("error", `${theme.bold("Error")} ${item.error}`));
		}
		if (item.output) {
			lines.push("");
			lines.push(theme.bold("Final Output"));
			for (const line of item.output.split("\n")) {
				lines.push(theme.fg("toolOutput", line));
			}
		}

		lines.push("");
		lines.push(theme.bold("Events"));
		const events = compactEventTexts(item.events).slice(-16);
		if (events.length === 0) {
			lines.push(theme.fg("muted", "No events captured yet."));
		} else {
			for (const event of events) {
				const repeated = event.count > 1 ? ` (repeated ${event.count}x)` : "";
				lines.push(theme.fg("muted", `- ${event.text}${repeated}`));
			}
		}

		return lines.map((line) => truncateToWidth(line, width, "..."));
	}

	private getSelectedItem(): SubagentDetailsItem | undefined {
		const items = resultItems(this.data);
		return items.find((item) => item.index === this.selectedIndex) ?? items[0];
	}
}
