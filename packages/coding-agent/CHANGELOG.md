# Changelog

## [Unreleased]

### Added

- Primary agent 支持 `skills` 字段：通过 glob 模式按需过滤可用 skills。不配置则使用全部 skills（默认行为），显式空数组则禁用 skills，配置模式则只启用匹配的 skills。Primary agent 的 skills 过滤仅影响主会话系统提示词，不影响 subagent

## [0.11.3] - 2026-07-17

### Added

- `sudo-helper` 扩展：当 agent 通过 bash 工具执行 sudo 命令时，弹出遮罩密码输入框，通过 SUDO_ASKPASS + FIFO（/dev/shm tmpfs）安全注入密码。密码全程不落盘、不传 agent、不在 ps 中可见，XOR 动态加密存储，用完即毁

### Changed

- install.sh 已安装检测：重复运行 install.sh 时自动跳过核心二进制/资源拷贝，仅触发扩展和 Agent 选择安装
- install.sh 扩展候选新增 sudo-helper（file:sudo-helper.ts，默认不勾选）
- install.sh 扩展候选新增 pi-hermes-memory（npm:pi-hermes-memory，默认不勾选）：持久记忆与自驱动学习循环

### Fixed

- TUI 卡顿修复：thinking 流式渲染引入 Markdown token 级增量缓存，消除每个 streaming token 触发的全量 markdown 重解析（lexer + wrapTextWithAnsi）；`AssistantMessageComponent.updateContent` 复用 thinking Markdown 实例，通过 `appendText()` 保留渲染缓存，将单帧渲染成本从 O(总文本) 降到 O(最后一个 token)
- `sudo-helper` 假死修复：SecureBuffer 重构时遗漏 `writer.stdin.end()` 调用，导致 cat 进程不关闭 FIFO 写端，askpass 的 cat FIFO 永远收不到 EOF，sudo 无限等待 askpass 返回
- `sudo-helper` 鼠标滚轮误触关闭修复：`handleInput` 逐字符检测 `\x1b` 导致箭头键转义序列（`\x1b[A`，鼠标滚轮转义）被误判为 Escape 键。改用 `matchesKey()` 精确匹配，仅独立 Escape / Ctrl+C / Ctrl+D 触发取消

## [0.11.2] - 2026-07-16

### Changed

- install.sh 扩展和 Agent 拆分为两步独立选择：先选扩展（9 项，默认 4 项），再选 Primary Agent（plan/coding/config，全默认勾选）
- 新增 `plan.md` primary agent 到 dist-assets，coding.md 移除 `thinking` frontmatter 参数
- 扩展候选新增 superpowers、pi-plugin-manager、pi-lens

### Removed

- install.sh 移除 fd 下载逻辑（pi 已内置 fd 安装）

### Fixed

- pi-lens `no-case-declarations` 误报：项目级规则覆盖修复嵌套 `inside` 缺 `stopBy: end`，case 块已有花括号时不再误报嵌套 if 块内的 const 声明为 error
- footer 分支显示不动态更新：agent 执行 bash 命令或外部 shell 切换分支后底栏分支标签不刷新（fs.watch 原子写事件过滤遗漏 + FooterComponent.invalidate() 为 no-op 未清除缓存）

## [0.11.1] - 2026-07-16

### Fixed

- `loader.ts` 模块解析：新增 `resolveModuleEntry` fallback，修复 vitest SSR 环境下 `import.meta.resolve` 不可用导致 59 个扩展相关测试失败
- `agent-session-retry-events` 测试断言对齐上游 `agent_settled` 事件
- 内置 `/plugins` 命令重命名为 `/claude-plugin`（CLI: `pi claude-plugin`），避免与 pi-plugin-manager 扩展的 `/plugins` 命令冲突

### Changed

- `Shift+Tab` 从循环切换思考强度改为循环切换 primary agent；思考强度切换通过命令面板访问

## [0.11.0] - 2026-07-16

### Changed

