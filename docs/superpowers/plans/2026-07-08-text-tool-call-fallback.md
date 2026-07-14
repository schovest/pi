# Text Tool Call Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable rule-based text tool call fallback parsing + steering correction for models that emit tool calls as text instead of structured `delta.tool_calls`, and wire the existing guard system into the main Agent→AgentSession call chain.

**Architecture:** Three-layer defense: (1) `parseTextToolCalls()` scans plain text (excluding code blocks) for inline tool call JSON patterns with triple validation; (2) `onTextToolCallFallback` guard handler decides use_parsed vs inject_steering vs skip based on resilience level; (3) `loopGuardResolver` connects `ModelRegistry.getLoopGuardConfig()` to `Agent.createLoopConfig()` so all guards (malformed, premature stop, repeated, max tokens, text fallback) activate for configured models.

**Tech Stack:** TypeScript, vitest, TypeBox schema validation, `@schovest/pi-ai` (parseJsonWithRepair, validateToolArguments, TextContent), `@schovest/pi-agent-core` (Agent, agent-loop, loop-guards)

**Spec:** `docs/superpowers/specs/2026-07-08-text-tool-call-fallback-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/agent/src/types.ts` | Type definitions for guard contexts, actions, AgentLoopConfig | Modify — add `TextToolCallFallbackContext`, `TextToolCallFallbackAction`, `onTextToolCallFallback` field, extend `GuardTriggeredEvent` |
| `packages/agent/src/agent-loop.ts` | Core loop logic, tool call extraction, guard dispatch | Modify — add `parseTextToolCalls()` function, `FENCED_CODE_BLOCK_RE`/`INLINE_TOOL_CALL_RE` regexes, fallback branch in `runLoop()`, `fallbackSteering` merge at L426 |
| `packages/agent/src/harness/loop-guards.ts` | Guard handler factory | Modify — add `textToolCallFallbackHandler()`, wire into `createLoopGuards()` |
| `packages/agent/src/agent.ts` | Stateful Agent wrapper | Modify — add `loopGuardResolver` to `AgentOptions` and `Agent` class, import `createLoopGuards`, expand guards in `createLoopConfig()` |
| `packages/coding-agent/src/core/sdk.ts` | Session creation | Modify — pass `loopGuardResolver` to `new Agent()` |
| `packages/agent/test/loop-guards.test.ts` | Guard handler unit tests | Modify — add `textToolCallFallbackHandler` tests |
| `packages/agent/test/agent-loop.test.ts` | Loop integration tests | Modify — add fallback parsing + steering tests |
| `packages/agent/test/text-tool-call-fallback.test.ts` | `parseTextToolCalls` unit tests | Create — dedicated test file for parsing logic |

---

## Task 1: Add Guard Types to types.ts

**Files:**
- Modify: `packages/agent/src/types.ts:136-191` (guard context/action types) and `packages/agent/src/types.ts:335-347` (AgentLoopConfig guard fields)

- [ ] **Step 1: Add TextToolCallFallbackContext and TextToolCallFallbackAction types**

Add after `RepeatedToolCallContext` (after line 164) and before `// --- Guard Action Types ---`:

```typescript
export interface TextToolCallFallbackContext {
	/** The assistant message that contains text but no structured tool calls. */
	message: AssistantMessage;
	/** Turn number when the fallback was triggered. */
	turnNumber: number;
	/** Tool calls successfully parsed from text, if any. */
	parsedToolCalls: AgentToolCall[];
	/** Whether any tool calls were successfully parsed. */
	parsed: boolean;
}
```

Add after `RepeatedToolCallAction` (after line 181) and before `// --- Guard Triggered Event ---`:

```typescript
export type TextToolCallFallbackAction =
	/** Use the parsed tool calls and execute them. */
	| { type: "use_parsed" }
	/** Ignore parsed results, inject a steering message to let the model retry. */
	| { type: "inject_steering"; message: string }
	/** No action, treat as normal text output (no tool calls). */
	| { type: "skip" };
```

