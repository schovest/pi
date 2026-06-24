import type {
	AgentLoopConfig,
	MalformedToolCallAction,
	MalformedToolCallContext,
	MaxTokensAction,
	MaxTokensContext,
	ModelResilience,
	PrematureStopAction,
	PrematureStopContext,
	RepeatedToolCallAction,
	RepeatedToolCallContext,
} from "../types.ts";

/** models.json 模型条目的 guard 扩展字段 */
export interface ModelEntryGuardFields {
	resilience?: ModelResilience;
	maxTurns?: number;
	onPrematureStop?: "stop" | "continue" | "abort";
	onMalformedToolCall?: "error_result" | "inject_steering" | "abort";
	onMaxTokens?: "continue" | "escalate" | "stop";
	onRepeatedToolCall?: "proceed" | "inject_steering" | "skip" | "abort";
}

const MAX_TURNS_BY_LEVEL: Record<ModelResilience, number | undefined> = {
	high: undefined,
	medium: 50,
	low: 80,
};

function malformedToolCallHandler(level: ModelResilience): (ctx: MalformedToolCallContext) => MalformedToolCallAction {
	return (ctx) => {
		if (level === "high") return { type: "error_result" };
		if (level === "medium") {
			if (ctx.recentMalformedCount >= 2) {
				return {
					type: "inject_steering",
					message: `Your last tool call had an error: ${ctx.error}. Please check the parameters and try again.`,
				};
			}
			return { type: "error_result" };
		}
		// low
		return {
			type: "inject_steering",
			message: `Your last tool call had an error: ${ctx.error}. Common fixes:\n- Check that all required parameters are present\n- Ensure parameter types match the schema (strings quoted, numbers unquoted)\n- Use the exact tool name as defined\nPlease try again with corrected arguments.`,
		};
	};
}

function maxTokensHandler(level: ModelResilience): (ctx: MaxTokensContext) => MaxTokensAction {
	return () => {
		if (level === "low") {
			return {
				type: "continue",
				message:
					"Your response was cut off due to the output length limit. Please continue exactly from where you left off. Do not repeat what you already wrote — just continue the incomplete part.",
			};
		}
		return { type: "continue", message: "Please continue from where you left off." };
	};
}

function prematureStopHandler(level: ModelResilience): (ctx: PrematureStopContext) => PrematureStopAction {
	return (ctx) => {
		if (level === "high") return { type: "stop" };
		const threshold = level === "medium" ? 3 : 5;
		if (ctx.totalToolCallsSoFar < threshold) {
			return {
				type: "continue",
				message:
					"You appear to have stopped before completing the task. If there are remaining steps, continue with the appropriate tool calls. If you are truly done, say so explicitly.",
			};
		}
		return { type: "stop" };
	};
}

function repeatedToolCallHandler(level: ModelResilience): (ctx: RepeatedToolCallContext) => RepeatedToolCallAction {
	return (ctx) => {
		if (level === "high") return { type: "proceed" };
		if (level === "medium") {
			if (ctx.repeatCount >= 3) {
				return {
					type: "inject_steering",
					message: `You have called ${ctx.toolCall.name} with the same arguments ${ctx.repeatCount} times. This suggests you may be stuck in a loop. Consider a different approach or verify the tool result.`,
				};
			}
			return { type: "proceed" };
		}
		// low
		if (ctx.repeatCount >= 4) return { type: "skip" };
		if (ctx.repeatCount >= 2) {
			return {
				type: "inject_steering",
				message: `You have called ${ctx.toolCall.name} with the same arguments ${ctx.repeatCount} times. This suggests you may be stuck in a loop. Consider a different approach or verify the tool result.`,
			};
		}
		return { type: "proceed" };
	};
}

export function createLoopGuards(level: ModelResilience, overrides?: ModelEntryGuardFields): Partial<AgentLoopConfig> {
	const guards: Partial<AgentLoopConfig> = {
		onMalformedToolCall: malformedToolCallHandler(level),
		onMaxTokens: maxTokensHandler(level),
		onPrematureStop: prematureStopHandler(level),
		onRepeatedToolCall: repeatedToolCallHandler(level),
		maxTurns: MAX_TURNS_BY_LEVEL[level],
	};

	// User overrides take precedence
	if (overrides?.maxTurns !== undefined) guards.maxTurns = overrides.maxTurns;

	return guards;
}
