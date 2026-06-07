import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";

export type { AgentToolResult, AgentToolUpdateCallback };
export type { Component };

// ---------------------------------------------------------------------------
// Theme — subset of coding-agent Theme used by builtin plugins
// ---------------------------------------------------------------------------

export interface Theme {
	fg(name: string, text: string): string;
	bg(name: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	strikethrough(text: string): string;
}

// ---------------------------------------------------------------------------
// MarkdownTheme — for Markdown rendering in ask-user-question preview
// ---------------------------------------------------------------------------

export interface MarkdownTheme {
	heading(text: string): string;
	link(text: string): string;
	linkUrl(text: string): string;
	code(text: string): string;
	codeBlock(text: string): string;
	codeBlockBorder(text: string): string;
	quote(text: string): string;
	quoteBorder(text: string): string;
	hr(text: string): string;
	listBullet(text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	strikethrough(text: string): string;
	highlightCode(code: string, lang?: string): string[];
}

// ---------------------------------------------------------------------------
// DynamicBorder — re-implementation (avoids coding-agent dependency)
// ---------------------------------------------------------------------------

export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => str) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}

// ---------------------------------------------------------------------------
// EventBus — shared event bus for extension communication
// ---------------------------------------------------------------------------

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// ReadonlySessionManager — subset used by builtin plugins
// ---------------------------------------------------------------------------

export interface ReadonlySessionManager {
	getBranch(): Iterable<unknown>;
	getCwd(): string;
	getSessionDir(): string;
	getSessionId(): string;
	getSessionFile(): string;
	getLeafId(): string;
	getLeafEntry(): unknown;
	getEntry(id: string): unknown;
	getLabel(id: string): string | undefined;
	getHeader(): unknown;
	getEntries(): unknown[];
	getTree(): unknown;
	getSessionName(): string | undefined;
}

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

export interface ToolRenderResultOptions {
	expanded: boolean;
	isPartial: boolean;
}

export interface ToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	sourceInfo: unknown;
}

// ---------------------------------------------------------------------------
// ExtensionUIContext
// ---------------------------------------------------------------------------

export interface ExtensionUIContext {
	readonly theme: Theme;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	/**
	 * Set a widget to display above or below the editor.
	 * String array form: simple text lines.
	 * Factory form: component factory receiving TUI and Theme.
	 */
	setWidget(
		key: string,
		content:
			| string[]
			| ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
			| undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	custom<T = unknown>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: unknown,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: unknown;
			onHandle?: (handle: unknown) => void;
		},
	): Promise<T>;
}

// ---------------------------------------------------------------------------
// ModelRegistry
// ---------------------------------------------------------------------------

export interface ModelRegistry {
	getAvailable(): Model<Api>[];
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| {
				ok: true;
				apiKey?: string;
				headers?: Record<string, string>;
		  }
		| {
				ok: false;
				error: string;
		  }
	>;
}

// ---------------------------------------------------------------------------
// ExtensionContext — context passed to event handlers and tool callbacks
// ---------------------------------------------------------------------------

export interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
	sessionManager: ReadonlySessionManager;
	modelRegistry: ModelRegistry;
	model: Model<Api> | undefined;
	signal: AbortSignal | undefined;
	reload(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ExtensionAPI — main API surface for builtin plugins
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
	// Event subscription
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_compact", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_tree", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "agent_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "tool_execution_end", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;

	// Tool registration
	registerTool(tool: unknown): void;

	// Command registration
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		},
	): void;

	// Flag registration
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;
	getFlag(name: string): boolean | string | undefined;

	// Actions
	exec(
		command: string,
		args: string[],
		options?: unknown,
	): Promise<{
		code: number;
		stdout: string;
		stderr: string;
		signal?: string;
	}>;
	getAllTools(): ToolInfo[];
	sendMessage<T = unknown>(
		message: {
			customType: string;
			content: string | string[];
			display?: string;
			details?: T;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	// Shared event bus for extension communication
	events: EventBus;
}
