import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Git snapshot capture mode. */
export type GitSnapshotMode = "tracked-only" | "include-untracked" | "all";

/** Git snapshot data stored in session CustomEntry. */
export interface GitSnapshotData {
	/** HEAD commit hash at snapshot time */
	head: string;
	/** git stash push --include-untracked result. null if working tree was clean. */
	stashCommit: string | null;
	/** Whether the working tree was clean (no staged/unstaged/untracked changes) */
	clean: boolean;
	/** Capture mode. Absent on legacy records (treated as "include-untracked"). */
	mode?: GitSnapshotMode;
}

/** Maximum buffer size for git commands (10MB) */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Check if the given directory is inside a git repository.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd, maxBuffer: MAX_BUFFER });
		return true;
	} catch {
		return false;
	}
}

/**
 * Take a git snapshot of the current working tree state.
 *
 * Uses `git stash push` with the specified mode to capture the working tree,
 * then immediately `git stash pop` to restore it. Creates a 3-parent stash
 * commit that preserves both tracked modifications and untracked files.
 *
 * @param cwd Working directory
 * @param mode "tracked-only" captures tracked changes only;
 *             "include-untracked" also captures non-ignored untracked files (default);
 *             "all" also captures .gitignore'd files
 * @returns GitSnapshotData, or null if not a git repository or on error
 */
