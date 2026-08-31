import { type ImageProtocol, setCapabilities, setKeybindings } from "@schovest/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector.ts";
import { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "./../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";

function makeConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		showImages: true,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		enableAgentsSkills: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "auto",
		httpIdleTimeoutMs: 300000,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		defaultThinkingLevel: undefined,
		thinkingBudgets: {},
		currentTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		collapseChangelog: false,
		enableInstallTelemetry: true,
		enableAnalytics: false,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: true,
		editorPaddingX: 0,
		autocompleteMaxVisible: 5,
		editorBorderStyle: "plain",
		quietStartup: true,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		warnings: {},
		gitSnapshotMode: "include-untracked",
		gitSnapshotMaxCount: 100,
		showCacheMissNotices: false,
		outputPad: 1,
		codeBlockIndent: "  ",
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		branchSummary: { reserveTokens: 16384, skipPrompt: false },
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxRetryDelayMs: 30000 },
		externalEditor: undefined,
		sessionDir: undefined,
		httpProxy: undefined,
		websocketConnectTimeoutMs: undefined,
		shellPath: undefined,
		shellCommandPrefix: undefined,
		npmCommand: undefined,
		bashBackgroundTimeout: undefined,
		...overrides,
	};
}

function makeCallbacks(): SettingsCallbacks {
	return {
		onAutoCompactChange: vi.fn(),
		onShowImagesChange: vi.fn(),
		onImageWidthCellsChange: vi.fn(),
		onAutoResizeImagesChange: vi.fn(),
		onBlockImagesChange: vi.fn(),
		onEnableSkillCommandsChange: vi.fn(),
		onEnableAgentsSkillsChange: vi.fn(),
		onSteeringModeChange: vi.fn(),
		onFollowUpModeChange: vi.fn(),
		onTransportChange: vi.fn(),
		onHttpIdleTimeoutMsChange: vi.fn(),
		onThinkingLevelChange: vi.fn(),
		onDefaultThinkingLevelChange: vi.fn(),
		onThinkingBudgetsChange: vi.fn(),
		onThemeChange: vi.fn(),
		onThemePreview: vi.fn(),
		onHideThinkingBlockChange: vi.fn(),
		onCollapseChangelogChange: vi.fn(),
		onEnableInstallTelemetryChange: vi.fn(),
		onEnableAnalyticsChange: vi.fn(),
		onDoubleEscapeActionChange: vi.fn(),
		onTreeFilterModeChange: vi.fn(),
		onShowHardwareCursorChange: vi.fn(),
		onEditorPaddingXChange: vi.fn(),
		onAutocompleteMaxVisibleChange: vi.fn(),
		onEditorBorderStyleChange: vi.fn(),
		onQuietStartupChange: vi.fn(),
		onDefaultProjectTrustChange: vi.fn(),
		onClearOnShrinkChange: vi.fn(),
		onShowTerminalProgressChange: vi.fn(),
		onWarningsChange: vi.fn(),
		onGitSnapshotModeChange: vi.fn(),
		onGitSnapshotMaxCountChange: vi.fn(),
		onShowCacheMissNoticesChange: vi.fn(),
		onOutputPadChange: vi.fn(),
		onCodeBlockIndentChange: vi.fn(),
		onCompactionEnabledChange: vi.fn(),
		onCompactionReserveTokensChange: vi.fn(),
		onCompactionKeepRecentTokensChange: vi.fn(),
		onBranchSummaryReserveTokensChange: vi.fn(),
		onBranchSummarySkipPromptChange: vi.fn(),
		onRetryEnabledChange: vi.fn(),
		onRetryMaxRetriesChange: vi.fn(),
		onRetryBaseDelayMsChange: vi.fn(),
		onRetryMaxRetryDelayMsChange: vi.fn(),
		onExternalEditorChange: vi.fn(),
		onSessionDirChange: vi.fn(),
		onHttpProxyChange: vi.fn(),
		onWebSocketConnectTimeoutMsChange: vi.fn(),
		onShellPathChange: vi.fn(),
		onShellCommandPrefixChange: vi.fn(),
		onNpmCommandChange: vi.fn(),
		onBashBackgroundTimeoutChange: vi.fn(),
		onCancel: vi.fn(),
	};
}

/** Open the settings selector and enter the category at the given index. */
function enterCategory(component: SettingsSelectorComponent, index: number): void {
	for (let i = 0; i < index; i++) {
		component.getSettingsList().handleInput(DOWN);
	}
	component.getSettingsList().handleInput(ENTER);
}

