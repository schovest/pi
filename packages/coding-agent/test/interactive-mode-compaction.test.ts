import { describe, expect, test, vi } from "vitest";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat after compaction without appending a compaction summary block", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			footerDataProvider: { invalidateBranchCache: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		// v3：chatbox 不渲染 [compaction] summary 块，compaction 后只保留真实对话
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("renderSessionContext skips compaction summary messages in the chatbox", () => {
		const chatChildren: unknown[] = [];
		const fakeThis = {
			pendingTools: new Map(),
			entryIdToComponent: new Map(),
			chatContainer: {
				children: chatChildren,
				addChild: (child: unknown) => {
					chatChildren.push(child);
				},
			},
			ui: { requestRender: vi.fn() },
			toolOutputExpanded: false,
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (message: unknown) => void,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getUserMessageText: (message: { role: string; content: string | unknown }) =>
				typeof message.content === "string" ? message.content : "",
		};

		const renderSessionContext = Reflect.get(InteractiveMode.prototype, "renderSessionContext") as (
			this: typeof fakeThis,
			sessionContext: {
				messages: unknown[];
				entryIds: (string | null)[];
			},
		) => void;

		renderSessionContext.call(fakeThis, {
			messages: [
				createCompactionSummaryMessage("summarized old history", 5000, "2026-08-01T00:00:00.000Z"),
				{ role: "user", content: "actual question after compaction", timestamp: Date.now() },
			],
			entryIds: ["c1", "u1"],
		});

		expect(chatChildren.some((child) => child instanceof CompactionSummaryMessageComponent)).toBe(false);
		expect(chatChildren.some((child) => child instanceof UserMessageComponent)).toBe(true);
	});
});
