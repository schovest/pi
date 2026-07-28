import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { type Component, Container, Spacer, Text, TUI } from "@schovest/pi-tui";
import { describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}
function assistantMsg(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
function toolResultMsg(toolCallId: string, toolName: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details: undefined,
		isError: false,
		timestamp: Date.now(),
	};
}

function makeMockTerminal(columns: number, rows: number) {
	let onInput: ((d: string) => void) | undefined;
	let onResize: (() => void) | undefined;
	return {
		start(i: (d: string) => void, r: () => void) {
			onInput = i;
			onResize = r;
		},
		stop() {},
		drainInput() {
			return Promise.resolve();
		},
		write() {},
		get columns() {
			return columns;
		},
		get rows() {
			return rows;
		},
		get kittyProtocolActive() {
			return true;
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		enterAlternateScreen() {},
		exitAlternateScreen() {},
		enableMouseTracking() {},
		disableMouseTracking() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		get stdinBuffer() {
			return undefined;
		},
		triggerResize: () => onResize?.(),
		sendInput: (d: string) => onInput?.(d),
	};
}

interface TuiInternals {
	children: Component[];
	currentFullLines: string[];
	currentScrollableViewportTop: number;
}

// Faithful copy of InteractiveMode.renderSessionContext's entryIdToComponent mapping.
function buildMap(
	ui: TUI,
	chat: Container,
	entryIdToComponent: Map<string, Component>,
	messages: { message: AgentMessage; entryId: string }[],
) {
	entryIdToComponent.clear();
	const renderedPendingTools = new Map<string, ToolExecutionComponent>();
	for (const { message, entryId } of messages) {
		if (message.role === "assistant") {
			const beforeChildren = chat.children.length;
			chat.addChild(new AssistantMessageComponent(message as AssistantMessage));
			const afterChildren = chat.children.length;
			if (entryId && afterChildren > beforeChildren) {
				entryIdToComponent.set(entryId, chat.children[afterChildren - 1]!);
			}
			for (const content of message.content) {
				if (content.type === "toolCall") {
					const component = new ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						{ showImages: false, imageWidthCells: 60 },
						undefined,
						ui,
						process.cwd(),
					);
					chat.addChild(component);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						component.updateResult({ content: [{ type: "text", text: "error" }], isError: true });
					} else {
						renderedPendingTools.set(content.id, component);
					}
				}
			}
		} else if (message.role === "toolResult") {
			const component = renderedPendingTools.get((message as { toolCallId: string }).toolCallId);
			if (component) {
				component.updateResult(message);
				if (entryId) {
					entryIdToComponent.set(entryId, component);
				}
			}
		} else {
			const beforeChildren = chat.children.length;
			chat.addChild(new UserMessageComponent(message.role === "user" ? String(message.content) : ""));
			const afterChildren = chat.children.length;
			if (entryId && afterChildren > beforeChildren) {
				entryIdToComponent.set(entryId, chat.children[afterChildren - 1]!);
			}
		}
	}
}

function peekAtMessage(
	ui: TUI,
	chat: Container,
	entryIdToComponent: Map<string, Component>,
	entryId: string,
): { ok: boolean; targetLineOffset: number } {
	const internals = ui as unknown as TuiInternals;
	const targetComponent = entryIdToComponent.get(entryId);
	if (!targetComponent) return { ok: false, targetLineOffset: -1 };
	const width = (ui as unknown as { terminal: { columns: number } }).terminal.columns;
	const fixedBottomCount = (ui as unknown as { getFixedBottomCount(): number }).getFixedBottomCount();
	let targetLineOffset = 0;
	let found = false;
	const children = internals.children;
	for (let i = 0; i < children.length; i++) {
		const tuiChild = children[i];
		const isScrollable = i < children.length - fixedBottomCount;
		if (tuiChild === chat) {
			const chatChildren = (chat as unknown as { children: Component[] }).children;
			for (const chatChild of chatChildren) {
				if (chatChild === targetComponent) {
					found = true;
					break;
				}
				targetLineOffset += chatChild.render(width).length;
			}
			if (found) break;
			return { ok: false, targetLineOffset: -1 };
		}
		if (isScrollable) targetLineOffset += tuiChild.render(width).length;
	}
	if (!found) return { ok: false, targetLineOffset: -1 };
	const height = (ui as unknown as { terminal: { rows: number } }).terminal.rows;
	let fixedHeight = 0;
	const childCount = children.length;
	for (let i = childCount - fixedBottomCount; i < childCount; i++) {
		fixedHeight += children[i].render(width).length;
	}
	const scrollableViewport = Math.max(0, height - fixedHeight);
	let totalScrollableLines = 0;
	for (let i = 0; i < childCount - fixedBottomCount; i++) {
		totalScrollableLines += children[i].render(width).length;
	}
	const desiredOffset = totalScrollableLines - scrollableViewport - targetLineOffset;
	const maxScroll = (ui as unknown as { getMaxScrollOffset(): number }).getMaxScrollOffset();
	const clamped = Math.max(0, Math.min(desiredOffset, maxScroll));
	(ui as unknown as { setScrollOffset(o: number): void }).setScrollOffset(clamped);
	(ui as unknown as { doRender?(): void }).doRender?.();
	return { ok: true, targetLineOffset };
}

