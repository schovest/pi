import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type GitSnapshotData, protectSnapshot, unprotectSnapshot } from "./git-snapshot.ts";

/**
 * CWD-scoped global snapshot index.
 *
 * Git snapshots for revert are stored here (one file per project/cwd, shared
 * across all sessions in that cwd) rather than inside individual session files.
 * This makes the {@link Settings.gitSnapshotMaxCount} limit apply to the total
 * count across sessions, instead of per-session.
 *
 * The file lives at `<sessionDir>/sessions.snapshots` (one JSON object per line).
 * Each session tree keeps a lightweight `git_snapshot` custom entry ("anchor")
 * whose `data` is `{ refId }`, pointing into this index. `findGitSnapshot` tree
 * traversal is unchanged; the anchor's refId resolves to the real snapshot here.
 *
 * Concurrency: because the index is shared across sessions, two sessions may
 * write it concurrently. All mutators (append/remove/trim) serialize through a
 * lock file so a concurrent append is never lost to a read-modify-rename trim.
 * Readers (getSnapshot/countSnapshots) are lock-free and see a consistent file
 * snapshot (rename is atomic).
 */
export interface SnapshotIndexEntry {
	/** Full UUID. Used as the git ref name (refs/pi-snapshots/<refId>) and primary key. */
	refId: string;
	/** Session that created the snapshot. */
	sessionId: string;
	/** ISO timestamp. Used to order trim (oldest first). */
	timestamp: string;
	/** Real git snapshot data. */
	snapshot: GitSnapshotData;
}

/** A pending anchor data rewrite produced by migration. */
export interface SnapshotDataUpdate {
	entryId: string;
	data: unknown;
}

const SNAPSHOTS_FILENAME = "sessions.snapshots";
/** Pre-rename index filename; migrated lazily on first access. */
const LEGACY_SNAPSHOTS_FILENAME = "snapshots.jsonl";
const LOCK_SUFFIX = ".lock";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 20;
const LOCK_STALE_MS = 30_000;

function indexPath(sessionDir: string): string {
	return join(sessionDir, SNAPSHOTS_FILENAME);
}

function lockPath(file: string): string {
	return `${file}${LOCK_SUFFIX}`;
}

function ensureDir(sessionDir: string): void {
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
}

