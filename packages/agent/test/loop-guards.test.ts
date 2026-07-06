import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createLoopGuards } from "../src/harness/loop-guards.ts";
import type { MaxTokensContext, PrematureStopContext, RepeatedToolCallContext } from "../src/types.ts";

describe("createLoopGuards", () => {
	describe("high resilience", () => {
		const guards = createLoopGuards("high");

		it("onMalformedToolCall returns error_result", () => {
			const action = guards.onMalformedToolCall!({
				toolCall: {} as any,
				error: "test",
				turnNumber: 1,
				recentMalformedCount: 1,
			});
			assert.deepStrictEqual(action, { type: "error_result" });
		});

		it("onMaxTokens returns continue with short message", () => {
			const action = guards.onMaxTokens!({} as MaxTokensContext);
			assert.strictEqual(action.type, "continue");
		});

		it("onPrematureStop returns stop", () => {
			const action = guards.onPrematureStop!({} as PrematureStopContext);
			assert.deepStrictEqual(action, { type: "stop" });
		});

		it("onRepeatedToolCall returns proceed", () => {
			const action = guards.onRepeatedToolCall!({} as RepeatedToolCallContext);
			assert.deepStrictEqual(action, { type: "proceed" });
		});

		it("maxTurns is undefined", () => {
			assert.strictEqual(guards.maxTurns, undefined);
		});
	});

	describe("medium resilience", () => {
		const guards = createLoopGuards("medium");

		it("onMalformedToolCall returns error_result on first error", () => {
			const action = guards.onMalformedToolCall!({
				toolCall: {} as any,
				error: "test",
				turnNumber: 1,
				recentMalformedCount: 1,
			});
			assert.deepStrictEqual(action, { type: "error_result" });
		});

		it("onMalformedToolCall returns inject_steering on 2nd+ error", () => {
			const action = guards.onMalformedToolCall!({
				toolCall: {} as any,
				error: "test",
				turnNumber: 1,
				recentMalformedCount: 2,
			});
			assert.strictEqual(action.type, "inject_steering");
		});

		it("onPrematureStop returns continue when toolCallsSoFar < 3", () => {
			const action = guards.onPrematureStop!({ totalToolCallsSoFar: 2 } as PrematureStopContext);
			assert.strictEqual(action.type, "continue");
		});

		it("onPrematureStop returns stop when toolCallsSoFar >= 3", () => {
			const action = guards.onPrematureStop!({ totalToolCallsSoFar: 3 } as PrematureStopContext);
			assert.deepStrictEqual(action, { type: "stop" });
		});

		it("maxTurns is 50", () => {
			assert.strictEqual(guards.maxTurns, 50);
		});
	});

	describe("low resilience", () => {
		const guards = createLoopGuards("low");

		it("onMalformedToolCall always returns inject_steering with detailed message", () => {
			const action = guards.onMalformedToolCall!({
				toolCall: {} as any,
				error: "bad args",
				turnNumber: 1,
				recentMalformedCount: 1,
			});
			assert.strictEqual(action.type, "inject_steering");
			assert.ok((action as any).message.includes("bad args"));
			assert.ok((action as any).message.includes("Common fixes"));
		});

		it("onPrematureStop returns continue when toolCallsSoFar < 5", () => {
			const action = guards.onPrematureStop!({ totalToolCallsSoFar: 4 } as PrematureStopContext);
			assert.strictEqual(action.type, "continue");
		});

		it("onPrematureStop returns stop when toolCallsSoFar >= 5", () => {
			const action = guards.onPrematureStop!({ totalToolCallsSoFar: 5 } as PrematureStopContext);
			assert.deepStrictEqual(action, { type: "stop" });
		});

		it("onRepeatedToolCall returns inject_steering at repeatCount 2", () => {
			const action = guards.onRepeatedToolCall!({
				toolCall: { name: "read" } as any,
				repeatCount: 2,
			} as RepeatedToolCallContext);
			assert.strictEqual(action.type, "inject_steering");
		});

		it("onRepeatedToolCall returns skip at repeatCount 4", () => {
			const action = guards.onRepeatedToolCall!({
				toolCall: { name: "read" } as any,
				repeatCount: 4,
			} as RepeatedToolCallContext);
			assert.deepStrictEqual(action, { type: "skip" });
		});

		it("maxTurns is 80", () => {
			assert.strictEqual(guards.maxTurns, 80);
		});
	});

	describe("user overrides", () => {
		it("maxTurns override takes precedence", () => {
			const guards = createLoopGuards("low", { resilience: "low", maxTurns: 100 });
			assert.strictEqual(guards.maxTurns, 100);
		});
	});
});
