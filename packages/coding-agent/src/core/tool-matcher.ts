import { minimatch } from "minimatch";

/**
 * Check if a string contains glob metacharacters.
 */
function isGlobPattern(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

/**
 * Test whether a single tool name matches a single pattern.
 * Exact match when no glob chars, minimatch otherwise.
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
	if (!isGlobPattern(pattern)) return toolName === pattern;
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
 * - If `includedPatterns` is non-empty, only tools matching at least one pattern are returned.
 * - Otherwise, if `excludedPatterns` is non-empty, all tools EXCEPT those matching any exclude pattern.
 * - Otherwise, `defaults` is returned (falling back to `allToolNames`).
 */
export function resolveActiveTools(
	allToolNames: string[],
	includedPatterns?: string[],
	excludedPatterns?: string[],
	defaults?: string[],
): string[] {
	if (includedPatterns && includedPatterns.length > 0) {
		return allToolNames.filter((t) => matchesAnyToolPattern(t, includedPatterns));
	}
	if (excludedPatterns && excludedPatterns.length > 0) {
		return allToolNames.filter((t) => !matchesAnyToolPattern(t, excludedPatterns));
	}
	return defaults ?? allToolNames;
}
