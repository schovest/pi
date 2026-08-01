import { describe, expect, it } from "vitest";
import { type LabelEntry, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager pruneOrphanedEntries", () => {
	it("removes entries not on the path to the kept leaf", () => {
		const session = SessionManager.inMemory();

		// Build a tree:
		//   root (user1) -> assistant1 -> user2 -> assistant2
		//                                \-> user3 -> assistant3  (branch)
		const user1Id = session.appendMessage(userMsg("msg1"));
		const assistant1Id = session.appendMessage(assistantMsg("resp1"));
		const user2Id = session.appendMessage(userMsg("msg2"));

		// Branch from assistant1
		session.branch(assistant1Id);
		const user3Id = session.appendMessage(userMsg("msg3"));
		const assistant3Id = session.appendMessage(assistantMsg("resp3"));

		// Now leaf is assistant3. Prune to assistant1 (keep path root->user1->assistant1)
		const removedIds = session.pruneOrphanedEntries(assistant1Id);

		// user2, user3, assistant3 should be removed
		expect(removedIds.has(user2Id)).toBe(true);
		expect(removedIds.has(user3Id)).toBe(true);
		expect(removedIds.has(assistant3Id)).toBe(true);

		// root, user1, assistant1 should be kept
		expect(removedIds.has(user1Id)).toBe(false);
		expect(removedIds.has(assistant1Id)).toBe(false);

		// Verify remaining entries
		const entries = session.getEntries();
		const ids = new Set(entries.map((e) => e.id));
		expect(ids.has(user1Id)).toBe(true);
		expect(ids.has(assistant1Id)).toBe(true);
		expect(ids.has(user2Id)).toBe(false);
		expect(ids.has(user3Id)).toBe(false);
		expect(ids.has(assistant3Id)).toBe(false);
	});

	it("preserves labels whose targetId is kept", () => {
		const session = SessionManager.inMemory();

		const user1Id = session.appendMessage(userMsg("msg1"));
		const assistant1Id = session.appendMessage(assistantMsg("resp1"));
		session.appendLabelChange(user1Id, "important");

		// Branch
		session.branch(user1Id);
		const user2Id = session.appendMessage(userMsg("msg2"));
		session.appendLabelChange(user2Id, "checkpoint");

		// Prune to assistant1 - user1's label survives, user2's label is removed
		session.pruneOrphanedEntries(assistant1Id);

		const entries = session.getEntries();
		const labelEntries = entries.filter((e) => e.type === "label") as LabelEntry[];

		// user1's label should be kept
		expect(labelEntries.some((l) => l.targetId === user1Id)).toBe(true);
		// user2's label should be removed
		expect(labelEntries.some((l) => l.targetId === user2Id)).toBe(false);
	});

	it("preserves subagent entries regardless of leaf position", () => {
		const session = SessionManager.inMemory();

		session.appendMessage(userMsg("msg1"));
		session.appendMessage(assistantMsg("resp1"));

		// Add a subagent_run entry with a child message - not on the main path
		const subagentRunEntry = {
			type: "subagent_run" as const,
			id: "sub_run_1",
			parentId: null,
			timestamp: new Date().toISOString(),
			subagentId: "test-agent",
			status: "completed" as const,
		};
		// Manually push to fileEntries since appendMessage only does messages
		(session as any).fileEntries.push(subagentRunEntry);
		(session as any).byId.set("sub_run_1", subagentRunEntry);

		const subChild = {
			type: "message" as const,
			id: "sub_msg_1",
			parentId: "sub_run_1",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "sub msg" },
		};
		(session as any).fileEntries.push(subChild);
		(session as any).byId.set("sub_msg_1", subChild);

		// Prune to user1 (which keeps only root->user1)
		// The leaf is now on the main path but subagent is preserved anyway
		const entries = session.getEntries();
		const msgEntries = entries.filter((e) => e.type === "message");
		const lastMainMsg = msgEntries[msgEntries.length - 1];
		session.pruneOrphanedEntries(lastMainMsg!.id);

		const finalEntries = session.getEntries();
		const ids = new Set(finalEntries.map((e) => e.id));
		expect(ids.has("sub_run_1")).toBe(true);
		expect(ids.has("sub_msg_1")).toBe(true);
	});

	it("returns empty set when all entries are on path", () => {
		const session = SessionManager.inMemory();

		session.appendMessage(userMsg("msg1"));
		const assistant1Id = session.appendMessage(assistantMsg("resp1"));

		// Prune to current leaf - nothing should be removed
		const removedIds = session.pruneOrphanedEntries(assistant1Id);
		expect(removedIds.size).toBe(0);
	});
});
