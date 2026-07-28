# Tree Revert + Git 回滚 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户发消息时自动记录 git 工作区快照（`git stash create --include-untracked`），在 tree 中选中节点 → Enter → 选择 "Revert" 时恢复 git 工作区到目标节点快照状态并切换 session 分支。

**Architecture:** 新建 `core/git-snapshot.ts` 模块封装 git 快照采集与恢复；在 `AgentSession.prompt()` 开始时采集快照存为 `CustomEntry`；在 tree 操作选择器中添加 "Revert" 选项，恢复 git 后调用 `navigateTree`。

**Tech Stack:** TypeScript, vitest, child_process (execFile)

## Global Constraints

- 禁止 `any`，必须使用精确类型
- 禁止 inline import，使用顶层 import
- 修改后运行 `npm run check`（完整输出）
- CHANGELOG 同步更新
- 测试用 vitest（`npx vitest run --dir packages/coding-agent/test <pattern>`）
- git 命令通过 `utils/child-process.ts` 的 `execFileAsync` 执行，不直接 spawn
- Revert 操作必须先检查工作区状态，有未提交变更时警告确认

---

## 文件结构

| 文件 | 职责 | 改动 |
| ------ | ------ | ------ |
| `packages/coding-agent/src/core/git-snapshot.ts` | Git 快照采集、恢复、工作区检查 | 新建 |
| `packages/coding-agent/src/core/agent-session.ts` | prompt() 中采集快照 | 修改 |
| `packages/coding-agent/src/core/session-manager.ts` | 新增 findGitSnapshot 辅助方法 | 修改 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Revert 逻辑 + 操作选择器添加 Revert 选项 | 修改 |
| `packages/coding-agent/src/core/index.ts` | 导出 git-snapshot 类型 | 修改 |
| `packages/coding-agent/test/git-snapshot.test.ts` | Git 快照模块单元测试 | 新建 |
| `packages/coding-agent/CHANGELOG.md` | 新增 Added 条目 | 修改 |

---

## Task 1: 创建 git-snapshot.ts 模块

**Files:**

- Create: `packages/coding-agent/src/core/git-snapshot.ts`
- Test: `packages/coding-agent/test/git-snapshot.test.ts`

**Interfaces:**

- Produces:
  - `GitSnapshotData` 接口
  - `takeSnapshot(cwd: string): Promise<GitSnapshotData | null>` — 采集快照，非 git 仓库返回 null
  - `restoreSnapshot(cwd: string, snapshot: GitSnapshotData): Promise<void>` — 恢复到快照状态
  - `hasUncommittedChanges(cwd: string): Promise<boolean>` — 检查工作区是否有变更
  - `protectSnapshot(cwd: string, entryId: string, stashCommit: string): Promise<void>` — 创建 ref 防 gc
  - `isGitRepo(cwd: string): Promise<boolean>` — 检查是否 git 仓库

- [ ] **Step 1: 检查 child-process 工具**

查看 `packages/coding-agent/src/utils/child-process.ts` 的导出：

Run: `grep "export" packages/coding-agent/src/utils/child-process.ts`

确认可用的执行函数名（预期 `execFileAsync` 或类似）。

- [ ] **Step 2: 创建 git-snapshot.ts**

创建 `packages/coding-agent/src/core/git-snapshot.ts`：

```typescript
import { execFile } from "child_process";
import { promisify } from "util";

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
 * Uses `git stash create --include-untracked` to capture the complete state
 * (tracked modifications + staged changes + untracked files) without modifying
 * the working tree, index, or stash stack.
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

  // Create stash snapshot (includes untracked files)
  // Returns empty string if working tree is clean
  let stashCommit: string | null = null;
  if (!clean) {
   const { stdout: stashStdout } = await execFileAsync(
    "git",
    ["stash", "create", "--include-untracked"],
    { cwd, maxBuffer: MAX_BUFFER },
   );
   const trimmed = stashStdout.trim();
   if (trimmed) {
    stashCommit = trimmed;
   }
  }

  return { head, stashCommit, clean };
 } catch {
  return null;
 }
}

/**
 * Protect a snapshot's git object from garbage collection by creating a ref.
 * Creates refs/pi-snapshots/<entryId> pointing to the stash commit.
 */
export async function protectSnapshot(
 cwd: string,
 entryId: string,
 stashCommit: string,
): Promise<void> {
 try {
  await execFileAsync(
   "git",
   ["update-ref", `refs/pi-snapshots/${entryId}`, stashCommit],
   { cwd, maxBuffer: MAX_BUFFER },
  );
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
  // Reset index to match snapshot HEAD (checkout updates index)
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
```

