import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Git snapshot data stored in session CustomEntry. */
export interface GitSnapshotData {
	/** HEAD commit hash at snapshot time */
	head: string;
	/** git stash create --include-untracked result. null if working tree was clean. */
	stashCommit: string | null;
	/** Whether the working tree was clean (no staged/unstaged/untracked changes) */
	clean: boolean;
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
 * Uses `git stash push --include-untracked` to capture the complete state
 * (tracked modifications + staged changes + untracked files), then immediately
 * `git stash pop` to restore the working tree. This creates a proper 3-parent
 * stash commit that preserves untracked files.
 *
 * @returns GitSnapshotData, or null if not a git repository
 */
export async function takeSnapshot(cwd: string): Promise<GitSnapshotData | null> {
	if (!(await isGitRepo(cwd))) {
		return null;
	}

	try {
		// Get current HEAD
		const { stdout: headStdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
		const head = headStdout.trim();

		// Check if working tree is clean
		const { stdout: statusStdout } = await execFileAsync("git", ["status", "--porcelain"], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
		const clean = statusStdout.trim().length === 0;

		if (clean) {
			return { head, stashCommit: null, clean: true };
		}

		// Push stash to capture complete working tree state (including untracked)
		// git stash push creates a 3-parent commit (HEAD, index, untracked) which
		// preserves untracked files properly, unlike git stash create.
		await execFileAsync("git", ["stash", "push", "--include-untracked", "-m", "pi-snapshot"], {
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

		return { head, stashCommit, clean: false };
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
 * Creates refs/pi-snapshots/<entryId> pointing to the stash commit.
 */
export async function protectSnapshot(cwd: string, entryId: string, stashCommit: string): Promise<void> {
	try {
		await execFileAsync("git", ["update-ref", `refs/pi-snapshots/${entryId}`, stashCommit], {
			cwd,
			maxBuffer: MAX_BUFFER,
		});
	} catch {
		// Non-fatal: snapshot will still work within gc grace period (default 2 weeks)
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
	// Step 1: Verify snapshot objects still exist
	if (snapshot.stashCommit && !(await objectExists(cwd, snapshot.stashCommit))) {
		throw new Error("Git snapshot has been garbage collected and is no longer available");
	}
	if (!(await objectExists(cwd, snapshot.head))) {
		throw new Error("Snapshot HEAD commit no longer exists in the repository");
	}

	// Step 2: Discard all current working tree changes
	await execFileAsync("git", ["checkout", "--", "."], { cwd, maxBuffer: MAX_BUFFER });
	// Remove untracked files
	await execFileAsync("git", ["clean", "-fd"], { cwd, maxBuffer: MAX_BUFFER });
	// Reset staged changes
	await execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd, maxBuffer: MAX_BUFFER });

	// Step 3: Restore tracked files to snapshot HEAD state (if HEAD differs)
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

	// Step 4: Apply stash to restore working tree modifications + untracked files
	if (snapshot.stashCommit) {
		try {
			await execFileAsync("git", ["stash", "apply", snapshot.stashCommit], {
				cwd,
				maxBuffer: MAX_BUFFER,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to apply git snapshot: ${message}`);
		}
	}
}
