import type { Plan, PlanStep, StepStatus } from "./plan-types.ts";

const STATUS_EMOJI: Record<StepStatus, string> = {
	completed: "✅",
	in_progress: "▶️",
	pending: "⬜",
	skipped: "⏭️",
	failed: "❌",
};

export function generatePlanDocument(plan: Plan): string {
	const date = new Date(plan.createdAt).toISOString().split("T")[0];
	const lines: string[] = [`# Plan: ${plan.title}`, "", `**Status**: ${plan.status}`, `**Created**: ${date}`];

	if (plan.status === "completed") {
		lines.push(`**Completed**: ${new Date().toISOString().split("T")[0]}`);
	}

	lines.push("", "## Steps", "");

	for (let i = 0; i < plan.steps.length; i++) {
		const step = plan.steps[i];
		const emoji = STATUS_EMOJI[step.status];
		lines.push(`${i + 1}. ${emoji} ${step.text}`);

		if (step.result) {
			lines.push(`   - Result: ${step.result}`);
		}
	}

	return lines.join("\n");
}

export function parsePlanDocument(doc: string): Plan {
	const titleMatch = doc.match(/^# Plan:\s+(.+)$/m);
	const title = titleMatch?.[1]?.trim() ?? "Plan";

	const statusMatch = doc.match(/\*\*Status\*\*:\s*(\w+)/);
	const status = (statusMatch?.[1] ?? "draft") as Plan["status"];

	const createdMatch = doc.match(/\*\*Created\*\*:\s*(\S+)/);
	const createdAt = createdMatch ? new Date(createdMatch[1]).getTime() : Date.now();

	const steps: PlanStep[] = [];
	const stepPattern = /^\d+\.\s+(✅|▶️|⬜|⏭️|❌)\s+(.+)$/gm;

	for (const match of doc.matchAll(stepPattern)) {
		const emoji = match[1];
		const text = match[2].trim();
		const statusMap: Record<string, StepStatus> = {
			"✅": "completed",
			"▶️": "in_progress",
			"⬜": "pending",
			"⏭️": "skipped",
			"❌": "failed",
		};
		steps.push({
			id: `s${steps.length + 1}`,
			text,
			status: statusMap[emoji] ?? "pending",
			dependencies: [],
		});
	}

	const resultPattern = /^\s+- Result:\s+(.+)$/gm;
	let resultIdx = 0;
	for (const match of doc.matchAll(resultPattern)) {
		if (resultIdx < steps.length) {
			steps[resultIdx].result = match[1].trim();
		}
		resultIdx++;
	}

	return {
		id: `p-${createdAt}`,
		title,
		steps,
		status,
		createdAt,
		rawMarkdown: doc,
	};
}
