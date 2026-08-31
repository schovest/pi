import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai/compat";
import {
	Container,
	getCapabilities,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@schovest/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type { DefaultProjectTrust, ThinkingBudgetsSettings, WarningSettings } from "../../../core/settings-manager.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
	max: "Maximum reasoning (model limit)",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	enableAgentsSkills: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	defaultThinkingLevel: ThinkingLevel | undefined;
	thinkingBudgets: ThinkingBudgetsSettings;
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	enableAnalytics: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	editorBorderStyle: "plain" | "emoji";
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	warnings: WarningSettings;
	gitSnapshotMode: "tracked-only" | "include-untracked" | "all";
	gitSnapshotMaxCount: number;
	showCacheMissNotices: boolean;
	outputPad: 0 | 1;
	codeBlockIndent: string;
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	branchSummary: { reserveTokens: number; skipPrompt: boolean };
	retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxRetryDelayMs: number };
	externalEditor: string | undefined;
	sessionDir: string | undefined;
	httpProxy: string | undefined;
	websocketConnectTimeoutMs: number | undefined;
	shellPath: string | undefined;
	shellCommandPrefix: string | undefined;
	npmCommand: string[] | undefined;
	bashBackgroundTimeout: number | undefined;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onEnableAgentsSkillsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onDefaultThinkingLevelChange: (level: ThinkingLevel | undefined) => void;
	onThinkingBudgetsChange: (budgets: ThinkingBudgetsSettings | undefined) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onEnableAnalyticsChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onEditorBorderStyleChange: (style: "plain" | "emoji") => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onGitSnapshotModeChange: (mode: "tracked-only" | "include-untracked" | "all") => void;
	onGitSnapshotMaxCountChange: (count: number) => void;
	onShowCacheMissNoticesChange: (show: boolean) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onCodeBlockIndentChange: (indent: string | undefined) => void;
	onCompactionEnabledChange: (enabled: boolean) => void;
	onCompactionReserveTokensChange: (tokens: number) => void;
	onCompactionKeepRecentTokensChange: (tokens: number) => void;
	onBranchSummaryReserveTokensChange: (tokens: number) => void;
	onBranchSummarySkipPromptChange: (skip: boolean) => void;
	onRetryEnabledChange: (enabled: boolean) => void;
	onRetryMaxRetriesChange: (maxRetries: number) => void;
	onRetryBaseDelayMsChange: (delayMs: number) => void;
	onRetryMaxRetryDelayMsChange: (delayMs: number) => void;
	onExternalEditorChange: (command: string | undefined) => void;
	onSessionDirChange: (dir: string | undefined) => void;
	onHttpProxyChange: (proxy: string | undefined) => void;
	onWebSocketConnectTimeoutMsChange: (timeoutMs: number | undefined) => void;
	onShellPathChange: (path: string | undefined) => void;
	onShellCommandPrefixChange: (prefix: string | undefined) => void;
	onNpmCommandChange: (command: string[] | undefined) => void;
	onBashBackgroundTimeoutChange: (seconds: number | undefined) => void;
	onCancel: () => void;
}

/** A group of related settings shown as one entry in the /settings category list. */
interface SettingsCategory {
	id: string;
	label: string;
	description: string;
	items: SettingItem[];
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

/**
 * Submenu for editing a free-form text value with an input field.
 * onSubmit receives the raw input (may be empty); the caller decides semantics.
 */
class TextSubmenu extends Container {
	private input: Input;
	private errorText: Text;

	constructor(
		title: string,
		description: string,
		currentValue: string,
		validate: ((value: string) => string | null) | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		this.addChild(new Spacer(1));

		this.input = new Input();
		// Feed the initial value through the input so the cursor lands at the end
		// (setValue leaves the cursor at position 0, so typed text would insert at the start)
		if (currentValue) {
			this.input.handleInput(currentValue);
		}
		this.input.onSubmit = (value) => {
			const error = validate?.(value);
			if (error) {
				this.errorText.setText(theme.fg("error", `  ${error}`));
				return;
			}
			onSubmit(value);
		};
		this.input.onEscape = onCancel;
		this.addChild(this.input);

		this.errorText = new Text("", 0, 0);
		this.addChild(this.errorText);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		// Clear stale validation error as soon as the user edits again
		this.errorText.setText("");
		this.input.handleInput(data);
	}
}

/**
 * A settings category panel: titled settings list delegating to a shared onChange handler.
 */
class CategorySubmenu extends Container {
	private settingsList: SettingsList;

