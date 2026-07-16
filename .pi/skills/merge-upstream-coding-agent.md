---
name: merge-upstream-coding-agent
description: Checklist for merging upstream pi coding-agent and tui source changes into the fork. Covers identifying missing commits, categorizing by status, handling fork-specific differences (import paths, deleted workspace packages), and selective application.
---

# Merging Upstream coding-agent/tui Changes

Fork depends on upstream `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as npm packages (no local `packages/ai/` or `packages/agent/`). coding-agent and tui source is maintained locally. This skill covers syncing local source with upstream.

## 1. Identify Version Gap

```bash
# Current upstream npm dependency version
grep "pi-agent-core\|pi-ai" packages/coding-agent/package.json | head -3

# All upstream commits since the local base version (oldest first)
cd /data/mine/earendil-works-pi
git log --reverse --oneline --no-merges v<BASE>..HEAD -- packages/coding-agent/src/ packages/coding-agent/test/
git log --reverse --oneline --no-merges v<BASE>..HEAD -- packages/tui/src/ packages/tui/test/
```

## 2. Categorize Each Commit (APPLIED / PARTIAL / MISSING)

For each upstream commit, extract distinctive added lines (not imports/braces/comments) and grep the local source:

```bash
# Extract 3 signature lines from each commit diff
diff_added=$(git show "$hash" -- packages/coding-agent/src/ --format="" \
  | grep '^+' | grep -v '^+++' \
  | grep -vE '^\+\s*$|^\+\s*//|^\+\s*\*|^\+\s*import |^\+\s*\}|^\+\s*\{|^\+\s*\]|^\+\s*\)' \
  | sed 's/^+//' | awk '{if(length($0)>25) print}' | head -3)

# Check each against local
for sig in $diff_added; do
  grep -rqF "$sig" /data/mine/pi/packages/coding-agent/src/ /data/mine/pi/packages/coding-agent/test/ && echo "FOUND"
done
```

Classification:
- **APPLIED** (≥67% signatures found): Skip.
- **PARTIAL** (33–66%): Diff locally to find what's missing. Often test files or minor branches are incomplete.
- **MISSING** (<33%): Full merge needed.
- **N/A**: Commits touching only `packages/ai/` or `packages/agent/` — handled by npm package, skip.

## 3. Handle Fork-Specific Differences

When applying upstream diffs, these will differ:

### Import paths
- Upstream: `@earendil-works/pi-tui`, `@mariozechner/pi-tui`
- Local: `@schovest/pi-tui`
- Upstream: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`
- Local: same (already migrated)
- Normalize mentally when reading diffs; local code already has correct paths.

### Deleted workspace packages
- Upstream `loader.ts` uses `resolveWorkspaceOrImport("agent/dist/index.js", ...)` — workspace path exists.
- Local has no `packages/agent/` — falls through to npm resolution.
- Local `resolveModuleEntry()` handles vitest SSR fallback where `import.meta.resolve` is unavailable.

### Fork-only features (DO NOT remove during merge)
- `packages/coding-agent/src/core/background-process-manager.ts`
- `packages/coding-agent/src/core/claude-plugin-manager.ts`
- `packages/coding-agent/src/core/command-palette/`
- `packages/coding-agent/src/core/primary-agents/`
- `packages/coding-agent/src/core/subagents/`
- `packages/coding-agent/src/core/tool-matcher.ts`
- `packages/coding-agent/src/utils/self-update.ts`
- Various `modes/interactive/components/` fork-specific components

## 4. Merge Workflow (Per Commit)

1. **Read the upstream diff**: `git show <hash> -- packages/coding-agent/src/ packages/coding-agent/test/ --format=""`.
2. **Check if source already applied**: grep for key function/variable names in local source.
3. **Apply source changes**: Edit local files. Match local style (tabs, import paths).
4. **Copy test files**: If upstream adds new test files, copy verbatim (import paths are already `@earendil-works/*`).
5. **Update existing tests**: If upstream modifies test assertions, apply the same changes locally.
6. **Type check**: `npx tsgo --noEmit 2>&1 | grep -v "packages/ai/test/"`.
7. **Run affected tests**: `npx vitest run --dir packages/coding-agent/test <pattern>`.
8. **Commit**: One commit per upstream commit (or grouped for tightly coupled commits). Message format: `fix: <upstream description> (upstream <hash>)`.

## 5. Decision Framework — What to Skip

| Category | Skip? | Reason |
|----------|-------|--------|
| `packages/ai/` or `packages/agent/` only | ✅ Skip | Handled by npm dependency |
| Pure UI/TUI rendering (tui.ts, editor, markdown) | ✅ Skip | Fork rewrote TUI engine |
| Self-update / package-manager-cli | ✅ Skip | Fork has own update flow |
| Theme system (`d0b46764` automatic theme mode) | ✅ Skip | Large UI change |
| Added+Reverted pairs (net zero) | ✅ Skip | No-op |
| agent-session core logic | ❌ Merge | Correctness critical |
| Extensions system | ❌ Merge | Compatibility critical |
| Model resolver / registry | ❌ Merge | Provider support |
| Compaction | ❌ Merge | Correctness critical |
| Bash/tool safety | Review case-by-case | |

## 6. After All Commits Merged

```bash
# Full test suite
npm test 2>&1 | grep -E "(Test Files|Tests |FAIL )"

# Full check
npm run check

# Build
npm run build

# Binary (from packages/coding-agent, skip deleted workspace deps)
cd packages/coding-agent
bun build --compile ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile dist/pi
```

## 7. Build Notes

- `build:binary` script references deleted `../ai` and `../agent` — run Bun compile manually.
- `npm run build` (tsgo + copy-assets) produces Node-runnable dist but lacks binary-specific assets.
- Binary assets (`copy-binary-assets` script) include: extensions, primary-agents, install.sh, docs, examples, photon WASM.

## 8. CHANGELOG

Each merged commit should add a `### Fixed` / `### Changed` entry under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`, referencing the upstream commit hash.
