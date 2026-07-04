import type { ThinkingLevel } from "@schovest/pi-agent-core";

export type PrimaryAgentDefinitionScope = "builtin" | "user" | "project";

export interface PrimaryAgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	scope: PrimaryAgentDefinitionScope;
	sourcePath?: string;
	includedTools?: string[];
	excludedTools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
}

export interface DiscoverPrimaryAgentsOptions {
	cwd: string;
	agentDir: string;
}
