# 自定义 Agents 开发规则

本仓库基于上游(`https://github.com/earendil-works/pi`) release `v0.81.1` 的 Pi 开发自己的 agents、工具链和发行版。默认目标不是维护上游 `pi`，而是在保留 Pi 核心能力的基础上，构建通用agent，包括编程和其他功能。

## 项目目标

将 Pi 作为 agent 平台底座，而非原版 CLI。扩展优先级：

1. **可安装扩展** — 通过 `pi install` 按需安装，核心扩展在 `packages/coding-agent/dist-assets/install.sh` 中提供
2. **Skills/Prompt Templates** — `.pi/skills/`、`.pi/prompts/`，项目级或用户级
3. **MCP Server** — 通过内置 MCP 插件桥接，默认 proxy 模式控制上下文占用
4. **配置层** — settings.json、keybindings、themes

优先使用成熟生态包；只在不满足二进制内置、权限、安全或体验要求时才本地集成或 vendor。
二进制发行应自带关键能力，避免首次运行依赖网络安装。
新增能力时必须明确它属于哪一层。

## 架构参考索引

详细架构文档见 [`docs/architecture.md`](docs/architecture.md)，以下为摘要索引。**更新 `docs/architecture.md` 时须同步更新本索引。**

| 章节 | 文件 | 摘要 |
| ------ | ------ | ------ |
| 包依赖关系 | `docs/architecture.md#包依赖关系` | coding-agent → agent + tui → ai |
| 各包职责 | `docs/architecture.md#各包职责` | agent/ai/tui/coding-agent 四包职责与关键导出 |
| 核心数据流 | `docs/architecture.md#核心数据流` | 一次 prompt 的完整调用链：Mode → AgentSession → Agent → runAgentLoop → streamSimple → Provider → EventStream |
| Agent 抽象层 | `docs/architecture.md#agent-抽象层` | 低层 agentLoop → 中层 Agent → 应用层 AgentSession；AgentHarness 为独立抽象，不在主调用链 |
| 扩展点与能力归属 | `docs/architecture.md#扩展点与能力归属` | 17 类能力的归属位置、配置方式和关键约束 |
| 关键路径入口 | `docs/architecture.md#关键路径入口` | 14 个功能模块的入口文件和调用链（含 ModelRuntime 认证运行时） |

## 交流风格

- 用中文进行回复，要求：短、直接、技术化
- 反馈分析时先明确"同意"或"不同意"，再说明改动
- 不默认按上游贡献流程处理；除非用户明确要求，不创建上游 issue/PR/release

## 代码质量

- 大范围修改前必须完整阅读相关文件，不只依赖搜索片段
- 禁止 `any`，除非无可行类型表达；必须局部化并说明原因
- 禁止 inline import（`await import()`、`import("pkg").Type`）；使用顶层 import
- 禁止 erasable syntax 违规（参数属性、`enum`、`namespace`/`module`、`import =`、`export =`）
- 不通过删除或降级功能修复类型错误；依赖过旧时优先升级
- 外部 API 类型以 `node_modules` 或官方文档为准，不猜测
- 不硬编码快捷键；默认快捷键放入 `keybindings` 配置
- 不手改 `packages/ai/src/models.generated.ts` ,`image-models.generated.ts`；这是编译自动生成的
- 删除内容前需充分考量是否会影响其他功能，如果有影响需要向用户汇报，得到批准以后进行。
- 不为兼容旧行为保留复杂分支，除非用户要求
- **每次变更完毕后必须自查 `packages/coding-agent/docs/` 是否需要更新**：对照变更内容逐项检查 docs 下各文件，确认文档与代码一致；不需要更新时也须明确说明"已自查，docs 无需更新"，禁止跳过此步。

## 开发规范

### 检查与测试

- 代码改动后运行 `npm run check`（完整输出，不 tail），修复所有 errors/warnings/infos
- 文档或纯说明文件改动通常不需要跑 check
- 完成测试命令 `npm test > /tmp/pi-test.txt`（不要直接控制台输出）
- 修改测试文件后必须运行对应测试并迭代到通过
- 临时脚本写到 `/tmp`，运行后删除

#### 类型检查

