import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	LAZY_ENTRY_THRESHOLD,
	loadEntriesFromFile,
	peekEntryFields,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

function makeHeader(version = 3): string {
	return JSON.stringify({
		type: "session",
		version,
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
function makeCompaction(id: string, firstKept: string, parentId: string | null = null): string {
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

describe("peekEntryFields", () => {
	it("extracts type/id/parentId without full parse", () => {
		const line = makeMsg("abc", "p1", 10);
		const f = peekEntryFields(line);
		expect(f.type).toBe("message");
		expect(f.id).toBe("abc");
		expect(f.parentId).toBe("p1");
	});

	it("handles null parentId", () => {
		const f = peekEntryFields(makeMsg("abc", null, 10));
		expect(f.parentId).toBe(null);
	});
});

describe("loadEntriesFromFile boundary-aware lazy", () => {
	it("compaction-前大行 → LazyEntry", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("big1", null, LAZY_ENTRY_THRESHOLD + 1000)}\n${makeCompaction("c1", "big1", "big1")}\n${makeMsg("after", "c1", 50)}\n`,
		);
		const entries = loadEntriesFromFile(file);
		const big1 = entries.find((e) => (e as { id?: string }).id === "big1") as {
			__lazy?: boolean;
			message?: unknown;
		};
		expect(big1.__lazy).toBe(true);
		expect(big1.message).toBeUndefined();
	});

	it("compaction-后大行 → full parse（活跃）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${makeHeader()}\n${makeCompaction("c1", "h", null)}\n${makeMsg("big2", "c1", LAZY_ENTRY_THRESHOLD + 1000)}\n`,
		);
		const entries = loadEntriesFromFile(file);
		const big2 = entries.find((e) => (e as { id?: string }).id === "big2") as {
			__lazy?: boolean;
			message?: unknown;
		};
		expect(big2.__lazy).not.toBe(true);
		expect(big2.message).toBeDefined(); // 已 full parse
	});

	it("无 compaction 大行 → full parse（零回归）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${makeHeader()}\n${makeMsg("big3", null, LAZY_ENTRY_THRESHOLD + 1000)}\n`);
		const entries = loadEntriesFromFile(file);
		const big3 = entries.find((e) => (e as { id?: string }).id === "big3") as {
			__lazy?: boolean;
			message?: unknown;
		};
		expect(big3.__lazy).not.toBe(true);
		expect(big3.message).toBeDefined(); // 已 full parse
	});

	it("小行永远 full parse（无论 compaction 前后）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("small1", null, 10)}\n${makeCompaction("c1", "small1", "small1")}\n${makeMsg("small2", "c1", 10)}\n`,
		);
		const entries = loadEntriesFromFile(file);
		for (const e of entries) {
			if ((e as { id?: string }).id === "small1" || (e as { id?: string }).id === "small2") {
				expect((e as { __lazy?: boolean }).__lazy).not.toBe(true);
				expect((e as { message?: unknown }).message).toBeDefined();
			}
		}
	});

	it("peek 取不到元数据时 fallback full parse（零丢失）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		// 大行但顶层 id 是数字（非常规序列化）：regex peek 取不到 id → fallback full parse
		const oddLine = JSON.stringify({
			type: "message",
			id: 42,
			parentId: null,
			timestamp: "2026-08-01T00:00:00.000Z",
			message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(LAZY_ENTRY_THRESHOLD + 100) }] },
		});
		writeFileSync(file, `${makeHeader()}\n${oddLine}\n${makeCompaction("c1", "x", null)}\n`);
		const entries = loadEntriesFromFile(file);
		const odd = entries.find((e) => (e as { id?: unknown }).id === 42) as { message?: unknown };
		expect(odd.message).toBeDefined(); // fallback full parse 保留了内容
	});
});

describe("SessionManager.materialize", () => {
	it("restores full content from lazy placeholder", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigM", null, LAZY_ENTRY_THRESHOLD + 500);
		writeFileSync(file, `${makeHeader()}\n${big}\n${makeCompaction("c1", "bigM", "bigM")}\n`);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect((sm.getEntry("bigM") as { __lazy?: boolean }).__lazy).toBe(true);
		const m = sm.materialize("bigM");
		expect(m).toBeDefined();
		expect((m as { message: { content: unknown[] } }).message.content).toEqual(JSON.parse(big).message.content);
		expect((sm.getEntry("bigM") as { __lazy?: boolean }).__lazy).not.toBe(true);
	});

	it("returns undefined for unknown id and passthrough for non-lazy entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${makeHeader()}\n${makeMsg("small", null, 10)}\n`);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect(sm.materialize("nope")).toBeUndefined();
		const e = sm.materialize("small");
		expect(e).toBeDefined();
		expect((e as { message: { role: string } }).message.role).toBe("toolResult");
	});
});

