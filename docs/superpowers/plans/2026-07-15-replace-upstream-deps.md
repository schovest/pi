# Replace Upstream ai/agent Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove local `packages/ai` and `packages/agent` packages, replace with upstream npm packages `@earendil-works/pi-ai@0.80.7` and `@earendil-works/pi-agent-core@0.80.7`.

**Architecture:** coding-agent currently depends on `@schovest/pi-ai` and `@schovest/pi-agent-core` (workspace packages that are fork copies of upstream). We delete both packages, install upstream npm packages, and rewire all imports. The upstream `@earendil-works/pi-ai/compat` entry is a superset of the main index (re-exports everything plus streamSimple/completeSimple/findEnvKeys/getEnvApiKey), so all pi-ai imports map to compat. `SubagentRunEntry` (fork-only type in agent-core) moves to coding-agent. `@schovest/pi-tui` stays as a local workspace package.

**Tech Stack:** Node.js monorepo, npm workspaces, TypeScript, Bun binary bundling, jiti extension loading

## Global Constraints

- Upstream version: `@earendil-works/pi-ai@0.80.7` and `@earendil-works/pi-agent-core@0.80.7`
- `@schovest/pi-tui` remains a workspace package (NOT being replaced)
- `@schovest/pi-coding-agent` remains a workspace package (self-reference in loader)
- VIRTUAL_MODULES must keep all three scope aliases (`@schovest/*`, `@mariozechner/*`, `@earendil-works/*`) for extension compat
- Working in worktree `.worktrees/replace-upstream-deps` on branch `feat/replace-upstream-deps`
- After each task, verify with `npx tsgo --noEmit` (fast type check)

---

### Task 1: Update package.json dependencies and workspace config

**Files:**
- Modify: `package.json` (root) — remove nothing from workspaces (glob `packages/*` auto-includes only existing dirs)
- Modify: `packages/coding-agent/package.json` — change dependency names and versions

**Interfaces:**
- Consumes: nothing
- Produces: package.json with `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as dependencies

- [ ] **Step 1: Update coding-agent/package.json dependencies**

Replace these three lines in `packages/coding-agent/package.json` dependencies:

```json
"@schovest/pi-agent-core": "^0.10.2",
"@schovest/pi-ai": "^0.10.2",
"@schovest/pi-tui": "^0.10.2",
```

with:

```json
"@earendil-works/pi-agent-core": "0.80.7",
"@earendil-works/pi-ai": "0.80.7",
"@schovest/pi-tui": "^0.10.2",
```

- [ ] **Step 2: Delete packages/ai and packages/agent**

```bash
rm -rf packages/ai packages/agent
```

- [ ] **Step 3: Update root build script**

In root `package.json`, change the `build` script from:

```
"build": "cd packages/tui && npm run build && cd ../ai && npm run build && cd ../agent && npm run build && cd ../coding-agent && npm run build"
```

to:

```
"build": "cd packages/tui && npm run build && cd ../coding-agent && npm run build"
```

- [ ] **Step 4: npm install to fetch upstream packages**

```bash
npm install --ignore-scripts
```

This installs `@earendil-works/pi-ai@0.80.7` and `@earendil-works/pi-agent-core@0.80.7` from npm registry. The `packages/*` workspace glob will now only match `coding-agent` and `tui`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json packages/coding-agent/package.json
git commit -m "refactor: remove local ai/agent packages, depend on upstream @earendil-works/*"
```

---

### Task 2: Move SubagentRunEntry to coding-agent

**Files:**
- Create: `packages/coding-agent/src/core/types/subagent-entry.ts`
- Modify: `packages/coding-agent/src/core/session-manager.ts` — define local SubagentRunEntry, remove import from agent-core
- Modify: `packages/coding-agent/src/core/subagents/runner.ts` — import from local
- Modify: `packages/coding-agent/src/modes/interactive/components/subagent-details.ts` — import from local

**Interfaces:**
- Consumes: nothing
- Produces: `SubagentRunEntry` interface defined locally in coding-agent

- [ ] **Step 1: Create subagent-entry.ts**

```typescript
// packages/coding-agent/src/core/types/subagent-entry.ts

/**
 * Session tree entry for subagent runs.
 *
 * This type was previously defined in @schovest/pi-agent-core (fork-only addition).
 * Moved to coding-agent so we can use upstream @earendil-works/pi-agent-core directly.
 */