- **移除本地 ai/agent 包，改用上游 npm 依赖**：`@earendil-works/pi-ai@0.80.6` 和 `@earendil-works/pi-agent-core@0.80.6`，减少 ~86k 行维护代码
- **Extension API 与上游完全对齐**：补回 `session_info_changed`、`before_provider_headers`、`agent_settled` 事件和 `registerEntryRenderer` API 方法
- **agent-session 行为对齐上游**：compaction 携带 `env`、overflow zero-usage 兜底、`content ?? []` 归一化、`isIdle/isStreaming` 改用 `_isAgentRunActive`、`getSessionStats` 遍历所有 session entries 等
- **`convertToLlm` 从 ExtensionAPI 移除**：上游从未暴露，扩展通过 SDK import 使用即可
- **`SubagentRunEntry` 类型外提至 coding-agent**：不再侵入 agent 包
- extensions.md 文档补全新增事件和 API，packages.md 更新包引用

### Removed

- `packages/ai` 和 `packages/agent` 两个工作区包全部删除
- `PlanEngine` / `Plan` 死代码移除
- `InlineExtension` 类型（上游新增，fork 未使用）

## [0.10.2] - 2026-07-15

### Changed

- 版本升级流程简化：`npm run version:<level>` 一步完成版本号升级、包间依赖同步、lockfile 更新
- 示例扩展版本号同步至 0.10.2

## [0.10.1] - 2026-07-15

### Changed

- 后台命令完成通知从 followUp 队列改为 steer 队列，确保 agent 更及时收到通知
- `update.sh` 不再随安装包落地（从 dist-assets 移除），`pi self-update` 始终从 GitHub 拉取最新 update.sh 执行

### Fixed

- 安装脚本支持交互式选择安装目录（空白默认 `~/.local/share/pi`），并持久化到 `~/.pi/agent/.install-prefix`
- 升级时正确检测并安装到用户自定义的安装目录（配置文件 → 符号链接 → 默认值三级回退），不再强制使用默认路径
- `pi self-update --force` 现在正确跳过版本检查（通过 `PI_FORCE_UPDATE=1` 传递给 update.sh）

## [0.10.0] - 2026-07-15

### Added

- 上游合并 0.79.2~Unreleased: 108 项修复/功能 (架构迁移至 api/+providers/ 分离模式)
  - 新模型: Claude Sonnet 5/Fable 5, GPT-5.5/5.6, GLM-5.2 等
  - Provider 架构: api/ + providers/ factory 模式
  - 新增 RPC 命令: get_entries, get_tree
  - Compaction: post-compaction token 估算, 空守卫, custom messages budget
  - Session: 子树排序, 无效文件拒绝, --no-session --session-id
  - Tools: fuzzy edit, WSL bash stdin, find/fd 层级 gitignore
  - Stability: Windows context 文件发现, 多 provider retry 修复

### Changed

- pi-ai 根入口精简 (~50行), compat.ts 提供旧 API 兼容
- models.generated.ts: 18k行单体 → 聚合 re-export
- overflow recovery: 多重重试改为单次重试，匹配上游

### Fixed

- 0.79.2~0.79.7: 24 项修复 (已有本地等价实现确认)
- compilation: 源码零错误 (tsgo --noEmit)
- 测试适配: compaction/session 行为变更同步更新测试

## [0.9.2] - 2026-07-10

### Fixed

- update.sh 更新模式不再用默认扩展集覆盖用户配置：通过 `PI_INSTALL_MODE=update` 环境变量显式通知 install.sh 跳过扩展安装，保留用户首次安装时的自定义选择
- install.sh 现在将 install.sh 和 update.sh 复制到安装目录（`~/.local/share/pi/`），用户可随时重新运行 install.sh 调整扩展选择
- install.sh 复制列表增加 `primary-agents` 目录，确保从安装目录重新运行时 agent 类型扩展（config、coding）能找到源文件

## [0.9.1] - 2026-07-10

### Fixed

- `pi update`、`pi install`、`pi remove`、`pi list`、`pi plugins`、`pi self-update` 等子命令完成后进程不退出（缺少 `process.exit(0)` 导致 event loop 残留 handle 挂起）

