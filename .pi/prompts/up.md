---
description: 执行版本升级全流程，传参为目标版本号
argument-hint: "<version> e.g. v0.11.1"
---
将项目升级到版本 $1，严格按以下步骤执行。

## 版本号处理

- 目标版本：`$1`
- 去掉 `v` 前缀得到纯版本号（如 `v0.11.1` → `0.11.1`），后续 `<VER>` 代表纯版本号
- 必须在 **dev 分支**上操作；若不在则先 `git checkout dev`

## 执行步骤

全部在 dev 上完成步骤 1-6，然后以 PR 合入 main：

### 1. 升级版本号 + 同步包间依赖 + 更新 lockfile

```bash
npm version <VER> -ws --no-git-tag-version
node scripts/sync-versions.js
npm install --package-lock-only --ignore-scripts
```

### 2. 更新 root package.json

手动将根 `package.json` 的 `version` 字段改为 `<VER>`。

### 3. 更新 shrinkwrap

```bash
node scripts/generate-coding-agent-shrinkwrap.mjs
```

### 4. 更新 CHANGELOG

将 `packages/coding-agent/CHANGELOG.md` 中 `## [Unreleased]` 下的条目移入新版本段落 `## [<VER>] - <YYYY-MM-DD>`，然后清空 `[Unreleased]`。

### 5. 构建并打包（门控测试）

基于所有源文件已到最终状态（版本号、CHANGELOG 等）执行构建测试：

```bash
npm run build:tgz
```

构建失败则中止版本升级，修复 bug 后重新执行全流程；成功才继续提交。产物在 `packages/coding-agent/binaries/`（已被 gitignore，不入库，CI 会自行重建）。

### 6. 在 dev 上提交

用显式路径 stage 变更文件（禁止 git add -A）：

```bash
git add package.json package-lock.json packages/*/package.json packages/coding-agent/examples/extensions/*/package.json packages/coding-agent/examples/extensions/*/package-lock.json packages/coding-agent/npm-shrinkwrap.json packages/coding-agent/CHANGELOG.md
PI_ALLOW_LOCKFILE_CHANGE=1 git commit -m "chore: bump version to <VER>"
```

### 7. 推送 dev 并创建 PR dev → main

```bash
git push -u origin dev
gh pr create --base main --head dev --title "release v<VER>: <变更摘要>" --body "版本升级，见 CHANGELOG"
```

- main 为 GitHub 保护分支，只能 PR 合并，**禁止直接 `git push origin main`**
- 合并方式：**merge commit**（--no-ff 语义），不要 squash/rebase
- 门禁：至少 1 个 review 通过 + CI 全绿，仅维护人可合并
- GitHub 上选择「Create a merge commit」，或 `gh pr merge <PR> --merge`

### 8. 合并后在 main 合并 commit 上打 tag 并 push（触发发布）

push tag 是触发 CI/CD 发布的关键动作，两种方式任选：

```bash
# 方式一：不切分支，直接标记远端 main 合并 commit
git fetch origin main
git tag v<VER> origin/main
git push origin v<VER>

# 方式二：本地 pull main 后打 tag，再切回 dev
git checkout main && git pull origin main && git tag v<VER> && git push origin v<VER> && git checkout dev
```

在 main 合并 commit 上打 tag，不在 dev 上打 tag；tag 推送不受分支保护（除非另设 tag 保护）。

## 注意事项

- 禁止使用 `scripts/release.mjs`
- main 是 GitHub 保护分支：只能 PR 合并（merge commit + review + CI），**禁止直接 `git push origin main`**
- push tag 后 CI/CD 自动构建二进制、创建 Release、发布 npm，无需手动操作
- 每一步执行后检查输出是否成功，失败则停止并报告
- 版本 tag 只打 main 合并 commit（`git tag v<VER> origin/main` 或本地 pull main 后打），不在 dev 上打 tag
