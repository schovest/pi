/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@schovest/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Pending guard_triggered event collected during prepareToolCall, emitted later by runLoop. */
interface PendingGuardEvent {
	guard: "malformed_tool_call" | "premature_stop" | "repeated_tool_call" | "max_tokens";
	action: "error_result" | "inject_steering" | "abort" | "stop" | "continue" | "escalate" | "proceed" | "skip";
	turnNumber: number;
	details?: string;
}

/** Mutable guard runtime state, shared by reference across the loop call chain. */
interface GuardRuntimeState {
	turnNumber: number;
	totalToolCallsSoFar: number;
	recentMalformedCount: number;
	recentToolCallHistory: AgentToolCall[];
	abort: boolean;
	skippedToolCallIds: Set<string>;
	pendingGuardEvents: PendingGuardEvent[];
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Guard runtime state (shared by reference with executeToolCalls chain)
	const guard: GuardRuntimeState = {
		turnNumber: 0,
		totalToolCallsSoFar: 0,
		recentMalformedCount: 0,
		recentToolCallHistory: [],
		abort: false,
		skippedToolCallIds: new Set(),
		pendingGuardEvents: [],
	};

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (!guard.abort) {
		let hasMoreToolCalls = true;
		let lastAssistantMessage: AssistantMessage | null = null;

		// Inner loop: process tool calls and steering messages
		while ((hasMoreToolCalls || pendingMessages.length > 0) && !guard.abort) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);
			lastAssistantMessage = message;

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({
					type: "agent_end",
					messages: newMessages,
					stopReason: guard.abort ? "guard_abort" : "normal",
				});
				return;
			}

			// Guard: onMaxTokens — stopReason === "length"
			if (message.stopReason === "length" && config.onMaxTokens) {
				try {
					const hasIncompleteToolCalls = message.content.some(
						(c): c is AgentToolCall => c.type === "toolCall" && !("name" in c),
					);
					const action = config.onMaxTokens({
						message,
						turnNumber: guard.turnNumber,
						totalToolCallsSoFar: guard.totalToolCallsSoFar,
						hasIncompleteToolCalls,
					});
					if (action.type === "continue") {
						pendingMessages = [
							{ role: "user", content: [{ type: "text", text: action.message }], timestamp: Date.now() },
						];
						if (config.emitGuardEvents) {
							await emit({
								type: "guard_triggered",
								guard: "max_tokens",
								action: "continue",
								turnNumber: guard.turnNumber,
							});
						}
						continue;
					}
					// "escalate" and "stop" fall through to normal flow
				} catch {
					// Guard must not throw
				}
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			// Guard: onRepeatedToolCall — check before execution
			if (toolCalls.length > 0 && config.onRepeatedToolCall) {
				for (const toolCall of toolCalls) {
					const previousCalls = guard.recentToolCallHistory.filter(
						(prev) =>
							prev.name === toolCall.name &&
							JSON.stringify(prev.arguments) === JSON.stringify(toolCall.arguments),
					);
					if (previousCalls.length > 0) {
						try {
							const action = config.onRepeatedToolCall({
								toolCall,
								previousCalls,
								repeatCount: previousCalls.length,
							});
							if (config.emitGuardEvents) {
								await emit({
									type: "guard_triggered",
									guard: "repeated_tool_call",
									action: action.type,
									turnNumber: guard.turnNumber,
									details: `tool=${toolCall.name} repeatCount=${previousCalls.length}`,
								});
							}
							if (action.type === "abort") {
								guard.abort = true;
								break;
							}
							if (action.type === "inject_steering") {
								pendingMessages = [
									{ role: "user", content: [{ type: "text", text: action.message }], timestamp: Date.now() },
								];
							}
							if (action.type === "skip") {
								guard.skippedToolCallIds.add(toolCall.id);
							}
							// "proceed" requires no action
						} catch {
							// Guard must not throw
						}
					}
				}
			}

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;

			// Handle skipped tool calls (from onRepeatedToolCall skip action)
			const activeToolCalls = toolCalls.filter((tc) => !guard.skippedToolCallIds.has(tc.id));
			const skippedToolCalls = toolCalls.filter((tc) => guard.skippedToolCallIds.has(tc.id));
			guard.skippedToolCallIds.clear();

			// Create placeholder results for skipped tool calls
			for (const skipped of skippedToolCalls) {
				const placeholder: ToolResultMessage = {
					role: "toolResult",
					toolCallId: skipped.id,
					toolName: skipped.name,
					content: [{ type: "text", text: "[skipped by repeated_tool_call guard]" }],
					details: {},
					isError: false,
					timestamp: Date.now(),
				};
				toolResults.push(placeholder);
			}

			if (activeToolCalls.length > 0 && !guard.abort) {
				const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit, guard);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				// Collect steering messages from guard hooks in prepareToolCall
				if (executedToolBatch.steeringMessages.length > 0) {
					const steeringAsMessages: AgentMessage[] = executedToolBatch.steeringMessages.map((text) => ({
						role: "user" as const,
						content: [{ type: "text" as const, text }],
						timestamp: Date.now(),
					}));
					pendingMessages = [...(pendingMessages || []), ...steeringAsMessages];
				}

				// Emit pending guard events collected during prepareToolCall
				if (config.emitGuardEvents && guard.pendingGuardEvents.length > 0) {
					for (const ge of guard.pendingGuardEvents) {
						await emit({
							type: "guard_triggered",
							guard: ge.guard,
							action: ge.action,
							turnNumber: ge.turnNumber,
							details: ge.details,
						});
					}
					guard.pendingGuardEvents = [];
				}

				// Update guard counters after successful tool execution
				guard.totalToolCallsSoFar += activeToolCalls.length;
				guard.recentMalformedCount = 0; // successful tool calls, reset error count
				guard.recentToolCallHistory = [...guard.recentToolCallHistory, ...activeToolCalls];
			}

			// Persist all tool results (including skipped placeholders)
			for (const result of toolResults) {
				currentContext.messages.push(result);
				newMessages.push(result);
			}

			await emit({ type: "turn_end", message, toolResults });

			// Guard: maxTurns check
			guard.turnNumber++;
			if (config.maxTurns && guard.turnNumber > config.maxTurns) {
				await emit({ type: "agent_end", messages: newMessages, stopReason: "max_turns" });
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({
					type: "agent_end",
					messages: newMessages,
					stopReason: guard.abort ? "guard_abort" : "normal",
				});
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Guard: onPrematureStop — inner loop exited without tool calls and not due to length
		if (!guard.abort && !hasMoreToolCalls && pendingMessages.length === 0) {
			// Find the last assistant message to check stopReason
			const lastAssistant = lastAssistantMessage;
			if (
				lastAssistant &&
				lastAssistant.stopReason !== "toolUse" &&
				lastAssistant.stopReason !== "length" &&
				config.onPrematureStop
			) {
				try {
					const action = config.onPrematureStop({
						message: lastAssistant,
						turnNumber: guard.turnNumber,
						totalToolCallsSoFar: guard.totalToolCallsSoFar,
					});
					if (action.type === "continue") {
						pendingMessages = [
							{ role: "user", content: [{ type: "text", text: action.message }], timestamp: Date.now() },
						];
						if (config.emitGuardEvents) {
							await emit({
								type: "guard_triggered",
								guard: "premature_stop",
								action: "continue",
								turnNumber: guard.turnNumber,
							});
						}
						continue;
					}
					if (action.type === "abort") {
						guard.abort = true;
						if (config.emitGuardEvents) {
							await emit({
								type: "guard_triggered",
								guard: "premature_stop",
								action: "abort",
								turnNumber: guard.turnNumber,
							});
						}
					}
				} catch {
					// Guard must not throw
				}
			}
		}

		if (guard.abort) {
			break;
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages, stopReason: guard.abort ? "guard_abort" : "normal" });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	guard: GuardRuntimeState,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit, guard);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit, guard);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
	steeringMessages: string[];
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	guard: GuardRuntimeState,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];
	const steeringMessages: string[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal, guard);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			if (preparation.steeringMessage) {
				steeringMessages.push(preparation.steeringMessage);
			}
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
		steeringMessages,
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	guard: GuardRuntimeState,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];
	const steeringMessages: string[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal, guard);
		if (preparation.kind === "immediate") {
			if (preparation.steeringMessage) {
				steeringMessages.push(preparation.steeringMessage);
			}
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
		steeringMessages,
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
	steeringMessage?: string;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	guard: GuardRuntimeState,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		const errorStr = `Tool ${toolCall.name} not found`;
		guard.recentMalformedCount++;
		if (config.onMalformedToolCall) {
			try {
				const action = config.onMalformedToolCall({
					toolCall,
					error: errorStr,
					turnNumber: guard.turnNumber,
					recentMalformedCount: guard.recentMalformedCount,
				});
				if (config.emitGuardEvents) {
					guard.pendingGuardEvents.push({
						guard: "malformed_tool_call",
						action: action.type,
						turnNumber: guard.turnNumber,
						details: `tool=${toolCall.name} error=${errorStr}`,
					});
				}
				if (action.type === "inject_steering") {
					return {
						kind: "immediate",
						result: createErrorToolResult(errorStr),
						isError: true,
						steeringMessage: action.message,
					};
				}
				if (action.type === "abort") {
					guard.abort = true;
				}
			} catch {
				// Guard must not throw
			}
		}
		return {
			kind: "immediate",
			result: createErrorToolResult(errorStr),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		const errorStr = error instanceof Error ? error.message : String(error);
		guard.recentMalformedCount++;
		if (config.onMalformedToolCall) {
			try {
				const action = config.onMalformedToolCall({
					toolCall,
					error: errorStr,
					turnNumber: guard.turnNumber,
					recentMalformedCount: guard.recentMalformedCount,
				});
				if (config.emitGuardEvents) {
					guard.pendingGuardEvents.push({
						guard: "malformed_tool_call",
						action: action.type,
						turnNumber: guard.turnNumber,
						details: `tool=${toolCall.name} error=${errorStr}`,
					});
				}
				if (action.type === "inject_steering") {
					return {
						kind: "immediate",
						result: createErrorToolResult(errorStr),
						isError: true,
						steeringMessage: action.message,
					};
				}
				if (action.type === "abort") {
					guard.abort = true;
				}
			} catch {
				// Guard must not throw
			}
		}
		return {
			kind: "immediate",
			result: createErrorToolResult(errorStr),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
