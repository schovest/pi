/**
 * Goal 自主编排扩展
 *
 * 用户输入 `/goal <target>` → agent 自主分解为子任务 → 调度 subagent 执行
 * → 追踪进度 → 遇阻自主调整 → 循环直到目标完成。全程无人值守。
 *
 * 核心运行时零改动，完全通过 ExtensionAPI 实现：
 * - registerCommand: /goal, /goal:status, /goal:abort
 * - registerTool: updateGoal（LLM 结构化进度更新）
 * - on("before_agent_start"): 每轮注入编排上下文到 systemPrompt
 * - on("agent_end"): 检查 goal 状态，未完成则自动驱动下一轮
 *
 * 状态持久化：GoalState 存于 CustomEntry（不入 LLM 上下文），compaction 不影响。
 */

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@schovest/pi-coding-agent";

// ============================================================================
// 类型定义
// ============================================================================

interface GoalTask {
	id: string; // "t1", "t2"...
	description: string;
	status: "pending" | "in_progress" | "done" | "failed" | "skipped";
	result?: string; // 执行结果摘要
	retryCount: number;
}

interface GoalState {
	id: string; // UUID
	target: string; // 原始目标
	createdAt: number;
	status: "planning" | "executing" | "completed" | "failed" | "aborted";
	tasks: GoalTask[]; // 分解的子任务列表
	turnCount: number; // 已执行轮次（护栏计数）
	maxTurns: number; // 硬上限（默认 50）
	summary?: string; // 最终总结（完成/失败时填写）
	consecutiveSameCalls: number; // 循环检测计数
	lastToolCallSignature?: string; // 上次 tool call 签名（循环检测用）
}

// ============================================================================
// 状态管理（模块级，单 session 单 goal）
// ============================================================================

let activeGoal: GoalState | undefined;

/** 用户配置的 maxTurns（通过 /goal:config 设置），undefined 表示用默认值 */
let configMaxTurns: number | undefined;

const DEFAULT_MAX_TURNS = 50;

function createGoal(target: string, maxTurns = DEFAULT_MAX_TURNS): GoalState {
	return {
		id: randomUUID(),
		target,
		createdAt: Date.now(),
		status: "planning",
		tasks: [],
		turnCount: 0,
		maxTurns,
		consecutiveSameCalls: 0,
	};
}

/** 从 session branch 读取最新的 goal 状态 */
function loadGoalFromSession(ctx: ExtensionContext): GoalState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: GoalState };
		if (entry.type === "custom" && entry.customType === "goal" && entry.data) {
			return entry.data;
		}
	}
	return undefined;
}

/** 持久化当前 goal 状态到 session */
function persistGoal(pi: ExtensionAPI): void {
	if (!activeGoal) return;
	pi.appendEntry("goal", activeGoal);
}

// ============================================================================
// 配置持久化（CustomEntry，跨 reload / session 切换存活）
// ============================================================================

interface GoalConfig {
	maxTurns: number | null; // null = 使用默认值
}

/** 从 session branch 读取最新的 goal 配置并恢复到内存 */
function loadConfigFromSession(ctx: ExtensionContext): void {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: GoalConfig };
		if (entry.type === "custom" && entry.customType === "goal:config" && entry.data) {
			configMaxTurns = entry.data.maxTurns ?? undefined;
			return;
		}
	}
}

/** 持久化当前配置到 session */
function persistConfig(pi: ExtensionAPI): void {
	pi.appendEntry("goal:config", { maxTurns: configMaxTurns ?? null });
}

// ============================================================================
// 编排逻辑
// ============================================================================

type CompletionResult = "continue" | "completed" | "failed";

function checkGoalCompletion(state: GoalState): CompletionResult {
	// 1. 用户主动中止
	if (state.status === "aborted") return "failed";

	// 2. maxTurns 超限
	if (state.turnCount >= state.maxTurns) return "failed";

	// 3. 所有 tasks 已终态（done/failed/skipped）
	const allTerminal = state.tasks.every(
		(t) => t.status === "done" || t.status === "failed" || t.status === "skipped",
	);
	if (!allTerminal) return "continue";

	// 4. 全部 done/skipped → completed
	const allDone = state.tasks.every((t) => t.status === "done" || t.status === "skipped");
	if (allDone) return "completed";

	// 5. 有 failed 但无 pending → failed
	return "failed";
}