```bash
# 完整类型检查（包含 biome + pinned-deps + ts-imports + shrinkwrap + tsgo）
npm run check

# 仅 TypeScript 类型检查（更快，跳过 lint/shrinkwrap）
npx tsgo --noEmit

# 排除已知错误（packages/ai/test/ 有预存的模型类型错误，与业务无关）
npx tsgo --noEmit 2>&1 | grep -v "packages/ai/test/"
```

#### 单元测试

```bash
# 项目根目录运行（Node 原生 test runner，适用于使用 node:test 的测试文件）
node --test packages/<pkg>/test/specific.test.ts

# 项目根目录运行（vitest，适用于使用 vitest 断言的测试文件）
# 必须用 --dir 限定搜索目录，避免 vitest 扫描到 .worktrees/ 中的旧测试
npx vitest run --dir packages/<pkg>/test <pattern>
# 示例：运行 subagents 相关测试
npx vitest run --dir packages/coding-agent/test subagents
# 示例：运行 agent-loop 测试
npx vitest run --dir packages/agent/test agent-loop

# 注意：不要从子包目录直接调用 vitest CLI，路径解析会出错。
# 以下命令**不可用**：
#   cd packages/tui && node ../../node_modules/vitest/dist/cli.js --run test/foo.ts  ❌
# 不要直接传文件路径，会触发全目录扫描（包括 .worktrees/）：
#   npx vitest run packages/tui/test/foo.ts  ❌
# 必须用 --dir 限定 + pattern 匹配：
#   npx vitest run --dir packages/tui/test foo  ✅
```

**判断用哪种 runner**：

| 包 | Runner | 命令 | 断言风格 |
| --- | --- | --- | --- |
| **tui** | `node:test` | `node --test test/*.test.ts`（从包目录） | `import assert from "node:assert"` |
| **agent** | vitest | `npx vitest run --dir packages/agent/test <pattern>` | `import { describe, expect, it } from "vitest"` |
| **ai** | vitest | `npx vitest run --dir packages/ai/test <pattern>` | `import { describe, expect, it } from "vitest"` |
| **coding-agent** | vitest | `npx vitest run --dir packages/coding-agent/test <pattern>` | `import { describe, expect, it } from "vitest"` |

- 测试文件 `import { describe, it } from "node:test"` → `node --test`（仅 tui）
- 测试文件 `import { describe, it } from "vitest"` 或使用 `expect()` → `npx vitest run --dir`（agent/ai/coding-agent）
- **禁止混用**：tui 测试只用 `node:test` + `node:assert`，其他包只用 vitest；新增测试文件须遵循所属包的 runner

**vitest 扫描问题**：

- vitest 默认 `include` 模式为 `**/*.{test,spec}.{ts,tsx,...}`，从项目根递归扫描
- `.worktrees/` 下的旧分支代码会被一并发现，导致加载失败或运行错误
- `--dir` 将搜索根限定到指定目录，彻底避免此问题

### 依赖安全

- npm 依赖和 lockfile 变更视为代码变更，需审查；直接外部依赖固定精确版本
- 安装/更新：`npm install --ignore-scripts`
- 干净安装：`npm ci --ignore-scripts`
- 仅刷新 lockfile：`npm install --package-lock-only --ignore-scripts`
- 不运行 lifecycle scripts，除非用户明确要求
- 新依赖带 lifecycle scripts 时需显式审查并更新 allowlist
- `coding-agent/npm-shrinkwrap.json` 更新：`node scripts/generate-coding-agent-shrinkwrap.mjs`
- shrinkwrap 生成必须保留 bundled internal workspace 语义

### Git

- 只提交当前会话修改的文件；用显式路径 stage（`git add path1 path2`）
- 禁止 `git add -A`、`git add .`、`git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git commit --no-verify`
- 提交前 `git status` 确认只 stage 自己的文件
- 提交前必须检查 `docs/superpowers/` 下是否有未跟踪的文件，有则一并提交，避免遗漏设计文档
- **功能/修复 commit 必须同步更新 `packages/coding-agent/CHANGELOG.md`**：在 `## [Unreleased]` 下新增对应条目，与代码改动同 commit 提交，不要等到版本升级时才补写
- 只解决自己修改过的文件里的冲突；冲突在他人文件时停止并询问
- 不 force push
- **升级版本必须打 tag**
- **严禁添加 upstream 类远程仓库**（如 upstream-temp），严禁 fetch 上游仓库的 tag。只在 origin (schovest/pi) 上管理版本标签
- **严禁批量删除/重建标签**，标签操作限定为版本升级时在 main 上打新版本 tag

