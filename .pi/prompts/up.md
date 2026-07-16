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

全部在 dev 上完成步骤 1-6，然后 merge 到 main：

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

### 4. 构建并打包 tgz

```bash
npm run build:tgz
```

### 5. 更新 CHANGELOG

将 `packages/coding-agent/CHANGELOG.md` 中 `## [Unreleased]` 下的条目移入新版本段落 `## [<VER>] - <YYYY-MM-DD>`，然后清空 `[Unreleased]`。

### 6. 在 dev 上提交

用显式路径 stage 变更文件（禁止 git add -A）：

```bash
git add package.json package-lock.json packages/*/package.json packages/coding-agent/npm-shrinkwrap.json packages/coding-agent/CHANGELOG.md
git add packages/coding-agent/*.tgz  # build:tgz 产物
PI_ALLOW_LOCKFILE_CHANGE=1 git commit -m "chore: bump version to <VER>"
```

### 7. 切到 main，merge dev

```bash
git checkout main
git merge dev --no-ff -m "release v<VER>: <变更摘要>"
```

### 8. 在 main 上打 tag

```bash
git tag v<VER>
```

### 9. push main + tag

push tag 是触发 CI/CD 发布的关键动作：

```bash
git push origin main
git push origin v<VER>
```

### 10. 切回 dev

```bash
git checkout dev
```

## 注意事项

- 禁止使用 `scripts/release.mjs`
- push tag 后 CI/CD 自动构建二进制、创建 Release、发布 npm，无需手动操作
- 每一步执行后检查输出是否成功，失败则停止并报告
