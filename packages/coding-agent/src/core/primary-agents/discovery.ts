import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { DiscoverPrimaryAgentsOptions, PrimaryAgentDefinition, PrimaryAgentDefinitionScope } from "./types.ts";

interface PrimaryAgentFrontmatter extends Record<string, unknown> {
	description?: unknown;
	includedTools?: unknown;
	excludedTools?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown;
	skills?: unknown;
}

const VALID_THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && VALID_THINKING.has(value as ThinkingLevel);
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings;
}

const BUILT_IN_PRIMARY_AGENTS: PrimaryAgentDefinition[] = [
	{
		name: "code",
		description: "Default agent with full tools for implementation and execution.",
		systemPrompt: "",
		scope: "builtin",
	},
	{
		name: "plan",
		description: "Planning agent with read-only tools for analysis and design.",
		systemPrompt:
			"You are a planning agent. Analyze requirements, explore the codebase, and produce concise implementation plans. Do not modify files or execute commands. Focus on understanding, designing, and proposing solutions.",
		scope: "builtin",
		excludedTools: ["bash", "subagent"],
	},
];

function readPrimaryAgentFile(path: string, scope: PrimaryAgentDefinitionScope): PrimaryAgentDefinition {
	const content = readFileSync(path, "utf8");
	const parsed = parseFrontmatter<PrimaryAgentFrontmatter>(content);
	const name = basename(path, ".md");
	return {
		name,
		description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : name,
		systemPrompt: parsed.body,
		scope,
		sourcePath: path,
		includedTools: (() => {
			const parsedIncluded = stringArray(parsed.frontmatter.includedTools);
			const parsedLegacy = stringArray(parsed.frontmatter.tools);
			return parsedIncluded !== undefined ? parsedIncluded : parsedLegacy;
		})(),
		excludedTools: stringArray(parsed.frontmatter.excludedTools),
		model: typeof parsed.frontmatter.model === "string" ? parsed.frontmatter.model : undefined,
		thinking: isThinkingLevel(parsed.frontmatter.thinking) ? parsed.frontmatter.thinking : undefined,
		skills: stringArray(parsed.frontmatter.skills),
	};
}

function loadPrimaryAgentDir(path: string, scope: PrimaryAgentDefinitionScope): PrimaryAgentDefinition[] {
	if (!existsSync(path)) return [];
	const entries = readdirSync(path, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => readPrimaryAgentFile(join(path, entry.name), scope));
}

function findNearestProjectPrimaryAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	for (;;) {
		const candidate = join(current, ".pi", "primary-agents");
		if (existsSync(candidate) && statSync(candidate).isDirectory()) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function mergePrimaryAgents(groups: PrimaryAgentDefinition[][]): PrimaryAgentDefinition[] {
	const merged = new Map<string, PrimaryAgentDefinition>();
	for (const group of groups) {
		for (const agent of group) {
			merged.set(agent.name, agent);
		}
	}
	return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverPrimaryAgentsSync(options: DiscoverPrimaryAgentsOptions): PrimaryAgentDefinition[] {
	const builtIn = BUILT_IN_PRIMARY_AGENTS.map((agent) => ({ ...agent }));
	const user = loadPrimaryAgentDir(join(options.agentDir, "primary-agents"), "user");
	const projectDir = findNearestProjectPrimaryAgentsDir(options.cwd);
	const project = projectDir ? loadPrimaryAgentDir(projectDir, "project") : [];
	return mergePrimaryAgents([builtIn, user, project]);
}

export async function discoverPrimaryAgents(options: DiscoverPrimaryAgentsOptions): Promise<PrimaryAgentDefinition[]> {
	return discoverPrimaryAgentsSync(options);
}