export interface SubagentRunEntry {
	type: "subagent_run";
	id: string;
	parentId: string | null;
	timestamp: string;
	runId: string;
	index: number;
	agent: string;
	task: string;
	title?: string;
	status: "success" | "failed" | "aborted";
	model?: string;
	thinking?: string;
	totalTokens?: number;
	toolCount: number;
	outputSummary?: string;
	error?: string;
}
```

- [ ] **Step 2: Update session-manager.ts import**

In `packages/coding-agent/src/core/session-manager.ts`, change:

```typescript
import { type AgentMessage, type SubagentRunEntry, uuidv7 } from "@schovest/pi-agent-core";
```

to:

```typescript
import { type AgentMessage, uuidv7 } from "@earendil-works/pi-agent-core";
import type { SubagentRunEntry } from "./types/subagent-entry.ts";
```

- [ ] **Step 3: Update subagents/runner.ts import**

Find and change any `SubagentRunEntry` import from `@schovest/pi-agent-core` to the local path.

- [ ] **Step 4: Update subagent-details.ts import**

In `packages/coding-agent/src/modes/interactive/components/subagent-details.ts`, change:

```typescript
import type { SubagentRunEntry } from "@schovest/pi-agent-core";
```

to:

```typescript
import type { SubagentRunEntry } from "../../../core/types/subagent-entry.ts";
```

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/types/subagent-entry.ts \
  packages/coding-agent/src/core/session-manager.ts \
  packages/coding-agent/src/core/subagents/runner.ts \
  packages/coding-agent/src/modes/interactive/components/subagent-details.ts
git commit -m "refactor: move SubagentRunEntry from agent-core to coding-agent"
```

---

### Task 3: Replace all @schovest/pi-* import paths in coding-agent src

**Files:**
- Modify: all `packages/coding-agent/src/**/*.ts` files that import from `@schovest/pi-ai` or `@schovest/pi-agent-core`
- Modify: `packages/coding-agent/examples/extensions/**/*.ts` files with the same imports

**Interfaces:**
- Consumes: upstream npm packages installed in Task 1
- Produces: all imports pointing to `@earendil-works/pi-ai/compat`, `@earendil-works/pi-ai/oauth`, `@earendil-works/pi-ai/bedrock-provider`, `@earendil-works/pi-agent-core`

**Import mapping:**
| Old | New | Notes |
|-----|-----|-------|
| `@schovest/pi-ai` | `@earendil-works/pi-ai/compat` | compat is superset of index |
| `@schovest/pi-ai/oauth` | `@earendil-works/pi-ai/oauth` | separate subpath |
| `@schovest/pi-ai/compat` | `@earendil-works/pi-ai/compat` | already correct subpath |
| `@schovest/pi-ai/bedrock-provider` | `@earendil-works/pi-ai/bedrock-provider` | separate subpath |
| `@schovest/pi-agent-core` | `@earendil-works/pi-agent-core` | direct replacement |
| `@schovest/pi-tui` | `@schovest/pi-tui` | NO CHANGE — stays workspace package |

- [ ] **Step 1: Replace @schovest/pi-ai/oauth → @earendil-works/pi-ai/oauth (do FIRST)**

```bash
cd packages/coding-agent
find src examples -name '*.ts' -exec sed -i 's|@schovest/pi-ai/oauth|@earendil-works/pi-ai/oauth|g' {} +
```

- [ ] **Step 2: Replace @schovest/pi-ai/compat → @earendil-works/pi-ai/compat**

```bash
find src examples -name '*.ts' -exec sed -i 's|@schovest/pi-ai/compat|@earendil-works/pi-ai/compat|g' {} +
```

- [ ] **Step 3: Replace @schovest/pi-ai/bedrock-provider → @earendil-works/pi-ai/bedrock-provider**

```bash
find src examples -name '*.ts' -exec sed -i 's|@schovest/pi-ai/bedrock-provider|@earendil-works/pi-ai/bedrock-provider|g' {} +
```

- [ ] **Step 4: Replace remaining @schovest/pi-ai → @earendil-works/pi-ai/compat**

```bash
find src examples -name '*.ts' -exec sed -i 's|@schovest/pi-ai"|@earendil-works/pi-ai/compat"|g' {} +
```