	constructor(
		title: string,
		description: string,
		items: SettingItem[],
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		this.addChild(new Spacer(1));

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			onChange,
			onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}

	invalidate(): void {
		this.settingsList.invalidate();
	}
}

/**
 * Main settings selector component: category list -> category settings.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		let currentWarnings = { ...config.warnings };
		let currentThinkingBudgets: ThinkingBudgetsSettings = { ...config.thinkingBudgets };

		// ---- Item factories ----

		const boolItem = (id: string, label: string, description: string, value: boolean): SettingItem => ({
			id,
			label,
			description,
			currentValue: value ? "true" : "false",
			values: ["true", "false"],
		});

		const textItem = (
			id: string,
			label: string,
			description: string,
			value: string,
			validate?: (value: string) => string | null,
		): SettingItem => ({
			id,
			label,
			description,
			currentValue: value,
			submenu: (currentValue, done) =>
				new TextSubmenu(
					label,
					description,
					currentValue,
					validate,
					(newValue) => done(newValue),
					() => done(),
				),
		});

		const positiveInt = (label: string) => (value: string) => {
			const trimmed = value.trim();
			const parsed = Number(trimmed);
			if (trimmed === "" || !Number.isInteger(parsed) || parsed <= 0) {
				return `${label} must be a positive integer`;
			}
			return null;
		};

		const nonNegativeInt = (label: string) => (value: string) => {
			const trimmed = value.trim();
			const parsed = Number(trimmed);
			if (trimmed === "" || !Number.isInteger(parsed) || parsed < 0) {
				return `${label} must be a non-negative integer`;
			}
			return null;
		};

		// ---- Categories ----

		const categories: SettingsCategory[] = [];

		categories.push({
			id: "general",
			label: "General",
			description: "Startup, telemetry, trust, and storage",
			items: [
				boolItem("quiet-startup", "Quiet startup", "Disable verbose printing at startup", config.quietStartup),
				boolItem(
					"collapse-changelog",
					"Collapse changelog",
					"Show condensed changelog after updates",
					config.collapseChangelog,
				),
				boolItem(
					"install-telemetry",
					"Install telemetry",
					"Send attribution headers to LLM providers (OpenRouter, Cloudflare)",
					config.enableInstallTelemetry,
				),
				boolItem(
					"enable-analytics",
					"Analytics",
					"Opt in to sharing anonymized analytics data",
					config.enableAnalytics,
				),
				{
					id: "default-project-trust",
					label: "Default project trust",
					description: "Fallback behavior when no extension or saved trust decision decides project trust",
					currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
					values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
				},
				textItem(
					"session-dir",
					"Session directory",
					"Custom session storage directory (requires restart; empty = default location)",
					config.sessionDir ?? "",
				),
			],
		});

		categories.push({
			id: "chat",
			label: "Chat",
			description: "Steering, thinking, and message rendering",
			items: [
				{
					id: "steering-mode",
					label: "Steering mode",
					description:
						"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
					currentValue: config.steeringMode,
					values: ["one-at-a-time", "all"],
				},
				{
					id: "follow-up-mode",
					label: "Follow-up mode",
					description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
					currentValue: config.followUpMode,
					values: ["one-at-a-time", "all"],
				},
				{
					id: "thinking",
					label: "Thinking level",
					description: "Reasoning depth for thinking-capable models",
					currentValue: config.thinkingLevel,
					submenu: (currentValue, done) =>
						new SelectSubmenu(
							"Thinking Level",
							"Select reasoning depth for thinking-capable models",
							config.availableThinkingLevels.map((level) => ({
								value: level,
								label: level,
								description: THINKING_DESCRIPTIONS[level],
							})),
							currentValue,
							(value) => {
								callbacks.onThinkingLevelChange(value as ThinkingLevel);
								done(value);
							},
							() => done(),
						),
				},
				{
					id: "default-thinking-level",
					label: "Default thinking level",
					description: "Thinking level applied to new sessions ('default' clears the persisted override)",
					currentValue: config.defaultThinkingLevel ?? "default",
					values: ["default", ...THINKING_LEVELS],
				},
				{
					id: "thinking-budgets",
					label: "Thinking budgets",
					description: "Custom token budgets per thinking level (empty = model default)",
					currentValue: "configure",
					submenu: (_currentValue, done) => {
						const budgetItems: SettingItem[] = (["minimal", "low", "medium", "high"] as const).map((level) => ({
							id: `thinking-budget-${level}`,
							label: level.charAt(0).toUpperCase() + level.slice(1),
							description: `Token budget for ${level} thinking (empty = model default)`,
							currentValue:
								currentThinkingBudgets[level] !== undefined ? String(currentThinkingBudgets[level]) : "",
							submenu: (currentValue, budgetDone) =>
								new TextSubmenu(
									`${level.charAt(0).toUpperCase() + level.slice(1)} budget`,
									`Token budget for ${level} thinking (empty = model default)`,
									currentValue,
									positiveInt("Budget"),
									(value) => budgetDone(value),
									() => budgetDone(),
								),
						}));
						return new CategorySubmenu(
							"Thinking budgets",
							"Custom token budgets per thinking level",
							budgetItems,
							(id, newValue) => {
								const level = id.replace("thinking-budget-", "") as keyof ThinkingBudgetsSettings;
								const trimmed = newValue.trim();
								const budgets: ThinkingBudgetsSettings = { ...currentThinkingBudgets };
								if (trimmed === "") {
									delete budgets[level];
								} else {
									budgets[level] = Number(trimmed);
								}
								currentThinkingBudgets = budgets;
								const hasValues = Object.values(budgets).some((v) => v !== undefined);
								callbacks.onThinkingBudgetsChange(hasValues ? budgets : undefined);
							},
							() => done(),
						);
					},
				},
				boolItem(
					"hide-thinking",
					"Hide thinking",
					"Hide thinking blocks in assistant responses",
					config.hideThinkingBlock,
				),
				boolItem(
					"show-cache-miss-notices",
					"Cache miss notices",
					"Show transcript notices for significant prompt-cache misses",
					config.showCacheMissNotices,
				),
				{
					id: "output-pad",
					label: "Output padding",
					description: "Horizontal padding for chat message output",
					currentValue: String(config.outputPad),
					values: ["0", "1"],
				},
				textItem(
					"code-block-indent",
					"Code block indent",
					"Indentation for markdown code blocks (empty = two spaces)",
					config.codeBlockIndent,
				),
			],
		});

		categories.push({
			id: "compaction",
			label: "Compaction",
			description: "Context compaction and branch summaries",
			items: [
				boolItem(
					"autocompact",
					"Auto-compact",
					"Automatically compact context when it gets too large",
					config.autoCompact,
				),
				boolItem(
					"compaction-enabled",
					"Compaction enabled",
					"Allow compaction when the context gets too large",
					config.compaction.enabled,
				),
				textItem(
					"compaction-reserve-tokens",
					"Reserve tokens",
					"Tokens reserved for compaction responses",
					String(config.compaction.reserveTokens),
					positiveInt("Reserve tokens"),
				),
				textItem(
					"compaction-keep-recent-tokens",
					"Keep recent tokens",
					"Tokens of recent context kept after compaction",
					String(config.compaction.keepRecentTokens),
					positiveInt("Keep recent tokens"),
				),
				textItem(
					"branch-summary-reserve-tokens",
					"Branch summary reserve",
					"Tokens reserved for prompt + LLM response when summarizing a branch",
					String(config.branchSummary.reserveTokens),
					positiveInt("Reserve tokens"),
				),
				boolItem(
					"branch-summary-skip-prompt",
					"Skip branch summary prompt",
					"Skip the 'Summarize branch?' prompt and default to no summary",
					config.branchSummary.skipPrompt,
				),
			],
		});

		categories.push({
			id: "retry",
			label: "Retry",
			description: "Automatic retry of failed provider requests",
			items: [
				boolItem(
					"retry-enabled",
					"Retry enabled",
					"Automatically retry failed provider requests",
					config.retry.enabled,
				),
				textItem(
					"retry-max-retries",
					"Max retries",
					"Maximum retry attempts (0 disables retries)",
					String(config.retry.maxRetries),
					nonNegativeInt("Max retries"),
				),
				textItem(
					"retry-base-delay-ms",
					"Base delay (ms)",
					"Base delay for exponential backoff in milliseconds",
					String(config.retry.baseDelayMs),
					nonNegativeInt("Base delay"),
				),
				textItem(
					"retry-max-retry-delay-ms",
					"Max delay (ms)",
					"Cap for exponential backoff delay in milliseconds",
					String(config.retry.maxRetryDelayMs),
					nonNegativeInt("Max delay"),
				),
			],
		});

		const imageItems: SettingItem[] = [];
		if (supportsImages) {
			imageItems.push(
				boolItem("show-images", "Show images", "Render images inline in terminal", config.showImages),
				{
					id: "image-width-cells",
					label: "Image width",
					description: "Preferred inline image width in terminal cells",
					currentValue: String(config.imageWidthCells),
					values: ["60", "80", "120"],
				},
			);
		}
		imageItems.push(
			boolItem(
				"auto-resize-images",
				"Auto-resize images",
				"Resize large images to 2000x2000 max for better model compatibility",
				config.autoResizeImages,
			),
			boolItem(
				"block-images",
				"Block images",
				"Prevent images from being sent to LLM providers",
				config.blockImages,
			),
		);
		categories.push({
			id: "images",
			label: "Images",
			description: "Inline image rendering and handling",
			items: imageItems,
		});

		categories.push({
			id: "editor",
			label: "Editor",
			description: "Input editor appearance and behavior",
			items: [
				{
					id: "editor-padding",
					label: "Editor padding",
					description: "Horizontal padding for input editor (0-3)",
					currentValue: String(config.editorPaddingX),
					values: ["0", "1", "2", "3"],
				},
				{
					id: "autocomplete-max-visible",
					label: "Autocomplete max items",
					description: "Max visible items in autocomplete dropdown (3-20)",
					currentValue: String(config.autocompleteMaxVisible),
					values: ["3", "5", "7", "10", "15", "20"],
				},
				{
					id: "editor-border-style",
					label: "Editor border style",
					description: "Path/branch info display style in the input editor top border",
					currentValue: config.editorBorderStyle,
					values: ["plain", "emoji"],
				},
				textItem(
					"external-editor",
					"External editor",
					"Command for the Ctrl+G external editor (empty = VISUAL/EDITOR env or platform default)",
					config.externalEditor ?? "",
				),
				{
					id: "double-escape-action",
					label: "Double-escape action",
					description: "Action when pressing Escape twice with empty editor",
					currentValue: config.doubleEscapeAction,
					values: ["tree", "fork", "none"],
				},
				{
					id: "tree-filter-mode",
					label: "Tree filter mode",
					description: "Default filter when opening /tree",
					currentValue: config.treeFilterMode,
					values: ["default", "no-tools", "user-only", "labeled-only", "all"],
				},
			],
		});

		categories.push({
			id: "terminal",
			label: "Terminal",
			description: "Theme and terminal rendering",
			items: [
				{
					id: "theme",
					label: "Theme",
					description: "Color theme for the interface",
					currentValue: config.currentTheme,
					submenu: (currentValue, done) =>
						new SelectSubmenu(
							"Theme",
							"Select color theme",
							config.availableThemes.map((t) => ({
								value: t,
								label: t,
							})),
							currentValue,
							(value) => {
								callbacks.onThemeChange(value);
								done(value);
							},
							() => {
								// Restore original theme on cancel
								callbacks.onThemePreview?.(currentValue);
								done();
							},
							(value) => {
								// Preview theme on selection change
								callbacks.onThemePreview?.(value);
							},
						),
				},
				boolItem(
					"show-hardware-cursor",
					"Show hardware cursor",
					"Show steady bar cursor for reliable IME candidate window positioning (recommended)",
					config.showHardwareCursor,
				),
				boolItem(
					"clear-on-shrink",
					"Clear on shrink",
					"Clear empty rows when content shrinks (may cause flicker)",
					config.clearOnShrink,
				),
				boolItem(
					"terminal-progress",
					"Terminal progress",
					"Show OSC 9;4 progress indicators in the terminal tab bar",
					config.showTerminalProgress,
				),
			],
		});

		categories.push({
			id: "network",
			label: "Network",
			description: "Transport, timeouts, and proxy",
			items: [
				{
					id: "transport",
					label: "Transport",
					description: "Preferred transport for providers that support multiple transports",
					currentValue: config.transport,
					values: ["sse", "websocket", "websocket-cached", "auto"],
				},
				{
					id: "http-idle-timeout",
					label: "HTTP idle timeout",
					description:
						"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
					currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
					values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
				},
				textItem(
					"http-proxy",
					"HTTP proxy",
					"Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients (requires restart; empty = disabled)",
					config.httpProxy ?? "",
				),
				textItem(
					"websocket-connect-timeout",
					"WebSocket connect timeout (ms)",
					"WebSocket connect/open handshake timeout in milliseconds (requires restart; 0 = disable)",
					config.websocketConnectTimeoutMs !== undefined ? String(config.websocketConnectTimeoutMs) : "",
					nonNegativeInt("Connect timeout"),
				),
			],
		});

		categories.push({
			id: "shell",
			label: "Shell",
			description: "Shell and bash command execution",
			items: [
				textItem(
					"shell-path",
					"Shell path",
					"Custom shell path, e.g. for Cygwin users on Windows (empty = system default)",
					config.shellPath ?? "",
				),
				textItem(
					"shell-command-prefix",
					"Shell command prefix",
					"Prefix prepended to every bash command, e.g. 'shopt -s expand_aliases' for alias support (empty = no prefix)",
					config.shellCommandPrefix ?? "",
				),
				textItem(
					"npm-command",
					"npm command",
					'Command used for npm package operations, space-separated argv (empty = "npm")',
					(config.npmCommand ?? []).join(" "),
				),
				textItem(
					"bash-background-timeout",
					"Bash background timeout",
					"Seconds before a bash command is moved to background (empty = 120)",
					config.bashBackgroundTimeout !== undefined ? String(config.bashBackgroundTimeout) : "",
					nonNegativeInt("Timeout"),
				),
			],
		});

		categories.push({
			id: "snapshots",
			label: "Snapshots",
			description: "Git snapshots for message revert",
			items: [
				{
					id: "git-snapshot-mode",
					label: "Git snapshot mode",
					description: "What files to capture in git snapshots for revert",
					currentValue: config.gitSnapshotMode,
					values: ["tracked-only", "include-untracked", "all"],
				},
				{
					id: "git-snapshot-max-count",
					label: "Git snapshot max count",
					description: "Maximum snapshots to retain (0 = disable snapshots)",
					currentValue: String(config.gitSnapshotMaxCount),
					values: ["0", "20", "50", "100", "200"],
				},
			],
		});

		categories.push({
			id: "skills",
			label: "Skills",
			description: "Skill loading and command registration",
			items: [
				boolItem(
					"skill-commands",
					"Skill commands",
					"Register skills as /skill:name commands",
					config.enableSkillCommands,
				),
				boolItem(
					"agents-skills",
					"Agents skills",
					"Load skills from ~/.agents/skills and project .agents/skills (default: off)",
					config.enableAgentsSkills,
				),
			],
		});

		categories.push({
			id: "warnings",
			label: "Warnings",
			description: "Enable or disable individual warnings",
			items: [
				{
					id: "warnings",
					label: "Warnings",
					description: "Enable or disable individual warnings",
					currentValue: "configure",
					submenu: (_currentValue, done) =>
						new WarningSettingsSubmenu(
							currentWarnings,
							(warnings) => {
								currentWarnings = warnings;
								callbacks.onWarningsChange(warnings);
							},
							() => done(),
						),
				},
			],
		});

		// ---- Shared change handler ----

		const handleSettingChange = (id: string, newValue: string): void => {
			switch (id) {
				case "autocompact":
					callbacks.onAutoCompactChange(newValue === "true");
					break;
				case "show-images":
					callbacks.onShowImagesChange(newValue === "true");
					break;
				case "image-width-cells":
					callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
					break;
				case "auto-resize-images":
					callbacks.onAutoResizeImagesChange(newValue === "true");
					break;
				case "block-images":
					callbacks.onBlockImagesChange(newValue === "true");
					break;
				case "skill-commands":
					callbacks.onEnableSkillCommandsChange(newValue === "true");
					break;
				case "agents-skills":
					callbacks.onEnableAgentsSkillsChange(newValue === "true");
					break;
				case "steering-mode":
					callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
					break;
				case "follow-up-mode":
					callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
					break;
				case "transport":
					callbacks.onTransportChange(newValue as Transport);
					break;
				case "http-idle-timeout": {
					const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
					if (choice) {
						callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
					}
					break;
				}
				case "hide-thinking":
					callbacks.onHideThinkingBlockChange(newValue === "true");
					break;
				case "collapse-changelog":
					callbacks.onCollapseChangelogChange(newValue === "true");
					break;
				case "quiet-startup":
					callbacks.onQuietStartupChange(newValue === "true");
					break;
				case "install-telemetry":
					callbacks.onEnableInstallTelemetryChange(newValue === "true");
					break;
				case "enable-analytics":
					callbacks.onEnableAnalyticsChange(newValue === "true");
					break;
				case "default-project-trust": {
					const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
					if (defaultProjectTrust) {
						callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
					}
					break;
				}
				case "double-escape-action":
					callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree" | "none");
					break;
				case "tree-filter-mode":
					callbacks.onTreeFilterModeChange(
						newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
					);
					break;
				case "show-hardware-cursor":
					callbacks.onShowHardwareCursorChange(newValue === "true");
					break;
				case "editor-padding":
					callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
					break;
				case "autocomplete-max-visible":
					callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
					break;
				case "editor-border-style":
					callbacks.onEditorBorderStyleChange(newValue as "plain" | "emoji");
					break;
				case "clear-on-shrink":
					callbacks.onClearOnShrinkChange(newValue === "true");
					break;
				case "terminal-progress":
					callbacks.onShowTerminalProgressChange(newValue === "true");
					break;
				case "git-snapshot-mode":
					callbacks.onGitSnapshotModeChange(newValue as "tracked-only" | "include-untracked" | "all");
					break;
				case "git-snapshot-max-count":
					callbacks.onGitSnapshotMaxCountChange(parseInt(newValue, 10));
					break;
				case "default-thinking-level":
					callbacks.onDefaultThinkingLevelChange(newValue === "default" ? undefined : (newValue as ThinkingLevel));
					break;
				case "show-cache-miss-notices":
					callbacks.onShowCacheMissNoticesChange(newValue === "true");
					break;
				case "output-pad":
					callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
					break;
				case "code-block-indent":
					callbacks.onCodeBlockIndentChange(newValue.length === 0 ? undefined : newValue);
					break;
				case "compaction-enabled":
					callbacks.onCompactionEnabledChange(newValue === "true");
					break;
				case "compaction-reserve-tokens":
					callbacks.onCompactionReserveTokensChange(parseInt(newValue, 10));
					break;
				case "compaction-keep-recent-tokens":
					callbacks.onCompactionKeepRecentTokensChange(parseInt(newValue, 10));
					break;
				case "branch-summary-reserve-tokens":
					callbacks.onBranchSummaryReserveTokensChange(parseInt(newValue, 10));
					break;
				case "branch-summary-skip-prompt":
					callbacks.onBranchSummarySkipPromptChange(newValue === "true");
					break;
				case "retry-enabled":
					callbacks.onRetryEnabledChange(newValue === "true");
					break;
				case "retry-max-retries":
					callbacks.onRetryMaxRetriesChange(parseInt(newValue, 10));
					break;
				case "retry-base-delay-ms":
					callbacks.onRetryBaseDelayMsChange(parseInt(newValue, 10));
					break;
				case "retry-max-retry-delay-ms":
					callbacks.onRetryMaxRetryDelayMsChange(parseInt(newValue, 10));
					break;
				case "external-editor":
					callbacks.onExternalEditorChange(trimToUndefined(newValue));
					break;
				case "session-dir":
					callbacks.onSessionDirChange(trimToUndefined(newValue));
					break;
				case "http-proxy":
					callbacks.onHttpProxyChange(trimToUndefined(newValue));
					break;
				case "websocket-connect-timeout":
					callbacks.onWebSocketConnectTimeoutMsChange(newValue.trim() === "" ? undefined : parseInt(newValue, 10));
					break;
				case "shell-path":
					callbacks.onShellPathChange(trimToUndefined(newValue));
					break;
				case "shell-command-prefix":
					callbacks.onShellCommandPrefixChange(newValue.length === 0 ? undefined : newValue);
					break;
				case "npm-command": {
					const parts = newValue.trim().split(/\s+/).filter(Boolean);
					callbacks.onNpmCommandChange(parts.length > 0 ? parts : undefined);
					break;
				}
				case "bash-background-timeout":
					callbacks.onBashBackgroundTimeoutChange(newValue.trim() === "" ? undefined : parseInt(newValue, 10));
					break;
			}
		};

		// ---- Top-level category list ----

		const categoryItems: SettingItem[] = categories.map((category) => ({
			id: category.id,
			label: category.label,
			description: category.description,
			currentValue: `${category.items.length} settings`,
			submenu: (_currentValue, done) =>
				new CategorySubmenu(category.label, category.description, category.items, handleSettingChange, () =>
					done(),
				),
		}));

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			categoryItems,
			categories.length,
			getSettingsListTheme(),
			() => {},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}

function trimToUndefined(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