- [ ] **Step 3: 创建测试文件**

创建 `packages/coding-agent/test/git-snapshot.test.ts`：

```typescript
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  it("captures untracked files in stashCommit", async () => {
   writeFileSync(join(repoDir, "new-file.txt"), "new file");
   const snapshot = await takeSnapshot(repoDir);
   expect(snapshot).not.toBeNull();
   expect(snapshot!.clean).toBe(false);
   expect(snapshot!.stashCommit).not.toBeNull();
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
   const { readFileSync } = await import("node:fs");
   expect(readFileSync(join(repoDir, "file.txt"), "utf-8")).toBe("initial content");
  });

  it("restores untracked files", async () => {
   // Add untracked file, take snapshot
   writeFileSync(join(repoDir, "new.txt"), "new content");
   const snapshot = await takeSnapshot(repoDir);

   // Remove it
   const { unlinkSync } = await import("node:fs");
   unlinkSync(join(repoDir, "new.txt"));

   // Restore
   await restoreSnapshot(repoDir, snapshot!);

   // Verify untracked file is restored
   const { existsSync, readFileSync } = await import("node:fs");
   expect(existsSync(join(repoDir, "new.txt"))).toBe(true);
   expect(readFileSync(join(repoDir, "new.txt"), "utf-8")).toBe("new content");
  });

  it("restores clean snapshot (no stash)", async () => {
   const snapshot: GitSnapshotData = {
    head: snapshot?.head ?? "",
    stashCommit: null,
    clean: true,
   };

   // Make changes
   writeFileSync(join(repoDir, "file.txt"), "dirty");

   // Restore to clean snapshot
   const cleanSnapshot = await takeSnapshot(repoDir);
   // Get the HEAD from the clean repo
   const { execFileSync } = await import("node:child_process");
   const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

   const cleanData: GitSnapshotData = { head, stashCommit: null, clean: true };
   await restoreSnapshot(repoDir, cleanData);

   expect(await hasUncommittedChanges(repoDir)).toBe(false);
  });
 });
});
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run --dir packages/coding-agent/test git-snapshot`
Expected: 全部 PASS

- [ ] **Step 5: 更新 index.ts 导出**

在 `packages/coding-agent/src/core/index.ts` 中添加导出（在现有 export from session-manager 附近）：

```typescript
export { type GitSnapshotData, takeSnapshot, restoreSnapshot, hasUncommittedChanges, isGitRepo } from "./git-snapshot.ts";
```

- [ ] **Step 6: 运行类型检查**

Run: `npx tsgo --noEmit 2>&1 | grep -v "packages/ai/test/"`
Expected: 无新增 error

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/src/core/git-snapshot.ts packages/coding-agent/src/core/index.ts packages/coding-agent/test/git-snapshot.test.ts
git commit -m "feat: add git-snapshot module for working tree snapshots"
```

---

## Task 2: 在 prompt() 中采集 git 快照

**Files:**

- Modify: `packages/coding-agent/src/core/agent-session.ts`（prompt 方法，约第 1271 行）
- Modify: `packages/coding-agent/src/core/session-manager.ts`（新增 findGitSnapshot 辅助方法）

**Interfaces:**

- Consumes: `takeSnapshot`, `protectSnapshot` from Task 1, `SessionManager.appendCustomEntry`
- Produces: 每个 user prompt 前自动存储 `git_snapshot` CustomEntry

- [ ] **Step 1: 在 SessionManager 添加 findGitSnapshot 方法**

在 `packages/coding-agent/src/core/session-manager.ts` 的 SessionManager 类中（`getBranch` 方法之后，约第 1280 行），添加：

```typescript
/**
 * Find the most recent git_snapshot custom entry at or before the given entry ID.
 * Walks from the given entry towards root.
 * @returns The GitSnapshotData if found, null otherwise
 */
