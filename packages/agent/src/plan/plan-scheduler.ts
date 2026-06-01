import type { PlanStep } from "./plan-types.ts";

export function detectCycle(steps: PlanStep[]): boolean {
	const adj = new Map<string, string[]>();
	const stepIds = new Set(steps.map((s) => s.id));

	for (const step of steps) {
		adj.set(
			step.id,
			step.dependencies.filter((d) => stepIds.has(d)),
		);
	}

	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const id of stepIds) {
		color.set(id, WHITE);
	}

	function dfs(node: string): boolean {
		color.set(node, GRAY);
		const neighbors = adj.get(node) ?? [];
		for (const neighbor of neighbors) {
			const neighborColor = color.get(neighbor);
			if (neighborColor === GRAY) return true;
			if (neighborColor === WHITE && dfs(neighbor)) return true;
		}
		color.set(node, BLACK);
		return false;
	}

	for (const id of stepIds) {
		if (color.get(id) === WHITE) {
			if (dfs(id)) return true;
		}
	}

	return false;
}

export function topologicalGroupByDependency(steps: PlanStep[]): PlanStep[][] {
	if (steps.length === 0) return [];

	const stepMap = new Map(steps.map((s) => [s.id, s]));
	const inDegree = new Map<string, number>();
	const adj = new Map<string, string[]>();

	for (const step of steps) {
		inDegree.set(step.id, 0);
		adj.set(step.id, []);
	}

	for (const step of steps) {
		for (const dep of step.dependencies) {
			if (stepMap.has(dep)) {
				adj.get(dep)!.push(step.id);
				inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
			}
		}
	}

	const groups: PlanStep[][] = [];
	let queue = steps.filter((s) => (inDegree.get(s.id) ?? 0) === 0);

	while (queue.length > 0) {
		groups.push(queue);
		const nextQueue: PlanStep[] = [];
		for (const step of queue) {
			const dependents = adj.get(step.id) ?? [];
			for (const depId of dependents) {
				const newDegree = (inDegree.get(depId) ?? 1) - 1;
				inDegree.set(depId, newDegree);
				if (newDegree === 0) {
					nextQueue.push(stepMap.get(depId)!);
				}
			}
		}
		queue = nextQueue;
	}

	return groups;
}

export function getNextExecutableSteps(steps: PlanStep[]): PlanStep[] {
	const completedIds = new Set(
		steps.filter((s) => s.status === "completed" || s.status === "skipped").map((s) => s.id),
	);

	return steps.filter((step) => {
		if (step.status !== "pending") return false;
		return step.dependencies.every((dep) => completedIds.has(dep));
	});
}
