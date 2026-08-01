import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type CompactionEntry, SessionManager } from "../../src/core/session-manager.ts";

function makeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function appendAssistant(sm: SessionManager, input: number, output: number): string {
	return sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "a" }],
		provider: "p",
		model: "m",
		api: "anthropic-messages",
		usage: makeUsage(input, output),
		stopReason: "stop",
		timestamp: 0,
	});
}

describe("appendCompaction cumulativeUsage", () => {
	it("records cumulative usage of all prior entries", () => {
		const sm = SessionManager.inMemory();
		appendAssistant(sm, 30, 5);
		appendAssistant(sm, 40, 8);
		const leaf = sm.getLeafId()!;
		const cid = sm.appendCompaction("sum", leaf, 1000);
		const entry = sm.getEntry(cid) as CompactionEntry;
		expect(entry.cumulativeUsage?.input).toBe(70);
		expect(entry.cumulativeUsage?.output).toBe(13);
	});

	it("includes the compaction's own usage in cumulativeUsage", () => {
		const sm = SessionManager.inMemory();
		appendAssistant(sm, 30, 5);
		const leaf = sm.getLeafId()!;
		const cid = sm.appendCompaction("sum", leaf, 1000, undefined, false, makeUsage(7, 2));
		const entry = sm.getEntry(cid) as CompactionEntry;
		expect(entry.cumulativeUsage?.input).toBe(37);
		expect(entry.cumulativeUsage?.output).toBe(7);
	});

	it("persists cumulativeUsage across reload", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cum-"));
		const file = join(dir, "s.jsonl");
		const sm = SessionManager.create("/tmp", dir);
		sm.setSessionFile(file);
		appendAssistant(sm, 30, 5);
		const leaf = sm.getLeafId()!;
		sm.appendCompaction("sum", leaf, 1000);
		expect(readFileSync(file, "utf8")).toContain('"cumulativeUsage"');

		const reopened = SessionManager.open(file);
		const comp = reopened.getEntries().find((e) => e.type === "compaction") as CompactionEntry;
		expect(comp.cumulativeUsage?.input).toBe(30);
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes zero cumulativeUsage when no usage exists before compaction", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		const leaf = sm.getLeafId()!;
		const cid = sm.appendCompaction("sum", leaf, 1000);
		const entry = sm.getEntry(cid) as CompactionEntry;
		expect(entry.cumulativeUsage).toBeDefined();
		expect(entry.cumulativeUsage?.input).toBe(0);
		expect(entry.cumulativeUsage?.output).toBe(0);
	});
});

describe("loadEntriesFromFile cumulativeUsage round-trip (raw file)", () => {
	it("preserves cumulativeUsage on the parsed compaction entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cum-raw-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			JSON.stringify({ type: "session", id: "s1", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/tmp" }) +
				"\n" +
				JSON.stringify({
					type: "compaction",
					id: "c1",
					parentId: null,
					timestamp: "2026-08-01T00:00:00.000Z",
					summary: "s",
					firstKeptEntryId: "m1",
					tokensBefore: 1000,
					usage: { ...makeUsage(5, 1) },
					cumulativeUsage: makeUsage(35, 6),
				}) +
				"\n",
		);
		const sm = SessionManager.open(file);
		const comp = sm.getEntries().find((e) => e.type === "compaction") as CompactionEntry;
		expect(comp.cumulativeUsage?.input).toBe(35);
		rmSync(dir, { recursive: true, force: true });
	});
});
