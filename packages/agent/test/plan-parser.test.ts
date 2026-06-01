import { describe, expect, it } from "vitest";
import { inferDependencies, parsePlan } from "../src/plan/plan-parser.ts";
import type { PlanStep } from "../src/plan/plan-types.ts";

describe("parsePlan", () => {
	describe("numbered list after Plan: header", () => {
		it("extracts numbered items with dot notation", () => {
			const input = `Here's the plan:

Plan:
1. Analyze existing code structure
2. Design data model
3. Implement PlanEngine`;

			const result = parsePlan(input);
			expect(result.steps).toHaveLength(3);
			expect(result.steps[0].text).toBe("Analyze existing code structure");
			expect(result.steps[0].id).toBe("s1");
			expect(result.steps[0].status).toBe("pending");
			expect(result.title).toBe("Plan");
		});

		it("extracts numbered items with parenthesis notation", () => {
			const input = `Plan:
1) First item
2) Second item`;

			const result = parsePlan(input);
			expect(result.steps).toHaveLength(2);
		});

		it("handles bold Plan header", () => {
			const input = `**Plan:**
1. Do something`;

			const result = parsePlan(input);
			expect(result.steps).toHaveLength(1);
		});
	});

	describe("markdown task list", () => {
		it("extracts unchecked task items", () => {
			const input = `Plan:
- [ ] Analyze code
- [ ] Design model
- [ ] Implement engine`;

			const result = parsePlan(input);
			expect(result.steps).toHaveLength(3);
			expect(result.steps[0].text).toBe("Analyze code");
		});

		it("extracts mixed checked/unchecked items", () => {
			const input = `Plan:
- [x] Already done
- [ ] Still pending`;

			const result = parsePlan(input);
			expect(result.steps).toHaveLength(2);
			expect(result.steps[0].status).toBe("completed");
			expect(result.steps[1].status).toBe("pending");
		});
	});

	describe("heading-based steps", () => {
		it("extracts steps from ## Step N headings", () => {
			const input = `## Step 1: Analyze code
We need to look at the existing structure.

## Step 2: Design model
Create the data model.

## Step 3: Implement
Build the engine.`;

			const result = parsePlan(input);
			expect(result.steps).toHaveLength(3);
			expect(result.steps[0].text).toBe("Analyze code");
		});
	});

	describe("paragraph fallback", () => {
		it("splits paragraphs into steps when no structured format found", () => {
			const input = `First we need to analyze the code.

Then we design the model.

Finally we implement the engine.`;

			const result = parsePlan(input);
			expect(result.steps.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe("fallback to single step", () => {
		it("creates single step for very short input", () => {
			const input = `Just do the thing`;
			const result = parsePlan(input);
			expect(result.steps).toHaveLength(1);
			expect(result.steps[0].text).toBe("Just do the thing");
		});
	});

	describe("title extraction", () => {
		it("extracts title from first heading", () => {
			const input = `# Refactor Authentication

Plan:
1. Step one`;

			const result = parsePlan(input);
			expect(result.title).toBe("Refactor Authentication");
		});

		it("defaults title to Plan when no heading", () => {
			const input = `Plan:
1. Step one`;

			const result = parsePlan(input);
			expect(result.title).toBe("Plan");
		});
	});

	describe("rawMarkdown preservation", () => {
		it("preserves original input in rawMarkdown", () => {
			const input = `Plan:
1. Step one
2. Step two`;

			const result = parsePlan(input);
			expect(result.rawMarkdown).toBe(input);
		});
	});
});

describe("inferDependencies", () => {
	it("infers dependency from file reference", () => {
		const steps: PlanStep[] = [
			{ id: "s1", text: "Create packages/agent/src/plan/plan-types.ts", status: "pending", dependencies: [] },
			{
				id: "s2",
				text: "Import types from packages/agent/src/plan/plan-types.ts",
				status: "pending",
				dependencies: [],
			},
		];

		const result = inferDependencies(steps);
		expect(result[1].dependencies).toContain("s1");
	});

	it("infers dependency from sequential keywords (then/after)", () => {
		const steps: PlanStep[] = [
			{ id: "s1", text: "Analyze the codebase", status: "pending", dependencies: [] },
			{ id: "s2", text: "Then design the model", status: "pending", dependencies: [] },
		];

		const result = inferDependencies(steps);
		expect(result[1].dependencies).toContain("s1");
	});

	it("infers no dependency for parallel keywords (meanwhile/in parallel)", () => {
		const steps: PlanStep[] = [
			{ id: "s1", text: "Analyze the codebase", status: "pending", dependencies: [] },
			{ id: "s2", text: "Meanwhile, design the model", status: "pending", dependencies: [] },
		];

		const result = inferDependencies(steps);
		expect(result[1].dependencies).toHaveLength(0);
	});

	it("returns steps unchanged when no dependencies inferred", () => {
		const steps: PlanStep[] = [
			{ id: "s1", text: "Unrelated task A", status: "pending", dependencies: [] },
			{ id: "s2", text: "Unrelated task B", status: "pending", dependencies: [] },
		];

		const result = inferDependencies(steps);
		expect(result[0].dependencies).toHaveLength(0);
		expect(result[1].dependencies).toHaveLength(0);
	});
});
