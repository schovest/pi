import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type GitSnapshotData,
	hasUncommittedChanges,
	isGitRepo,
	restoreSnapshot,
	takeSnapshot,
} from "../src/core/git-snapshot.ts";

/** Create a temp git repo with an initial commit. Returns the repo path. */
function createTempGitRepo(): string {
	const dir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	writeFileSync(join(dir, "file.txt"), "initial content");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
	return dir;
}

describe("git-snapshot", () => {
	let repoDir: string;

	beforeEach(() => {
		repoDir = createTempGitRepo();
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
	});

	describe("isGitRepo", () => {
		it("returns true for git repo", async () => {
			expect(await isGitRepo(repoDir)).toBe(true);
		});

		it("returns false for non-git directory", async () => {
			const nonGit = join(tmpdir(), `pi-test-nongit-${Date.now()}`);
			mkdirSync(nonGit, { recursive: true });
			expect(await isGitRepo(nonGit)).toBe(false);
			rmSync(nonGit, { recursive: true, force: true });
		});
	});

	describe("takeSnapshot", () => {
		it("returns clean snapshot when working tree is clean", async () => {
			const snapshot = await takeSnapshot(repoDir);
			expect(snapshot).not.toBeNull();
			expect(snapshot!.clean).toBe(true);
			expect(snapshot!.stashCommit).toBeNull();
			expect(snapshot!.head).toMatch(/^[0-9a-f]{40}$/);
		});

		it("captures uncommitted changes in stashCommit", async () => {
			writeFileSync(join(repoDir, "file.txt"), "modified content");
			const snapshot = await takeSnapshot(repoDir);
			expect(snapshot).not.toBeNull();
			expect(snapshot!.clean).toBe(false);
			expect(snapshot!.stashCommit).not.toBeNull();
			expect(snapshot!.stashCommit).toMatch(/^[0-9a-f]{40}$/);
		});

		it("captures untracked files in stashCommit when combined with tracked modifications", async () => {
			writeFileSync(join(repoDir, "file.txt"), "modified");
			writeFileSync(join(repoDir, "new-file.txt"), "new file");
			const snapshot = await takeSnapshot(repoDir);
			expect(snapshot).not.toBeNull();
			expect(snapshot!.clean).toBe(false);
			expect(snapshot!.stashCommit).not.toBeNull();
		});

		it("captures untracked-only changes (no tracked modifications)", async () => {
			writeFileSync(join(repoDir, "new-file.txt"), "new file");
			const snapshot = await takeSnapshot(repoDir);
			expect(snapshot).not.toBeNull();
			expect(snapshot!.clean).toBe(false);
			expect(snapshot!.stashCommit).not.toBeNull();
			expect(snapshot!.stashCommit).toMatch(/^[0-9a-f]{40}$/);
		});

		it("returns null for non-git directory", async () => {
			const nonGit = join(tmpdir(), `pi-test-nongit-${Date.now()}`);
			mkdirSync(nonGit, { recursive: true });
			expect(await takeSnapshot(nonGit)).toBeNull();
			rmSync(nonGit, { recursive: true, force: true });
		});
	});

	describe("hasUncommittedChanges", () => {
		it("returns false when clean", async () => {
			expect(await hasUncommittedChanges(repoDir)).toBe(false);
		});

		it("returns true when there are modifications", async () => {
			writeFileSync(join(repoDir, "file.txt"), "modified");
			expect(await hasUncommittedChanges(repoDir)).toBe(true);
		});
	});

	describe("restoreSnapshot", () => {
		it("restores tracked file modifications", async () => {
			// Take snapshot of clean state
			const snapshot = await takeSnapshot(repoDir);

			// Make changes
			writeFileSync(join(repoDir, "file.txt"), "changed content");
			expect(await hasUncommittedChanges(repoDir)).toBe(true);

			// Restore
			await restoreSnapshot(repoDir, snapshot!);

			// Verify
			expect(await hasUncommittedChanges(repoDir)).toBe(false);
			expect(readFileSync(join(repoDir, "file.txt"), "utf-8")).toBe("initial content");
		});

		it("restores untracked files", async () => {
			// Add untracked file, take snapshot
			writeFileSync(join(repoDir, "new.txt"), "new content");
			const snapshot = await takeSnapshot(repoDir);

			// Remove it
			unlinkSync(join(repoDir, "new.txt"));

			// Restore
			await restoreSnapshot(repoDir, snapshot!);

			// Verify untracked file is restored
			expect(existsSync(join(repoDir, "new.txt"))).toBe(true);
			expect(readFileSync(join(repoDir, "new.txt"), "utf-8")).toBe("new content");
		});

		it("restores clean snapshot (no stash) to handle dirty working tree", async () => {
			// Get HEAD from clean repo
			const head = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoDir,
			})
				.toString()
				.trim();

			// Make the working tree dirty
			writeFileSync(join(repoDir, "file.txt"), "dirty content");

			// Restore to clean state (no stash)
			const cleanData: GitSnapshotData = { head, stashCommit: null, clean: true };
			await restoreSnapshot(repoDir, cleanData);

			expect(await hasUncommittedChanges(repoDir)).toBe(false);
			expect(readFileSync(join(repoDir, "file.txt"), "utf-8")).toBe("initial content");
		});
	});
});
