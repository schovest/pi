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
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
	sessionEntryToContextMessages,
} from "../../src/core/session-manager.ts";

// v3：lazy 纯按 compaction 边界（无大小阈值），用固定大字节数构造 compaction 前大行。
const BIG = 200_000;

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
		makeMsg("bigMsg", null, BIG), // compaction 前 toolResult → lazy（大小无关）
		makeCompaction("c1", "m1", "bigMsg"),
		makeMsg("m1", "c1", 20, "user"),
		makeMsg("bigMid", "m1", BIG), // c1 与 c2 之间 → lazy
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

	it("getLastAssistantUsage skips lazy entries and finds post-compaction assistant", () => {
		// v3：compaction 前全 lazy（含 assistant）；compaction 后 assistant full parse。
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("bigMsg", null, BIG)}\n${makeCompaction("c1", "m1", "bigMsg")}\n${makeMsg("m1", "c1", 20, "user")}\n${makeAssistantWithUsage("pre", "c1")}\n${makeCompaction("c2", "pre", "pre")}\n${makeAssistantWithUsage("post", "c2")}\n`,
		);
		const entries = loadEntriesFromFile(file) as SessionEntry[];
		// compaction 前 assistant（pre）也是 lazy 占位
		expect((entries.find((e) => e.id === "pre") as { __lazy?: boolean }).__lazy).toBe(true);
		expect(() => getLastAssistantUsage(entries)).not.toThrow();
		// lazy 占位无 .message → 跳过；compaction 后 assistant（post）full parse → 取到
		expect(getLastAssistantUsage(entries)).toBeDefined();
	});
});
