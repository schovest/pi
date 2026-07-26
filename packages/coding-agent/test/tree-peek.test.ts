import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";

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

function compactionEntry(
	id: string,
	parentId: string | null,
	summary: string,
	firstKeptEntryId: string,
): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 5000,
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

	it("entryIds aligned with messages after compaction", () => {
		const u1 = userEntry("u1", null, "Old message before compaction");
		const u2 = userEntry("u2", "u1", "Kept message");
		const a1 = assistantEntry("a1", "u2", "Kept response");
		const comp = compactionEntry("c1", "a1", "Compacted 3 messages", "u2");
		const u3 = userEntry("u3", "c1", "Message after compaction");
		const a2 = assistantEntry("a2", "u3", "Response after compaction");
		const entries: SessionEntry[] = [u1, u2, a1, comp, u3, a2];
		const ctx = buildSessionContext(entries, "a2");
		// Expected: compaction summary (c1), kept messages (u2, a1), post-compaction messages (u3, a2)
		expect(ctx.messages).toHaveLength(5);
		expect(ctx.messages[0].role).toBe("compactionSummary");
		expect(ctx.entryIds).toEqual(["c1", "u2", "a1", "u3", "a2"]);
	});
});