function render(component: SettingsSelectorComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		setCapabilities({ images: null as ImageProtocol, trueColor: true, hyperlinks: false });
	});

	it("renders all settings categories", () => {
		const component = new SettingsSelectorComponent(makeConfig(), makeCallbacks());

		const output = render(component);

		for (const category of [
			"General",
			"Chat",
			"Compaction",
			"Retry",
			"Images",
			"Editor",
			"Terminal",
			"Network",
			"Shell",
			"Snapshots",
			"Skills",
			"Warnings",
		]) {
			expect(output).toContain(category);
		}
	});

	it("cycles a boolean setting inside a category", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ quietStartup: true }), callbacks);

		enterCategory(component, 0); // General
		component.getSettingsList().handleInput(ENTER); // first item: Quiet startup

		expect(callbacks.onQuietStartupChange).toHaveBeenCalledWith(false);
	});

	it("returns to the category list on escape", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig(), callbacks);

		enterCategory(component, 0); // General
		expect(render(component)).not.toContain("settings");

		component.getSettingsList().handleInput(ESCAPE);

		expect(render(component)).toContain("settings");
		expect(callbacks.onCancel).not.toHaveBeenCalled();
	});

	it("edits a text setting via the text submenu", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig(), callbacks);

		enterCategory(component, 0); // General
		for (let i = 0; i < 5; i++) {
			component.getSettingsList().handleInput(DOWN); // move to Session directory
		}
		component.getSettingsList().handleInput(ENTER); // open text submenu
		component.getSettingsList().handleInput("/tmp/pi-sessions");
		component.getSettingsList().handleInput(ENTER); // save

		expect(callbacks.onSessionDirChange).toHaveBeenCalledWith("/tmp/pi-sessions");
	});

	it("rejects invalid numeric input in the text submenu", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig(), callbacks);

		enterCategory(component, 2); // Compaction
		for (let i = 0; i < 2; i++) {
			component.getSettingsList().handleInput(DOWN); // move to Reserve tokens
		}
		component.getSettingsList().handleInput(ENTER); // open text submenu
		for (let i = 0; i < 5; i++) {
			component.getSettingsList().handleInput(BACKSPACE); // clear "16384"
		}
		component.getSettingsList().handleInput("abc");
		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onCompactionReserveTokensChange).not.toHaveBeenCalled();
		expect(render(component)).toContain("must be a positive integer");

		for (let i = 0; i < 3; i++) {
			component.getSettingsList().handleInput(BACKSPACE); // clear "abc"
		}
		component.getSettingsList().handleInput("42");
		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onCompactionReserveTokensChange).toHaveBeenCalledWith(42);
	});

	it("clears a text setting when input is emptied", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig({ shellPath: "/bin/bash" }), callbacks);

		enterCategory(component, 8); // Shell
		component.getSettingsList().handleInput(ENTER); // first item: Shell path
		for (let i = 0; i < "/bin/bash".length; i++) {
			component.getSettingsList().handleInput(BACKSPACE);
		}
		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onShellPathChange).toHaveBeenCalledWith(undefined);
	});

	it("edits a thinking budget through the nested submenu", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig(), callbacks);

		enterCategory(component, 1); // Chat
		for (let i = 0; i < 4; i++) {
			component.getSettingsList().handleInput(DOWN); // move to Thinking budgets
		}
		component.getSettingsList().handleInput(ENTER); // open budgets list
		component.getSettingsList().handleInput(ENTER); // open Minimal budget
		component.getSettingsList().handleInput("1000");
		component.getSettingsList().handleInput(ENTER);

		expect(callbacks.onThinkingBudgetsChange).toHaveBeenCalledWith({ minimal: 1000 });
	});

	it("cycles the default thinking level including the default entry", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig(), callbacks);

		enterCategory(component, 1); // Chat
		for (let i = 0; i < 3; i++) {
			component.getSettingsList().handleInput(DOWN); // move to Default thinking level
		}
		component.getSettingsList().handleInput(ENTER); // cycle "default" -> "off"

		expect(callbacks.onDefaultThinkingLevelChange).toHaveBeenCalledWith("off");
	});

	it("escapes the selector entirely from the category list", () => {
		const callbacks = makeCallbacks();
		const component = new SettingsSelectorComponent(makeConfig(), callbacks);

		component.getSettingsList().handleInput(ESCAPE);

		expect(callbacks.onCancel).toHaveBeenCalled();
	});
});
