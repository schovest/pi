import type { Plan, PlanStep, StepStatus } from "./plan-types.ts";

const SEQUENTIAL_KEYWORDS = [
	/\bthen\b/i,
	/\bafter\s+(that|which|completing|finishing)\b/i,
	/\bnext\b/i,
	/\bfollowing\s+(that|which|up)\b/i,
	/\b先\b/,
	/\b然后\b/,
	/\b接着\b/,
	/\b之后\b/,
];

const PARALLEL_KEYWORDS = [
	/\bmeanwhile\b/i,
	/\bin\s+parallel\b/i,
	/\bat\s+the\s+same\s+time\b/i,
	/\bconcurrently\b/i,
	/\b同时\b/,
	/\b并行\b/,
	/\b并排\b/,
];

const FILE_PATH_PATTERN = /(?:\/[\w.-]+)+\.\w+/g;

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	return cleaned;
}

function extractFilePaths(text: string): Set<string> {
	const paths = new Set<string>();
	for (const match of text.matchAll(FILE_PATH_PATTERN)) {
		paths.add(match[0]);
	}
	return paths;
}

function parseNumberedList(text: string): { text: string; completed: boolean }[] {
	const items: { text: string; completed: boolean }[] = [];
	const pattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
	for (const match of text.matchAll(pattern)) {
		const raw = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (raw.length > 3 && !raw.startsWith("`") && !raw.startsWith("/")) {
			items.push({ text: cleanStepText(raw), completed: false });
		}
	}
	return items;
}

function parseTaskList(text: string): { text: string; completed: boolean }[] {
	const items: { text: string; completed: boolean }[] = [];
	const pattern = /^[\s]*-[\s]*\[([ xX])\][\s]+(.+)/gm;
	for (const match of text.matchAll(pattern)) {
		const completed = match[1].toLowerCase() === "x";
		const raw = match[2].trim();
		if (raw.length > 3) {
			items.push({ text: cleanStepText(raw), completed });
		}
	}
	return items;
}

function parseHeadings(text: string): { text: string; completed: boolean }[] {
	const items: { text: string; completed: boolean }[] = [];
	const pattern = /^#{2,}\s+(?:Step\s+)?(\d+[.:]?\s*)(.+)/gm;
	for (const match of text.matchAll(pattern)) {
		const raw = match[2].trim();
		if (raw.length > 3) {
			items.push({ text: cleanStepText(raw), completed: false });
		}
	}
	return items;
}

function parseParagraphs(text: string): { text: string; completed: boolean }[] {
	const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 10);
	return paragraphs.map((p) => ({ text: cleanStepText(p.trim()), completed: false }));
}

function extractTitle(text: string): string {
	const headingMatch = text.match(/^#{1,2}\s+(.+)$/m);
	if (headingMatch) {
		const title = headingMatch[1].trim();
		if (!title.toLowerCase().startsWith("plan")) {
			return title;
		}
	}
	return "Plan";
}

export function parsePlan(rawMarkdown: string): Plan {
	const title = extractTitle(rawMarkdown);

	const candidates = [parseNumberedList(rawMarkdown), parseTaskList(rawMarkdown), parseHeadings(rawMarkdown)];

	const nonEmpty = candidates.filter((c) => c.length > 0);
	let items: { text: string; completed: boolean }[];

	if (nonEmpty.length > 0) {
		items = nonEmpty.reduce((best, c) => (c.length > best.length ? c : best), nonEmpty[0]);
	} else {
		items = parseParagraphs(rawMarkdown);
		if (items.length === 0) {
			items = [{ text: cleanStepText(rawMarkdown.trim()) || "Execute the task", completed: false }];
		}
	}

	const steps: PlanStep[] = items.map((item, i) => ({
		id: `s${i + 1}`,
		text: item.text,
		status: (item.completed ? "completed" : "pending") as StepStatus,
		dependencies: [],
	}));

	return {
		id: `p-${Date.now()}`,
		title,
		steps,
		status: "draft",
		createdAt: Date.now(),
		rawMarkdown,
	};
}

export function inferDependencies(steps: PlanStep[]): PlanStep[] {
	const result = steps.map((step) => ({ ...step, dependencies: [...step.dependencies] }));

	for (let i = 0; i < result.length; i++) {
		if (result[i].dependencies.length > 0) continue;

		const hasParallelKeyword = PARALLEL_KEYWORDS.some((p) => p.test(result[i].text));
		if (hasParallelKeyword) continue;

		const hasSequentialKeyword = SEQUENTIAL_KEYWORDS.some((p) => p.test(result[i].text));
		if (hasSequentialKeyword && i > 0) {
			result[i].dependencies.push(result[i - 1].id);
			continue;
		}

		const currentPaths = extractFilePaths(result[i].text);
		if (currentPaths.size > 0 && i > 0) {
			for (let j = i - 1; j >= 0; j--) {
				const prevPaths = extractFilePaths(result[j].text);
				const overlap = [...currentPaths].filter((p) => prevPaths.has(p));
				if (overlap.length > 0) {
					result[i].dependencies.push(result[j].id);
					break;
				}
			}
		}
	}

	return result;
}
