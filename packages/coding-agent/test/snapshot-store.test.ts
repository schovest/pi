import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitSnapshotData } from "../src/core/git-snapshot.ts";
import {
	appendSnapshot,
	countSnapshots,
	createSnapshotRefId,
	getSnapshot,
	migrateLegacySnapshots,
	removeSnapshots,
	type SnapshotDataUpdate,
	type SnapshotIndexEntry,
	trimSnapshotsToMax,
} from "../src/core/snapshot-store.ts";

function makeSnapshot(head: string, stashCommit: string | null = null): GitSnapshotData {
	return { head, stashCommit, clean: stashCommit === null };
}

function makeEntry(
	refId: string,
	timestamp: string,
	snapshot: GitSnapshotData,
	sessionId = "sess",
): SnapshotIndexEntry {
	return { refId, sessionId, timestamp, snapshot };
}

describe("snapshot-store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-snap-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("appendSnapshot / getSnapshot / countSnapshots", () => {
		it("appends and retrieves a snapshot", async () => {
			const refId = createSnapshotRefId();
			const snapshot = makeSnapshot("aaa");
			await appendSnapshot(dir, makeEntry(refId, "2024-01-01T00:00:00.000Z", snapshot));

			expect(countSnapshots(dir)).toBe(1);
			expect(getSnapshot(dir, refId)).toEqual(snapshot);
		});

		it("returns null for unknown refId", () => {
			expect(getSnapshot(dir, "nope")).toBeNull();
		});

		it("returns null when index file does not exist", () => {
			expect(getSnapshot(dir, createSnapshotRefId())).toBeNull();
			expect(countSnapshots(dir)).toBe(0);
		});

		it("creates refIds as full UUIDs (no 8-char collisions risk)", () => {
			const ids = new Set<string>();
			for (let i = 0; i < 1000; i++) {
				ids.add(createSnapshotRefId());
			}
			expect(ids.size).toBe(1000);
			for (const id of ids) {
				expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			}
		});
	});

	describe("removeSnapshots", () => {
		it("removes specified refIds and keeps the rest", async () => {
			const a = createSnapshotRefId();
			const b = createSnapshotRefId();
			const c = createSnapshotRefId();
			await appendSnapshot(dir, makeEntry(a, "2024-01-01T00:00:00.000Z", makeSnapshot("a")));
			await appendSnapshot(dir, makeEntry(b, "2024-01-02T00:00:00.000Z", makeSnapshot("b")));
			await appendSnapshot(dir, makeEntry(c, "2024-01-03T00:00:00.000Z", makeSnapshot("c")));

			await removeSnapshots(dir, [a, c]);

			expect(countSnapshots(dir)).toBe(1);
			expect(getSnapshot(dir, a)).toBeNull();
			expect(getSnapshot(dir, c)).toBeNull();
			expect(getSnapshot(dir, b)).toEqual(makeSnapshot("b"));
		});

		it("is a no-op for an empty list", async () => {
			await appendSnapshot(dir, makeEntry(createSnapshotRefId(), "2024-01-01T00:00:00.000Z", makeSnapshot("x")));
			await removeSnapshots(dir, []);
			expect(countSnapshots(dir)).toBe(1);
		});
	});

	describe("trimSnapshotsToMax", () => {
		it("removes the oldest entries beyond maxCount, keeping the newest", async () => {
			const ids: string[] = [];
			for (let i = 0; i < 5; i++) {
				const refId = createSnapshotRefId();
				ids.push(refId);
				// ascending timestamps
				await appendSnapshot(dir, makeEntry(refId, `2024-01-0${i + 1}T00:00:00.000Z`, makeSnapshot(`h${i}`)));
			}

			const removed = await trimSnapshotsToMax(dir, 3);

			expect(removed).toHaveLength(2);
			// oldest two removed
			expect(removed).toContain(ids[0]);
			expect(removed).toContain(ids[1]);
			expect(countSnapshots(dir)).toBe(3);
			// newest three kept
			expect(getSnapshot(dir, ids[2])).not.toBeNull();
			expect(getSnapshot(dir, ids[3])).not.toBeNull();
			expect(getSnapshot(dir, ids[4])).not.toBeNull();
			expect(getSnapshot(dir, ids[0])).toBeNull();
		});

		it("returns empty when within limit", async () => {
			await appendSnapshot(dir, makeEntry(createSnapshotRefId(), "2024-01-01T00:00:00.000Z", makeSnapshot("h")));
			expect(await trimSnapshotsToMax(dir, 5)).toEqual([]);
			expect(countSnapshots(dir)).toBe(1);
		});

		it("is a no-op when maxCount <= 0", async () => {
			await appendSnapshot(dir, makeEntry(createSnapshotRefId(), "2024-01-01T00:00:00.000Z", makeSnapshot("h")));
			expect(await trimSnapshotsToMax(dir, 0)).toEqual([]);
			expect(countSnapshots(dir)).toBe(1);
		});

		it("orders by timestamp regardless of append order", async () => {
			const old = createSnapshotRefId();
			const mid = createSnapshotRefId();
			const newest = createSnapshotRefId();
			// append out of order
			await appendSnapshot(dir, makeEntry(newest, "2024-03-01T00:00:00.000Z", makeSnapshot("n")));
			await appendSnapshot(dir, makeEntry(old, "2024-01-01T00:00:00.000Z", makeSnapshot("o")));
			await appendSnapshot(dir, makeEntry(mid, "2024-02-01T00:00:00.000Z", makeSnapshot("m")));

			const removed = await trimSnapshotsToMax(dir, 1);

			expect(removed).toEqual([old, mid]);
			expect(getSnapshot(dir, newest)).not.toBeNull();
		});
	});

	describe("legacy index file migration", () => {
		it("renames snapshots.jsonl to sessions.snapshots on first read", () => {
			const refId = createSnapshotRefId();
			const entry = makeEntry(refId, "2024-01-01T00:00:00.000Z", makeSnapshot("legacy-head"));
			writeFileSync(join(dir, "snapshots.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");

			// Reader path (no writer first) still sees the legacy data and migrates.
			expect(getSnapshot(dir, refId)).toEqual(entry.snapshot);
			expect(existsSync(join(dir, "sessions.snapshots"))).toBe(true);
			expect(existsSync(join(dir, "snapshots.jsonl"))).toBe(false);

			// Subsequent reads work against the migrated file.
			expect(countSnapshots(dir)).toBe(1);
		});

		it("is a no-op when no legacy index exists", () => {
			expect(getSnapshot(dir, createSnapshotRefId())).toBeNull();
			expect(existsSync(join(dir, "sessions.snapshots"))).toBe(false);
		});
	});

	describe("migrateLegacySnapshots", () => {
		it("moves legacy entries into the index and rewrites anchor data in one batch", async () => {
			const updateEntriesData = vi.fn<(updates: SnapshotDataUpdate[]) => void>();

			const migrated = await migrateLegacySnapshots({
				sessionDir: dir,
				sessionId: "sess-1",
				cwd: dir, // not a git repo; protect/unprotect fail silently
				legacyEntries: [
					{ id: "anchor-1", timestamp: "2024-01-01T00:00:00.000Z", snapshot: makeSnapshot("h1") },
					{ id: "anchor-2", timestamp: "2024-01-02T00:00:00.000Z", snapshot: makeSnapshot("h2") },
				],
				updateEntriesData,
			});

			expect(migrated).toBe(2);
			expect(countSnapshots(dir)).toBe(2);
			// Batched: the session file is rewritten once, not once per entry.
			expect(updateEntriesData).toHaveBeenCalledTimes(1);
			const updates = updateEntriesData.mock.calls[0][0] as SnapshotDataUpdate[];
			expect(updates).toHaveLength(2);
			for (const u of updates) {
				expect(u.data).toHaveProperty("refId");
				expect(typeof (u.data as { refId: string }).refId).toBe("string");
			}
		});

		it("preserves timestamp and snapshot data in the index", async () => {
			const updateEntriesData = vi.fn<(updates: SnapshotDataUpdate[]) => void>();
			const snapshot = makeSnapshot("deadbeef", "stash-abc");

			await migrateLegacySnapshots({
				sessionDir: dir,
				sessionId: "sess-9",
				cwd: dir,
				legacyEntries: [{ id: "anchor-x", timestamp: "2024-05-01T12:00:00.000Z", snapshot }],
				updateEntriesData,
			});

			const updates = updateEntriesData.mock.calls[0][0] as SnapshotDataUpdate[];
			const refId = (updates[0].data as { refId: string }).refId;
			expect(getSnapshot(dir, refId)).toEqual(snapshot);
		});

		it("does not call updateEntriesData for no legacy entries", async () => {
			const updateEntriesData = vi.fn();
			const migrated = await migrateLegacySnapshots({
				sessionDir: dir,
				sessionId: "s",
				cwd: dir,
				legacyEntries: [],
				updateEntriesData,
			});
			expect(migrated).toBe(0);
			expect(countSnapshots(dir)).toBe(0);
			expect(updateEntriesData).not.toHaveBeenCalled();
		});
	});
});
