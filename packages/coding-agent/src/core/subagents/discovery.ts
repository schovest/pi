import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { SubagentDefinition, SubagentDefinitionScope, SubagentScope } from "./types.ts";

interface AgentFrontmatter extends Record<string, unknown> {
	description?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown;
}

export interface DiscoverSubagentsOptions {
	cwd: string;
	agentDir: string;
	scope?: SubagentScope;
}

const VALID_THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

const BUILT_IN_SUBAGENTS: SubagentDefinition[] = [
	{
		name: "scout",
		description: "Explore code, files, and context before implementation.",
		prompt:
			"You are a scout subagent. Gather focused facts, cite concrete files or observations, and avoid making code changes unless the task explicitly asks for them.",
		scope: "builtin",
		tools: ["read", "grep", "find", "ls"],
	},
	{
		name: "planner",
		description:
			"Turn requirements and discovered facts into an implementation plan with structured steps and dependencies.",
		prompt:
			'You are a planner subagent. Produce concise, ordered implementation steps with risks and verification commands.\n\nFormat your plan as a numbered list under a "Plan:" header:\n\nPlan:\n1. First step description\n2. Second step description (depends on step 1)\n3. Third step description (can run in parallel with step 2)\n\nFor each step, note:\n- Dependencies on other steps\n- Verification command or condition\n- Whether it can run in parallel',
		scope: "builtin",
		tools: ["read", "grep", "find", "ls"],
	},
	{
		name: "reviewer",
		description: "Review code or plans for correctness, regressions, and missing tests.",
		prompt:
			"You are a reviewer subagent. Lead with findings ordered by severity, include file references when available, and keep summaries secondary.",
		scope: "builtin",
		tools: ["read", "grep", "find", "ls"],
	},
	{
		name: "worker",
		description: "Execute a focused implementation or maintenance task.",
		prompt:
			"You are a worker subagent. Complete the assigned task directly, keep changes scoped, and report the result with verification evidence.",
		scope: "builtin",
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	},
];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && VALID_THINKING.has(value as ThinkingLevel);
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return strings.length > 0 ? strings : undefined;
}

function readAgentFile(path: string, scope: SubagentDefinitionScope): SubagentDefinition {
	const content = readFileSync(path, "utf8");
	const parsed = parseFrontmatter<AgentFrontmatter>(content);
	const name = basename(path, ".md");
	return {
		name,
		description: typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : name,
		prompt: parsed.body,
		scope,
		sourcePath: path,
		model: typeof parsed.frontmatter.model === "string" ? parsed.frontmatter.model : undefined,
		thinking: isThinkingLevel(parsed.frontmatter.thinking) ? parsed.frontmatter.thinking : undefined,
		tools: stringArray(parsed.frontmatter.tools),
	};
}

function loadAgentDir(path: string, scope: SubagentDefinitionScope): SubagentDefinition[] {
	if (!existsSync(path)) {
		return [];
	}
	const entries = readdirSync(path, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => readAgentFile(join(path, entry.name), scope));
}

function findNearestProjectSubagentsDir(cwd: string): string | undefined {
	let current = cwd;
	for (;;) {
		const candidate = join(current, ".pi", "subagents");
		if (existsSync(candidate) && statSync(candidate).isDirectory()) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

function mergeAgents(groups: SubagentDefinition[][]): SubagentDefinition[] {
	const merged = new Map<string, SubagentDefinition>();
	for (const group of groups) {
		for (const agent of group) {
			merged.set(agent.name, agent);
		}
	}
	return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverSubagentsSync(options: DiscoverSubagentsOptions): SubagentDefinition[] {
	const scope = options.scope ?? "user";
	const builtIn = BUILT_IN_SUBAGENTS.map((agent) => ({ ...agent }));
	const user = loadAgentDir(join(options.agentDir, "subagents"), "user");
	const shouldLoadProject = scope === "project" || scope === "both";
	const projectDir = shouldLoadProject ? findNearestProjectSubagentsDir(options.cwd) : undefined;
	const project = projectDir ? loadAgentDir(projectDir, "project") : [];
	return mergeAgents([builtIn, user, project]);
}

export async function discoverSubagents(options: DiscoverSubagentsOptions): Promise<SubagentDefinition[]> {
	return discoverSubagentsSync(options);
}