## [0.9.0] - 2026-07-10

### Added

- 新增 `pi self-update` CLI 命令和 `/self-update` TUI 斜杠命令，用于升级 pi 本身（Bun 二进制安装运行 update.sh，包管理器安装沿用 npm 路径）

### Changed

- 上游版本自动检测目标从 `pi.dev/api/latest-version` 改为 GitHub `schovest/pi` releases（网页重定向优先 + API 回退）
- 移除 `pi update --self`，升级 pi 只使用 `pi self-update`

### Fixed

- update.sh 全新安装时通过 `/dev/tty` 连接控制终端，确保 `curl|bash` 管道下也能弹出组件选择菜单
- update.sh 更新模式跳过组件选择菜单，避免每次更新重选扩展

## [0.8.1] - 2026-07-09

### Changed

- update.sh 获取最新 release 版本号改为优先使用 GitHub 网页重定向（无速率限制），API 作为回退方案
- install.sh 的 fd 下载同样改为网页重定向优先 + API 回退
- tools-manager.ts 的 fd/ripgrep 版本获取改为网页重定向优先 + API 回退，避免匿名用户触发 GitHub API 60 次/小时速率限制

## [0.8.0] - 2026-07-07

### Changed

- 默认键位调整：`shift+enter` 从换行（`tui.input.newLine`）移至 followUp 队列（`app.message.followUp`）。换行键改为 `ctrl+j` 和 `alt+enter`；followUp 队列键为 `shift+enter` 和 `ctrl+enter`

## [0.7.5] - 2026-07-07

### Added

- 新增 update.sh 脚本：从 GitHub 下载最新 release、验证 sha256、自动安装/更新 pi，已安装且为最新版本时自动跳过
- CI（build-binaries.yml）在发布时生成 sha256sums.txt 校验文件并上传到 release
- README Quick Start 新增一键安装命令（release binary 方式，无需 Node.js）

### Changed

- release archive 打包时同步包含 update.sh 脚本

### Fixed

- config agent（primary-agent）文档查询路径从 `~/.pi/agent/docs/` 改为 `~/.local/share/pi/docs/`

### Removed

- 删除不再需要的 debug subagent

## [0.7.4] - 2026-07-06

## [0.7.3] - 2026-07-06

## [0.7.2] - 2026-07-06

### Changed

- 统一二进制打包流程到 scripts/build-binaries.sh，移除 coding-agent/scripts/pack-tgz.mjs

## [0.7.1] - 2026-07-05

### Added

- 命令后台运行：bash 命令超时后自动转入后台运行，新增 `Ctrl+Down` 管理后台进程，进程结束后自动通知 agent
- 新增 settings 配置项 `bashBackgroundTimeout`（默认 120 秒），控制命令转后台的超时阈值
- footer 显示后台进程运行计数和快捷键提示 `bg:N(ctrl+down)`

### Changed

- 更新生成模型元数据（API 切换、定价）

### Fixed

- 后台进程完成通知在 agent 空闲时无法触发：agent streaming 时放入 followUpQueue，agent 空闲时直接调用 prompt()

## [0.7.0] - 2026-07-04

### Added

- Alt+Enter 在编辑器中插入换行，followUp 改为 Ctrl+Enter

### Changed

- npm scope 从 @earendil-works 迁移到 @schovest，仓库 URL 统一为 github.com/schovest/pi

## [0.6.5] - 2026-06-26

### Fixed

- 修复鼠标滚动触发 Editor Up/Down 键历史导航的问题（stdin-buffer 消除鼠标 SGR 序列双重投递 + 50ms 滚轮后方向键抑制）
- 修复 subagent overlay 显示历史条目时内容错误
- 修复 @ 文件搜索空查询时未按深度排序

### Changed

- 更新生成模型元数据（API 切换、定价）
- 明确各包测试 runner 对照表，禁止 tui 与其他包混用

## [0.6.4] - 2026-06-26

### Fixed

- 修复 @ 文件搜索优先显示深层文件而非当前目录文件的问题，回退 find.ts 深度排序

