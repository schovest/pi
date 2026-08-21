import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	accumulateBurst,
	formatElapsedTime,
	formatWorkingTokenSuffix,
	nextWorkingSuffix,
	type WorkingSuffixCache,
	type WorkingTokenStats,
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
		expect(formatTokenCount(1000)).toBe("1.0k");
		expect(formatTokenCount(1234)).toBe("1.2k");
		expect(formatTokenCount(10000)).toBe("10k");
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

describe("nextWorkingSuffix", () => {
	it("recomputes after the 1s throttle window elapses", () => {
		const empty: WorkingSuffixCache = { lastRefresh: 0, lastSuffix: "" };
		const stats: WorkingTokenStats = { runOutputTokens: 342, partialMessage: null };

		// now=1500，lastRefresh=0 → 超过 1s，需重算并得到新的 lastRefresh=1500。
		const first = nextWorkingSuffix(empty, 1500, stats, 1500);
		expect(first.suffix).toBe(" · ↓342 · 0:01");
		expect(first.cache.lastRefresh).toBe(1500);
		expect(first.cache.lastSuffix).toBe(" · ↓342 · 0:01");

		// now=1600 < lastRefresh+1000 → 返回缓存，cache 不变。
		const cached = nextWorkingSuffix(first.cache, 1600, stats, 1600);
		expect(cached.suffix).toBe(first.suffix);
		expect(cached.cache).toBe(first.cache);

		// now=2600 再次跨越 1s → 重算。
		const second = nextWorkingSuffix(cached.cache, 2600, stats, 2600);
		expect(second.suffix).toBe(" · ↓342 · 0:02");
		expect(second.cache.lastRefresh).toBe(2600);
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
