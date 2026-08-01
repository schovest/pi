import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { isLazyEntry, SessionManager } from "../src/core/session-manager.ts";
import {
	computeFooterUsage,
	FooterComponent,
	type FooterUsageSourceEntry,
} from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function makeUsage(input: number, output: number, cacheRead = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
	};
}

function assistant(input: number, output: number, cacheRead = 0): FooterUsageSourceEntry {
	return { type: "message", message: { role: "assistant", usage: makeUsage(input, output, cacheRead) } };
}
function toolResult(input: number, output: number): FooterUsageSourceEntry {
	return { type: "message", message: { role: "toolResult", usage: makeUsage(input, output) } };
}
function lazyPlaceholder(): FooterUsageSourceEntry {
	// compaction 前大行占位：无 .message（无 __lazy 标记，computeFooterUsage 从不读取），
	// 访问 message.usage 为 undefined，靠 optional chaining 自然跳过
	return { type: "message" };
}
function compaction(input: number, output: number, cumulativeUsage?: Usage): FooterUsageSourceEntry {
	const entry: FooterUsageSourceEntry = { type: "compaction", usage: makeUsage(input, output) };
	if (cumulativeUsage) entry.cumulativeUsage = cumulativeUsage;
	return entry;
}
function branchSummary(input: number, output: number): FooterUsageSourceEntry {
	return { type: "branch_summary", usage: makeUsage(input, output) };
}

describe("computeFooterUsage", () => {
	it("uses last compaction cumulativeUsage as baseline and adds later entries", () => {
		const entries = [assistant(30, 5), compaction(7, 2, makeUsage(37, 7)), assistant(40, 8)];
		const totals = computeFooterUsage(entries);
		expect(totals.input).toBe(77);
		expect(totals.output).toBe(15);
		expect(totals.costTotal).toBe(77);
	});

	it("skips pre-compaction lazy placeholder, recovers its usage via cumulativeUsage", () => {
		const entries = [lazyPlaceholder(), compaction(5, 1, makeUsage(35, 6)), assistant(40, 8)];
		const totals = computeFooterUsage(entries);
		expect(totals.input).toBe(75); // 35 基线（含 lazy 之前的 30）+ 40
		expect(totals.output).toBe(14); // 6 + 8
	});

	it("falls back to linear accumulation when no compaction carries cumulativeUsage", () => {
		const entries = [assistant(30, 5), compaction(7, 2), assistant(40, 8)];
		const totals = computeFooterUsage(entries);
		expect(totals.input).toBe(77);
		expect(totals.output).toBe(15);
	});

	it("later compaction cumulativeUsage replaces earlier baseline", () => {
		const entries = [
			assistant(30, 5),
			compaction(3, 1, makeUsage(33, 6)),
			assistant(20, 4),
			compaction(4, 2, makeUsage(57, 12)),
			assistant(10, 2),
		];
		const totals = computeFooterUsage(entries);
		expect(totals.input).toBe(67); // 57 + 10
		expect(totals.output).toBe(14); // 12 + 2
	});

	it("counts toolResult and branch_summary usage", () => {
		const totals = computeFooterUsage([toolResult(5, 1), branchSummary(3, 2)]);
		expect(totals.input).toBe(8);
		expect(totals.output).toBe(3);
	});

	it("cache hit rate comes from the latest assistant message with usage", () => {
		const totals = computeFooterUsage([
			assistant(100, 10, 50), // 50/150 ≈ 33.3%
			assistant(200, 20, 100), // 100/300 ≈ 33.3%
			assistant(50, 5, 50), // 50/100 = 50%
		]);
		expect(totals.latestCacheHitRate).toBeCloseTo(50, 5);
	});

	it("no usage anywhere → zero totals and undefined hit rate", () => {
		const totals = computeFooterUsage([lazyPlaceholder(), { type: "message", message: { role: "user" } }]);
		expect(totals.input).toBe(0);
		expect(totals.output).toBe(0);
		expect(totals.cacheRead).toBe(0);
		expect(totals.cacheWrite).toBe(0);
		expect(totals.costTotal).toBe(0);
		expect(totals.latestCacheHitRate).toBeUndefined();
	});

	it("recovers full totals on resume: lazy pre-compaction line + persisted cumulativeUsage", () => {
		// 真实 resume 路径：磁盘文件中 compaction 前有一条大行（v3 无大小阈值，加载为 LazyEntry 占位），
		// compaction 行携带 appendCompaction 写入的 cumulativeUsage。
		const dir = mkdtempSync(join(tmpdir(), "pi-footer-cum-"));
		const file = join(dir, "s.jsonl");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "s1",
			timestamp: "2026-08-01T00:00:00.000Z",
			cwd: "/tmp",
		});
		const big = JSON.stringify({
			type: "message",
			id: "big",
			parentId: null,
			timestamp: "2026-08-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "t",
				toolName: "x",
				content: [{ type: "text", text: "x".repeat(200_000) }],
				isError: false,
				timestamp: 0,
			},
		});
		const comp = JSON.stringify({
			type: "compaction",
			id: "c1",
			parentId: "big",
			timestamp: "2026-08-01T00:00:00.000Z",
			summary: "s",
			firstKeptEntryId: "big",
			tokensBefore: 1000,
			usage: makeUsage(5, 1),
			cumulativeUsage: makeUsage(35, 6),
		});
		const after = JSON.stringify({
			type: "message",
			id: "a1",
			parentId: "c1",
			timestamp: "2026-08-01T00:00:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "p",
				model: "m",
				usage: makeUsage(40, 8),
				stopReason: "stop",
				timestamp: 0,
			},
		});
		writeFileSync(file, `${[header, big, comp, after].join("\n")}\n`);

		const sm = SessionManager.open(file);
		expect(isLazyEntry(sm.getEntry("big"))).toBe(true);
		const totals = computeFooterUsage(sm.getEntries());
		expect(totals.input).toBe(75); // 35 基线（含 lazy 前的 30）+ 40
		expect(totals.output).toBe(14); // 6 + 8
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("FooterComponent.render cumulativeUsage integration", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("displays cumulativeUsage baseline + post-compaction usage, skipping lazy", () => {
		const entries = [lazyPlaceholder(), compaction(5, 1, makeUsage(35, 6)), assistant(40, 8)];
		const footer = new FooterComponent(createSession(entries), createFooterData(1));
		const plain = footer.render(120).join("\n");
		expect(plain).toContain("↑75");
		expect(plain).toContain("↓14");
	});

	it("still accumulates linearly for sessions without cumulativeUsage", () => {
		const entries = [assistant(30, 5), assistant(40, 8)];
		const footer = new FooterComponent(createSession(entries), createFooterData(1));
		const plain = footer.render(120).join("\n");
		expect(plain).toContain("↑70");
		expect(plain).toContain("↓13");
	});
});

function createSession(entries: FooterUsageSourceEntry[]): AgentSession {
	const session = {
		state: {
			model: {
				id: "test-model",
				provider: "test",
				contextWindow: 200_000,
				reasoning: false,
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		getRunningSubagentCount: () => 0,
		backgroundProcessManager: { getRunningCount: () => 0 },
		modelRuntime: { isUsingOAuth: () => false },
	};
	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};
	return provider;
}
