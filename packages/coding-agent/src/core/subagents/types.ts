import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";

export type SubagentScope = "user" | "project" | "both";
export type SubagentDefinitionScope = "builtin" | "user" | "project";
export type SubagentRunMode = "parallel" | "chain";
export type SubagentRunStatus = "pending" | "running" | "success" | "failed" | "aborted";

export interface SubagentDefinition {
	name: string;
	description: string;
	prompt: string;
	scope: SubagentDefinitionScope;
	sourcePath?: string;
	model?: string;
	thinking?: ThinkingLevel;
	includedTools?: string[];
	excludedTools?: string[];
	skills?: string[]; // glob 模式列表，匹配主 agent 已加载的 skills
}

export interface SubagentTask {
	agent: string;
	task: string;
	title: string;
	model?: string;
	thinking?: ThinkingLevel;
	includedTools?: string[];
	excludedTools?: string[];
	skills?: string[]; // 运行时覆盖 definition 的 skills
}

export type SubagentRunRequest =
	| { tasks: SubagentTask[]; subagentScope?: SubagentScope }
	| { chain: SubagentTask[]; subagentScope?: SubagentScope };

export interface SubagentRunOptions {
	signal?: AbortSignal;
	agentDir?: string;
	onEvent?: (event: SubagentRunEvent, child: AgentSession) => void;
}

export interface SubagentRunEvent {
	runId: string;
	index: number;
	agent: string;
	task: string;
	title: string;
	status: SubagentRunStatus;
	model?: string;
	thinking?: ThinkingLevel;
	currentTool?: string;
	currentToolArgs?: string;
	toolResultSummary?: string;
	outputSummary?: string;
	usage?: Usage;
	error?: string;
	timestamp: number;
}

export interface SubagentTaskResult {
	index: number;
	agent: string;
	task: string;
	title: string;
	status: Exclude<SubagentRunStatus, "pending" | "running">;
	output: string;
	model?: string;
	thinking?: ThinkingLevel;
	usage?: Usage;
	error?: string;
	messages: AgentMessage[];
	events: SubagentRunEvent[];
}

export interface SubagentRunResult {
	mode: SubagentRunMode;
	results: SubagentTaskResult[];
	usage?: Usage;
}
