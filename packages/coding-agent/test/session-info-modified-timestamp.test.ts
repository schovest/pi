import { mkdirSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createSessionFile(path: string): void {
	const header: SessionHeader = {
		type: "session",
		id: "test-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp",
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

	// SessionManager only persists once it has seen at least one assistant message.
	// Add a minimal assistant entry so subsequent appends are persisted.
	const mgr = SessionManager.open(path);
	mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
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
		timestamp: Date.now(),
	});
}

describe("SessionInfo.modified", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses last user/assistant message timestamp instead of file mtime", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-modified.jsonl`);
		createSessionFile(filePath);

		const before = await stat(filePath);
		// Ensure the file mtime can differ from our message timestamp even on coarse filesystems.
		await new Promise((r) => setTimeout(r, 10));

		const mgr = SessionManager.open(filePath);
		const msgTime = Date.now();
		mgr.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "later" }],
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
			timestamp: msgTime,
		});

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.modified.getTime()).toBe(msgTime);
		expect(s!.modified.getTime()).not.toBe(before.mtime.getTime());
	});

	it("hand-written session without meta: firstMessage from head, modified falls back to mtime", async () => {
		const dir = join(tmpdir(), `pi-list-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "big.jsonl");
		// 120 条消息（超过头部扫描 100 行阈值）——首条 user 文本独特，末条时间戳独特
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "big", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" }),
		];
		for (let i = 0; i < 120; i++) {
			const id = `m${i}`;
			const parentId = i === 0 ? null : `m${i - 1}`;
			const role = i % 2 === 0 ? "user" : "assistant";
			const text = i === 0 ? "FIRST-USER-MESSAGE" : `msg-${i}`;
			lines.push(
				JSON.stringify({
					type: "message",
					id,
					parentId,
					timestamp: i === 119 ? "2026-08-02T12:00:00.000Z" : "2026-08-01T00:00:10.000Z",
					message: { role, content: [{ type: "text", text }] },
				}),
			);
		}
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
		const st = await stat(filePath);

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.id === "big");
		expect(s).toBeDefined();
		expect(s!.firstMessage).toBe("FIRST-USER-MESSAGE");
		// 无 meta → modified 回退文件 mtime（append-only 下 mtime = 最后写入时刻）
		expect(s!.modified.getTime()).toBe(st.mtime.getTime());
		// fileSize 来自 stat，精确等于文件字节数（无需解析内容）
		expect(s!.fileSize).toBe(st.size);
	});

	it("renamed session_info is picked up from head scan (no meta)", async () => {
		const dir = join(tmpdir(), `pi-list-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "renamed.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "ren", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" }),
			JSON.stringify({
				type: "session_info",
				id: "si1",
				parentId: "m0",
				timestamp: "2026-08-01T00:00:00.000Z",
				targetId: "ren",
				name: "old-name",
			}),
			JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: "m0",
				timestamp: "2026-08-01T00:00:10.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
			}),
			JSON.stringify({
				type: "session_info",
				id: "si2",
				parentId: "m1",
				timestamp: "2026-08-01T00:00:10.000Z",
				targetId: "ren",
				name: "new-name",
			}),
		];
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.id === "ren");
		expect(s).toBeDefined();
		expect(s!.name).toBe("new-name");
	});

	it("hand-written session without meta falls back to file mtime", async () => {
		const dir = join(tmpdir(), `pi-list-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "tail-tool.jsonl");
		const headerTime = "2026-08-01T00:00:00.000Z";
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "tt", timestamp: headerTime, cwd: "/tmp" }),
			JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "2026-08-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: "m0",
				timestamp: "2026-08-01T00:00:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
			}),
			// 超长 tool 输出（1.5MB > 1MB 尾部窗口）占据文件末尾
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-08-01T00:00:03.000Z",
				message: { role: "tool", content: [{ type: "text", text: "x".repeat(1500 * 1024) }] },
			}),
		];
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
		const st = await stat(filePath);

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.id === "tt");
		expect(s).toBeDefined();
		// 尾部窗口无 user/assistant 消息 → 回退 mtime（最后写入时刻），而非会话创建时间
		expect(s!.modified.getTime()).toBe(st.mtime.getTime());
		expect(s!.modified.getTime()).not.toBe(new Date(headerTime).getTime());
	});

	it("empty-name session_info clears the name instead of resurrecting an older one", async () => {
		const dir = join(tmpdir(), `pi-list-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "cleared.jsonl");
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "cleared",
				timestamp: "2026-08-01T00:00:00.000Z",
				cwd: "/tmp",
			}),
			JSON.stringify({
				type: "session_info",
				id: "si1",
				parentId: null,
				timestamp: "2026-08-01T00:00:01.000Z",
				name: "old-name",
			}),
			JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "2026-08-01T00:00:02.000Z",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			}),
			JSON.stringify({
				type: "session_info",
				id: "si2",
				parentId: "m0",
				timestamp: "2026-08-01T00:00:03.000Z",
				name: "",
			}),
		];
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.id === "cleared");
		expect(s).toBeDefined();
		// 最后的 session_info 是空名（清除）——不应复活更旧的 "old-name"
		expect(s!.name).toBeUndefined();
	});

	it("session name containing the type marker literal is not misdetected", async () => {
		const dir = join(tmpdir(), `pi-list-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "quoted-name.jsonl");
		const trickyName = 'quoted "type":"session_info" name';
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "qn", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" }),
			JSON.stringify({
				type: "session_info",
				id: "si1",
				parentId: null,
				timestamp: "2026-08-01T00:00:01.000Z",
				name: trickyName,
			}),
			JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "2026-08-01T00:00:02.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			}),
		];
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.id === "qn");
		expect(s).toBeDefined();
		// 名字里的引号被 JSON.stringify 转义，lastIndexOf 只命中真 session_info 行，name 完整保留
		expect(s!.name).toBe(trickyName);
	});

	it("renamed session_info in head scan wins without meta", async () => {
		const dir = join(tmpdir(), `pi-list-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "mid-rename.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "mr", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" }),
			JSON.stringify({
				type: "session_info",
				id: "si1",
				parentId: null,
				timestamp: "2026-08-01T00:00:01.000Z",
				name: "mid-name",
			}),
			JSON.stringify({
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: "2026-08-01T00:00:02.000Z",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			}),
			// 500KB 输出把 session_info 挤出 64KB 窗口，但仍落在 1MB 窗口内
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: "m0",
				timestamp: "2026-08-01T00:00:03.000Z",
				message: { role: "tool", content: [{ type: "text", text: "x".repeat(500 * 1024) }] },
			}),
		];
		writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

		const sessions = await SessionManager.list("/tmp", dir);
		const s = sessions.find((x) => x.id === "mr");
		expect(s).toBeDefined();
		expect(s!.name).toBe("mid-name");
	});
});