export async function takeSnapshot(
	cwd: string,
	mode: GitSnapshotMode = "include-untracked",
): Promise<GitSnapshotData | null> {
	if (!(await isGitRepo(cwd))) {
		return null;
	}

	// tracked-only: only tracked changes matter (untracked files are not captured)
	const statusArgs =
		mode === "tracked-only" ? ["status", "--porcelain", "--untracked-files=no"] : ["status", "--porcelain"];
	// git stash push flags per mode (tracked-only: none)
	const stashFlags = mode === "all" ? ["--all"] : mode === "include-untracked" ? ["--include-untracked"] : [];

	try {
		// Get current HEAD
		const { stdout: headStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
		const head = headStdout.trim();

		// Check if working tree is clean (per-mode scope)
		const { stdout: statusStdout } = await execFileAsync("git", statusArgs, {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
		const clean = statusStdout.trim().length === 0;

		if (clean) {
			return { head, stashCommit: null, clean: true, mode };
		}

		// Push stash to capture working tree state
		await execFileAsync("git", ["stash", "push", ...stashFlags, "-m", "pi-snapshot"], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});

		// Get the stash commit hash
		const { stdout: revStdout } = await execFileAsync("git", ["rev-parse", "stash@{0}"], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
		const stashCommit = revStdout.trim();

		// Immediately pop to restore working tree
		await execFileAsync("git", ["stash", "pop"], { cwd, maxBuffer: MAX_BUFFER });

		return { head, stashCommit, clean: false, mode };
	} catch {
		// Best-effort: try to pop stash if push succeeded but pop failed
		try {
			await execFileAsync("git", ["stash", "pop"], { cwd, maxBuffer: MAX_BUFFER });
		} catch {
			// Ignore pop errors in cleanup
		}
		return null;
	}
}

/**
 * Protect a snapshot's git object from garbage collection by creating a ref.
 * Creates refs/pi-snapshots/<refId> pointing to the stash commit.
 *
 * @param refId Globally-unique snapshot id (full UUID) from the cwd-scoped index.
 */
export async function protectSnapshot(cwd: string, refId: string, stashCommit: string): Promise<void> {
	try {
		await execFileAsync("git", ["update-ref", `refs/pi-snapshots/${refId}`, stashCommit], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
	} catch {
		// Non-fatal: snapshot will still work within gc grace period (default 2 weeks)
	}
}

/**
 * Remove the git ref protecting a snapshot, allowing git gc to reclaim the stash object.
 * Deletes refs/pi-snapshots/<refId>.
 *
 * @param refId Globally-unique snapshot id (full UUID) from the cwd-scoped index.
 */
export async function unprotectSnapshot(cwd: string, refId: string): Promise<void> {
	try {
		await execFileAsync("git", ["update-ref", "-d", `refs/pi-snapshots/${refId}`], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
	} catch {
		// Non-fatal: ref may not exist or git operation failed
	}
}

/**
 * Check if a git object (commit) exists in the repository.
 */
async function objectExists(cwd: string, sha: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["cat-file", "-t", sha], { cwd, maxBuffer: MAX_BUFFER });
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if the working tree has any uncommitted changes.
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
	if (!(await isGitRepo(cwd))) {
		return false;
	}
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Restore the working tree to a snapshot's state.
 *
 * Steps:
 * 1. Discard all current working tree changes (checkout + clean)
 * 2. Restore tracked files to snapshot's HEAD state (if different)
 * 3. Apply snapshot's stash to restore working tree modifications + untracked files
 *
 * @throws Error if git operations fail (e.g., stash apply conflict, missing objects)
 */
export async function restoreSnapshot(cwd: string, snapshot: GitSnapshotData): Promise<void> {
	// tracked-only: restore tracked files only; untracked/ignored files are left untouched.
	// Legacy records without a mode are treated as "include-untracked" (full restore).
	if (snapshot.mode === "tracked-only") {
		await restoreTrackedOnly(cwd, snapshot);
		return;
	}

	// Step 1: Verify snapshot objects still exist
	await verifySnapshotObjects(cwd, snapshot);

	// Step 2: Discard all current working tree changes
	// Remove untracked files, then reset staged + working tree to HEAD
	await execFileAsync("git", ["clean", "-fd"], { cwd, maxBuffer: MAX_BUFFER });
	await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd, maxBuffer: MAX_BUFFER });

	// Step 3: Restore tracked files to snapshot HEAD state (if HEAD differs)
	await checkoutSnapshotHeadIfNeeded(cwd, snapshot);

	// Step 4: Apply stash to restore working tree modifications + untracked files
	if (snapshot.stashCommit) {
		await applyStashCommit(cwd, snapshot.stashCommit);
	}
}

/**
 * Restore only git-tracked files to the snapshot state. Current untracked and
 * ignored files in the working tree are left untouched (the snapshot never
 * captured them, so discarding them would lose data).
 */
async function restoreTrackedOnly(cwd: string, snapshot: GitSnapshotData): Promise<void> {
	// Verify snapshot objects still exist
	await verifySnapshotObjects(cwd, snapshot);

	// Discard current tracked changes (index + working tree). Untracked/ignored files survive.
	await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd, maxBuffer: MAX_BUFFER });

	// Restore tracked files to snapshot HEAD state (if HEAD differs)
	await checkoutSnapshotHeadIfNeeded(cwd, snapshot);

	// Apply stash to restore the tracked modifications captured at snapshot time
	if (snapshot.stashCommit) {
		await applyStashCommit(cwd, snapshot.stashCommit);
	}
}

/** Verify the snapshot's stash/HEAD objects still exist, throwing on garbage collection. */
async function verifySnapshotObjects(cwd: string, snapshot: GitSnapshotData): Promise<void> {
	if (snapshot.stashCommit && !(await objectExists(cwd, snapshot.stashCommit))) {
		throw new Error("Git snapshot has been garbage collected and is no longer available");
	}
	if (!(await objectExists(cwd, snapshot.head))) {
		throw new Error("Snapshot HEAD commit no longer exists in the repository");
	}
}

/**
 * Restore tracked files to the snapshot HEAD state when the current HEAD differs
 * from the snapshot's HEAD. No-op when they match.
 */
async function checkoutSnapshotHeadIfNeeded(cwd: string, snapshot: GitSnapshotData): Promise<void> {
	const { stdout: currentHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
		cwd,
		maxBuffer: MAX_BUFFER,
	});
	if (currentHead.trim() !== snapshot.head) {
		await execFileAsync("git", ["checkout", snapshot.head, "--", "."], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
	}
}

/** Apply a snapshot stash, wrapping failures with a stable error message. */
async function applyStashCommit(cwd: string, stashCommit: string): Promise<void> {
	try {
		await execFileAsync("git", ["stash", "apply", stashCommit], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to apply git snapshot: ${message}`);
	}
}
