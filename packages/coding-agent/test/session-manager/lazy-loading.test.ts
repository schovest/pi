import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLazyEntry, loadEntriesFromFile, peekEntryFields, SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

// v3：lazy 纯按 compaction 边界，无大小阈值（LAZY_ENTRY_THRESHOLD 已移除）。
// 大/小行用固定字节数区分，仅为断言"不区分大小"。
const BIG = 200_000;
const SMALL = 20;

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
function makeLabel(id: string, parentId: string, targetId: string, label: string): string {
	return JSON.stringify({
		type: "label",
		id,
		parentId,
		timestamp: "2026-08-01T00:00:00.000Z",
		targetId,
		label,
	});
}
function makeSubagentRun(id: string, parentId: string, agent: string): string {
	return JSON.stringify({
		type: "subagent_run",
		id,
		parentId,
		timestamp: "2026-08-01T00:00:00.000Z",
		runId: `run-${id}`,
		index: 0,
		agent,
		task: "research",
		status: "success",
		toolCount: 3,
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

describe("loadEntriesFromFile compaction-boundary lazy (v3, no size threshold)", () => {
	it("compaction 前大行 → LazyEntry", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("big1", null, BIG)}\n${makeCompaction("c1", "big1", "big1")}\n${makeMsg("after", "c1", SMALL)}\n`,
		);
		const entries = loadEntriesFromFile(file);
		const big1 = entries.find((e) => (e as { id?: string }).id === "big1") as { message?: unknown };
		expect(isLazyEntry(big1)).toBe(true);
		expect(big1.message).toBeUndefined();
	});

	it("compaction 前小行也 → LazyEntry（v3 去 64KB）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("small1", null, SMALL)}\n${makeCompaction("c1", "small1", "small1")}\n${makeMsg("after", "c1", SMALL)}\n`,
		);
		const entries = loadEntriesFromFile(file);
		const small1 = entries.find((e) => (e as { id?: string }).id === "small1") as { message?: unknown };
		expect(isLazyEntry(small1)).toBe(true);
		expect(small1.message).toBeUndefined();
	});

	it("compaction 后行 → full parse（活跃，大小无关）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${makeHeader()}\n${makeCompaction("c1", "h", null)}\n${makeMsg("big2", "c1", BIG)}\n${makeMsg("small2", "c1", SMALL)}\n`,
		);
		const entries = loadEntriesFromFile(file);
		for (const e of entries) {
			if ((e as { id?: string }).id === "big2" || (e as { id?: string }).id === "small2") {
				expect(isLazyEntry(e)).toBe(false);
				expect((e as { message?: unknown }).message).toBeDefined(); // 已 full parse
			}
		}
	});

	it("无 compaction 行 → full parse（零回归，大小无关）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${makeHeader()}\n${makeMsg("big3", null, BIG)}\n${makeMsg("small3", null, SMALL)}\n`);
		const entries = loadEntriesFromFile(file);
		for (const e of entries) {
			if ((e as { id?: string }).id === "big3" || (e as { id?: string }).id === "small3") {
				expect(isLazyEntry(e)).toBe(false);
				expect((e as { message?: unknown }).message).toBeDefined(); // 已 full parse
			}
		}
	});

	it("peek 取不到元数据时 fallback full parse（零丢失）", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		// 顶层 id 是数字（非常规序列化）：regex peek 取不到 id → fallback full parse
		const oddLine = JSON.stringify({
			type: "message",
			id: 42,
			parentId: null,
			timestamp: "2026-08-01T00:00:00.000Z",
			message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(20_000) }] },
		});
		writeFileSync(file, `${makeHeader()}\n${oddLine}\n${makeCompaction("c1", "x", null)}\n`);
		const entries = loadEntriesFromFile(file);
		const odd = entries.find((e) => (e as { id?: unknown }).id === 42) as { message?: unknown };
		expect(odd.message).toBeDefined(); // fallback full parse 保留了内容
	});
});

it("compaction 前非 message 类型（label/subagent_run）full parse，索引不失效", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(
		file,
		`${makeHeader()}\n${makeMsg("m1", null, BIG)}\n${makeLabel("l1", "m1", "m1", "checkpoint")}\n${makeSubagentRun("sa1", "m1", "researcher")}\n${makeCompaction("c1", "m1", "m1")}\n${makeMsg("after", "c1", SMALL)}\n`,
	);
	const sm = SessionManager.create("/tmp", dir);
	sm.setSessionFile(file);
	// label 索引正常（_buildIndex 的 labelsById 生效）
	expect(sm.getLabel("m1")).toBe("checkpoint");
	// subagent_run 加载正常（loadSubagentRunEntries 按 type 过滤）
	const runs = sm.loadSubagentRunEntries();
	expect(runs).toHaveLength(1);
	expect(runs[0].agent).toBe("researcher");
	// 类型未被错误改写为 message/lazy
	const l1 = sm.getEntry("l1") as { type: string; label?: string };
	expect(l1.type).toBe("label");
	expect(l1.label).toBe("checkpoint");
	const sa1 = sm.getEntry("sa1") as { type: string; agent?: string };
	expect(sa1.type).toBe("subagent_run");
	expect(sa1.agent).toBe("researcher");
});

