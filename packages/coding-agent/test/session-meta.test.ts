import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

function makeDir(): string {
	return join(tmpdir(), `pi-meta-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeMessage(text: string, timestamp: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** 创建一个已 flush 落盘的会话（手写 header cwd=/tmp 后 open，再 append 触发落盘）。 */
function createSession(dir: string, id: string): string {
	const filePath = join(dir, `${id}.jsonl`);
	writeFileSync(
		filePath,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" })}\n`,
		"utf8",
	);
	const mgr = SessionManager.open(filePath);
	mgr.appendMessage(makeMessage("init", Date.now()));
	return filePath;
}

describe("session meta (.meta companion file)", () => {
	it("writes a .meta file with size/name/lastActivityMs after append and rename", async () => {
		const dir = makeDir();
		mkdirSync(dir, { recursive: true });
		const filePath = createSession(dir, "s1");

		const mgr = SessionManager.open(filePath);
		mgr.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1700000000000 });
		mgr.appendSessionInfo("my-name");
		const assistTime = 1700000001000;
		mgr.appendMessage(makeMessage("reply", assistTime));

		const metaPath = `${filePath}.meta`;
		expect(existsSync(metaPath)).toBe(true);
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
			size: number;
			lastActivityMs: number;
			name: string;
			hasSessionInfo: boolean;
		};
		expect(meta.size).toBe(statSync(filePath).size);
		expect(meta.name).toBe("my-name");
		expect(meta.lastActivityMs).toBe(assistTime);
		expect(meta.hasSessionInfo).toBe(true);
	});

	it("list uses the meta fast path when size matches", async () => {
		const dir = makeDir();
		mkdirSync(dir, { recursive: true });
		const filePath = createSession(dir, "s2");

		const mgr = SessionManager.open(filePath);
		mgr.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1700000000000 });
		mgr.appendSessionInfo("my-name");
		const assistTime = 1700000001000;
		mgr.appendMessage(makeMessage("reply", assistTime));

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.name).toBe("my-name");
		expect(s!.modified.getTime()).toBe(assistTime);
	});

	it("falls back to head scan + mtime when meta is stale (size mismatch)", async () => {
		const dir = makeDir();
		mkdirSync(dir, { recursive: true });
		const filePath = createSession(dir, "s3");

		const mgr = SessionManager.open(filePath);
		mgr.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1700000000000 });
		mgr.appendSessionInfo("my-name");
		mgr.appendMessage(makeMessage("reply", 1700000001000));

		// 绕过 meta 直接向主文件追加（模拟外部修改）——size 变化使 meta 过期
		appendFileSync(
			filePath,
			`${JSON.stringify({
				type: "message",
				id: "ext1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "external" }], timestamp: 1700000002000 },
			})}\n`,
		);

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		// meta 过期 → 回退：name 用头部扫描，modified 用文件 mtime
		expect(s!.name).toBe("my-name");
		expect(s!.modified.getTime()).toBe(statSync(filePath).mtime.getTime());
	});

	it("empty-name session_info clears the name in meta", async () => {
		const dir = makeDir();
		mkdirSync(dir, { recursive: true });
		const filePath = createSession(dir, "s4");

		const mgr = SessionManager.open(filePath);
		mgr.appendSessionInfo("old-name");
		mgr.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1700000000000 });
		mgr.appendSessionInfo("");

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.name).toBeUndefined();
	});

	it("resume preserves historical name in meta after further appends", async () => {
		const dir = makeDir();
		mkdirSync(dir, { recursive: true });
		const filePath = createSession(dir, "s5");

		// 第一段：改名
		let mgr = SessionManager.open(filePath);
		mgr.appendSessionInfo("history-name");
		// 模拟会话关闭后重新打开（resume），再追加消息
		mgr = SessionManager.open(filePath);
		mgr.appendMessage(makeMessage("more", 1700000003000));

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.name).toBe("history-name");
		expect(s!.modified.getTime()).toBe(1700000003000);
	});

	it("rename before first assistant (unflushed session) persists name to jsonl and meta", async () => {
		const dir = makeDir();
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "s7.jsonl");
		// 新会话（open 不存在路径 → newSession；cwdOverride 使其可被 list("/tmp", dir) 匹配）
		const mgr = SessionManager.open(filePath, undefined, "/tmp");
		mgr.appendSessionInfo("ext-name"); // 首条 assistant 之前改名（未 flush）
		mgr.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1700000000000 });
		mgr.appendMessage(makeMessage("reply", 1700000001000)); // 首条 assistant → 全量 flush

		// JSONL 已含 session_info 行
		const raw = readFileSync(filePath, "utf8");
		expect(raw).toContain('"name":"ext-name"');
		// meta 记录 name（未 flush 阶段的改名在 flush 时不丢失）
		const meta = JSON.parse(readFileSync(`${filePath}.meta`, "utf8")) as {
			name?: string;
			hasSessionInfo?: boolean;
		};
		expect(meta.name).toBe("ext-name");
		expect(meta.hasSessionInfo).toBe(true);
		// 列表显示正确
		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.name).toBe("ext-name");
	});

	it("hand-written session without meta falls back to head scan + mtime", async () => {
		const dir = makeDir();
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "s6.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s6", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" }),
			JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "2026-08-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: "m0",
				timestamp: "2026-08-01T00:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			}),
		];
		appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.id === "s6");
		expect(s).toBeDefined();
		expect(s!.name).toBeUndefined();
		expect(s!.firstMessage).toBe("hello");
		// 无 meta → modified 回退文件 mtime
		expect(s!.modified.getTime()).toBe(statSync(filePath).mtime.getTime());
	});
});