- [ ] **Step 2: Add onTextToolCallFallback field to AgentLoopConfig**

Add after `onRepeatedToolCall` field (after line 342):

```typescript
	/** Guard: text tool call fallback handler — parses tool calls from text when no structured tool calls are present */
	onTextToolCallFallback?: (context: TextToolCallFallbackContext) => TextToolCallFallbackAction;
```

- [ ] **Step 3: Extend GuardTriggeredEvent guard and action union types**

Change the `guard` field (line 187) from:
```typescript
	guard: "malformed_tool_call" | "premature_stop" | "repeated_tool_call" | "max_tokens";
```
to:
```typescript
	guard: "malformed_tool_call" | "premature_stop" | "repeated_tool_call" | "max_tokens" | "text_tool_call_fallback";
```

Change the `action` field (line 188) from:
```typescript
	action: "error_result" | "inject_steering" | "abort" | "stop" | "continue" | "escalate" | "proceed" | "skip";
```
to:
```typescript
	action: "error_result" | "inject_steering" | "abort" | "stop" | "continue" | "escalate" | "proceed" | "skip" | "use_parsed";
```

- [ ] **Step 4: Verify types compile**

Run: `cd /data/mine/pi && npx tsc --noEmit --project packages/agent/tsconfig.json 2>&1 | head -20`
Expected: No new errors (existing errors may be present)

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/types.ts
git commit -m "feat(agent): add TextToolCallFallback guard types to AgentLoopConfig"
```

---

## Task 2: Add parseTextToolCalls Unit Tests

**Files:**
- Create: `packages/agent/test/text-tool-call-fallback.test.ts`

- [ ] **Step 1: Write failing tests for parseTextToolCalls**

Create `packages/agent/test/text-tool-call-fallback.test.ts`:

```typescript
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../src/types.ts";

// parseTextToolCalls is not exported yet — will be after Task 3
// import { parseTextToolCalls } from "../src/agent-loop.ts";

