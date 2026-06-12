---
name: merge-remote-pi
description: 合并上游 pi-remote 分支新版本到本地 dev 分支的完整指南。在执行上游合并操作时加载此 skill。核心原则：本地开发优先，获取上游新特性的同时不破坏本地变更；矛盾冲突时舍去上游部分并报告。
---

# 合并上游 pi-remote 版本指南

## 核心原则

**本地开发优先。** 合并的目标是在保留所有本地定制的前提下获取上游新特性。任何冲突中，本地代码优先级高于上游代码。无法调和的矛盾，舍去上游部分并向用户报告。

## 前置条件

- 当前在 `dev` 分支
- `pi-remote` 远程已配置且已 fetch
- 工作区干净（无未提交改动，有则先 stash 或提交）

## 合并流程

### Phase 1: 差异分析

1. 找到共同祖先：
   ```bash
   git merge-base dev pi-remote
   ```

2. 统计上游新增提交：
   ```bash
   git log <ancestor>..pi-remote --oneline
   ```

3. 统计本地独有提交：
   ```bash
   git log <ancestor>..dev --oneline
   ```

4. 找出双方都修改的文件（冲突风险文件）：
   ```bash
   git diff --name-only <ancestor>..pi-remote > /tmp/upstream-files.txt
   git diff --name-only <ancestor>..dev > /tmp/local-files.txt
   comm -12 <(sort /tmp/upstream-files.txt) <(sort /tmp/local-files.txt)
   ```

5. 按包分组统计冲突风险，输出分析报告给用户

### Phase 2: 执行合并

1. 提交工作区中任何未提交的改动（如 generated models）

2. 执行合并不自动提交：
   ```bash
   git merge pi-remote --no-commit --no-ff
   ```

3. 列出所有冲突文件：
   ```bash
   git diff --name-only --diff-filter=U
   ```

### Phase 3: 冲突解决

冲突解决按以下优先级和策略处理：

#### 冲突解决优先级

| 优先级 | 规则 | 适用场景 |
|--------|------|----------|
| **P0** | 本地优先 | 本地有实质性功能改动，上游也有改动 → 保留本地，合并上游不冲突部分 |
| **P1** | 上游优先 | 上游新增功能/修复，本地无改动或仅版本号 → 取上游 |
| **P2** | 并集合并 | 双方改动不矛盾（如不同 import、不同方法）→ 两者都保留 |
| **P3** | 舍去上游 | 双方改动根本矛盾，无法共存 → 保留本地，记录到冲突报告 |

#### 按文件类型的处理策略

**自动解决（低风险，取上游）：**

| 文件类型 | 策略 | 后续操作 |
|----------|------|----------|
| `packages/ai/src/models.generated.ts` | 取上游（更完整模型列表） | 后续可按需精简 |
| `packages/ai/src/image-models.generated.ts` | 取上游 | 同上 |
| `package-lock.json` | 取上游 | 合并后重新生成 |
| `npm-shrinkwrap.json` | 取上游 | 合并后重新生成 |
| `examples/` 下 `package.json` / `package-lock.json` | 取上游 | — |
| 各包 `package.json` 版本号 | 取上游版本号 | **Phase 4 改回本地版本号** |

**需要审查的代码冲突（逐文件处理）：**

| 包 | 高风险文件 | 说明 |
|----|-----------|------|
| `coding-agent` | `agent-session.ts`, `main.ts`, `interactive-mode.ts`, `resource-loader.ts`, `package-manager-cli.ts` | 本地有大量功能扩展 |
| `tui` | `tui.ts`, `terminal.ts` | 双方都有实质性改动 |
| `agent` | `compaction.ts` 等 | 本地有 plan 系统等 |
| 根目录 | `AGENTS.md` | 双方都有规则改动，需手工合并 |

**代码冲突解决步骤：**

1. 读取冲突文件，找到 `<<<<<<< HEAD` / `=======` / `>>>>>>> pi-remote` 标记
2. 理解 HEAD（本地）改动意图和 pi-remote（上游）改动意图
3. 按优先级表决定策略
4. 如果是 P2（并集合并），保留双方改动
5. 如果是 P3（舍去上游），保留本地代码，将舍弃的上游改动记录到冲突报告
6. 解决后 `git add <file>`

**冲突报告格式：**

合并完成后，输出冲突报告：

```
## 冲突报告

### 舍弃的上游改动（P3）

| 文件 | 上游改动 | 舍弃原因 |
|------|---------|---------|
| ... | ... | 与本地 XXX 功能矛盾 |

### 并集合并（P2）

| 文件 | 本地改动 | 上游改动 | 合并方式 |
|------|---------|---------|---------|
| ... | ... | ... | 两者共存 |

### 本地优先（P0）

| 文件 | 保留的本地功能 | 上游改动处理 |
|------|--------------|------------|
| ... | ... | 非冲突部分已合入 |
```