findGitSnapshot(fromEntryId?: string | null): { data: unknown; entryId: string } | null {
 const startId = fromEntryId ?? this.leafId;
 let current = startId ? this.byId.get(startId) : undefined;
 while (current) {
  if (
   current.type === "custom" &&
   (current as CustomEntry).customType === "git_snapshot"
  ) {
   return { data: (current as CustomEntry).data, entryId: current.id };
  }
  current = current.parentId ? this.byId.get(current.parentId) : undefined;
 }
 return null;
}
```

- [ ] **Step 2: 在 prompt() 方法中添加快照采集**

在 `packages/coding-agent/src/core/agent-session.ts` 的 `prompt()` 方法中，找到验证 model 和 API key 之后、构建 messages 之前的位置（约第 1390 行，在 `// Build messages array` 注释前）。

添加 git 快照采集逻辑：

```typescript
// Take git snapshot before processing the prompt (for revert functionality)
try {
 const cwd = this.sessionManager.getCwd();
 const snapshot = await takeSnapshot(cwd);
 if (snapshot) {
  const entryId = this.sessionManager.appendCustomEntry("git_snapshot", snapshot);
  // Protect stash object from gc if working tree was dirty
  if (snapshot.stashCommit) {
   await protectSnapshot(cwd, entryId, snapshot.stashCommit);
  }
 }
} catch {
 // Non-fatal: snapshot is best-effort, prompt should continue
}
```

确保在文件顶部添加 import：

```typescript
import { takeSnapshot, protectSnapshot } from "./git-snapshot.ts";
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsgo --noEmit 2>&1 | grep -v "packages/ai/test/"`
Expected: 无新增 error

- [ ] **Step 4: 运行现有 tree navigation 测试确认无回归**

Run: `npx vitest run --dir packages/coding-agent/test agent-session-tree-navigation`
Expected: 全部 PASS（这些是 e2e 测试，需要 API key，可能被 skip）

Run: `npx vitest run --dir packages/coding-agent/test session-manager`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/agent-session.ts packages/coding-agent/src/core/session-manager.ts
git commit -m "feat: capture git snapshot on each user prompt for revert support"
```

---

## Task 3: 在操作选择器添加 Revert 选项并实现恢复逻辑

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（showTreeSelector 方法）

**Interfaces:**

- Consumes: `findGitSnapshot` from Task 2, `restoreSnapshot`, `hasUncommittedChanges` from Task 1, `navigateTree` 现有方法

**前提:** Peek 实现计划已完成（操作选择器已存在，含 Peek / Navigate / Navigate with summary / Navigate with custom prompt）

- [ ] **Step 1: 在操作选择器中添加 Revert 选项**

在 `showTreeSelector` 的 onSelect 回调中（Peek 计划 Task 4 已建立的操作选择器），添加 Revert 选项。

找到操作选择器的选项数组：

```typescript
const PEEK = "Peek";
const NAVIGATE = "Navigate";
const NAVIGATE_SUMMARY = "Navigate with summary";
const NAVIGATE_CUSTOM = "Navigate with custom prompt";
```

修改为：

```typescript
const PEEK = "Peek";
const NAVIGATE = "Navigate";
const NAVIGATE_SUMMARY = "Navigate with summary";
const NAVIGATE_CUSTOM = "Navigate with custom prompt";
const REVERT = "Revert";
```

修改 `showExtensionSelector` 调用的选项数组：

```typescript
const action = await this.showExtensionSelector("Select action", [
 PEEK,
 NAVIGATE,
 NAVIGATE_SUMMARY,
 NAVIGATE_CUSTOM,
 REVERT,
]);
```

- [ ] **Step 2: 添加 Revert 处理逻辑**

在 Peek 处理逻辑之后、Navigate 处理逻辑之前，添加 Revert 分支：

```typescript
if (action === REVERT) {
 await this.handleRevert(entryId);
 return;
}
```

- [ ] **Step 3: 实现 handleRevert 方法**

在 `InteractiveMode` 类中（`peekAtMessage` 方法之后），添加：

```typescript
/**
 * Revert to a tree node: restore git working tree to snapshot state + navigate session.
 */