Note: The `"` ensures we only match the bare `@schovest/pi-ai` (no subpath). The oauth/compat/bedrock subpaths were already replaced in steps 1-3.

- [ ] **Step 5: Replace @schovest/pi-agent-core → @earendil-works/pi-agent-core**

```bash
find src examples -name '*.ts' -exec sed -i 's|@schovest/pi-agent-core|@earendil-works/pi-agent-core|g' {} +
```

- [ ] **Step 6: Verify no @schovest/pi-ai or @schovest/pi-agent-core remain**

```bash
grep -rn '@schovest/pi-ai\|@schovest/pi-agent-core' src/ examples/ | grep -v node_modules
```

Expected: empty output (all replaced). `@schovest/pi-tui` and `@schovest/pi-coding-agent` should remain.

- [ ] **Step 7: Commit**

```bash
cd /data/mine/pi/.worktrees/replace-upstream-deps
git add -A packages/coding-agent/src packages/coding-agent/examples
git commit -m "refactor: replace @schovest/pi-ai → @earendil-works/pi-ai/compat, @schovest/pi-agent-core → @earendil-works/pi-agent-core"
```

---

### Task 4: Update loader.ts VIRTUAL_MODULES and imports

**Files:**
- Modify: `packages/coding-agent/src/core/extensions/loader.ts`

**Interfaces:**
- Consumes: upstream npm packages
- Produces: VIRTUAL_MODULES mapping all three scopes to upstream bundled packages

The loader bundles packages for Bun binary extension loading. It must:
1. Import from upstream packages (not `@schovest/*`)
2. Map all three scopes in VIRTUAL_MODULES so extensions using any scope work

- [ ] **Step 1: Update static imports at top of loader.ts**

Change:
```typescript
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as _bundledPiAi from "@earendil-works/pi-ai/compat";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
```

(The sed in Task 3 already changed these from `@schovest/` to `@earendil-works/`. Verify they're correct. The key change is `_bundledPiAi` must come from `/compat` subpath.)

Verify with:
```bash
grep '_bundledPi' packages/coding-agent/src/core/extensions/loader.ts | head -10
```

- [ ] **Step 2: Update VIRTUAL_MODULES entries**

The VIRTUAL_MODULES object maps scope names to bundled modules. Update the `@schovest/pi-ai` entries to point to the compat import. Verify the current state:

```bash
grep -A2 '@schovest/pi-ai' packages/coding-agent/src/core/extensions/loader.ts
```

The `@schovest/pi-ai` key should map to `_bundledPiAi` (which is now imported from `@earendil-works/pi-ai/compat`). If the sed didn't change the VIRTUAL_MODULES keys (they're object keys, not import paths), update them manually if needed. The VIRTUAL_MODULES should look like:

```typescript
const VIRTUAL_MODULES: Record<string, unknown> = {
    typebox: _bundledTypebox,
    "typebox/compile": _bundledTypeboxCompile,
    "typebox/value": _bundledTypeboxValue,
    "@sinclair/typebox": _bundledTypebox,
    "@sinclair/typebox/compile": _bundledTypeboxCompile,
    "@sinclair/typebox/value": _bundledTypeboxValue,
    "@earendil-works/pi-agent-core": _bundledPiAgentCore,
    "@schovest/pi-tui": _bundledPiTui,
    "@earendil-works/pi-ai/compat": _bundledPiAi,
    "@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
    "@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
    // Legacy scope aliases for extensions that use old import paths
    "@schovest/pi-agent-core": _bundledPiAgentCore,
    "@schovest/pi-ai": _bundledPiAi,
    "@schovest/pi-ai/oauth": _bundledPiAiOauth,
    "@schovest/pi-coding-agent": _bundledPiCodingAgent,
    "@mariozechner/pi-agent-core": _bundledPiAgentCore,
    "@mariozechner/pi-tui": _bundledPiTui,
    "@mariozechner/pi-ai": _bundledPiAi,
    "@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
    "@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
    "@earendil-works/pi-tui": _bundledPiTui,
    "@earendil-works/pi-ai": _bundledPiAi,
    "@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
    "@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
};
```

Key changes:
- `@schovest/pi-ai` → points to `_bundledPiAi` (compat import) — keeps extension compat
- `@schovest/pi-ai/oauth` → points to `_bundledPiAiOauth`
- `@earendil-works/pi-ai` → also points to `_bundledPiAi` (compat, for any extension using upstream scope)

