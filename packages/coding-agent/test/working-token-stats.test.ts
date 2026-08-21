import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	accumulateBurst,
	formatElapsedTime,
	formatWorkingTokenSuffix,
} from "../src/modes/interactive/working-token-stats.ts";
import { formatTokenCount } from "../src/utils/format-token-count.ts";

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 构造一个 assistant 波次消息；content：单 4-char text 时 estimateTokens 恰为 1。 */
function burst(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

const singleTextBurst = burst([{ type: "text", text: "abcd" }]);

describe("formatTokenCount", () => {
	it("mirrors the footer abbreviation behavior", () => {
		expect(formatTokenCount(342)).toBe("342");
		expect(formatTokenCount(1234)).toBe("1.2k");
		expect(formatTokenCount(12345)).toBe("12k");
		expect(formatTokenCount(1234567)).toBe("1.2M");
	});
});

describe("formatElapsedTime", () => {
	it("formats mm:ss under an hour", () => {
		expect(formatElapsedTime(0)).toBe("0:00");
		expect(formatElapsedTime(12000)).toBe("0:12");
		expect(formatElapsedTime(59000)).toBe("0:59");
		expect(formatElapsedTime(60000)).toBe("1:00");
		expect(formatElapsedTime(3599000)).toBe("59:59");
	});
	it("formats h:mm:ss from an hour on", () => {
		expect(formatElapsedTime(3600000)).toBe("1:00:00");
		expect(formatElapsedTime(3723000)).toBe("1:02:03");
	});
});

describe("accumulateBurst", () => {
	it("adds the estimated tokens of a completed assistant burst", () => {
		expect(accumulateBurst(0, singleTextBurst)).toBe(1);
		expect(accumulateBurst(5, singleTextBurst)).toBe(6);
	});
});

describe("formatWorkingTokenSuffix", () => {
	it("shows only the elapsed time when there is no output", () => {
		expect(formatWorkingTokenSuffix({ runOutputTokens: 0, partialMessage: null }, 12000)).toBe(" · 0:12");
	});
	it("includes the accumulated output with the ↓ arrow", () => {
		expect(formatWorkingTokenSuffix({ runOutputTokens: 342, partialMessage: undefined }, 0)).toBe(" · ↓342 · 0:00");
	});
	it("merges the currently-streaming partial message", () => {
		// 已累计 342 + 当前 partial("abcd" → 估算 1) = 343
		expect(formatWorkingTokenSuffix({ runOutputTokens: 342, partialMessage: singleTextBurst }, 0)).toBe(
			" · ↓343 · 0:00",
		);
	});
});
