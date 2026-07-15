/**
 * Session tree entry for subagent runs.
 *
 * This type was previously defined in @schovest/pi-agent-core (fork-only addition).
 * Moved to coding-agent so we can use upstream @earendil-works/pi-agent-core directly.
 */
export interface SubagentRunEntry {
	type: "subagent_run";
	id: string;
	parentId: string | null;
	timestamp: string;
	runId: string;
	index: number;
	agent: string;
	task: string;
	title?: string;
	status: "success" | "failed" | "aborted";
	model?: string;
	thinking?: string;
	totalTokens?: number;
	toolCount: number;
	outputSummary?: string;
	error?: string;
}
