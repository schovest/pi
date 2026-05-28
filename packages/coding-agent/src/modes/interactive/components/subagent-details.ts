import { Container, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentRunEvent, SubagentRunResult, SubagentTaskResult } from "../../../core/subagents/types.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface SubagentDetailsData {
	result?: SubagentRunResult;
	events: SubagentRunEvent[];
}

interface SubagentDetailsItem {
	index: number;
	agent: string;
	task: string;
	status: string;
	model?: string;
	thinking?: string;
	output?: string;
	error?: string;
	totalTokens?: number;
	currentTool?: string;
	currentToolArgs?: string;
	toolResultSummary?: string;
	outputSummary?: string;
	events: SubagentRunEvent[];
}

function latestByIndex(events: SubagentRunEvent[]): Map<number, SubagentRunEvent> {
	const byIndex = new Map<number, SubagentRunEvent>();
	for (const event of events) {
		byIndex.set(event.index, event);
	}
	return byIndex;
}

function latestEvents(events: SubagentRunEvent[]): SubagentDetailsItem[] {
	const byIndex = latestByIndex(events);
	return Array.from(byIndex.values())
		.sort((a, b) => a.index - b.index)
		.map((event) => {
			const itemEvents = events.filter((candidate) => candidate.index === event.index);
			return {
				index: event.index,
				agent: event.agent,
				task: event.task,
				status: event.status,
				model: event.model,
				thinking: event.thinking,
				error: event.error,
				totalTokens: event.usage?.totalTokens,
				currentTool: latestDefined(itemEvents, (candidate) => candidate.currentTool),
				currentToolArgs: latestDefined(itemEvents, (candidate) => candidate.currentToolArgs),
				toolResultSummary: latestDefined(itemEvents, (candidate) => candidate.toolResultSummary),
				outputSummary: latestDefined(itemEvents, (candidate) => candidate.outputSummary),
				events: itemEvents,
			};
		});
}

function resultItems(data: SubagentDetailsData): SubagentDetailsItem[] {
	const latest = latestByIndex(data.events);
	if (!data.result) {
		return latestEvents(data.events);
	}
	return data.result.results.map((result: SubagentTaskResult) => {
		const latestEvent = latest.get(result.index);
		const resultEvents =
			result.events.length > 0 ? result.events : data.events.filter((event) => event.index === result.index);
		return {
			index: result.index,
			agent: result.agent,
			task: result.task,
			status: latestEvent?.status ?? result.status,
			model: latestEvent?.model ?? result.model,
			thinking: latestEvent?.thinking ?? result.thinking,
			output: result.output,
			error: latestEvent?.error ?? result.error,
			totalTokens: latestEvent?.usage?.totalTokens ?? result.usage?.totalTokens,
			currentTool: latestDefined(resultEvents, (event) => event.currentTool),
			currentToolArgs: latestDefined(resultEvents, (event) => event.currentToolArgs),
			toolResultSummary: latestDefined(resultEvents, (event) => event.toolResultSummary),
			outputSummary: latestDefined(resultEvents, (event) => event.outputSummary),
			events: resultEvents,
		};
	});
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

function statusColor(status: string): "success" | "error" | "warning" | "muted" {
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
				const tool = item.currentTool ? theme.fg("muted", ` tool=${item.currentTool}`) : "";
				const usage = item.totalTokens === undefined ? "" : theme.fg("muted", ` tokens=${item.totalTokens}`);
				this.addChild(new Text(`${pointer}${item.index + 1}. ${item.agent} ${status}${tool}${usage}`, 1, 0));
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

	invalidate(): void {
		// Render is derived directly from current data.
	}

	render(width: number): string[] {
		const item = this.getSelectedItem();
		const lines: string[] = [];
		lines.push(theme.fg("accent", theme.bold(`Subagent ${item?.agent ?? ""}`)).trimEnd());
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
				`model=${item.model ?? "default"} thinking=${item.thinking ?? "default"} index=${item.index + 1}`,
			),
		);
		lines.push(`${theme.bold("Task")} ${item.task}`);

		if (item.currentTool) {
			const args = item.currentToolArgs ? ` ${item.currentToolArgs}` : "";
			lines.push(`${theme.bold("Current Tool")} ${item.currentTool}${args}`);
		}
		if (item.toolResultSummary) {
			lines.push(`${theme.bold("Tool Result")} ${item.toolResultSummary}`);
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
