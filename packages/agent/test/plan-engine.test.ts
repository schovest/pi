import { describe, expect, it } from "vitest";
import { PlanEngine } from "../src/plan/plan-engine.ts";

describe("PlanEngine", () => {
	describe("createPlan", () => {
		it("creates a draft plan from raw markdown", () => {
			const engine = new PlanEngine();
			const plan = engine.createPlan(`Plan:
1. First step
2. Second step`);

			expect(plan.status).toBe("draft");
			expect(plan.steps).toHaveLength(2);
			expect(engine.currentPlan).toBe(plan);
		});
	});

	describe("approvePlan", () => {
		it("transitions draft to approved", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one`);
			engine.approvePlan();

			expect(engine.currentPlan!.status).toBe("approved");
		});

		it("throws if not in draft status", () => {
			const engine = new PlanEngine();
			expect(() => engine.approvePlan()).toThrow();
		});
	});

	describe("startExecution", () => {
		it("transitions approved to executing", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one`);
			engine.approvePlan();
			engine.startExecution();

			expect(engine.currentPlan!.status).toBe("executing");
			expect(engine.currentPlan!.steps[0].status).toBe("in_progress");
		});

		it("throws if not in approved status", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one`);
			expect(() => engine.startExecution()).toThrow();
		});
	});

	describe("pauseExecution / resumeExecution", () => {
		it("pauses and resumes execution", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one\n2. Step two`);
			engine.approvePlan();
			engine.startExecution();
			engine.pauseExecution();

			expect(engine.currentPlan!.status).toBe("paused");

			engine.resumeExecution();
			expect(engine.currentPlan!.status).toBe("executing");
		});
	});

	describe("step operations", () => {
		it("marks step completed and auto-advances", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one\n2. Step two`);
			engine.approvePlan();
			engine.startExecution();

			engine.markStepCompleted("s1", "Done");
			expect(engine.currentPlan!.steps[0].status).toBe("completed");
			expect(engine.currentPlan!.steps[0].result).toBe("Done");
			expect(engine.currentPlan!.steps[1].status).toBe("in_progress");
		});

		it("marks step failed and pauses", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one`);
			engine.approvePlan();
			engine.startExecution();

			engine.markStepFailed("s1", "Error occurred");
			expect(engine.currentPlan!.steps[0].status).toBe("failed");
			expect(engine.currentPlan!.status).toBe("paused");
		});

		it("skips step", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one\n2. Step two`);
			engine.approvePlan();
			engine.startExecution();

			engine.skipStep("s1");
			expect(engine.currentPlan!.steps[0].status).toBe("skipped");
		});

		it("completes plan when all steps done", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one`);
			engine.approvePlan();
			engine.startExecution();

			engine.markStepCompleted("s1", "Done");
			expect(engine.currentPlan!.status).toBe("completed");
		});
	});

	describe("resetPlan", () => {
		it("resets to draft from any state", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one`);
			engine.approvePlan();
			engine.startExecution();
			engine.resetPlan();

			expect(engine.currentPlan!.status).toBe("draft");
			expect(engine.currentPlan!.steps[0].status).toBe("pending");
		});
	});

	describe("getNextExecutableSteps", () => {
		it("returns pending steps with completed dependencies", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one\n2. Step two`);
			engine.approvePlan();
			engine.startExecution();

			const next = engine.getNextExecutableSteps();
			expect(next).toHaveLength(1);
			expect(next[0].id).toBe("s1");
		});
	});

	describe("serialization", () => {
		it("round-trips through serialize/deserialize", () => {
			const engine = new PlanEngine();
			engine.createPlan(`Plan:\n1. Step one\n2. Step two`);
			engine.approvePlan();

			const json = engine.serialize();
			const restored = PlanEngine.deserialize(json);

			expect(restored.currentPlan!.status).toBe("approved");
			expect(restored.currentPlan!.steps).toHaveLength(2);
			expect(restored.currentPlan!.title).toBe("Plan");
		});
	});
});