describe("peek mapping + algorithm with tool calls", () => {
	it("locates user, assistant and tool-result entries", () => {
		initTheme("dark");
		const terminal = makeMockTerminal(80, 12);
		const ui = new TUI(terminal as unknown as never);
		const header = new Container();
		const chat = new Container();
		const pending = new Container();
		const status = new Container();
		const widgetAbove = new Container();
		const editor = new Container();
		const widgetBelow = new Container();
		const footer = new Container();
		ui.addChild(header);
		ui.addChild(chat);
		ui.addChild(pending);
		ui.addChild(status);
		ui.addChild(widgetAbove);
		ui.addChild(editor);
		ui.addChild(widgetBelow);
		ui.addChild(footer);
		ui.setFixedBottomCount(5);

		const messages = [
			{
				message: userMsg(
					"First user message, fairly long so it wraps across multiple lines in the chat at eighty columns width.",
				),
				entryId: "u1",
			},
			{
				message: assistantMsg([
					{ type: "text", text: "I will read the file." },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/x" } },
				]),
				entryId: "a1",
			},
			{
				message: toolResultMsg(
					"tc1",
					"read",
					"file contents here, also somewhat long so it wraps when rendered at eighty columns.",
				),
				entryId: "t1",
			},
			{
				message: userMsg(
					"Second user message, also long enough to wrap across several lines when measured at the chosen width of eighty columns.",
				),
				entryId: "u2",
			},
			{
				message: assistantMsg([
					{ type: "text", text: "Done. The file contains the expected content based on the read result." },
				]),
				entryId: "a2",
			},
		];

		const entryIdToComponent = new Map<string, Component>();
		buildMap(ui, chat, entryIdToComponent, messages);
		(ui as unknown as { start(): void }).start();
		(ui as unknown as { requestRender(force?: boolean): void }).requestRender(true);
		(ui as unknown as { doRender?(): void }).doRender?.();

		// Simulate the real flow where showStatus() has already appended a
		// status line to chatContainer (it appends, not a fixed-bottom region).
		chat.addChild(new Spacer(1));
		chat.addChild(new Text("Peeked at message", 1, 0));
		(ui as unknown as { doRender?(): void }).doRender?.();

		const internals = ui as unknown as TuiInternals;
		const chatChildren = (chat as unknown as { children: Component[] }).children;
		console.log("chat children count:", chatChildren.length);
		console.log("map keys:", [...entryIdToComponent.keys()]);

		for (const { entryId } of messages) {
			const result = peekAtMessage(ui, chat, entryIdToComponent, entryId);
			const target = entryIdToComponent.get(entryId);
			// Tool-result / tool-call entries must now be locatable.
			expect(result.ok, `entryId=${entryId} should be locatable`).toBe(true);
			expect(target, `entryId=${entryId} should map to a component`).toBeDefined();
			if (!target) continue;

			// The target component must be VISIBLE in the current viewport.
			// (Near-bottom messages correctly clamp instead of reaching the very top.)
			const strip = (s: string) => s.replace(/\x1b\][0-9;]*[A-Za-z]\x07/g, "").replace(/\x1b\[0?m/g, "");
			const targetLines = target.render(80).map(strip);
			const firstNonEmpty = targetLines.find((l) => l.trim().length > 0) ?? "";
			const viewport = internals.currentFullLines.slice(
				internals.currentScrollableViewportTop,
				internals.currentScrollableViewportTop + (ui as unknown as { terminal: { rows: number } }).terminal.rows,
			);
			expect(
				viewport.some((l) => strip(l).includes(firstNonEmpty) || firstNonEmpty.includes(strip(l).trim())),
				`entryId=${entryId} target should be visible in viewport`,
			).toBe(true);
		}
	});
});
