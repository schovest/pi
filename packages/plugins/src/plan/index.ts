import type {
	AgentEndEvent,
	AgentMessage,
	AssistantMessage,
	BeforeAgentStartEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolCallEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Plan, TextContent } from "@earendil-works/pi-agent-core";
import { Key } from "@earendil-works/pi-tui";
import { isSafeCommand } from "./bash-safety.ts";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

interface PlanState {
	planModeEnabled: boolean;
	currentPlan: Plan | null;
}

export default function planPlugin(pi: ExtensionAPI): void {
	const state: PlanState = {
		planModeEnabled: false,
		currentPlan: null,
	};

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		const ui = ctx.ui;

		if (state.currentPlan && state.currentPlan.status === "executing") {
			const completed = state.currentPlan.steps.filter(
				(s) => s.status === "completed" || s.status === "skipped",
			).length;
			ui.setStatus("plan-mode", ui.theme.fg("accent", `plan ${completed}/${state.currentPlan.steps.length}`));
		} else if (state.planModeEnabled) {
			ui.setStatus("plan-mode", ui.theme.fg("warning", "plan"));
		} else {
			ui.setStatus("plan-mode", undefined);
		}

		if (state.currentPlan && (state.currentPlan.status === "executing" || state.currentPlan.status === "paused")) {
			const lines = state.currentPlan.steps.map((step) => {
				if (step.status === "completed") {
					return ui.theme.fg("success", "☑ ") + ui.theme.fg("muted", ui.theme.strikethrough(step.text));
				}
				if (step.status === "in_progress") {
					return ui.theme.fg("accent", "▶ ") + step.text;
				}
				if (step.status === "failed") {
					return ui.theme.fg("error", "✗ ") + step.text;
				}
				return ui.theme.fg("muted", "☐ ") + step.text;
			});
			ui.setWidget("plan-todos", lines);
		} else {
			ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		state.planModeEnabled = !state.planModeEnabled;
		state.currentPlan = null;

		if (state.planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify("Plan mode enabled. Tools: " + PLAN_MODE_TOOLS.join(", "));
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args: string, ctx: ExtensionContext) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-approve", {
		description: "Approve current plan and start execution",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!state.currentPlan || state.currentPlan.status !== "draft") {
				ctx.ui.notify("No draft plan to approve", "warning");
				return;
			}
			state.currentPlan.status = "approved";
			state.planModeEnabled = false;
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			state.currentPlan.status = "executing";
			const firstPending = state.currentPlan.steps.find((s) => s.status === "pending");
			if (firstPending) firstPending.status = "in_progress";
			updateStatus(ctx);
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: `Execute the plan. Start with: ${firstPending?.text ?? "step 1"}`, display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("plan-pause", {
		description: "Pause plan execution",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!state.currentPlan || state.currentPlan.status !== "executing") {
				ctx.ui.notify("No executing plan to pause", "warning");
				return;
			}
			state.currentPlan.status = "paused";
			updateStatus(ctx);
			ctx.ui.notify("Plan execution paused");
		},
	});

	pi.registerCommand("plan-resume", {
		description: "Resume plan execution",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!state.currentPlan || state.currentPlan.status !== "paused") {
				ctx.ui.notify("No paused plan to resume", "warning");
				return;
			}
			state.currentPlan.status = "executing";
			const nextPending = state.currentPlan.steps.find((s) => s.status === "pending");
			if (nextPending) nextPending.status = "in_progress";
			updateStatus(ctx);
			pi.sendMessage(
				{ customType: "plan-resume", content: `Resume plan. Next: ${nextPending?.text ?? "remaining steps"}`, display: true },
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show current plan status",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!state.currentPlan) {
				ctx.ui.notify("No active plan", "info");
				return;
			}
			const lines = state.currentPlan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.text}${s.result ? ` — ${s.result}` : ""}`);
			ctx.ui.notify(`Plan: ${state.currentPlan.title} (${state.currentPlan.status})\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("plan-save", {
		description: "Save current plan as document",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!state.currentPlan) {
				ctx.ui.notify("No plan to save", "warning");
				return;
			}
			ctx.ui.notify(`Plan "${state.currentPlan.title}" saved to .pi/plans/${state.currentPlan.id}.md`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx: ExtensionContext) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event: ToolCallEvent) => {
		if (!state.planModeEnabled || event.toolName !== "bash") return;
		const command = (event.input as Record<string, unknown>).command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked. Use /plan to disable.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event: ContextEvent) => {
		if (state.planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async (_event: BeforeAgentStartEvent) => {
		if (state.planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

For each step, note:
- Dependencies on other steps (e.g., "depends on step 1")
- Verification command or condition
- Whether it can run in parallel with other steps

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (state.currentPlan && state.currentPlan.status === "executing") {
			const remaining = state.currentPlan.steps.filter((s) => s.status === "pending" || s.status === "in_progress");
			const todoList = remaining.map((s) => `${s.id}. ${s.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response (n = step number).`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx: ExtensionContext) => {
		if (!state.currentPlan || state.currentPlan.status !== "executing") return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		const donePattern = /\[DONE:(\d+)\]/gi;
		for (const match of text.matchAll(donePattern)) {
			const stepNum = Number(match[1]);
			const step = state.currentPlan.steps[stepNum - 1];
			if (step && step.status === "in_progress") {
				step.status = "completed";
			}
		}

		const allDone = state.currentPlan.steps.every(
			(s) => s.status === "completed" || s.status === "skipped",
		);
		if (allDone) {
			state.currentPlan.status = "completed";
			pi.sendMessage(
				{ customType: "plan-complete", content: "**Plan Complete!**", display: true },
				{ triggerTurn: false },
			);
			state.currentPlan = null;
			pi.setActiveTools(NORMAL_MODE_TOOLS);
		} else {
			const nextPending = state.currentPlan.steps.find((s) => s.status === "pending");
			if (nextPending) nextPending.status = "in_progress";
		}

		updateStatus(ctx);
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		if (state.currentPlan && state.currentPlan.status === "executing") return;
		if (!state.planModeEnabled) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const { parsePlan, inferDependencies } = await import("@earendil-works/pi-agent-core");
			const parsed = parsePlan(getTextContent(lastAssistant));
			if (parsed.steps.length > 0) {
				parsed.steps = inferDependencies(parsed.steps);
				state.currentPlan = parsed;
			}
		}

		if (state.currentPlan && state.currentPlan.steps.length > 0) {
			const todoListText = state.currentPlan.steps
				.map((s, i) => `${i + 1}. ☐ ${s.text}${s.dependencies.length > 0 ? ` (after ${s.dependencies.join(", ")})` : ""}`)
				.join("\n");

			pi.sendMessage(
				{ customType: "plan-todo-list", content: `**Plan Steps (${state.currentPlan.steps.length}):**\n\n${todoListText}`, display: true },
				{ triggerTurn: false },
			);

			const choice = await ctx.ui.select("Plan mode - what next?", [
				"Execute the plan (track progress)",
				"Stay in plan mode",
				"Refine the plan",
			]);

			if (choice === "Execute the plan (track progress)") {
				state.planModeEnabled = false;
				state.currentPlan!.status = "approved";
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				state.currentPlan!.status = "executing";
				const firstPending = state.currentPlan!.steps.find((s) => s.status === "pending");
				if (firstPending) firstPending.status = "in_progress";
				updateStatus(ctx);

				pi.sendMessage(
					{ customType: "plan-mode-execute", content: `Execute the plan. Start with: ${firstPending?.text ?? "step 1"}`, display: true },
					{ triggerTurn: true },
				);
			} else if (choice === "Refine the plan") {
				const refinement = await ctx.ui.editor("Refine the plan:", "");
				if (refinement?.trim()) {
					pi.sendUserMessage(refinement.trim());
				}
			}
		}
	});

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (pi.getFlag("plan") === true) {
			state.planModeEnabled = true;
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
