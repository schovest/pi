import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { clampThinkingLevel, modelsAreEqual } from "@earendil-works/pi-ai";
import type { AgentSession } from "../agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "../defaults.ts";
import { resolveActiveTools } from "../tool-matcher.ts";
import { discoverSubagents } from "./discovery.ts";
import type {
	SubagentDefinition,
	SubagentRunEvent,
	SubagentRunOptions,
	SubagentRunRequest,
	SubagentRunResult,
	SubagentTask,
	SubagentTaskResult,
} from "./types.ts";

const MAX_PARALLEL_TASKS = 8;
const PARALLEL_CONCURRENCY = 4;

interface ResolvedTask {
	index: number;
	definition: SubagentDefinition;
	task: SubagentTask;
	title: string;
	model: Model<any>;
	thinking: ThinkingLevel;
	tools: string[];
	prompt: string;
}

function textFromMessage(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function lastAssistantText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = textFromMessage(messages[index]);
		if (text) {
			return text;
		}
	}
	return "";
}

function lastAssistantError(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant" && message.errorMessage) {
			return message.errorMessage;
		}
	}
	return undefined;
}

function usageFromMessages(messages: AgentMessage[]): Usage | undefined {
	let aggregate: Usage | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage) continue;
		if (!aggregate) {
			aggregate = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		aggregate.input += usage.input;
		aggregate.output += usage.output;
		aggregate.cacheRead += usage.cacheRead;
		aggregate.cacheWrite += usage.cacheWrite;
		aggregate.totalTokens += usage.totalTokens;
		aggregate.cost.input += usage.cost.input;
		aggregate.cost.output += usage.cost.output;
		aggregate.cost.cacheRead += usage.cost.cacheRead;
		aggregate.cost.cacheWrite += usage.cost.cacheWrite;
		aggregate.cost.total += usage.cost.total;
	}
	return aggregate;
}

function formatModel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function resolveModel(session: AgentSession, requested: string | undefined): Model<any> {
	if (requested) {
		const slashIndex = requested.indexOf("/");
		const model =
			slashIndex === -1
				? session.modelRegistry.getAll().find((candidate) => candidate.id === requested)
				: session.modelRegistry.find(requested.slice(0, slashIndex), requested.slice(slashIndex + 1));
		if (!model) {
			throw new Error(`Unknown subagent model: ${requested}`);
		}
		return model;
	}

	const defaultProvider = session.settingsManager.getDefaultProvider();
	const defaultModel = session.settingsManager.getDefaultModel();
	if (defaultProvider && defaultModel) {
		const model = session.modelRegistry.find(defaultProvider, defaultModel);
		if (model && session.modelRegistry.hasConfiguredAuth(model)) {
			return model;
		}
	}

	if (!session.model) {
		throw new Error("No model selected for subagent run");
	}
	return session.model;
}

function resolveThinking(
	session: AgentSession,
	model: Model<any>,
	task: SubagentTask,
	definition: SubagentDefinition,
): ThinkingLevel {
	const requested =
		task.thinking ??
		definition.thinking ??
		session.settingsManager.getDefaultThinkingLevel() ??
		DEFAULT_THINKING_LEVEL;
	return clampThinkingLevel(model, requested) as ThinkingLevel;
}

function buildPrompt(definition: SubagentDefinition, task: string): string {
	return [`You are the "${definition.name}" subagent.`, definition.prompt, `Task:\n${task}`].join("\n\n");
}