### Phase 4: 版本号修正

**版本号不跟上游一致。** 合并后必须改回本地版本线：

1. 确定新版本号（合并后升 minor，如 0.4.1 → 0.5.0）
2. 执行版本升级：
   ```bash
   npm version <new-version> -ws --no-git-tag-version
   node scripts/sync-versions.js
   ```
3. 手动更新 root `package.json` 的 `version` 字段
4. 重新生成 lockfile 和 shrinkwrap：
   ```bash
   npm install --package-lock-only --ignore-scripts
   node scripts/generate-coding-agent-shrinkwrap.mjs
   ```

### Phase 5: 验证

1. 运行完整检查：
   ```bash
   npm run check
   ```
2. 修复所有 errors/warnings（`packages/ai/test/` 的 TS2345 已知错误可忽略）
3. 确认本地定制功能完整性（见 Phase 6）

### Phase 6: 本地完整性审计

合并后必须验证本地定制功能未被破坏：

**审计清单：**

| 包 | 检查项 | 验证方式 |
|----|--------|---------|
| `plugins` | 6 个内置插件完整（mcp/plan/todo/ask-user-question/tps/btw） | 目录结构 + index.ts 导出 + tsgo 编译 |
| `coding-agent` | Plan 系统、subagent 存储/overlay、双击 Esc/Ctrl+D、command palette、项目信任扩展、branch summarization、export HTML | 关键方法/类存在性检查 |
| `tui` | hardware cursor、滚动优化、alternate screen + 鼠标选择、fixed bottom、no-clear-screen 渲染 | 关键字段/方法存在性检查 |
| `agent` | Plan engine、inline subagent storage | import 链完整性 |

**完整性检查方法：**

对每个本地特有功能，在合并后的代码中搜索其关键标识（方法名、字段名、import 路径），确认存在且未被覆盖。

### Phase 7: 提交

1. 暂存所有改动：
   ```bash
   git add -A
   ```

2. 提交合并结果（需要 `PI_ALLOW_LOCKFILE_CHANGE=1`）：
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 git commit -m "merge: pi-remote vX.Y.Z — upstream features into dev

   Upstream changes merged:
   - <上游新特性列表>

   Local changes preserved:
   - <本地定制功能列表>

   Conflicts resolved:
   - <冲突解决摘要>"
   ```

3. 打版本 tag：
    ```bash
    git tag v<local-version>
    ```

### Phase 8: 清理上游 tag

合并会引入上游的 tag（如 `v0.10.0`、`v0.79.1` 等），这些不属于本地版本线，必须清理：

1. 列出本地版本线的 tag（当前为 `v0.x.x`）：
   ```bash
   git tag -l | grep -E "^v0\.[0-5]\.[0-9]$"
   ```

2. 删除所有非本地版本线的 tag：
   ```bash
   # 先确认要保留的 tag 范围，例如保留 v0.0.x ~ v0.5.x
   git tag -l | grep -v -E "^v0\.[0-5]\.[0-9]$" | xargs git tag -d
   ```

3. 验证只保留本地 tag：
   ```bash
   git tag -l
   ```

## 常见陷阱

| 陷阱 | 说明 | 规避 |
|------|------|------|
| 版本号跟随上游 | 上游 0.79.x 与本地 0.x.x 是不同版本线 | 合并后必须改回本地版本号 |
| `models.generated.ts` 方向冲突 | 上游新增模型，本地精简模型 | 取上游完整版，后续按需精简 |
| shrinkwrap 过期 | 合并冲突解决后 shrinkwrap 可能不一致 | 必须重新生成 |
| 上游新增文件本地缺失 | 上游引用了新模块（如 version-check.ts），本地已删除 | 从上游 checkout 这些文件，或移除引用 |
| biome warnings | 合并可能引入未使用变量/无效 suppression | `npx biome check --write --unsafe` 修复 |
| pre-commit hook 阻止 | lockfile 变更/ai test 类型错误触发 hook | `PI_ALLOW_LOCKFILE_CHANGE=1` + `--no-verify`（仅 ai test 错误时） |
| 上游 tag 残留 | 合并后上游 tag 污染本地 tag 命名空间 | 合并后必须清理，只保留本地版本线的 tag |

## 分支规范

- **合并目标分支**: `dev`（不是 `main`）
- **`main` 分支**: 稳定版本，不允许操作
- **上游远程**: `pi-remote`
- **本地功能分支**: `feat/*` 等，通过 worktree 管理
