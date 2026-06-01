export type StepStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";

export type PlanStatus = "draft" | "approved" | "executing" | "completed" | "failed" | "paused";

export type ToolRestriction = "readonly" | "full";

export interface PlanStep {
	id: string;
	text: string;
	status: StepStatus;
	dependencies: string[];
	toolRestriction?: ToolRestriction;
	verification?: string;
	assignedTo?: "main" | string;
	result?: string;
}

export interface Plan {
	id: string;
	title: string;
	steps: PlanStep[];
	status: PlanStatus;
	createdAt: number;
	rawMarkdown: string;
}

export type PlanJSON = Plan;
