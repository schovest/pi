import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
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
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});
});

describe("SessionManager.updateCustomEntriesData", () => {
	it("updates data of multiple custom entries in one pass", () => {
		const session = SessionManager.inMemory();
		const a = session.appendCustomEntry("git_snapshot", { legacy: true });
		const b = session.appendCustomEntry("git_snapshot", { legacy: true });
		const c = session.appendCustomEntry("other", { keep: 1 });

		const updated = session.updateCustomEntriesData([
			{ entryId: a, data: { refId: "ref-a" } },
			{ entryId: b, data: { refId: "ref-b" } },
		]);

		expect(updated).toBe(2);
		const entries = session.getEntries();
		expect((entries.find((e) => e.id === a) as CustomEntry).data).toEqual({ refId: "ref-a" });
		expect((entries.find((e) => e.id === b) as CustomEntry).data).toEqual({ refId: "ref-b" });
		// Unrelated custom entries are untouched.
		expect((entries.find((e) => e.id === c) as CustomEntry).data).toEqual({ keep: 1 });
	});

	it("returns 0 and does nothing for empty updates", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry("git_snapshot", { legacy: true });
		expect(session.updateCustomEntriesData([])).toBe(0);
	});

	it("ignores entryIds that do not exist without creating entries", () => {
		const session = SessionManager.inMemory();
		const a = session.appendCustomEntry("git_snapshot", { legacy: true });
		const updated = session.updateCustomEntriesData([
			{ entryId: a, data: { refId: "ref-a" } },
			{ entryId: "nonexistent", data: { refId: "x" } },
		]);
		expect(updated).toBe(2); // returns the number of requested updates
		expect((session.getEntries().find((e) => e.id === a) as CustomEntry).data).toEqual({ refId: "ref-a" });
		expect(session.getEntries()).toHaveLength(1); // no entry created for the unknown id
	});
});