// ============================================================================
// 循环检测
// ============================================================================

const LOOP_THRESHOLD = 3;

/** 检测连续相同 tool call 签名，超阈值返回 true */
function detectLoop(state: GoalState, signature: string): boolean {
	if (state.lastToolCallSignature === signature) {
		state.consecutiveSameCalls++;
		if (state.consecutiveSameCalls >= LOOP_THRESHOLD) {
			return true;
		}
	} else {
		state.consecutiveSameCalls = 0;
		state.lastToolCallSignature = signature;
	}
	return false;
}

// ============================================================================
// 格式化
// ============================================================================

const TASK_ICONS: Record<GoalTask["status"], string> = {
	pending: "⬜",
	in_progress: "🔄",
	done: "✅",
	failed: "❌",
	skipped: "⏭️",
};

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** 构建 updateGoal 工具的文本返回值（details 无 UI 渲染需求） */
function textResult(text: string): { content: { type: "text"; text: string }[]; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

function formatProgress(state: GoalState): string {
	const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
	const total = state.tasks.length;
	const inProgress = state.tasks.find((t) => t.status === "in_progress");
	const part = inProgress ? ` | 进行中: ${inProgress.id}(${truncate(inProgress.description, 30)})` : "";
	return `[Goal 进度] 已完成 ${done}/${total}${part}`;
}

function formatStatus(state: GoalState): string {
	const lines = [`🎯 ${state.target}`];
	for (const task of state.tasks) {
		const icon = TASK_ICONS[task.status];
		const result = task.result ? ` (${truncate(task.result, 40)})` : "";
		const retry = task.status === "failed" && task.retryCount > 0 ? ` [重试 ${task.retryCount}/2]` : "";
		lines.push(`  ${icon} ${task.id}: ${truncate(task.description, 50)}${retry}${result}`);
	}
	const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
	lines.push(`  进度: ${done}/${state.tasks.length} | 轮次: ${state.turnCount}/${state.maxTurns}`);
	return lines.join("\n");
}

/** 构建每轮 before_agent_start 注入的编排上下文（追加到 systemPrompt 末尾） */
function buildOrchestrationContext(state: GoalState): string {
	const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
	const pending = state.tasks
		.filter((t) => t.status === "pending" || t.status === "in_progress")
		.map((t) => t.id)
		.join(", ");
	return [
		"",
		"## 🎯 当前 Goal 编排（自动模式）",
		"",
		`目标：${state.target}`,
		`进度：${done}/${state.tasks.length} tasks completed`,
		`待办：${pending || "无"}`,
		"",
		"你正在自主编排模式下工作。继续执行下一个待办子任务。",
		"所有子任务完成后，验证整体目标并调用 updateGoal 标记 goal 完成。",
	].join("\n");
}

/** Footer 底栏进度显示 */
function formatFooter(state: GoalState): string {
	const done = state.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
	const total = state.tasks.length;
	return `🎯 goal: ${done}/${total} (${state.status})`;
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function goalExtension(pi: ExtensionAPI): void {
/** 同步 footer 进度显示（goal 无活动时清除） */
function syncFooter(ctx: ExtensionContext): void {
ctx.ui.setStatus("goal", activeGoal ? formatFooter(activeGoal) : undefined);
}

// ========================================================================
// 事件: session_start（恢复持久化的配置）
// ========================================================================
pi.on("session_start", (_event, ctx) => {
loadConfigFromSession(ctx);
});
	// ========================================================================
	// 命令: /goal <target>
	// ========================================================================
	pi.registerCommand("goal", {
		description: "启动目标编排：agent 自主分解并执行直到目标完成",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("Usage: /goal <目标描述>", "error");
				return;
			}

			// 已有 active goal 则拒绝
			const existing = activeGoal ?? loadGoalFromSession(ctx);
			if (existing && (existing.status === "planning" || existing.status === "executing")) {
				ctx.ui.notify(
					`已有进行中的 goal: ${truncate(existing.target, 40)}。使用 /goal:abort 中止后再启动新的。`,
					"error",
				);
				return;
			}

			// 创建新 goal
			activeGoal = createGoal(target, configMaxTurns);
			persistGoal(pi);
			syncFooter(ctx);
			ctx.ui.notify(`🎯 目标编排已启动: ${truncate(target, 50)}`, "info");

			// 发送初始编排 prompt（sendUserMessage 始终触发 turn）
			const orchestrationPrompt = [
				"## 🎯 目标编排模式已激活",
				"",
				`你的目标：${target}`,
				"",
				"### 工作流程",
				"1. **分解**：将目标拆分为可独立验证的子任务（3-12 个）",
				"2. **执行**：对每个子任务，使用 subagent 工具调度 worker/reviewer",
				"3. **追踪**：每完成一个子任务，调用 updateGoal 工具更新进度",
				"4. **循环**：所有子任务完成后，验证整体目标是否达成",
				"5. **收尾**：产出最终总结",
				"",
				"### updateGoal 工具用法",
				"- 分解完成后：调用 updateGoal(action=set_tasks) 设置所有子任务（每个含 id, description）",
				"- 开始子任务时：action=update_task, taskId, status=in_progress",
				"- 完成子任务时：action=update_task, taskId, status=done, result=结果摘要",
				"- 子任务失败时：action=update_task, taskId, status=failed, result=失败原因",
				"- 全部完成验证后：action=complete, summary=总结",
				"",
				"### 完成标准",
				`目标达成的定义：${target}`,
				"必须通过具体验证（运行测试、检查覆盖率等），不能自我宣称完成。",
				"",
				"### 护栏",
				`- 最大轮次：${activeGoal.maxTurns}`,
				"- 每个子任务最多重试 2 次",
				"- 遇到阻塞性问题（无法绕过）时标记失败并停止",
			].join("\n");

			pi.sendUserMessage(orchestrationPrompt);
		},
	});

	// ========================================================================
	// 命令: /goal:status
	// ========================================================================
	pi.registerCommand("goal:status", {
		description: "查看当前 goal 的进度",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const goal = activeGoal ?? loadGoalFromSession(ctx);
			if (!goal) {
				ctx.ui.notify("当前没有活动的 goal", "info");
				return;
			}
			ctx.ui.notify(formatStatus(goal), "info");
		},
	});

	// ========================================================================
	// 命令: /goal:abort
	// ========================================================================
	pi.registerCommand("goal:abort", {
		description: "中止当前 goal 编排",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const goal = activeGoal ?? loadGoalFromSession(ctx);
			if (!goal) {
				ctx.ui.notify("当前没有活动的 goal", "info");
				return;
			}
			if (goal.status === "completed" || goal.status === "failed" || goal.status === "aborted") {
				ctx.ui.notify("Goal 已结束，无需中止", "info");
				return;
			}
			goal.status = "aborted";
			persistGoal(pi);
			const done = goal.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
			ctx.ui.notify(`编排已中止。已完成 ${done}/${goal.tasks.length} 子任务。`, "warning");
			ctx.ui.setStatus("goal", undefined);
			activeGoal = undefined;
		},
	});

	// ========================================================================
	// 命令: /goal:config maxTurns [N|reset]
	// ========================================================================
	pi.registerCommand("goal:config", {
		description: "配置 goal 参数（当前支持: maxTurns）",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// 不带参数：交互式面板
			if (args.trim() === "") {
				const current = configMaxTurns ?? DEFAULT_MAX_TURNS;
				const input = await ctx.ui.input(
					`maxTurns 配置`,
					`当前 ${current}（默认 ${DEFAULT_MAX_TURNS}）。输入新值，留空取消，输入 reset 恢复默认`,
				);
				if (input === undefined || input.trim() === "") return; // 用户取消
				args = `maxTurns ${input.trim()}`;
			}

			const parts = args.trim().split(/\s+/);
			const key = parts[0];
			const value = parts[1];

			if (key !== "maxTurns") {
				ctx.ui.notify("Usage: /goal:config maxTurns <N|reset>", "error");
				return;
			}

			if (value === "reset" || value === undefined) {
				configMaxTurns = undefined;
				persistConfig(pi);
				ctx.ui.notify(`maxTurns 已恢复默认值 (${DEFAULT_MAX_TURNS})`, "info");
				return;
			}

			const n = Number(value);
			if (!Number.isInteger(n) || n < 1) {
				ctx.ui.notify(`无效值: "${value}"。maxTurns 必须是正整数。`, "error");
				return;
			}

			configMaxTurns = n;
			persistConfig(pi);
			ctx.ui.notify(`maxTurns 已设为 ${n}（下次 /goal 生效）`, "info");
		},
	});

	// ========================================================================
	// 工具: updateGoal（LLM 可调用）
	// ========================================================================
	const updateGoalSchema = Type.Object({
		action: Type.Union([
			Type.Literal("set_tasks"),
			Type.Literal("update_task"),
			Type.Literal("complete"),
		]),
		tasks: Type.Optional(
			Type.Array(
				Type.Object({
					id: Type.String({ description: "子任务 ID，如 t1, t2" }),
					description: Type.String({ description: "子任务描述" }),
				}),
				{ description: "action=set_tasks 时：完整子任务列表" },
			),
		),
		taskId: Type.Optional(Type.String({ description: "action=update_task 时：目标 task ID" })),
		status: Type.Optional(
			Type.Union([
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("done"),
				Type.Literal("failed"),
				Type.Literal("skipped"),
			]),
		),
		result: Type.Optional(Type.String({ description: "结果摘要或失败原因" })),
		summary: Type.Optional(Type.String({ description: "action=complete 时：最终总结" })),
	});

	pi.registerTool({
		name: "updateGoal",
		label: "Goal Progress",
		description:
			"更新当前 goal 编排的进度。三种用法：1) set_tasks：分解完成后设置所有子任务；2) update_task：更新单个子任务状态；3) complete：标记整个 goal 完成。",
		parameters: updateGoalSchema,
		promptSnippet: "updateGoal: 更新 goal 编排进度（set_tasks/update_task/complete）",
		promptGuidelines: [
			"分解目标后立即调用 updateGoal(set_tasks) 注册所有子任务",
			"每次子任务状态变更时调用 updateGoal(update_task)",
			"所有子任务完成验证后调用 updateGoal(complete)",
		],
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!activeGoal) {
				const loaded = loadGoalFromSession(ctx);
				if (loaded) {
					activeGoal = loaded;
				} else {
					return textResult("❌ 当前没有活动的 goal");
				}
			}

			switch (params.action) {
				case "set_tasks": {
					if (!params.tasks || params.tasks.length === 0) {
						return textResult("❌ set_tasks 需要 tasks 参数");
					}
					activeGoal.tasks = params.tasks.map((t, i) => ({
						id: t.id || `t${i + 1}`,
						description: t.description,
						status: "pending" as const,
						retryCount: 0,
					}));
					activeGoal.status = "executing";
					persistGoal(pi);
					syncFooter(ctx);
					return textResult(`✅ 已设置 ${activeGoal.tasks.length} 个子任务。开始执行第一个。`);
				}

				case "update_task": {
					if (!params.taskId || !params.status) {
						return textResult("❌ update_task 需要 taskId 和 status");
					}
					const task = activeGoal.tasks.find((t) => t.id === params.taskId);
					if (!task) {
						return textResult(`❌ 未找到 task: ${params.taskId}`);
					}

					// 重试逻辑：failed 时检查 retryCount
					if (params.status === "failed") {
						if (task.retryCount < 2) {
							task.retryCount++;
							task.status = "pending"; // 重置为待重试
							task.result = params.result;
							persistGoal(pi);
							syncFooter(ctx);
							return textResult(
								`🔄 Task ${task.id} 失败，将重试 (${task.retryCount}/2)。原因: ${params.result ?? "未知"}`,
							);
						}
						// 超过重试上限，标记为永久失败
						task.status = "failed";
					} else {
						task.status = params.status;
					}
						task.result = params.result;
					persistGoal(pi);
					syncFooter(ctx);
					return textResult(`✅ Task ${task.id} → ${task.status}`);
				}

				case "complete": {
					activeGoal.status = "completed";
					activeGoal.summary = params.summary;
					persistGoal(pi);
					syncFooter(ctx);
					return textResult(`🎉 Goal 已标记完成。${params.summary ?? ""}`);
				}

				default:
					return textResult(`❌ 未知 action: ${params.action}`);
			}
		},
	});

	// ========================================================================
	// 事件: before_agent_start（每轮注入编排上下文）
	// ========================================================================
	pi.on("before_agent_start", (event, ctx) => {
		// 确保 activeGoal 与 session 同步
		if (!activeGoal) {
			activeGoal = loadGoalFromSession(ctx);
		}
		if (!activeGoal) return;

		// turnCount 递增（编排护栏计数）
		activeGoal.turnCount++;

		// 注入编排上下文到 systemPrompt 末尾
		const orchestrationCtx = buildOrchestrationContext(activeGoal);

		// 同时通过 nextTurn 消息注入进度快照（display:false，进度由 updateGoal tool call + /goal:status 可见）
		pi.sendMessage(
			{ customType: "goal_progress", content: [{ type: "text", text: formatProgress(activeGoal) }], display: false },
			{ deliverAs: "nextTurn" },
		);

		persistGoal(pi);
		syncFooter(ctx);
		return { systemPrompt: event.systemPrompt + orchestrationCtx };
	});

	// ========================================================================
	// 事件: agent_end（检查状态，自动驱动下一轮）
	// ========================================================================
	pi.on("agent_end", (_event, ctx) => {
		if (!activeGoal) {
			activeGoal = loadGoalFromSession(ctx);
		}
		if (!activeGoal) return;

		const completion = checkGoalCompletion(activeGoal);

		switch (completion) {
			case "completed": {
				activeGoal.status = "completed";
				persistGoal(pi);
				ctx.ui.notify(`🎉 Goal 完成: ${truncate(activeGoal.target, 40)}`, "info");
				ctx.ui.setStatus("goal", undefined);
				activeGoal = undefined;
				break;
			}

			case "failed": {
				if (activeGoal.status !== "aborted") {
					activeGoal.status = "failed";
				}
				persistGoal(pi);
				const reason =
					activeGoal.turnCount >= activeGoal.maxTurns
						? `达到最大轮次 (${activeGoal.maxTurns})`
						: "有子任务失败";
				ctx.ui.notify(`❌ Goal 失败: ${reason}`, "warning");
				ctx.ui.setStatus("goal", undefined);
				activeGoal = undefined;
				break;
			}

			case "continue": {
				// 确保不在 streaming 中（agent_end 时应已 idle）
				if (!ctx.isIdle()) {
					// 安全降级：等 idle 后由下次 agent_end 处理
					break;
				}
				// 自动驱动下一轮（triggerTurn 在非 streaming 时启动新 turn）
				pi.sendMessage(
					{
						customType: "goal_continue",
						content: [{ type: "text", text: `继续执行 goal。当前进度: ${formatProgress(activeGoal)}` }],
						display: false,
					},
					{ triggerTurn: true },
				);
				break;
			}
		}
	});

	// ========================================================================
	// 事件: tool_call（循环检测）
	// ========================================================================
	pi.on("tool_call", (event, _ctx) => {
		if (!activeGoal) return;

		// 构建 tool call 签名（toolName + 参数），用于检测连续相同操作
		const signature = `${event.toolName}:${JSON.stringify(event.input)}`;

		if (detectLoop(activeGoal, signature)) {
			// 超阈值（连续 3 次相同操作），注入纠正消息
			pi.sendMessage(
				{
					customType: "goal_loop_warning",
					content: [
						{
							type: "text",
							text: "⚠️ 检测到循环行为（连续 3 次相同操作）。请改变策略或标记当前子任务为 failed。",
						},
					],
					display: false,
				},
				{ deliverAs: "nextTurn" },
			);
		}
	});
}