## [0.6.3] - 2026-06-25

### Added

- subagent 定义支持 `skills` 字段，使用 glob 模式匹配技能

## [0.6.2] - 2026-06-25

### Added

- Agent 循环守卫（loop guards）：三级策略（repeated-tool-calls / malformed-response / overflow），通过 `models.json` resilience 字段配置
- `models.json` schema 扩展 resilience 和 guard 字段
- `AgentLoopConfig` 新增 guard 相关字段，`agent_end` 事件新增 `stopReason`
- `GuardTriggeredEvent` 类型及 action 语义

### Fixed

- 修复 backoff 抖动和上限、retry off-by-one、overflow 多重恢复
- 修复 `maxRetries` 默认值覆盖 SDK 默认行为（移除 `?? 0`）
- 修复 overlay 关闭后残留 renderedOverlayLayouts 导致渲染异常
- subagent 工具调用前缀从 `--` 改为 `>`

### Changed

- 架构参考迁移到 `docs/specs/architecture.md`，修正核心数据流调用链
- AGENTS.md 更新为索引摘要表

## [0.6.1] - 2026-06-23

### Changed

- 更新文档以反映 v0.6.0 后的代码库现状
- 取消跟踪 dist/install.sh（已由 .gitignore 覆盖）

## [0.6.0] - 2026-06-23

基于上游 Pi 0.79.1 fork 的首个独立版本。主要本地变更：

### Added

- **Glob 工具匹配** — subagent 的 `includedTools`/`excludedTools` 支持 glob 模式（minimatch）
- **Primary agent 持久化** — 会话创建时恢复持久化的 primary agent，footer 始终以 accent 高亮显示
- **primaryAgentPrompt** — 在 SYSTEM.md 自定义 prompt 前注入
- **install.sh 扩展菜单** — 交互式安装时选择 context-mode 插件
- **merge-remote-pi skill** — 上游合并指南
- **首次设置流程** — `PI_EXPERIMENTAL=1` 下可选主题和遥测
- **项目信任设置** — `defaultProjectTrust` 全局设置
- **Prompt template 参数默认值** — `${1:-7}` 语法
- **Autocomplete trigger characters** — 扩展可声明触发字符
- **实验性功能守卫** — `areExperimentalFeaturesEnabled`
- **Subagent title 字段** — 任务识别
- **双击 Esc/Ctrl+D 确认** — 流式输出中需双击才能中断/退出
- **CSI 序列支持** — Alt+Up/Down，Ctrl+Up 出队

### Fixed

- 修复 CJK 文本编辑器换行（字符边界 + grapheme 边界）
- 修复 IME 硬件光标默认启用（steady bar）
- 修复 overlay 选择高亮和 copy 包含侧边栏
- 修复 subagent chain mode 作用域不匹配和未捕获错误
- 修复 PageUp/PageDown 使用实际可滚动视口高度
- 修复 OAuth 登录 prompt 行不稳定
- 修复 `/reload` 同步 queue modes
- 修复 `models.json` 无效语法时的迁移处理
- 修复 `--help`/`--version` 重定向输出
- 修复 shell-quote 安全漏洞（GHSA-w7jw-789q-3m8p）
- 修复 auto-scroll 提交消息后不滚到底部
- 修复 copy-on-select 选中空白时误触发
- 修复 prompt history 浏览后恢复草稿
- 修复 Amazon Bedrock inference profile ARN 区域解析
- 修复 Azure GPT-5.4/5.5 context window 和 GPT-5 Pro maxTokens
- 修复 Claude Fable 5 thinking-off 和 metadata
- 修复 OpenCode completions maxTokens
- 修复 Moonshot thinking-off
- 修复 Azure OpenAI response storage
- 修复 z.ai thinking payload
- 修复 loose list 项间空行

### Changed

- 移除内置插件（builtin plugins），改为可安装扩展
- 打包归档嵌套在 `pi-x.x.x/` 目录下
- 移除 pack-tgz 中的 fd 下载
