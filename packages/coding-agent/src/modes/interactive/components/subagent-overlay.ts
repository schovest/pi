import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, getKeybindings, matchesKey, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { SubagentTaskResult } from "../../../core/subagents/types.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";
import { resultItems, type SubagentDetailsData, type SubagentDetailsItem, statusColor } from "./subagent-details.ts";

export interface SubagentOverlayOptions {
	data: SubagentDetailsData;
	onClose: () => void;
	renderMessages: (messages: AgentMessage[], container: Container, expanded: boolean) => void;
	getChildSession: (index: number) => AgentSession | undefined;
}

interface AgentListItem {
	index: number;
	agent: string;
	status: string;
	model?: string;
	thinking?: string;
	totalTokens?: number;
	toolCount: number;
	recentTools: string[];
}

function toListItems(data: SubagentDetailsData): AgentListItem[] {
	return resultItems(data).map((item: SubagentDetailsItem) => ({
		index: item.index,
		agent: item.agent,
		status: item.status,
		model: item.model,
		thinking: item.thinking,
		totalTokens: item.totalTokens,
		toolCount: item.toolCount,
		recentTools: item.recentTools,
	}));
}

export class SubagentOverlayComponent extends Container {
	private data: SubagentDetailsData;
	private onClose: () => void;
	private renderMessages: (messages: AgentMessage[], container: Container, expanded: boolean) => void;
	private getChildSession: (index: number) => AgentSession | undefined;

	private selectedIndex = 0;
	private focusedPane: "list" | "detail" = "list";
	private expanded = false;
	private detailScrollOffset = 0;

	private leftPanel: Container;
	private rightPanel: Container;
	private rightContent: Container;
	private rightFooter: Container;

	constructor(options: SubagentOverlayOptions) {
		super();
		this.data = options.data;
		this.onClose = options.onClose;
		this.renderMessages = options.renderMessages;
		this.getChildSession = options.getChildSession;

		this.leftPanel = new Container();
		this.rightPanel = new Container();
		this.rightContent = new Container();
		this.rightFooter = new Container();

		this.rebuild();
	}

	update(data: SubagentDetailsData): void {
		this.data = data;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, toListItems(data).length - 1));
		this.rebuild();
	}

	handleInput(keyData: string): boolean {
		const kb = getKeybindings();
		const items = toListItems(this.data);

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onClose();
			return true;
		}

		if (this.focusedPane === "list") {
			if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.detailScrollOffset = 0;
				this.rebuild();
				return true;
			} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
				this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
				this.detailScrollOffset = 0;
				this.rebuild();
				return true;
			} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n" || keyData === "\t") {
				this.focusedPane = "detail";
				this.rebuild();
				return true;
			}
		} else {
			if (keyData === "\t") {
				this.focusedPane = "list";
				this.rebuild();
				return true;
			} else if (keyData === "\x0f") {
				this.expanded = !this.expanded;
				this.rebuildRightPanel();
				return true;
			} else if (this.focusedPane === "detail") {
				const termHeight = process.stdout.rows || 24;
				const pageAmount = termHeight - 4;
				if (matchesKey(keyData, "pageUp") || keyData === "\x1b[scrollUp") {
					this.detailScrollOffset = Math.max(0, this.detailScrollOffset - pageAmount);
					return true;
				} else if (matchesKey(keyData, "pageDown") || keyData === "\x1b[scrollDown") {
					this.detailScrollOffset += pageAmount;
					return true;
				} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
					this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
					return true;
				} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
					this.detailScrollOffset++;
					return true;
				}
			}
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
				const focused = this.focusedPane === "list";
				const pointer = selected && focused ? theme.fg("accent", "> ") : "  ";
				const status = theme.fg(statusColor(item.status), item.status);
				const usage = item.totalTokens === undefined ? "" : theme.fg("muted", ` t=${item.totalTokens}`);
				const tools = theme.fg("muted", ` tools=${item.toolCount}`);
				const lastTool = item.recentTools.length > 0 ? theme.fg("muted", ` -> ${item.recentTools.at(-1)}`) : "";
				this.leftPanel.addChild(
					new Text(`${pointer}${item.index + 1}. ${item.agent} ${status}${usage}${tools}${lastTool}`, 1, 0),
				);
			}
		}

		this.leftPanel.addChild(new Spacer(1));
		this.leftPanel.addChild(
			new Text(
				`${rawKeyHint("j/k", "nav")}  ${rawKeyHint("Enter/Tab", "detail")}  ${rawKeyHint("Esc", "close")}`,
				1,
				0,
			),
		);
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
				theme.bold(`${item.agent}`) +
					` ${status}` +
					theme.fg("muted", `${usage} model=${item.model ?? "default"} thinking=${item.thinking ?? "default"}`),
				1,
				0,
			),
		);
		this.rightPanel.addChild(new Text(theme.fg("muted", `Task: ${detailsItem?.task ?? ""}`), 1, 0));
		this.rightPanel.addChild(new Spacer(1));

		const messages = this.getMessagesForAgent(item.index);
		if (messages.length > 0) {
			this.renderMessages(messages, this.rightContent, this.expanded);
		} else {
			this.rightContent.addChild(new Text(theme.fg("muted", "(no messages yet)"), 1, 0));
		}

		this.rightPanel.addChild(this.rightContent);

		this.rightFooter.addChild(new Spacer(1));
		this.rightFooter.addChild(new DynamicBorder());
		this.rightFooter.addChild(
			new Text(
				`${rawKeyHint("Tab", "list")}  ${rawKeyHint("Ctrl-O", this.expanded ? "collapse" : "expand")}  ${rawKeyHint("j/k/PgUp/PgDn", "scroll")}`,
				1,
				0,
			),
		);
		this.rightPanel.addChild(this.rightFooter);
	}

	private getMessagesForAgent(index: number): AgentMessage[] {
		const child = this.getChildSession(index);
		if (child) {
			return child.messages;
		}
		if (this.data.result) {
			const taskResult = this.data.result.results.find((r: SubagentTaskResult) => r.index === index);
			if (taskResult) {
				return taskResult.messages;
			}
		}
		return [];
	}

	render(width: number): string[] {
		const listWidth = Math.max(20, Math.min(40, Math.floor(width * 0.3)));
		const detailWidth = width - listWidth - 1;
		const termHeight = process.stdout.rows || 24;
		const sep = theme.fg("border", "│");

		const leftLines = this.leftPanel.render(listWidth);
		const rightLines = this.rightPanel.render(Math.max(1, detailWidth));

		const maxOffset = Math.max(0, rightLines.length - termHeight);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxOffset));

		const visibleRight = rightLines.slice(this.detailScrollOffset, this.detailScrollOffset + termHeight);
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
