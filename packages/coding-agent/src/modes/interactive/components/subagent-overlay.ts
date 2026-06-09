import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, getKeybindings, matchesKey, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.ts";
import type { SubagentTaskResult } from "../../../core/subagents/types.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";
import {
	displayTitle,
	resultItems,
	type SubagentDetailsData,
	type SubagentDetailsItem,
	statusColor,
} from "./subagent-details.ts";

export interface SubagentOverlayOptions {
	data: SubagentDetailsData;
	onClose: () => void;
	renderMessages: (messages: AgentMessage[], container: Container, expanded: boolean) => void;
	getChildSession: (index: number) => AgentSession | undefined;
	requestRender: () => void;
	getTerminalHeight: () => number;
	/** Load historical subagent messages from inline session data */
	getSubagentMessages?: (subagentEntryId: string) => AgentMessage[];
}

interface AgentListItem {
	index: number;
	agent: string;
	title?: string;
	task: string;
	status: string;
	model?: string;
	thinking?: string;
	totalTokens?: number;
	toolCount: number;
	recentTools: string[];
	runId?: string;
	subagentEntryId?: string;
}

function toListItems(data: SubagentDetailsData): AgentListItem[] {
	return resultItems(data).map((item: SubagentDetailsItem) => ({
		index: item.index,
		agent: item.agent,
		title: item.title,
		task: item.task,
		status: item.status,
		model: item.model,
		thinking: item.thinking,
		totalTokens: item.totalTokens,
		toolCount: item.toolCount,
		recentTools: item.recentTools,
		runId: item.runId,
		subagentEntryId: item.subagentEntryId,
	}));
}

export class SubagentOverlayComponent extends Container {
	private data: SubagentDetailsData;
	private onClose: () => void;
	private renderMessages: (messages: AgentMessage[], container: Container, expanded: boolean) => void;
	private getChildSession: (index: number) => AgentSession | undefined;
	private requestRender: () => void;
	private getTerminalHeight: () => number;
	private getSubagentMessages?: (subagentEntryId: string) => AgentMessage[];

	private selectedIndex = 0;
	private expanded = false;
	private detailScrollOffset = 0;

	private leftPanel: Container;
	private rightPanel: Container;
	private rightContent: Container;
	private rightFooter: Container;

	private childUnsubscribe: (() => void) | undefined;

	constructor(options: SubagentOverlayOptions) {
		super();
		this.data = options.data;
		this.onClose = options.onClose;
		this.renderMessages = options.renderMessages;
		this.getChildSession = options.getChildSession;
		this.requestRender = options.requestRender;
		this.getTerminalHeight = options.getTerminalHeight;
		this.getSubagentMessages = options.getSubagentMessages;

		this.leftPanel = new Container();
		this.rightPanel = new Container();
		this.rightContent = new Container();
		this.rightFooter = new Container();

		this.rebuild();
		this.subscribeToSelectedChild();
	}

	/** Clean up subscriptions when the overlay is destroyed. */
	destroy(): void {
		this.unsubscribeFromChild();
	}

