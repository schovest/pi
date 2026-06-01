import type { Plan, PlanJSON, PlanStatus, PlanStep, StepStatus } from "./plan-types.ts";
import { inferDependencies, parsePlan } from "./plan-parser.ts";
import { detectCycle, getNextExecutableSteps } from "./plan-scheduler.ts";

export class PlanEngine {
  currentPlan: Plan | null = null;

  createPlan(rawMarkdown: string): Plan {
    const plan = parsePlan(rawMarkdown);
    plan.steps = inferDependencies(plan.steps);

    if (detectCycle(plan.steps)) {
      plan.steps = plan.steps.map((s) => ({ ...s, dependencies: [] }));
    }

    this.currentPlan = plan;
    return plan;
  }

  approvePlan(): void {
    this.requireStatus("draft");
    this.currentPlan!.status = "approved";
  }

  startExecution(): void {
    this.requireStatus("approved");
    this.currentPlan!.status = "executing";
    this.advanceSteps();
  }

  pauseExecution(): void {
    this.requireStatus("executing");
    this.currentPlan!.status = "paused";
  }

  resumeExecution(): void {
    this.requireStatus("paused");
    this.currentPlan!.status = "executing";
    this.advanceSteps();
  }

  resetPlan(): void {
    if (!this.currentPlan) return;
    this.currentPlan.status = "draft";
    this.currentPlan.steps = this.currentPlan.steps.map((s) => ({
      ...s,
      status: "pending" as StepStatus,
      result: undefined,
    }));
  }

  updateStep(stepId: string, update: Partial<PlanStep>): void {
    const step = this.findStep(stepId);
    Object.assign(step, update);
  }

  skipStep(stepId: string): void {
    const step = this.findStep(stepId);
    step.status = "skipped";
    this.checkAutoAdvance();
  }

  retryStep(stepId: string): void {
    const step = this.findStep(stepId);
    step.status = "in_progress";
    step.result = undefined;
    if (this.currentPlan!.status === "paused") {
      this.currentPlan!.status = "executing";
    }
  }

  getNextExecutableSteps(): PlanStep[] {
    if (!this.currentPlan) return [];
    const inProgress = this.currentPlan.steps.filter((s) => s.status === "in_progress");
    if (inProgress.length > 0) return inProgress;
    return getNextExecutableSteps(this.currentPlan.steps);
  }

  markStepStarted(stepId: string): void {
    const step = this.findStep(stepId);
    step.status = "in_progress";
  }

  markStepCompleted(stepId: string, result?: string): void {
    const step = this.findStep(stepId);
    step.status = "completed";
    step.result = result;
    this.checkAutoAdvance();
  }

  markStepFailed(stepId: string, error: string): void {
    const step = this.findStep(stepId);
    step.status = "failed";
    step.result = error;
    this.currentPlan!.status = "paused";
  }

  serialize(): PlanJSON {
    if (!this.currentPlan) {
      throw new Error("No plan to serialize");
    }
    return { ...this.currentPlan };
  }

  static deserialize(data: PlanJSON): PlanEngine {
    const engine = new PlanEngine();
    engine.currentPlan = { ...data, steps: data.steps.map((s) => ({ ...s })) };
    return engine;
  }

  private requireStatus(status: PlanStatus): void {
    if (!this.currentPlan) {
      throw new Error(`No plan exists (expected status: ${status})`);
    }
    if (this.currentPlan.status !== status) {
      throw new Error(`Expected status ${status}, got ${this.currentPlan.status}`);
    }
  }

  private findStep(stepId: string): PlanStep {
    if (!this.currentPlan) throw new Error("No plan exists");
    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);
    return step;
  }

  private advanceSteps(): void {
    const pending = getNextExecutableSteps(this.currentPlan!.steps);
    if (pending.length > 0) {
      pending[0].status = "in_progress";
    }
  }

  private checkAutoAdvance(): void {
    if (!this.currentPlan || this.currentPlan.status !== "executing") return;

    const allDone = this.currentPlan.steps.every(
      (s) => s.status === "completed" || s.status === "skipped",
    );

    if (allDone) {
      this.currentPlan.status = "completed";
      return;
    }

    this.advanceSteps();
  }
}