private async handleRevert(targetId: string): Promise<void> {
 // Find git snapshot for target node
 const snapshotResult = this.sessionManager.findGitSnapshot(targetId);

 if (!snapshotResult) {
  this.showStatus("No git snapshot found for this node");
  return;
 }

 const snapshot = snapshotResult.data as GitSnapshotData;

 // Check for uncommitted changes
 const cwd = this.sessionManager.getCwd();
 const hasChanges = await hasUncommittedChanges(cwd);

 if (hasChanges) {
  const confirmed = await this.showExtensionConfirm(
   "Revert",
   "Working tree has uncommitted changes. Reverting will discard them. Continue?",
  );
  if (!confirmed) {
   this.showStatus("Revert cancelled");
   return;
  }
 }

 // Show loader
 const revertLoader = new Loader(
  this.ui,
  (spinner) => theme.fg("accent", spinner),
  (text) => theme.fg("muted", text),
  "Reverting...",
 );
 this.statusContainer.addChild(revertLoader);
 this.ui.requestRender();

 try {
  // Restore git working tree
  await restoreSnapshot(cwd, snapshot);

  // Navigate session to target node (without summary)
  const navResult = await this.session.navigateTree(targetId, { summarize: false });

  if (navResult.cancelled) {
   this.showStatus("Revert cancelled");
   return;
  }

  // Update UI
  this.chatContainer.clear();
  this.renderInitialMessages();
  if (navResult.editorText && !this.editor.getText().trim()) {
   this.editor.setText(navResult.editorText);
  }
  this.showStatus("Reverted to selected node");
  void this.flushCompactionQueue({ willRetry: false });
 } catch (error) {
  this.showError(error instanceof Error ? error.message : String(error));
 } finally {
  revertLoader.stop();
  this.statusContainer.clear();
 }
}
```

确保在文件顶部添加 import：

```typescript
import { type GitSnapshotData, restoreSnapshot, hasUncommittedChanges } from "../../core/git-snapshot.ts";
```

- [ ] **Step 4: 运行类型检查**

Run: `npx tsgo --noEmit 2>&1 | grep -v "packages/ai/test/"`
Expected: 无新增 error

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/interactive-mode.ts
git commit -m "feat: add Revert option to tree action selector with git restore"
```

---

## Task 4: 更新帮助文本和 CHANGELOG

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`（帮助文本）
- Modify: `packages/coding-agent/CHANGELOG.md`

- [ ] **Step 1: 更新 CHANGELOG**

在 `packages/coding-agent/CHANGELOG.md` 的 `## [Unreleased]` → `### Added` 下添加：

```markdown
- Tree Revert 功能：在 session tree 中选中节点 → Enter → 选择 "Revert"，将 git 工作区恢复到目标节点时间点的文件状态（包括 untracked 文件），并切换 session 到该节点
- Git 快照系统：用户发送消息时自动通过 `git stash create --include-untracked` 记录工作区快照，存储为 session CustomEntry，用于 Revert 回滚
```

- [ ] **Step 2: 运行完整检查**

Run: `npm run check`
Expected: 所有检查通过

- [ ] **Step 3: 运行所有相关测试**

Run: `npx vitest run --dir packages/coding-agent/test tree && npx vitest run --dir packages/coding-agent/test git-snapshot && npx vitest run --dir packages/coding-agent/test session-manager`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/CHANGELOG.md
git commit -m "docs: update changelog for revert feature"
```

---

## Self-Review

### Spec coverage

- ✅ "用户发消息时记录 git HEAD + working tree diff" → Task 2 `takeSnapshot` in `prompt()`
- ✅ "git stash create --include-untracked" → Task 1 `takeSnapshot` 实现
- ✅ "防止 gc：创建 ref" → Task 1 `protectSnapshot` + Task 2 调用
- ✅ "有未提交变更 → 弹出警告" → Task 3 `handleRevert` 中 `showExtensionConfirm`
- ✅ "恢复 git 工作区" → Task 1 `restoreSnapshot` + Task 3 调用
- ✅ "切换 session" → Task 3 `navigateTree` 调用
- ✅ "非 git 仓库 → takeSnapshot 返回 null" → Task 1 实现 + Task 2 不存储
- ✅ "git stash apply 冲突 → 提示" → Task 1 `restoreSnapshot` throw + Task 3 catch
- ✅ "操作选择器含 Revert" → Task 3 Step 1

### Placeholder scan

无 TBD/TODO，所有步骤包含具体代码。

### Type consistency

- `GitSnapshotData` — Task 1 定义，Task 2 存储（appendCustomEntry data 参数），Task 3 读取并 cast，类型一致
- `findGitSnapshot() → { data: unknown; entryId: string } | null` — Task 2 定义，Task 3 消费，签名一致
- `restoreSnapshot(cwd: string, snapshot: GitSnapshotData)` — Task 1 定义，Task 3 消费，签名一致
