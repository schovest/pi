import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	getLastAssistantUsage,
	prepareCompaction,
} from "../../src/core/compaction/index.ts";
import {
	LAZY_ENTRY_THRESHOLD,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "../../src/core/session-manager.ts";

function makeHeader(): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: "s1",
		timestamp: "2026-08-01T00:00:00.000Z",
		cwd: "/tmp",
	});
}
function makeMsg(id: string, parentId: string | null, bytes: number, role = "toolResult"): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-01T00:00:00.000Z",
		message: { role, content: [{ type: "text", text: "x".repeat(Math.max(0, bytes)) }] },
	});
}
function makeCompaction(id: string, firstKept: string, parentId: string | null): string {
	return JSON.stringify({
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-08-01T00:00:00.000Z",
		summary: "s",
		firstKeptEntryId: firstKept,
		tokensBefore: 1000,
	});
}

/** 带 usage 的 assistant 消息行（getLastAssistantUsage 需要 usage 且 contextTokens > 0）。 */
function makeAssistantWithUsage(id: string, parentId: string | null): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		},
	});
}

/** 构造含 lazy 条目的 session 文件（header + bigMsg + c1 + m1 + bigMid + m3 + c2）。 */
function makeLazySessionFile(): string {
	const lines = [
		makeHeader(),
		makeMsg("bigMsg", null, LAZY_ENTRY_THRESHOLD + 100), // 64KB+ toolResult → lazy
		makeCompaction("c1", "m1", "bigMsg"),
		makeMsg("m1", "c1", 20, "user"),
		makeMsg("bigMid", "m1", LAZY_ENTRY_THRESHOLD + 200), // 64KB+，位于 c1 与 c2 之间 → lazy
		makeAssistantWithUsage("m3", "bigMid"),
		makeCompaction("c2", "m3", "m3"), // 文件最后 compaction 行 → bigMid 判 lazy
	];
	return `${lines.join("\n")}\n`;
}

function loadLazyEntries(): SessionEntry[] {
	const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, makeLazySessionFile());
	return loadEntriesFromFile(file) as SessionEntry[];
}

describe("lazy guards: sessionEntryToContextMessages", () => {
	it("returns [] for a lazy entry instead of crashing", () => {
		const entries = loadLazyEntries();
		const lazy = entries.find((e) => e.id === "bigMid") as SessionEntry & { __lazy?: boolean; message?: unknown };
		expect(lazy.__lazy).toBe(true);
		expect(lazy.message).toBeUndefined();
		// 修复前：TypeError: Cannot read properties of undefined (reading 'role')
		expect(() => sessionEntryToContextMessages(lazy)).not.toThrow();
		expect(sessionEntryToContextMessages(lazy)).toEqual([]);
	});
});

describe("lazy guards: compaction", () => {
	it("prepareCompaction does not crash when the cut window contains a lazy entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, makeLazySessionFile());
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		// 分支停在 c2 之前：getBranch 不含最后 compaction，cut 窗口会扫到 lazy 的 bigMid
		sm.branch("m3");
		const branch = sm.getBranch();
		expect(branch.some((e) => (e as { __lazy?: boolean }).__lazy)).toBe(true);
		expect(() => prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS)).not.toThrow();
	});

	it("findCutPoint does not crash on lazy entries", () => {
		const entries = loadLazyEntries();
		expect(entries.some((e) => (e as { __lazy?: boolean }).__lazy)).toBe(true);
		expect(() =>
			findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
		).not.toThrow();
	});

	it("getLastAssistantUsage skips lazy entries without crashing", () => {
		const entries = loadLazyEntries();
		expect(() => getLastAssistantUsage(entries)).not.toThrow();
		// bigMid 是 lazy toolResult，m3 是真实 assistant → 取到 m3 的 usage
		expect(getLastAssistantUsage(entries)).toBeDefined();
	});
});