async function resolveTask(
	session: AgentSession,
	definitions: Map<string, SubagentDefinition>,
	task: SubagentTask,
	index: number,
	allToolNames: string[],
): Promise<ResolvedTask | SubagentTaskResult> {
	const definition = definitions.get(task.agent);
	if (!definition) {
		const available = [...definitions.keys()].join(", ");
		return {
			index,
			agent: task.agent,
			task: task.task,
			title: task.title,
			status: "failed",
			output: "",
			error: `Unknown subagent: ${task.agent}. Available: ${available}`,
			messages: [],
			events: [],
		};
	}
	try {
		const model = resolveModel(session, task.model ?? definition.model);
		const thinking = resolveThinking(session, model, task, definition);
		const includedTools = task.includedTools ?? definition.includedTools;
		const excludedTools = task.excludedTools ?? definition.excludedTools;
		const resolvedTools = resolveActiveTools(allToolNames, includedTools, excludedTools, [
			"read",
			"bash",
			"edit",
			"write",
		]);
		return {
			index,
			definition,
			task,
			title: task.title,
			model,
			thinking,
			tools: resolvedTools,
			prompt: buildPrompt(definition, task.task),
		};
	} catch (error) {
		return {
			index,
			agent: definition.name,
			task: task.task,
			title: task.title,
			status: "failed",
			output: "",
			error: error instanceof Error ? error.message : String(error),
			messages: [],
			events: [],
		};
	}
}

function createEvent(
	runId: string,
	resolved: ResolvedTask,
	status: SubagentRunEvent["status"],
	overrides: Partial<SubagentRunEvent> = {},
): SubagentRunEvent {
	return {
		runId,
		index: resolved.index,
		agent: resolved.definition.name,
		task: resolved.task.task,
		title: resolved.title,
		status,
		model: formatModel(resolved.model),
		thinking: resolved.thinking,
		timestamp: Date.now(),
		...overrides,
	};
}

function summarizeUnknown(value: unknown, maxLength = 240): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
	} catch {
		return String(value);
	}
}

function textFromToolResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object" || !("content" in result)) {
		return undefined;
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const text = content
		.flatMap((part) => {
			if (!part || typeof part !== "object") {
				return [];
			}
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
		})
		.join("\n");
	return summarizeUnknown(text);
}

function countToolCalls(events: SubagentRunEvent[]): number {
	return events.filter((e) => e.currentTool && e.currentToolArgs).length;
}

async function runOne(
	session: AgentSession,
	runId: string,
	resolved: ResolvedTask,
	options: SubagentRunOptions,
): Promise<SubagentTaskResult> {
	const events: SubagentRunEvent[] = [];
	const emit = (event: SubagentRunEvent): void => {
		events.push(event);
		session.recordSubagentRunEvent(event);
		options.onEvent?.(event, child);
	};

	const child = session.createSubagentChildSession({
		model: resolved.model,
		thinkingLevel: resolved.thinking,
		tools: resolved.tools,
	});
	const unsubscribe = child.subscribe((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			emit(
				createEvent(runId, resolved, "running", {
					currentTool: event.toolName,
					currentToolArgs: summarizeUnknown(event.args),
				}),
			);
		} else if (event.type === "tool_execution_end") {
			emit(
				createEvent(runId, resolved, "running", {
					currentTool: event.toolName,
					toolResultSummary: textFromToolResult(event.result),
					error: event.isError ? textFromToolResult(event.result) : undefined,
				}),
			);
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			const outputSummary = textFromMessage(event.message).slice(0, 240);
			if (outputSummary) {
				emit(createEvent(runId, resolved, "running", { outputSummary }));
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const outputSummary = textFromMessage(event.message).slice(0, 240);
			emit(
				createEvent(runId, resolved, "running", {
					outputSummary: outputSummary || undefined,
					usage: event.message.usage,
				}),
			);
		}
	});
	const abortChild = (): void => {
		void child.abort();
	};
	options.signal?.addEventListener("abort", abortChild, { once: true });

	emit(createEvent(runId, resolved, "running"));
	try {
		if (options.signal?.aborted) {
			await child.abort();
		} else {
			await child.prompt(resolved.prompt, { expandPromptTemplates: false });
		}

		const messages = [...child.messages];
		const usage = usageFromMessages(messages);
		const error = lastAssistantError(messages);
		const output = lastAssistantText(messages);
		const status = options.signal?.aborted ? "aborted" : error ? "failed" : "success";
		emit(
			createEvent(runId, resolved, status, {
				usage,
				error,
				outputSummary: output.slice(0, 240),
			}),
		);

		// Write a reference entry in the parent session, then inline the messages
		const subagentEntryId = session.sessionManager.appendSubagentRunEntry({
			runId,
			index: resolved.index,
			agent: resolved.definition.name,
			task: resolved.task.task,
			title: resolved.title,
			status,
			model: formatModel(resolved.model),
			thinking: resolved.thinking,
			totalTokens: usage?.totalTokens,
			toolCount: countToolCalls(events),
			outputSummary: output.slice(0, 240) || undefined,
			error,
		});
		session.sessionManager.appendSubagentMessages(subagentEntryId, messages);

		return {
			index: resolved.index,
			agent: resolved.definition.name,
			task: resolved.task.task,
			title: resolved.title,
			status,
			output,
			model: formatModel(resolved.model),
			thinking: resolved.thinking,
			usage,
			error,
			messages,
			events,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = options.signal?.aborted ? "aborted" : "failed";
		emit(createEvent(runId, resolved, status, { error: message }));

		// Write a reference entry in the parent session for failed/aborted runs, then inline the messages
		const subagentEntryId = session.sessionManager.appendSubagentRunEntry({
			runId,
			index: resolved.index,
			agent: resolved.definition.name,
			task: resolved.task.task,
			title: resolved.title,
			status,
			model: formatModel(resolved.model),
			thinking: resolved.thinking,
			toolCount: countToolCalls(events),
			error: message,
		});
		session.sessionManager.appendSubagentMessages(subagentEntryId, [...child.messages]);

		return {
			index: resolved.index,
			agent: resolved.definition.name,
			task: resolved.task.task,
			title: resolved.title,
			status,
			output: "",
			model: formatModel(resolved.model),
			thinking: resolved.thinking,
			error: message,
			messages: [...child.messages],
			events,
		};
	} finally {
		options.signal?.removeEventListener("abort", abortChild);
		unsubscribe();
		child.dispose();
	}
}

async function runWithConcurrency<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		for (;;) {
			const item = items[nextIndex];
			nextIndex++;
			if (!item) {
				return;
			}
			await run(item);
		}
	});
	await Promise.all(workers);
}