	update(data: SubagentDetailsData): void {
		this.data = data;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, toListItems(data).length - 1));
		this.rebuild();
		this.subscribeToSelectedChild();
	}

	handleInput(keyData: string): boolean {
		const kb = getKeybindings();
		const items = toListItems(this.data);

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onClose();
			return true;
		}

		// ↑/↓/j/k — left panel list navigation
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = this.selectedIndex <= 0 ? items.length - 1 : this.selectedIndex - 1;
			this.detailScrollOffset = 0;
			this.rebuild();
			this.subscribeToSelectedChild();
			return true;
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = this.selectedIndex >= items.length - 1 ? 0 : this.selectedIndex + 1;
			this.detailScrollOffset = 0;
			this.rebuild();
			this.subscribeToSelectedChild();
			return true;
		}

		// Ctrl-O — toggle expand/collapse
		if (keyData === "\x0f") {
			this.expanded = !this.expanded;
			this.rebuildRightPanel();
			return true;
		}

		// Right panel scrolling — PgUp/PgDn, Home/End, mouse wheel
		const pageAmount = this.getTerminalHeight() - 4;
		if (keyData === "\x1b[scrollUp") {
			this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 3);
			this.rebuildRightPanel();
			this.requestRender();
			return true;
		} else if (keyData === "\x1b[scrollDown") {
			this.detailScrollOffset += 3;
			this.rebuildRightPanel();
			this.requestRender();
			return true;
		} else if (matchesKey(keyData, "pageUp")) {
			this.detailScrollOffset = Math.max(0, this.detailScrollOffset - pageAmount);
			this.rebuildRightPanel();
			this.requestRender();
			return true;
		} else if (matchesKey(keyData, "pageDown")) {
			this.detailScrollOffset += pageAmount;
			this.rebuildRightPanel();
			this.requestRender();
			return true;
		} else if (matchesKey(keyData, "home") || keyData === "g") {
			this.detailScrollOffset = 0;
			this.rebuildRightPanel();
			this.requestRender();
			return true;
		} else if (matchesKey(keyData, "end") || keyData === "G") {
			this.detailScrollOffset = Number.MAX_SAFE_INTEGER;
			this.clampScrollOffset();
			this.rebuildRightPanel();
			this.requestRender();
			return true;
		}

		return false;
	}

	private rebuild(): void {
		this.leftPanel.clear();
		this.rightPanel.clear();

		this.rebuildLeftPanel();
		this.rebuildRightPanel();
	}

	private rebuildLeftPanel(): void {
		this.leftPanel.clear();
		const items = toListItems(this.data);
		const running = items.filter((i) => i.status === "running").length;
		const completed = items.filter((i) => i.status !== "running").length;

		this.leftPanel.addChild(new DynamicBorder());
		this.leftPanel.addChild(
			new Text(
				theme.fg("accent", theme.bold(`Subagents`)) +
					theme.fg("muted", ` (${running} running, ${completed} done)`) +
					theme.fg("dim", `  Esc close`),
				1,
				0,
			),
		);
		this.leftPanel.addChild(new Spacer(1));

		if (items.length === 0) {
			this.leftPanel.addChild(new Text(theme.fg("muted", "No subagent runs."), 1, 0));
		} else {
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				const selected = i === this.selectedIndex;
				const pointer = selected ? theme.fg("accent", "> ") : "  ";
				const status = theme.fg(statusColor(item.status), item.status);
				const usage = item.totalTokens === undefined ? "" : theme.fg("muted", ` t=${item.totalTokens}`);
				const tools = theme.fg("muted", ` tools=${item.toolCount}`);
				const lastTool = item.recentTools.length > 0 ? theme.fg("muted", ` -> ${item.recentTools.at(-1)}`) : "";
				this.leftPanel.addChild(
					new Text(`${pointer}${i + 1}. ${displayTitle(item)} ${status}${usage}${tools}${lastTool}`, 1, 0),
				);
			}
		}

		this.leftPanel.addChild(new Spacer(1));
		this.leftPanel.addChild(new Text(`${rawKeyHint("↑↓/j/k", "nav")}  ${rawKeyHint("Esc", "close")}`, 1, 0));
		this.leftPanel.addChild(new DynamicBorder());
	}

	private rebuildRightPanel(): void {
		this.rightPanel.clear();
		this.rightContent.clear();
		this.rightFooter.clear();

		const items = toListItems(this.data);
		const item = items[this.selectedIndex];
		const detailsItem = resultItems(this.data)[this.selectedIndex];

		if (!item) {
			this.rightPanel.addChild(new Text(theme.fg("muted", "Select a subagent"), 1, 0));
			return;
		}

		const status = theme.fg(statusColor(item.status), item.status);
		const usage = item.totalTokens === undefined ? "" : ` tokens=${item.totalTokens}`;

		this.rightPanel.addChild(new DynamicBorder());
		this.rightPanel.addChild(
			new Text(
				theme.bold(`${displayTitle(item)}`) +
					` ${status}` +
					theme.fg(
						"muted",
						`${usage} model=${item.model ?? "default"} thinking=${item.thinking ?? "default"} agent=${item.agent}`,
					),
				1,
				0,
			),
		);
		this.rightPanel.addChild(new Text(theme.fg("muted", `Task: ${detailsItem?.task ?? ""}`), 1, 0));
		this.rightPanel.addChild(new Spacer(1));

		const messages = this.getMessagesForAgent(item);
		// Completed subagents (no live child session) default to expanded view
		const isCompleted = item.status !== "running" && !this.getChildSession(item.index);
		const effectiveExpanded = this.expanded || isCompleted;
		if (messages.length > 0) {
			this.renderMessages(messages, this.rightContent, effectiveExpanded);
		} else {
			this.rightContent.addChild(new Text(theme.fg("muted", "(no messages yet)"), 1, 0));
		}

		this.rightPanel.addChild(this.rightContent);

		this.rightFooter.addChild(new Spacer(1));
		this.rightFooter.addChild(new DynamicBorder());
		this.rightFooter.addChild(
			new Text(
				`${rawKeyHint("Ctrl-O", this.expanded ? "collapse" : "expand")}  ${rawKeyHint("PgUp/PgDn/Home/End", "scroll")}`,
				1,
				0,
			),
		);
		this.rightPanel.addChild(this.rightFooter);
	}

	private subscribeToSelectedChild(): void {
		this.unsubscribeFromChild();

		const items = toListItems(this.data);
		const item = items[this.selectedIndex];
		if (!item) return;

		const child = this.getChildSession(item.index);
		if (!child) return;

		this.childUnsubscribe = child.subscribe((event: AgentSessionEvent) => {
			switch (event.type) {
				case "message_start":
				case "message_update":
				case "message_end":
				case "tool_execution_start":
				case "tool_execution_update":
				case "tool_execution_end":
					this.rebuildRightPanel();
					this.requestRender();
					break;
				case "agent_end":
					this.rebuildRightPanel();
					this.requestRender();
					this.childUnsubscribe = undefined;
					break;
			}
		});
	}

	private unsubscribeFromChild(): void {
		if (this.childUnsubscribe) {
			this.childUnsubscribe();
			this.childUnsubscribe = undefined;
		}
	}

	private getMessagesForAgent(item: AgentListItem): AgentMessage[] {
		// 1. Live child session
		const child = this.getChildSession(item.index);
		if (child) {
			return child.messages;
		}
		// 2. Result from current run
		if (this.data.result) {
			const taskResult = this.data.result.results.find(
				(r: SubagentTaskResult) =>
					r.index === item.index && (item.runId === undefined || r.events.some((e) => e.runId === item.runId)),
			);
			if (taskResult) {
				return taskResult.messages;
			}
		}
		// 3. Inline historical messages from parent session (by subagentEntryId)
		if (this.getSubagentMessages && item.subagentEntryId) {
			return this.getSubagentMessages(item.subagentEntryId);
		}
		return [];
	}

	/** Clamp scroll offset to valid range based on current content. */
	private clampScrollOffset(): void {
		// Use a reasonable width estimate (80% of terminal) for measurement.
		// The final clamp happens in render() which uses the actual width,
		// so this is just an approximate cap to avoid hugely inflated offsets.
		const termHeight = this.getTerminalHeight();
		const estimatedWidth = Math.max(40, Math.floor(process.stdout.columns * 0.7));
		const rightLines = this.rightPanel.render(estimatedWidth);
		const maxOffset = Math.max(0, rightLines.length - termHeight);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxOffset));
	}

	/** Calculate the left panel (list) width for a given total width. */
	static getListWidth(width: number): number {
		return Math.max(20, Math.min(40, Math.floor(width * 0.3)));
	}

	render(width: number): string[] {
		const listWidth = SubagentOverlayComponent.getListWidth(width);
		const detailWidth = width - listWidth - 1;
		const termHeight = this.getTerminalHeight();
		const sep = theme.fg("border", "│");

		const leftLines = this.leftPanel.render(listWidth);
		const rightLines = this.rightPanel.render(Math.max(1, detailWidth));

		const maxOffset = Math.max(0, rightLines.length - termHeight);
		const scrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxOffset));
		// Sync the stored offset to the clamped value so that subsequent
		// scroll operations (PageUp/k) start from the visually correct position.
		// Without this, a stale inflated offset (e.g. from clampScrollOffset
		// using width=1) causes PageUp to appear unresponsive.
		this.detailScrollOffset = scrollOffset;

		const visibleRight = rightLines.slice(scrollOffset, scrollOffset + termHeight);
		while (visibleRight.length < termHeight) {
			visibleRight.push("");
		}

		const result: string[] = [];
		for (let i = 0; i < termHeight; i++) {
			const left = i < leftLines.length ? leftLines[i] : "";
			const right = visibleRight[i] ?? "";
			const leftPadded = padToWidth(left, listWidth);
			result.push(leftPadded + sep + right);
		}

		return result;
	}
}

function padToWidth(line: string, width: number): string {
	const currentWidth = visibleWidth(line);
	if (currentWidth >= width) return line;
	return line + " ".repeat(width - currentWidth);
}