function parseEntry(line: string): SnapshotIndexEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as Partial<SnapshotIndexEntry>;
		if (parsed.refId && parsed.snapshot) {
			return parsed as SnapshotIndexEntry;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * One-time lazy migration: rename the legacy `snapshots.jsonl` index to
 * `sessions.snapshots` on first access. Same-directory rename is atomic;
 * a concurrent migration by another process leaves the source missing,
 * which is caught and ignored.
 */
function migrateLegacyIndexFile(sessionDir: string): void {
	const file = indexPath(sessionDir);
	const legacy = join(sessionDir, LEGACY_SNAPSHOTS_FILENAME);
	if (!existsSync(file) && existsSync(legacy)) {
		try {
			renameSync(legacy, file);
		} catch {
			// Another process migrated it; ignore.
		}
	}
}

function readAll(sessionDir: string): SnapshotIndexEntry[] {
	migrateLegacyIndexFile(sessionDir);
	const file = indexPath(sessionDir);
	if (!existsSync(file)) return [];
	const entries: SnapshotIndexEntry[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const entry = parseEntry(line);
		if (entry) entries.push(entry);
	}
	return entries;
}

function writeAll(sessionDir: string, entries: SnapshotIndexEntry[]): void {
	ensureDir(sessionDir);
	const file = indexPath(sessionDir);
	const lines = entries.map((e) => JSON.stringify(e));
	const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function readLockPid(lock: string): number | null {
	try {
		const content = readFileSync(lock, "utf8").trim();
		const pid = Number.parseInt(content, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A lock is stale if its holder process is dead, or it is unreadable/ancient. */
function lockIsStale(lock: string): boolean {
	const pid = readLockPid(lock);
	if (pid === null) return true;
	if (!isProcessAlive(pid)) return true;
	try {
		return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
	} catch {
		return true;
	}
}

/**
 * Run `fn` while holding an exclusive lock on the index file. Blocks until the
 * lock is acquired (clearing stale locks from dead holders), then releases it
 * in finally. Throws on timeout.
 */
async function withIndexLock<T>(sessionDir: string, fn: () => T | Promise<T>): Promise<T> {
	ensureDir(sessionDir);
	const lock = lockPath(indexPath(sessionDir));
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let fd: number | undefined;
	while (fd === undefined) {
		try {
			fd = openSync(lock, "wx");
			writeFileSync(fd, String(process.pid));
		} catch {
			if (lockIsStale(lock)) {
				try {
					unlinkSync(lock);
				} catch {
					// Another process cleaned it up; loop and retry.
				}
			}
			if (Date.now() >= deadline) {
				throw new Error(`Timed out acquiring snapshot index lock: ${lock}`);
			}
			await sleep(LOCK_POLL_MS);
		}
	}
	try {
		return await fn();
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lock);
		} catch {
			// Already removed by a stale-lock recovery path.
		}
	}
}

/** Generate a new globally-unique snapshot ref id (full UUID). */
export function createSnapshotRefId(): string {
	return randomUUID();
}

/** Append a snapshot to the global index (serialized with other writers). */
export async function appendSnapshot(sessionDir: string, entry: SnapshotIndexEntry): Promise<void> {
	await withIndexLock(sessionDir, () => {
		appendFileSync(indexPath(sessionDir), `${JSON.stringify(entry)}\n`, "utf8");
	});
}

/** Look up a snapshot by refId. Returns null if not found (pruned). Lock-free. */
export function getSnapshot(sessionDir: string, refId: string): GitSnapshotData | null {
	for (const entry of readAll(sessionDir)) {
		if (entry.refId === refId) return entry.snapshot;
	}
	return null;
}

/** Remove snapshots by refId. Serialized with other writers. */
export async function removeSnapshots(sessionDir: string, refIds: string[]): Promise<void> {
	if (refIds.length === 0) return;
	const remove = new Set(refIds);
	await withIndexLock(sessionDir, () => {
		writeAll(
			sessionDir,
			readAll(sessionDir).filter((e) => !remove.has(e.refId)),
		);
	});
}

/**
 * Trim the global index to at most maxCount entries, removing the oldest first.
 * Returns the refIds of removed entries (for git ref cleanup). No-op when within
 * limit; maxCount <= 0 is a no-op (caller disables snapshots). Serialized.
 */
export async function trimSnapshotsToMax(sessionDir: string, maxCount: number): Promise<string[]> {
	if (maxCount <= 0) return [];
	return withIndexLock(sessionDir, () => {
		const entries = readAll(sessionDir);
		if (entries.length <= maxCount) return [] as string[];
		entries.sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp));
		const keepFrom = entries.length - maxCount;
		const removed = entries.slice(0, keepFrom);
		writeAll(sessionDir, entries.slice(keepFrom));
		return removed.map((e) => e.refId);
	});
}

/** Count snapshots in the global index. Lock-free. */
export function countSnapshots(sessionDir: string): number {
	return readAll(sessionDir).length;
}

function timestampMs(ts: string): number {
	const ms = Date.parse(ts);
	return Number.isNaN(ms) ? 0 : ms;
}

/** A legacy in-tree git_snapshot custom entry (data was the full GitSnapshotData). */
export interface LegacySnapshotRecord {
	/** Session entry id. Was used as the old 8-char git ref name. */
	id: string;
	/** Entry timestamp, preserved into the global index. */
	timestamp: string;
	/** Full snapshot data previously stored inline in the session tree. */
	snapshot: GitSnapshotData;
}

/**
 * Migrate legacy in-tree git_snapshot entries into the global index.
 *
 * For each legacy record: generates a refId, appends it to the global index,
 * moves the git ref from refs/pi-snapshots/<entryId> to refs/pi-snapshots/<refId>,
 * and collects an anchor data rewrite ({ refId }). Anchor rewrites are applied
 * in a single batch via {@link params.updateEntriesData} so the session file is
 * rewritten once, not once per entry.
 *
 * Returns the number of entries migrated. Best-effort: git ref failures are
 * non-fatal (protectSnapshot/unprotectSnapshot swallow errors).
 */
export async function migrateLegacySnapshots(params: {
	sessionDir: string;
	sessionId: string;
	cwd: string;
	legacyEntries: LegacySnapshotRecord[];
	updateEntriesData: (updates: SnapshotDataUpdate[]) => void;
}): Promise<number> {
	const updates: SnapshotDataUpdate[] = [];
	for (const record of params.legacyEntries) {
		const refId = createSnapshotRefId();
		await appendSnapshot(params.sessionDir, {
			refId,
			sessionId: params.sessionId,
			timestamp: record.timestamp,
			snapshot: record.snapshot,
		});
		if (record.snapshot.stashCommit) {
			// Move git ref: create new full-uuid ref, delete old 8-char ref.
			await protectSnapshot(params.cwd, refId, record.snapshot.stashCommit);
			await unprotectSnapshot(params.cwd, record.id);
		}
		updates.push({ entryId: record.id, data: { refId } });
	}
	if (updates.length > 0) {
		params.updateEntriesData(updates);
	}
	return updates.length;
}