function aggregateResultUsage(results: SubagentTaskResult[]): Usage | undefined {
	return usageFromMessages(results.flatMap((result) => result.messages));
}

export async function runSubagents(
	session: AgentSession,
	request: SubagentRunRequest,
	options: SubagentRunOptions = {},
): Promise<SubagentRunResult> {
	const mode: "parallel" | "chain" = "chain" in request ? "chain" : "parallel";
	const tasks = "chain" in request ? request.chain : request.tasks;

	if (tasks.length > MAX_PARALLEL_TASKS) {
		throw new Error(`subagent runs support at most ${MAX_PARALLEL_TASKS} tasks`);
	}

	const definitions = new Map(
		(
			await discoverSubagents({
				cwd: session.cwd,
				agentDir: options.agentDir ?? session.agentDir,
				scope: request.subagentScope ?? "both",
			})
		).map((definition) => [definition.name, definition]),
	);

	const allToolNames = session.getActiveToolNames();
	const runId = `subagent:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	let results: SubagentTaskResult[];

	if (mode === "chain") {
		results = [];
		for (let index = 0; index < tasks.length; index++) {
			const previous = results.at(-1)?.output ?? "";
			const task = { ...tasks[index], task: tasks[index].task.replaceAll("{previous}", previous) };
			const resolved = await resolveTask(session, definitions, task, index, allToolNames);
			if ("status" in resolved) {
				results.push(resolved);
				break;
			}
			const result = await runOne(session, runId, resolved, options);
			results.push(result);
			if (result.status !== "success") {
				break;
			}
		}
	} else {
		const resolvedTasks = await Promise.all(
			tasks.map((task, index) => resolveTask(session, definitions, task, index, allToolNames)),
		);
		results = new Array<SubagentTaskResult>(resolvedTasks.length);
		await runWithConcurrency(resolvedTasks, PARALLEL_CONCURRENCY, async (resolved) => {
			if ("status" in resolved) {
				results[resolved.index] = resolved;
				return;
			}
			results[resolved.index] = await runOne(session, runId, resolved, options);
		});
	}

	return {
		mode,
		results,
		usage: aggregateResultUsage(results),
	};
}

export function modelMatches(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
	return !!a && !!b && modelsAreEqual(a, b);
}