#### 分支策略

- `dev`：日常开发分支，自由提交
- `main`：保护分支，dev 上的改动经 `npm run check` 通过并完成相关测试后可合并，不限于版本升级
- 合并使用 `--no-ff`，merge commit message 填写变更摘要
- 版本 tag 打在 main 的 merge commit 上，不在 dev 上打 tag

### 构建与测试

#### 构建

- Node dist：`npm run build`
- Bun 单文件二进制：从 `packages/coding-agent` 运行 `npm run build:binary`
- 打包为可发行文件：从项目根目录运行 `npm run build:tgz`（调用 `scripts/build-binaries.sh`）

#### 测试

- 进行全部测试用例测试：项目根目录运行 `npm test`
- TUI 测试用受控 tmux 会话
- `packages/coding-agent/test/suite/` 用 `harness.ts` + faux provider，不调真实 provider

### CI/CD 流程

项目有两个核心 GitHub Actions workflow，位于 `.github/workflows/`：

#### CI（ci.yml）— 持续集成

- **触发**：push 到 `main`、或 PR 到 `main`
- **内容**：安装依赖 → `npm run build` → `npm run check`（biome + pinned-deps + ts-imports + shrinkwrap + tsgo + browser-smoke）→ `npm test`
- **作用**：保护 `main` 分支，确保所有合并的代码通过构建、检查和测试
- **并发控制**：同一分支的新 push 会取消旧的运行（`cancel-in-progress`）

#### Build Binaries（build-binaries.yml）— 发布构建

- **触发**：push `v*` tag，或手动 `workflow_dispatch`
- **build job**：checkout tag → `scripts/build-binaries.sh` 构建 6 平台二进制 → 生成 `sha256sums.txt` → 从 CHANGELOG 提取 release notes → 创建 GitHub Release 并上传所有资产
- **publish-npm job**：依赖 build job 完成 → checkout tag → 构建 → check → test → 验证源文件无变更 → 发布 npm 包（trusted publishing）
- **环境**：npm 发布使用 `npm-publish` environment（需审批）

#### 版本发布与 CI 的关系

执行 `/up` prompt 最后 push tag (`git push origin vx.y.z`) 触发 `build-binaries.yml`，CI 自动完成全部发布工作：

1. **构建二进制**：checkout tag → `scripts/build-binaries.sh` 构建 6 平台二进制 → 生成 `sha256sums.txt`
2. **创建 GitHub Release**：从 CHANGELOG 提取 release notes → 创建 Release 并上传所有资产
3. **发布 npm**：构建 → check → test → 验证源文件无变更 → 发布 npm 包（trusted publishing，需审批）
4. **不需要手动创建 release**，push tag 后等待 CI 完成即可
5. 如需重新触发（如 CI 失败），可用 `workflow_dispatch` 手动指定 tag 重新运行
6. 手动构建可在本地运行 `npm run build:tgz`，但发布必须通过 CI

### Changelog

- **每个功能/修复 commit 都必须同步写 CHANGELOG 条目**，放入 `## [Unreleased]` 下对应分类（`### Added` / `### Changed` / `### Fixed` / `### Removed`），与代码改动在同一个 commit 中提交。禁止先提交代码再补写 CHANGELOG。
- 不修改已发布版本段落的内容
- **版本升级时**：将 `[Unreleased]` 下的条目移入新版本段落（如 `## [0.8.1] - 2026-07-09`），然后清空 `[Unreleased]`。这是 `/up` prompt 执行流程的一部分。
- CHANGELOG 条目按 `### Added` / `### Changed` / `### Fixed` / `### Removed` 分类，每条一行简述
- 纯文档、重构、CI 等不影响用户行为的改动可不写 CHANGELOG

## 更新覆盖

项目中发生变更与 `AGENTS.md` 不一致的可对 `AGENTS.md` 修改，但需要主动告知用户变更内容

### 架构文档索引同步

更新 `docs/architecture.md` 时，须同步更新本文件中「架构参考索引」的摘要列，确保索引与实际内容一致。新增章节须在索引表中新增对应行；删除章节须移除对应行；章节内容变更须更新摘要描述。

## 用户覆盖

用户明确要求与本文件冲突时，先说明冲突点并请求确认。用户确认后按用户要求执行。
