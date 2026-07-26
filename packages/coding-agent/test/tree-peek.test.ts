import { describe, expect, it } from "vitest";
import { buildSessionContext, type SessionEntry, type SessionMessageEntry } from "../src/core/session-manager.ts";

function userEntry(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

describe("buildSessionContext entryIds", () => {
	it("entryIds aligned with messages for simple chain", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", null, "Hello"),
			assistantEntry("a1", "u1", "Hi there"),
			userEntry("u2", "a1", "Bye"),
			assistantEntry("a2", "u2", "Goodbye"),
		];
		const ctx = buildSessionContext(entries, "a2");
		expect(ctx.messages).toHaveLength(4);
		expect(ctx.entryIds).toEqual(["u1", "a1", "u2", "a2"]);
	});

	it("entryIds empty for null leafId", () => {
		const entries: SessionEntry[] = [userEntry("u1", null, "Hello")];
		const ctx = buildSessionContext(entries, null);
		expect(ctx.messages).toHaveLength(0);
		expect(ctx.entryIds).toHaveLength(0);
	});
});
