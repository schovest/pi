import { describe, expect, it } from "vitest";
import { detectCycle, getNextExecutableSteps, topologicalGroupByDependency } from "../src/plan/plan-scheduler.ts";
import type { PlanStep } from "../src/plan/plan-types.ts";

function makeStep(id: string, deps: string[] = []): PlanStep {
	return { id, text: `Step ${id}`, status: "pending", dependencies: deps };
}

describe("detectCycle", () => {
	it("returns false for acyclic graph", () => {
		const steps = [makeStep("s1"), makeStep("s2", ["s1"]), makeStep("s3", ["s2"])];
		expect(detectCycle(steps)).toBe(false);
	});

	it("returns true for direct cycle", () => {
		const steps = [makeStep("s1", ["s2"]), makeStep("s2", ["s1"])];
		expect(detectCycle(steps)).toBe(true);
	});

	it("returns true for indirect cycle", () => {
		const steps = [makeStep("s1", ["s3"]), makeStep("s2", ["s1"]), makeStep("s3", ["s2"])];
		expect(detectCycle(steps)).toBe(true);
	});

	it("returns false for independent steps", () => {
		const steps = [makeStep("s1"), makeStep("s2"), makeStep("s3")];
		expect(detectCycle(steps)).toBe(false);
	});
});

describe("topologicalGroupByDependency", () => {
	it("groups independent steps together", () => {
		const steps = [makeStep("s1"), makeStep("s2"), makeStep("s3")];
		const groups = topologicalGroupByDependency(steps);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toHaveLength(3);
	});

	it("separates sequential steps into different groups", () => {
		const steps = [makeStep("s1"), makeStep("s2", ["s1"]), makeStep("s3", ["s2"])];
		const groups = topologicalGroupByDependency(steps);
		expect(groups).toHaveLength(3);
		expect(groups[0].map((s) => s.id)).toEqual(["s1"]);
		expect(groups[1].map((s) => s.id)).toEqual(["s2"]);
		expect(groups[2].map((s) => s.id)).toEqual(["s3"]);
	});

	it("groups parallel steps after shared dependency", () => {
		const steps = [makeStep("s1"), makeStep("s2", ["s1"]), makeStep("s3", ["s1"])];
		const groups = topologicalGroupByDependency(steps);
		expect(groups).toHaveLength(2);
		expect(groups[0].map((s) => s.id)).toEqual(["s1"]);
		expect(groups[1].map((s) => s.id).sort()).toEqual(["s2", "s3"]);
	});

	it("handles diamond dependency", () => {
		const steps = [makeStep("s1"), makeStep("s2", ["s1"]), makeStep("s3", ["s1"]), makeStep("s4", ["s2", "s3"])];
		const groups = topologicalGroupByDependency(steps);
		expect(groups).toHaveLength(3);
		expect(groups[0].map((s) => s.id)).toEqual(["s1"]);
		expect(groups[1].map((s) => s.id).sort()).toEqual(["s2", "s3"]);
		expect(groups[2].map((s) => s.id)).toEqual(["s4"]);
	});
});

describe("getNextExecutableSteps", () => {
	it("returns steps with all dependencies completed", () => {
		const steps = [
			{ ...makeStep("s1"), status: "completed" as const },
			makeStep("s2", ["s1"]),
			makeStep("s3", ["s1"]),
		];
		const next = getNextExecutableSteps(steps);
		expect(next.map((s) => s.id).sort()).toEqual(["s2", "s3"]);
	});

	it("excludes steps with pending dependencies", () => {
		const steps = [makeStep("s1"), makeStep("s2", ["s1"])];
		const next = getNextExecutableSteps(steps);
		expect(next.map((s) => s.id)).toEqual(["s1"]);
	});

	it("excludes already in-progress steps", () => {
		const steps = [{ ...makeStep("s1"), status: "in_progress" as const }, makeStep("s2")];
		const next = getNextExecutableSteps(steps);
		expect(next.map((s) => s.id)).toEqual(["s2"]);
	});

	it("excludes completed steps", () => {
		const steps = [
			{ ...makeStep("s1"), status: "completed" as const },
			{ ...makeStep("s2"), status: "completed" as const },
		];
		const next = getNextExecutableSteps(steps);
		expect(next).toHaveLength(0);
	});
});
