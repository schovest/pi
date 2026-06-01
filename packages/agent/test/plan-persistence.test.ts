import { describe, expect, it } from "vitest";
import { generatePlanDocument, parsePlanDocument } from "../src/plan/plan-persistence.ts";
import type { Plan } from "../src/plan/plan-types.ts";

const samplePlan: Plan = {
	id: "p-20260601-001",
	title: "Refactor Authentication",
	steps: [
		{ id: "s1", text: "Analyze existing code", status: "completed", dependencies: [], result: "Found 3 modules" },
		{
			id: "s2",
			text: "Design data model",
			status: "completed",
			dependencies: ["s1"],
			result: "PlanStep/Plan defined",
		},
		{ id: "s3", text: "Implement PlanEngine", status: "pending", dependencies: ["s2"] },
	],
	status: "executing",
	createdAt: 1748764800000,
	rawMarkdown: "Plan:\n1. Analyze existing code\n2. Design data model\n3. Implement PlanEngine",
};

describe("generatePlanDocument", () => {
	it("generates markdown document from plan", () => {
		const doc = generatePlanDocument(samplePlan);
		expect(doc).toContain("# Plan: Refactor Authentication");
		expect(doc).toContain("**Status**: executing");
		expect(doc).toContain("✅ Analyze existing code");
		expect(doc).toContain("⬜ Implement PlanEngine");
		expect(doc).toContain("Found 3 modules");
	});

	it("includes completion timestamp for completed plans", () => {
		const completedPlan: Plan = { ...samplePlan, status: "completed" };
		const doc = generatePlanDocument(completedPlan);
		expect(doc).toContain("**Completed**:");
	});
});

describe("parsePlanDocument", () => {
	it("round-trips through generate and parse", () => {
		const doc = generatePlanDocument(samplePlan);
		const parsed = parsePlanDocument(doc);
		expect(parsed.title).toBe("Refactor Authentication");
		expect(parsed.steps).toHaveLength(3);
		expect(parsed.steps[0].status).toBe("completed");
		expect(parsed.steps[0].result).toBe("Found 3 modules");
		expect(parsed.steps[2].status).toBe("pending");
	});
});
