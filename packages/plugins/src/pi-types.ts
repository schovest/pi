import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";

export type { AgentToolResult, AgentToolUpdateCallback };

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

export interface ExtensionUIContext {
	readonly theme: {
		fg(name: string, text: string): string;
	};
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
	custom<T = unknown>(
		factory: (
			tui: TUI,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => unknown | Promise<unknown>,
		options?: {
			overlay?: boolean;
			overlayOptions?: unknown;
			onHandle?: (handle: unknown) => void;
		},
	): Promise<T>;
}

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

export interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
	modelRegistry: ModelRegistry;
	model: Model<Api> | undefined;
	signal: AbortSignal | undefined;
	reload(): Promise<void>;
}

export interface ExtensionAPI {
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	registerTool(tool: unknown): void;
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;
	getFlag(name: string): boolean | string | undefined;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		},
	): void;
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
}