- [ ] **Step 3: Update resolveWorkspaceOrImport calls in loader.ts**

The loader has workspace-specific path resolution like `resolveWorkspaceOrImport("ai/dist/oauth.js", ...)`. Since there's no longer a workspace `ai` package, these will fall through to the npm import. Verify the fallback works or simplify.

Search for workspace path references:
```bash
grep -n 'resolveWorkspaceOrImport\|ai/dist\|agent/dist' packages/coding-agent/src/core/extensions/loader.ts
```

Remove or simplify any workspace path resolution for ai/agent that no longer exists.

- [ ] **Step 4: Update getAliases() function**

The `getAliases()` function in loader.ts builds jiti aliases for Node.js dev mode. Check if it references `packages/ai` or `packages/agent` paths:

```bash
grep -n 'packages/ai\|packages/agent' packages/coding-agent/src/core/extensions/loader.ts
```

If found, remove or update to point to `node_modules/@earendil-works/`.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/extensions/loader.ts
git commit -m "refactor: update loader VIRTUAL_MODULES for upstream package imports"
```

---

### Task 5: Type check and fix errors iteratively

**Files:**
- Various files that may have type mismatches with upstream API

**Interfaces:**
- Consumes: all previous tasks
- Produces: clean type check

- [ ] **Step 1: Run tsgo type check**

```bash
npx tsgo --noEmit 2>&1 | head -80
```

- [ ] **Step 2: Fix errors iteratively**

Common expected issues:
- `StreamFn` type signature difference (fork simplified, upstream explicit) — functionally equivalent, should be fine
- Missing exports that were fork-specific additions — check each error
- `ShellExecOptions` vs `ExecutionEnvExecOptions` — if coding-agent references the old name
- Any type incompatibilities from upstream API changes between 0.80.6 and 0.80.7

For each error:
1. Read the error message
2. Check what the upstream package exports (check `node_modules/@earendil-works/*/dist/*.d.ts`)
3. Fix the import or type annotation
4. Re-run tsgo

- [ ] **Step 3: Run npm run check (full check: biome + tsgo + pinned-deps + ts-imports + shrinkwrap)**

```bash
npm run check 2>&1 | tail -40
```

Note: `check:pinned-deps` and `check:shrinkwrap` may need updates for new dependencies.

- [ ] **Step 4: Fix pinned-deps check if needed**

The `check:pinned-deps` script verifies exact version pinning. New dependencies `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` must be pinned to exact versions (already `0.80.7`).

- [ ] **Step 5: Regenerate shrinkwrap**

```bash
node scripts/generate-coding-agent-shrinkwrap.mjs
```

- [ ] **Step 6: Commit all fixes**

```bash
git add -A
git commit -m "fix: resolve type errors after upstream package switch"
```

---

### Task 6: Update sync-versions.js and AGENTS.md

**Files:**
- Modify: `scripts/sync-versions.js` — remove references to ai/agent workspace packages
- Modify: `docs/specs/architecture.md` — update package dependency graph
- Modify: `AGENTS.md` — update architecture reference index

- [ ] **Step 1: Check sync-versions.js for ai/agent references**

```bash
grep -n 'pi-ai\|pi-agent-core' scripts/sync-versions.js
```

The sync script reads all workspace packages and syncs versions. Since ai/agent are no longer workspace packages, the sync will naturally skip them. But verify no hardcoded references exist.

- [ ] **Step 2: Update architecture.md**

Update the package dependency graph and descriptions to reflect that ai and agent are now external npm dependencies, not workspace packages.

- [ ] **Step 3: Update AGENTS.md**

Update the architecture reference index table in `AGENTS.md` (root) and `packages/coding-agent/docs/` if needed.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-versions.js docs/specs/architecture.md AGENTS.md
git commit -m "docs: update architecture docs for upstream ai/agent dependency"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full build**

```bash
npm run build
```

- [ ] **Step 2: Full check**

```bash
npm run check
```

- [ ] **Step 3: Run targeted tests**

```bash
# coding-agent tests that use agent-core/pi-ai
npx vitest run --dir packages/coding-agent/test extensions
npx vitest run --dir packages/coding-agent/test session
```

- [ ] **Step 4: Report status**

Report: build pass/fail, check pass/fail, test pass/fail. If all green, ready for review.