function createReadTool(): AgentTool<any> {
	return {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

function createEchoTool(): AgentTool<any> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo",
		parameters: Type.Object({ value: Type.String() }),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

describe("parseTextToolCalls", () => {
	it("parses inline tool call in plain text", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '我来读取 {"name":"read","arguments":{"path":"/tmp/test"}}';
		const { toolCalls, remainingText } = parseTextToolCalls(text, [createReadTool()]);
		expect(toolCalls.length).toBe(1);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].arguments).toEqual({ path: "/tmp/test" });
		expect(remainingText).toBe("我来读取");
	});

	it("ignores tool calls inside code blocks", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '配置如下:\n```json\n{"name":"read","arguments":{"path":"/tmp/test"}}\n```';
		const { toolCalls, remainingText } = parseTextToolCalls(text, [createReadTool()]);
		expect(toolCalls.length).toBe(0);
		expect(remainingText).toBe(text);
	});

	it("ignores unknown tool names", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '{"name":"unknown","arguments":{}}';
		const { toolCalls } = parseTextToolCalls(text, [createReadTool()]);
		expect(toolCalls.length).toBe(0);
	});

	it("skips invalid JSON arguments", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '{"name":"read","arguments":{not valid json}}';
		const { toolCalls } = parseTextToolCalls(text, [createReadTool()]);
		expect(toolCalls.length).toBe(0);
	});

	it("skips arguments that fail schema validation", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		// path should be string, not number
		const text = '{"name":"read","arguments":{"path":123}}';
		const { toolCalls } = parseTextToolCalls(text, [createReadTool()]);
		expect(toolCalls.length).toBe(0);
	});

	it("parses "tool" field as alternative to "name"', async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '{"tool":"read","arguments":{"path":"/tmp/test"}}';
		const { toolCalls } = parseTextToolCalls(text, [createReadTool()]);
		expect(toolCalls.length).toBe(1);
		expect(toolCalls[0].name).toBe("read");
	});

	it("parses "input" field as alternative to "arguments"', async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '{"name":"read","input":{"path":"/tmp/test"}}';
		const { toolCalls } = parseTextToolCalls(text, [createReadTool()]);
		expect(toolCalls.length).toBe(1);
		expect(toolCalls[0].arguments).toEqual({ path: "/tmp/test" });
	});

	it("parses multiple inline tool calls in same text", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = 'First {"name":"read","arguments":{"path":"/tmp/a"}} then {"name":"echo","arguments":{"value":"hi"}}';
		const { toolCalls } = parseTextToolCalls(text, [createReadTool(), createEchoTool()]);
		expect(toolCalls.length).toBe(2);
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[1].name).toBe("echo");
	});

	it("returns empty remaining text when only tool call present", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '{"name":"read","arguments":{"path":"/tmp/test"}}';
		const { remainingText } = parseTextToolCalls(text, [createReadTool()]);
		expect(remainingText).toBe("");
	});

	it("does not trigger when no tools available", async () => {
		const { parseTextToolCalls } = await import("../src/agent-loop.ts");
		const text = '{"name":"read","arguments":{"path":"/tmp/test"}}';
		const { toolCalls } = parseTextToolCalls(text, []);
		expect(toolCalls.length).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /data/mine/pi && npx vitest run packages/agent/test/text-tool-call-fallback.test.ts 2>&1 | tail -20`
Expected: FAIL — `parseTextToolCalls` not exported from `agent-loop.ts`

- [ ] **Step 3: Commit failing tests**

```bash
git add packages/agent/test/text-tool-call-fallback.test.ts
git commit -m "test(agent): add failing tests for parseTextToolCalls"
```

---

## Task 3: Implement parseTextToolCalls in agent-loop.ts

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:6-13` (import) and `packages/agent/src/agent-loop.ts:787-799` (near `prepareToolCallArguments`)

- [ ] **Step 1: Add TextContent to imports**

Change the import block at line 6-13 from:
```typescript
import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@schovest/pi-ai";
```
to:
```typescript
import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type TextContent,
	type ToolResultMessage,
	validateToolArguments,
} from "@schovest/pi-ai";
```

- [ ] **Step 2: Add parseTextToolCalls function**

Add this after `prepareToolCallArguments` function (after line 799):

```typescript
/**
 * Regex matching fenced code blocks: ```lang\n...\n```
 * Used to EXCLUDE code blocks from text tool call parsing.
 */
const FENCED_CODE_BLOCK_RE = /```[^\n`]*\n[\s\S]*?\n```/g;

/**
 * Regex matching inline tool call patterns in plain text (NOT in code blocks).
 * Matches JSON objects that look like tool calls:
 *   {"name":"read","arguments":{...}}
 *   {"tool":"read","arguments":{...}}
 *   {"name":"read","input":{...}}
 */
const INLINE_TOOL_CALL_RE = /\{(?:"name"|"tool")\s*:\s*"([^"]+)"\s*,\s*(?:"arguments"|"input")\s*:\s*(\{[^}]*\})\}/g;

/**
 * Attempt to parse tool calls from plain text (excluding code blocks).
 *
 * Key rule: only "plain text" is scanned — content inside ```code blocks``` is ignored.
 * This prevents misinterpreting code examples or JSON configs as tool calls.
 *
 * Triple validation: JSON parse + tool name match + schema validation.
 * Any failure → skip that match, leave as text.
 *
 * @param textContent The full text content from the assistant message
 * @param tools Available tools to match against
 * @returns Parsed tool calls and the text with parsed calls removed
 */
export function parseTextToolCalls(
	textContent: string,
	tools: AgentTool<any>[],
): { toolCalls: AgentToolCall[]; remainingText: string } {
	const toolCalls: AgentToolCall[] = [];
	const knownToolNames = new Set(tools.map((t) => t.name));

	// Step 1: Remove code blocks from the text — we only scan plain text
	const plainText = textContent.replace(FENCED_CODE_BLOCK_RE, "");

	// Step 2: Search for inline tool call patterns in plain text
	const matches = [...plainText.matchAll(INLINE_TOOL_CALL_RE)];

	for (const match of matches) {
		const fullMatch = match[0];
		const toolName = match[1];
		const argsStr = match[2];

		// Must match a known tool name
		if (!knownToolNames.has(toolName)) continue;

		const tool = tools.find((t) => t.name === toolName)!;

		// Parse arguments
		let args: Record<string, any>;
		try {
			args = JSON.parse(argsStr);
		} catch {
			continue; // Not valid JSON, skip
		}

		// Validate against tool schema
		try {
			const syntheticId = `text_fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
			const validatedArgs = validateToolArguments(tool, {
				type: "toolCall",
				id: syntheticId,
				name: toolName,
				arguments: args,
			});
			toolCalls.push({
				type: "toolCall",
				id: syntheticId,
				name: toolName,
				arguments: validatedArgs,
			});
		} catch {
			// Validation failed, skip this match
		}
	}

	// Step 3: Remove parsed tool call text from the original textContent
	let remainingText = textContent;
	for (const match of matches) {
		const fullMatch = match[0];
		const toolName = match[1];
		if (!knownToolNames.has(toolName)) continue;
		// Only remove if this match was successfully parsed into a tool call
		const wasParsed = toolCalls.some((tc) => tc.name === toolName);
		if (wasParsed) {
			remainingText = remainingText.replace(fullMatch, "");
		}
	}
	remainingText = remainingText.trim();

	return { toolCalls, remainingText };
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /data/mine/pi && npx vitest run packages/agent/test/text-tool-call-fallback.test.ts 2>&1 | tail -20`
Expected: PASS — all 10 tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/agent-loop.ts packages/agent/test/text-tool-call-fallback.test.ts
git commit -m "feat(agent): implement parseTextToolCalls for text tool call fallback"
```

---

## Task 4: Add Fallback Branch to runLoop

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:270-272` (after toolCalls extraction) and `packages/agent/src/agent-loop.ts:426` (pendingMessages merge)

- [ ] **Step 1: Add fallback branch after toolCalls extraction**

Find this code at line 270-271:
```typescript
		// Check for tool calls
		const toolCalls = message.content.filter((c) => c.type === "toolCall");
```

Change `const toolCalls` to `let toolCalls` and add the fallback branch after it:

```typescript
		// Check for tool calls
		let toolCalls = message.content.filter((c) => c.type === "toolCall");

		// Guard: onTextToolCallFallback — parse tool calls from text when none are structured
		let fallbackSteering: AgentMessage[] | null = null;

		if (toolCalls.length === 0 && config.onTextToolCallFallback && context.tools && context.tools.length > 0) {
			const textBlocks = message.content.filter((c): c is TextContent => c.type === "text");
			if (textBlocks.length > 0) {
				const fullText = textBlocks.map((b) => b.text).join("\n");
				const { toolCalls: parsedCalls, remainingText } = parseTextToolCalls(fullText, context.tools);

				try {
					const action = config.onTextToolCallFallback({
						message,
						turnNumber: guard.turnNumber,
						parsedToolCalls: parsedCalls,
						parsed: parsedCalls.length > 0,
					});

					if (config.emitGuardEvents) {
						await emit({
							type: "guard_triggered",
							guard: "text_tool_call_fallback",
							action: action.type === "use_parsed" ? "use_parsed" : action.type === "inject_steering" ? "inject_steering" : "skip",
							turnNumber: guard.turnNumber,
							details: parsedCalls.length > 0 ? `parsed=${parsedCalls.length} calls` : "no calls parsed",
						});
					}

					if (action.type === "use_parsed" && parsedCalls.length > 0) {
						// Replace text content with remaining text + parsed tool calls
						message.content = message.content.filter((c) => c.type !== "text");
						if (remainingText.length > 0) {
							message.content.push({ type: "text", text: remainingText });
						}
						message.content.push(...parsedCalls);
						toolCalls = parsedCalls;
					} else if (action.type === "inject_steering") {
						// Store in temp variable, merge after L426 to avoid being overwritten
						fallbackSteering = [
							{ role: "user", content: [{ type: "text", text: action.message }], timestamp: Date.now() },
						];
					}
					// "skip" → do nothing, treat as normal text
				} catch {
					// Guard must not throw
				}
			}
		}
```

- [ ] **Step 2: Merge fallbackSteering after getSteeringMessages**

Find this code at line 426:
```typescript
		pendingMessages = (await config.getSteeringMessages?.()) || [];
```

Add the merge immediately after it:
```typescript
		pendingMessages = (await config.getSteeringMessages?.()) || [];

		// Merge fallback steering messages (from onTextToolCallFallback) with steering queue
		if (fallbackSteering) {
			pendingMessages = [...fallbackSteering, ...pendingMessages];
		}
```

- [ ] **Step 3: Verify agent-loop compiles**

Run: `cd /data/mine/pi && npx tsc --noEmit --project packages/agent/tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `cd /data/mine/pi && npx vitest run packages/agent/test/agent-loop.test.ts 2>&1 | tail -20`
Expected: PASS — all existing tests still pass

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/agent-loop.ts
git commit -m "feat(agent): add text tool call fallback branch to runLoop"
```

---

## Task 5: Add textToolCallFallbackHandler to loop-guards.ts

**Files:**
- Modify: `packages/agent/src/harness/loop-guards.ts:1-12` (import) and `packages/agent/src/harness/loop-guards.ts:100-115` (createLoopGuards)

- [ ] **Step 1: Write failing tests for textToolCallFallbackHandler**

Add to `packages/agent/test/loop-guards.test.ts` — after the last `describe` block (after line 129), before the closing `});`:

```typescript
	describe("textToolCallFallback handler", () => {
		it("high resilience returns skip when parsed", () => {
			const guards = createLoopGuards("high");
			const action = guards.onTextToolCallFallback!({
				message: {} as any,
				turnNumber: 1,
				parsedToolCalls: [{ type: "toolCall", id: "x", name: "read", arguments: {} }],
				parsed: true,
			});
			assert.deepStrictEqual(action, { type: "skip" });
		});

		it("high resilience returns skip when not parsed", () => {
			const guards = createLoopGuards("high");
			const action = guards.onTextToolCallFallback!({
				message: {} as any,
				turnNumber: 1,
				parsedToolCalls: [],
				parsed: false,
			});
			assert.deepStrictEqual(action, { type: "skip" });
		});

		it("medium resilience returns use_parsed when parsed", () => {
			const guards = createLoopGuards("medium");
			const action = guards.onTextToolCallFallback!({
				message: {} as any,
				turnNumber: 1,
				parsedToolCalls: [{ type: "toolCall", id: "x", name: "read", arguments: {} }],
				parsed: true,
			});
			assert.deepStrictEqual(action, { type: "use_parsed" });
		});

		it("medium resilience returns inject_steering when not parsed", () => {
			const guards = createLoopGuards("medium");
			const action = guards.onTextToolCallFallback!({
				message: {} as any,
				turnNumber: 1,
				parsedToolCalls: [],
				parsed: false,
			});
			assert.strictEqual(action.type, "inject_steering");
		});

		it("low resilience returns use_parsed when parsed", () => {
			const guards = createLoopGuards("low");
			const action = guards.onTextToolCallFallback!({
				message: {} as any,
				turnNumber: 1,
				parsedToolCalls: [{ type: "toolCall", id: "x", name: "read", arguments: {} }],
				parsed: true,
			});
			assert.deepStrictEqual(action, { type: "use_parsed" });
		});

		it("low resilience returns inject_steering with detailed message when not parsed", () => {
			const guards = createLoopGuards("low");
			const action = guards.onTextToolCallFallback!({
				message: {} as any,
				turnNumber: 1,
				parsedToolCalls: [],
				parsed: false,
			});
			assert.strictEqual(action.type, "inject_steering");
			assert.ok((action as any).message.includes("not recognized"));
		});
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /data/mine/pi && npx vitest run packages/agent/test/loop-guards.test.ts 2>&1 | tail -20`
Expected: FAIL — `guards.onTextToolCallFallback` is undefined

- [ ] **Step 3: Add import for new types**

Change the import block at line 1-12 from:
```typescript
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
```
to:
```typescript
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
	TextToolCallFallbackAction,
	TextToolCallFallbackContext,
} from "../types.ts";
```

- [ ] **Step 4: Add textToolCallFallbackHandler function**

Add after `repeatedToolCallHandler` (after line 100, before `createLoopGuards`):

```typescript
function textToolCallFallbackHandler(
	level: ModelResilience,
): (ctx: TextToolCallFallbackContext) => TextToolCallFallbackAction {
	return (ctx) => {
		// high: 信任模型，不解析文本中的工具调用
		if (level === "high") {
			return { type: "skip" };
		}

		// medium / low: 解析成功则使用
		if (ctx.parsed && ctx.parsedToolCalls.length > 0) {
			return { type: "use_parsed" };
		}

		// 解析失败: 注入 steering 让模型重试
		if (level === "low") {
			return {
				type: "inject_steering",
				message:
					"You appear to have attempted a tool call by outputting it as text, but it was not recognized as a valid tool call. " +
					"Please use the proper tool calling mechanism (function call format) to invoke tools. " +
					"Do not output tool calls as text — call them directly using the tool call function.",
			};
		}
		// medium
		return {
			type: "inject_steering",
			message:
				"Your tool call was not recognized. Please use the proper tool calling format to invoke the tool.",
		};
	};
}
```

- [ ] **Step 5: Wire into createLoopGuards**

Change the `createLoopGuards` function (line 102-115) from:
```typescript
export function createLoopGuards(level: ModelResilience, overrides?: ModelEntryGuardFields): Partial<AgentLoopConfig> {
	const guards: Partial<AgentLoopConfig> = {
		onMalformedToolCall: malformedToolCallHandler(level),
		onMaxTokens: maxTokensHandler(level),
		onPrematureStop: prematureStopHandler(level),
		onRepeatedToolCall: repeatedToolCallHandler(level),
		maxTurns: MAX_TURNS_BY_LEVEL[level],
	};
```
to:
```typescript
export function createLoopGuards(level: ModelResilience, overrides?: ModelEntryGuardFields): Partial<AgentLoopConfig> {
	const guards: Partial<AgentLoopConfig> = {
		onMalformedToolCall: malformedToolCallHandler(level),
		onMaxTokens: maxTokensHandler(level),
		onPrematureStop: prematureStopHandler(level),
		onRepeatedToolCall: repeatedToolCallHandler(level),
		onTextToolCallFallback: textToolCallFallbackHandler(level),
		maxTurns: MAX_TURNS_BY_LEVEL[level],
	};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /data/mine/pi && npx vitest run packages/agent/test/loop-guards.test.ts 2>&1 | tail -20`
Expected: PASS — all tests pass including new ones

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/harness/loop-guards.ts packages/agent/test/loop-guards.test.ts
git commit -m "feat(agent): add textToolCallFallbackHandler to loop-guards"
```

---

## Task 6: Wire loopGuardResolver into Agent

**Files:**
- Modify: `packages/agent/src/agent.ts:1-27` (import), `packages/agent/src/agent.ts:96-116` (AgentOptions), `packages/agent/src/agent.ts:166-219` (Agent class), `packages/agent/src/agent.ts:422-449` (createLoopConfig)

- [ ] **Step 1: Add createLoopGuards import to agent.ts**

Add after line 11 (`import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";`):

```typescript
import { createLoopGuards } from "./harness/loop-guards.ts";
```

- [ ] **Step 2: Add loopGuardResolver to AgentOptions**

Add after `toolExecution?: ToolExecutionMode;` (after line 115, before the closing `}`):

```typescript
	/** Loop guard resolver - returns guard config for a model ID */
	loopGuardResolver?: (modelId: string) =>
		{ resilience?: "high" | "medium" | "low"; maxTurns?: number } | undefined;
```

- [ ] **Step 3: Add loopGuardResolver field to Agent class**

Add after `public toolExecution: ToolExecutionMode;` (after line 199, before `constructor`):

```typescript
	/** Loop guard resolver for model-specific guard configuration */
	public loopGuardResolver?: AgentOptions["loopGuardResolver"];
```

- [ ] **Step 4: Assign loopGuardResolver in constructor**

Add after `this.toolExecution = options.toolExecution ?? "parallel";` (after line 218, before closing `}`):

```typescript
		this.loopGuardResolver = options.loopGuardResolver;
```

- [ ] **Step 5: Expand guards in createLoopConfig**

Change the entire `createLoopConfig` method (lines 422-449) from:
```typescript
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			prepareNextTurn: this.prepareNextTurn ? async () => await this.prepareNextTurn?.(this.signal) : undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}
```
to:
```typescript
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		const guardConfig = this.loopGuardResolver?.(this._state.model.id);
		const guards = guardConfig?.resilience
			? createLoopGuards(guardConfig.resilience, guardConfig)
			: {};
		return {
			...guards,
			emitGuardEvents: true,
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			prepareNextTurn: this.prepareNextTurn ? async () => await this.prepareNextTurn?.(this.signal) : undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}
```

- [ ] **Step 6: Verify agent.ts compiles**

Run: `cd /data/mine/pi && npx tsc --noEmit --project packages/agent/tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 7: Run existing agent tests to verify no regression**

Run: `cd /data/mine/pi && npx vitest run packages/agent/test/agent.test.ts 2>&1 | tail -20`
Expected: PASS — all existing tests still pass

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/agent.ts
git commit -m "feat(agent): wire loopGuardResolver into Agent.createLoopConfig"
```

---

## Task 7: Pass loopGuardResolver from sdk.ts

**Files:**
- Modify: `packages/coding-agent/src/core/sdk.ts:295-361` (Agent constructor call)

- [ ] **Step 1: Add loopGuardResolver to Agent constructor call**

Find the `new Agent({` call starting at line 295. After the `maxRetryDelayMs` line (line 360):

```typescript
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});
```

Change to:

```typescript
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		loopGuardResolver: (modelId) => modelRegistry.getLoopGuardConfig(modelId),
	});
```

- [ ] **Step 2: Verify sdk.ts compiles**

Run: `cd /data/mine/pi && npx tsc --noEmit --project packages/coding-agent/tsconfig.json 2>&1 | head -20`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/src/core/sdk.ts
git commit -m "feat(coding-agent): pass loopGuardResolver to Agent in sdk.ts"
```

---

## Task 8: Add runLoop Integration Tests

**Files:**
- Modify: `packages/agent/test/agent-loop.test.ts` (add new test cases)

- [ ] **Step 1: Add test for use_parsed fallback action**

Add at the end of the `describe("agentLoop with AgentMessage"` block, before the closing `});`:

```typescript
	it("should parse text tool calls via onTextToolCallFallback use_parsed", async () => {
		const toolSchema = Type.Object({ path: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.path);
				return {
					content: [{ type: "text", text: `read: ${params.path}` }],
					details: { path: params.path },
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("read /tmp/test");

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			emitGuardEvents: true,
			onTextToolCallFallback: (ctx) => {
				if (ctx.parsed && ctx.parsedToolCalls.length > 0) {
					return { type: "use_parsed" };
				}
				return { type: "skip" };
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: model outputs text containing a tool call pattern
					const message = createAssistantMessage([
						{ type: "text", text: '我来读取 {"name":"read","arguments":{"path":"/tmp/test"}}' },
					]);
					stream.push({ type: "done", reason: "stop", message });
				} else {
					// Second call: normal response after tool result
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const event of stream) {
			events.push(event);
		}

		// Tool should have been executed with parsed path
		expect(executed).toEqual(["/tmp/test"]);

		// Should have guard_triggered event for text_tool_call_fallback
		const guardEvent = events.find((e) => e.type === "guard_triggered");
		expect(guardEvent).toBeDefined();
	});

	it("should inject steering via onTextToolCallFallback inject_steering", async () => {
		const toolSchema = Type.Object({ path: Type.String() });
		const tool: AgentTool<typeof toolSchema, { path: string }> = {
			name: "read",
			label: "Read",
			description: "Read tool",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [tool],
		};

		const userPrompt: AgentMessage = createUserMessage("read the file");

		let steeringInjected = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			emitGuardEvents: true,
			onTextToolCallFallback: (ctx) => {
				if (ctx.parsed) return { type: "use_parsed" };
				steeringInjected = true;
				return { type: "inject_steering", message: "Please use the tool calling format." };
			},
		};

		let callIndex = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callIndex === 0) {
					// First call: plain text, no tool call pattern
					const message = createAssistantMessage([{ type: "text", text: "I need to read a file." }]);
					stream.push({ type: "done", reason: "stop", message });
				} else {
					// Second call: respond after steering
					const message = createAssistantMessage([{ type: "text", text: "done" }]);
					stream.push({ type: "done", reason: "stop", message });
				}
				callIndex++;
			});
			return stream;
		};

		const stream = agentLoop([userPrompt], context, config, undefined, streamFn);

		for await (const _ of stream) {
			// consume
		}

		// Steering should have been injected
		expect(steeringInjected).toBe(true);
	});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /data/mine/pi && npx vitest run packages/agent/test/agent-loop.test.ts 2>&1 | tail -30`
Expected: PASS — all tests pass including new ones

- [ ] **Step 3: Commit**

```bash
git add packages/agent/test/agent-loop.test.ts
git commit -m "test(agent): add runLoop integration tests for text tool call fallback"
```

---

## Task 9: Run Full Test Suite

**Files:**
- None (verification only)

- [ ] **Step 1: Run all agent package tests**

Run: `cd /data/mine/pi && npx vitest run --dir packages/agent/test 2>&1 | tail -30`
Expected: All tests pass

- [ ] **Step 2: Run coding-agent tests (if any fast ones)**

Run: `cd /data/mine/pi && npx vitest run --dir packages/coding-agent/test 2>&1 | tail -30`
Expected: No new failures

- [ ] **Step 3: Final commit if any fixes needed**

If any fixes were needed in steps 1-2, commit them. Otherwise skip.

```bash
git add -A
git commit -m "fix: address test regressions from guard integration"
```

---

## Summary of Changes

| Layer | File | What |
|---|---|---|
| Types | `types.ts` | `TextToolCallFallbackContext`, `TextToolCallFallbackAction`, `onTextToolCallFallback` field, `GuardTriggeredEvent` extension |
| Parsing | `agent-loop.ts` | `parseTextToolCalls()` exported function with regex-based code block exclusion + inline tool call extraction |
| Loop | `agent-loop.ts` | `runLoop()` fallback branch after toolCalls extraction + `fallbackSteering` merge after `getSteeringMessages` |
| Guard | `loop-guards.ts` | `textToolCallFallbackHandler()` with high→skip, medium/low→use_parsed/inject_steering |
| Agent | `agent.ts` | `loopGuardResolver` in `AgentOptions` + `createLoopConfig()` expands guards + `emitGuardEvents: true` |
| Wiring | `sdk.ts` | `loopGuardResolver: (modelId) => modelRegistry.getLoopGuardConfig(modelId)` passed to `new Agent()` |