describe("lazy entries and .message deref guards (B)", () => {
	it("buildSessionContext does not crash on lazy entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigC", null, LAZY_ENTRY_THRESHOLD + 100);
		writeFileSync(
			file,
			`${makeHeader()}\n${big}\n${makeCompaction("c1", "bigC", "bigC")}\n${makeMsg("after", "c1", 10, "user")}\n`,
		);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect((sm.getEntry("bigC") as { __lazy?: boolean }).__lazy).toBe(true);
		const ctx = sm.buildSessionContext();
		// compaction summary + after（lazy 条目无 .message，被 guard 跳过）
		expect(ctx.messages.length).toBe(2);
		const allText = ctx.messages.map((m) => JSON.stringify(m)).join("\n");
		expect(allText).not.toContain("x".repeat(1000));
	});

	it("resume then append does not crash and preserves lazy line (hasAssistant guard)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigP", null, LAZY_ENTRY_THRESHOLD + 200);
		const assistantLine = makeMsg("asst", "c1", 20, "assistant");
		writeFileSync(file, `${makeHeader()}\n${big}\n${makeCompaction("c1", "bigP", "bigP")}\n${assistantLine}\n`);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect((sm.getEntry("bigP") as { __lazy?: boolean }).__lazy).toBe(true);
		const id = sm.appendMessage(userMsg("new question"));
		expect(sm.getEntry(id)).toBeDefined();
		const content = readFileSync(file, "utf8");
		expect(content).toContain("new question");
		// lazy 行原样保留（未被破坏）
		expect(content).toContain("x".repeat(LAZY_ENTRY_THRESHOLD + 200));
	});

	it("createBranchedSession hasAssistant check does not crash on lazy entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		// lazy toolResult + assistant（确保 hasAssistant=true 分支也经过 lazy guard）
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("bigB", null, LAZY_ENTRY_THRESHOLD + 400)}\n${makeCompaction("c1", "bigB", "bigB")}\n${makeMsg("asst", "c1", 20, "assistant")}\n`,
		);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		const newPath = sm.createBranchedSession("asst");
		expect(newPath).toBeDefined();
		// 新文件里 lazy 内容完整（materialize 在切换 sessionFile 前完成）
		const sm2 = SessionManager.open(newPath!);
		const m = sm2.materialize("bigB");
		expect(m).toBeDefined();
		expect((m as { message: { content: { text: string }[] } }).message.content[0].text).toContain(
			"x".repeat(LAZY_ENTRY_THRESHOLD + 400),
		);
	});
});

describe("lazy serialization (C)", () => {
	it("rewriteFile during migration preserves lazy raw content", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigM", null, LAZY_ENTRY_THRESHOLD + 500);
		// v2 文件：setSessionFile 触发 migrate → _rewriteFile
		writeFileSync(
			file,
			`${makeHeader(2)}\n${big}\n${makeCompaction("c1", "bigM", "bigM")}\n${makeMsg("after", "c1", 10)}\n`,
		);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		const content = readFileSync(file, "utf8");
		expect(content).toContain("x".repeat(LAZY_ENTRY_THRESHOLD + 500));
		// 重写后 lazy 仍可加载、可 materialize
		const sm2 = SessionManager.open(file);
		expect((sm2.getEntry("bigM") as { __lazy?: boolean }).__lazy).toBe(true);
		const m = sm2.materialize("bigM");
		expect((m as { message: { content: { text: string }[] } }).message.content[0].text).toContain(
			"x".repeat(LAZY_ENTRY_THRESHOLD + 500),
		);
	});

	it("forkFrom preserves lazy raw content", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigF", null, LAZY_ENTRY_THRESHOLD + 300);
		writeFileSync(
			file,
			`${makeHeader()}\n${big}\n${makeCompaction("c1", "bigF", "bigF")}\n${makeMsg("after", "c1", 10)}\n`,
		);
		const forkDir = mkdtempSync(join(tmpdir(), "pi-fork-"));
		const sm = SessionManager.forkFrom(file, "/tmp/forked-cwd", forkDir);
		expect((sm.getEntry("bigF") as { __lazy?: boolean }).__lazy).toBe(true);
		const m = sm.materialize("bigF");
		expect(m).toBeDefined();
		expect((m as { message: { content: { text: string }[] } }).message.content[0].text).toContain(
			"x".repeat(LAZY_ENTRY_THRESHOLD + 300),
		);
	});
});