describe("SessionManager.materialize", () => {
	it("restores full content from lazy placeholder", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigM", null, BIG);
		writeFileSync(file, `${makeHeader()}\n${big}\n${makeCompaction("c1", "bigM", "bigM")}\n`);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect(isLazyEntry(sm.getEntry("bigM"))).toBe(true);
		const m = sm.materialize("bigM");
		expect(m).toBeDefined();
		expect((m as { message: { content: unknown[] } }).message.content).toEqual(JSON.parse(big).message.content);
		expect(isLazyEntry(sm.getEntry("bigM"))).toBe(false);
	});

	it("returns undefined for unknown id and passthrough for non-lazy entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, `${makeHeader()}\n${makeMsg("small", null, SMALL)}\n`);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect(sm.materialize("nope")).toBeUndefined();
		const e = sm.materialize("small");
		expect(e).toBeDefined();
		expect((e as { message: { role: string } }).message.role).toBe("toolResult");
	});
});

describe("lazy entries and .message deref guards (B)", () => {
	it("buildSessionContext materializes kept messages between firstKeptEntryId and compaction", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		// m1（大，toolResult，firstKept）+ m2（小，user）在 compaction 前 → lazy；
		// m2 是 compaction 本应保留的最近消息
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("m1", null, BIG)}\n${makeMsg("m2", "m1", SMALL, "user")}\n${makeCompaction("c1", "m1", "m2")}\n`,
		);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect(isLazyEntry(sm.getEntry("m2"))).toBe(true);
		const ctx = sm.buildSessionContext();
		// compaction summary + kept m1 + kept m2（修复前 lazy 被 guard 跳过，只剩 summary）
		expect(ctx.entryIds).toEqual(["c1", "m1", "m2"]);
		expect(ctx.messages.length).toBe(3);
		expect(ctx.messages[2]).toEqual(JSON.parse(makeMsg("m2", "m1", SMALL, "user")).message);
	});

	it("buildSessionContext does not crash on lazy entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigC", null, BIG);
		writeFileSync(
			file,
			`${makeHeader()}\n${big}\n${makeCompaction("c1", "bigC", "bigC")}\n${makeMsg("after", "c1", SMALL, "user")}\n`,
		);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect(isLazyEntry(sm.getEntry("bigC"))).toBe(true);
		const ctx = sm.buildSessionContext();
		// compaction summary + kept bigC（经 materializer 恢复）+ after
		// （kept 内容不再被跳过：lazy 占位在 SessionManager 路径下被读回）
		expect(ctx.messages.length).toBe(3);
		expect(ctx.entryIds).toEqual(["c1", "bigC", "after"]);
		const allText = ctx.messages.map((m) => JSON.stringify(m)).join("\n");
		expect(allText).toContain("x".repeat(1000));
	});

	it("resume then append does not crash and preserves lazy line (hasAssistant guard)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigP", null, BIG);
		const assistantLine = makeMsg("asst", "c1", SMALL, "assistant");
		writeFileSync(file, `${makeHeader()}\n${big}\n${makeCompaction("c1", "bigP", "bigP")}\n${assistantLine}\n`);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		expect(isLazyEntry(sm.getEntry("bigP"))).toBe(true);
		const id = sm.appendMessage(userMsg("new question"));
		expect(sm.getEntry(id)).toBeDefined();
		const content = readFileSync(file, "utf8");
		expect(content).toContain("new question");
		// lazy 行原样保留（未被破坏）
		expect(content).toContain("x".repeat(BIG));
	});

	it("createBranchedSession hasAssistant check does not crash on lazy entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		// lazy toolResult + assistant（确保 hasAssistant=true 分支也经过 lazy guard）
		writeFileSync(
			file,
			`${makeHeader()}\n${makeMsg("bigB", null, BIG)}\n${makeCompaction("c1", "bigB", "bigB")}\n${makeMsg("asst", "c1", SMALL, "assistant")}\n`,
		);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		const newPath = sm.createBranchedSession("asst");
		expect(newPath).toBeDefined();
		// 新文件里 lazy 内容完整（materialize 在切换 sessionFile 前完成）
		const sm2 = SessionManager.open(newPath!);
		const m = sm2.materialize("bigB");
		expect(m).toBeDefined();
		expect((m as { message: { content: { text: string }[] } }).message.content[0].text).toContain("x".repeat(BIG));
	});
});

describe("lazy serialization (C)", () => {
	it("rewriteFile during migration preserves lazy raw content", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigM", null, BIG);
		// v2 文件：setSessionFile 触发 migrate → _rewriteFile
		writeFileSync(
			file,
			`${makeHeader(2)}\n${big}\n${makeCompaction("c1", "bigM", "bigM")}\n${makeMsg("after", "c1", SMALL)}\n`,
		);
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		const content = readFileSync(file, "utf8");
		expect(content).toContain("x".repeat(BIG));
		// 重写后 lazy 仍可加载、可 materialize
		const sm2 = SessionManager.open(file);
		expect(isLazyEntry(sm2.getEntry("bigM"))).toBe(true);
		const m = sm2.materialize("bigM");
		expect((m as { message: { content: { text: string }[] } }).message.content[0].text).toContain("x".repeat(BIG));
	});

	it("forkFrom preserves lazy raw content", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-"));
		const file = join(dir, "s.jsonl");
		const big = makeMsg("bigF", null, BIG);
		writeFileSync(
			file,
			`${makeHeader()}\n${big}\n${makeCompaction("c1", "bigF", "bigF")}\n${makeMsg("after", "c1", SMALL)}\n`,
		);
		const forkDir = mkdtempSync(join(tmpdir(), "pi-fork-"));
		const sm = SessionManager.forkFrom(file, "/tmp/forked-cwd", forkDir);
		expect(isLazyEntry(sm.getEntry("bigF"))).toBe(true);
		const m = sm.materialize("bigF");
		expect(m).toBeDefined();
		expect((m as { message: { content: { text: string }[] } }).message.content[0].text).toContain("x".repeat(BIG));
	});

	describe("large lazy session bulk materialize (D)", () => {
		it("buildSessionContext bulk-materializes thousands of kept lazy entries", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lazy-bulk-"));
			const file = join(dir, "s.jsonl");
			// 2 万条 compaction 前 kept 消息 + 1 个 compaction + 少量活跃消息。
			// 旧实现 buildSessionContext 对每个 lazy 占位做 O(N) findIndex + 逐条 open/read/close，
			// 在 N=2 万时需数十秒；新实现单 fd 批量读回，毫秒级。此用例兼作性能哨兵。
			const KEPT = 20_000;
			const lines = [makeHeader()];
			for (let i = 0; i < KEPT; i++) {
				lines.push(makeMsg(`k${i}`, i === 0 ? null : `k${i - 1}`, SMALL));
			}
			lines.push(makeCompaction("c1", "k0", `k${KEPT - 1}`));
			lines.push(makeMsg("a1", "c1", SMALL));
			lines.push(makeMsg("a2", "a1", SMALL));
			writeFileSync(file, `${lines.join("\n")}\n`);

			const sm = SessionManager.open(file);
			const started = performance.now();
			const ctx = sm.buildSessionContext();
			const elapsed = performance.now() - started;

			// 语义：kept 消息全部 materialize 进入上下文（compaction summary + KEPT + 活跃）
			expect(ctx.messages.length).toBe(1 + KEPT + 2);
			expect(ctx.entryIds[1]).toBe("k0");
			const firstKept = ctx.messages[1] as { content?: { text: string }[] };
			expect((firstKept.content?.[0] as { text?: string })?.text).toContain("x");
			// fileEntries 中占位已被批量替换为完整条目
			expect(isLazyEntry(sm.getEntry("k0"))).toBe(false);
			expect(isLazyEntry(sm.getEntry(`k${KEPT - 1}`))).toBe(false);
			// 性能哨兵：2 万 lazy 条目的上下文构建应毫秒级；O(N²) 旧实现（findIndex + unshift）
			// 需数十秒。5s 阈值对实测值（约 200-300ms）留 16-25 倍余量，兼顾 CI 慢机。
			expect(elapsed).toBeLessThan(5000);
		});

		it("materialize uses entryIndex after appends (offset stays valid)", () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lazy-append-"));
			const file = join(dir, "s.jsonl");
			writeFileSync(file, `${makeHeader()}\n${makeMsg("k0", null, SMALL)}\n${makeCompaction("c1", "k0", "k0")}\n`);
			const sm = SessionManager.open(file);
			// append 若干条目后再 materialize，验证 entryIndex 随 append 维护、替换位置正确
			sm.appendMessage(userMsg("hello"));
			sm.appendMessage(userMsg("world"));
			const m = sm.materialize("k0");
			expect(m).toBeDefined();
			expect(isLazyEntry(sm.getEntry("k0"))).toBe(false);
			// 追加的消息不受影响
			expect(sm.getEntries().length).toBe(4); // k0 + c1 + 2 appended
		});
	});
});
