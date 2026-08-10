import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { SubagentDefinition, SubagentDefinitionScope, SubagentScope } from "./types.ts";

interface AgentFrontmatter extends Record<string, unknown> {
	description?: unknown;
	model?: unknown;
	thinking?: unknown;
	tools?: unknown; // deprecated, mapped to includedTools
	includedTools?: unknown;
	excludedTools?: unknown;
	skills?: unknown;
}

export interface DiscoverSubagentsOptions {
	cwd: string;
	agentDir: string;
	scope?: SubagentScope;
}

const VALID_THINKING = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

const BUILT_IN_SUBAGENTS: SubagentDefinition[] = [
	{
		name: "explorer",
		description: "Fast parallel search for discovery. Returns locations and summaries, not full content.",
		prompt:
			"You are an explorer subagent. Run parallel searches to discover files, patterns, or facts. Return only locations and concise summaries — never full file contents. Use when the main agent needs to find something but doesn't know where. Cost-optimized: prefer lightweight queries, stop early when found. Delegate to this subagent when discovery is needed; handle known paths directly in the main agent. You have full tool access but must stay strictly read-only: never modify files, and use bash only for read-only commands such as `git log`.",
		scope: "builtin",
		thinking: "low",
		includedTools: ["*"],
	},
	{
		name: "worker",
		description: "Execute a unit-scoped task with full tool access. Independent execution sandbox.",
		prompt:
			"You are a worker subagent. Execute the assigned unit-scoped task with full tool access. Work independently, keep changes focused, and report results with evidence. Suitable for any bounded task: file operations, shell commands, data processing, or multi-step workflows. Not limited to code — handle any concrete task the main agent delegates.",
		scope: "builtin",
		includedTools: ["*"],
	},
	{
		name: "reviewer",
		description: "Code review specialist for quality and security analysis",
		prompt:
			"You are a senior code reviewer. Analyze code for quality, security, and maintainability.\n\nYou are a read-only reviewer — never modify files or run builds, even though you have full tool access. Bash is for read-only commands only: `git diff`, `git log`, `git show`.\n\nStrategy:\n1. Run `git diff` to see recent changes (if applicable)\n2. Read the modified files\n3. Check for bugs, security issues, code smells\n\nOutput format:\n\n## Files Reviewed\n- `path/to/file.ts` (lines X-Y)\n\n## Critical (must fix)\n- `file.ts:42` - Issue description\n\n## Warnings (should fix)\n- `file.ts:100` - Issue description\n\n## Suggestions (consider)\n- `file.ts:150` - Improvement idea\n\n## Summary\nOverall assessment in 2-3 sentences.\n\nBe specific with file paths and line numbers.",
		scope: "builtin",
		includedTools: ["*"],
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
	return strings;
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
		includedTools: (() => {
			const parsedIncluded = stringArray(parsed.frontmatter.includedTools);
			const parsedLegacy = stringArray(parsed.frontmatter.tools);
			return parsedIncluded !== undefined ? parsedIncluded : parsedLegacy;
		})(),
		excludedTools: stringArray(parsed.frontmatter.excludedTools),
		skills: stringArray(parsed.frontmatter.skills),
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
