import { minimatch } from "minimatch";
import type { Skill } from "./skills.ts";

/**
 * Test whether a single tool name matches a single pattern.
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
	return minimatch(toolName, pattern, { nocase: true });
}

/**
 * Test whether a tool name matches any pattern in the list.
 */
export function matchesAnyToolPattern(toolName: string, patterns: string[]): boolean {
	return patterns.some((p) => matchesToolPattern(toolName, p));
}

/**
 * Resolve the final active tool set from an allowlist/denylist pattern set.
 *
 * - If `includedPatterns` is explicitly set (even to an empty array), only tools
 *   matching at least one pattern are returned. An empty array means "no tools".
 * - Otherwise, if `excludedPatterns` is non-empty, all tools EXCEPT those matching
 *   any exclude pattern.
 * - Otherwise, `defaults` is returned (falling back to `allToolNames`).
 */
export function resolveActiveTools(
	allToolNames: string[],
	includedPatterns?: string[],
	excludedPatterns?: string[],
	defaults?: string[],
): string[] {
	if (includedPatterns !== undefined) {
		return allToolNames.filter((t) => matchesAnyToolPattern(t, includedPatterns));
	}
	if (excludedPatterns && excludedPatterns.length > 0) {
		return allToolNames.filter((t) => !matchesAnyToolPattern(t, excludedPatterns));
	}
	return defaults ?? allToolNames;
}

/**
 * Resolve the active skill set for a PRIMARY agent from glob patterns.
 *
 * Semantics differ from `resolveActiveSkills` (used by subagents):
 * - `undefined` (not configured) → returns `undefined`, meaning "no restriction,
 *   use all loaded skills". The caller should fall back to the full skill list.
 * - `[]` (explicitly empty) → returns `[]`, meaning "no skills at all".
 * - `["pattern"]` → returns skills whose name matches at least one pattern.
 *
 * This allows primary agents to opt-in to skill filtering while defaulting
 * to the full skill set when no `skills` field is present.
 */
export function resolvePrimaryAgentSkills(allSkills: Skill[], patterns: string[] | undefined): Skill[] | undefined {
	if (patterns === undefined) return undefined;
	return allSkills.filter((skill) => matchesAnyToolPattern(skill.name, patterns));
}

/**
 * Resolve the active skill set from a list of glob patterns matched against all available skills.
 *
 * - If `patterns` is undefined or empty, returns an empty array (no skills for subagent).
 * - Otherwise, returns skills whose name matches at least one pattern (using minimatch).
 */
export function resolveActiveSkills(allSkills: Skill[], patterns: string[] | undefined): Skill[] {
	if (!patterns || patterns.length === 0) return [];
	return allSkills.filter((skill) => matchesAnyToolPattern(skill.name, patterns));
}
