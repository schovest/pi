# Changelog

## [Unreleased]

### Added

- 滚动底部提示：用户不在消息底部（向上滚动过）时，在 working 行上方**居中**显示 `↓ 新消息` 提示行，回到底部自动消失（纯显示，无交互）

## [0.13.3] - 2026-08-07

### Added

- 输入编辑器 prompt 前缀：输入区首行固定显示绿色 `>`，输入以 `!` 开头进入命令行模式时变为绿色 `$`；换行/滚动后的所有行保留同宽空白对齐（tui `Editor.setPromptPrefix`，扩展自定义编辑器可选实现 `EditorComponent.setPromptPrefix`）

### Fixed

- TUI 鼠标选择复制还原逻辑文本（通性）：复制任意内容（markdown 消息、thinking、工具调用、普通文本等）不再携带渲染多余空格——行首 padding/代码块缩进等渲染前缀与行尾填充空格一律剥离（代码块原有内容缩进保留）；长行 wrap 产生的显示换行在复制时合并回逻辑行（不产生 `\n`），符合终端复制习惯；无渲染元数据的组件行与 overlay 覆盖区域统一剥离行尾填充空格，粘贴进 bash/heredoc 不再因行尾空格失效

### Changed

- 安装脚本（`install.sh`）默认扩展源切换：`@juicesharp/rpiv-todo`/`rpiv-ask-user-question`/`rpiv-btw` 改为 `@schovest/pi-todo`/`pi-ask-user-question`/`pi-btw`

## [0.13.2] - 2026-08-04

### Fixed

- 会话改名事件统一：`session_info_changed` 事件新增 `sessionFile` 字段（标识发生改名的会话，可选、向后兼容）；picker（Ctrl+R）对任意会话改名后也发出该事件（此前不发），扩展可凭 `sessionFile` 区分目标会话；picker 改名当前会话时走 `setSessionName` 统一路径（更新 live 会话内存态与 `.meta`，标题/状态栏即时同步、事件名与 `getSessionName()` 一致，后续 append 不回退 meta）——`/name`、`pi.setSessionName()`、picker 改名三条路径行为一致
- 会话列表（`--resume`/`/resume` 选择器）性能优化：`buildSessionInfo` 只扫描每个会话文件的头部（前 100 行），标题与最后活动时间优先取伴生元数据文件（`<会话文件>.meta`，pi 写入会话时同步维护 size/lastActivityMs/name），不再全量读取/解析整个会话文件，也不做尾部扫描——含 200MB 大文件的列表构建从 ~1.4s 降至 ~25ms（约 55x）；picker 搜索改为只匹配会话标题（name/firstMessage）与元数据，不再索引消息内容；meta 缺失/过期（size 不一致，如外部修改或写失败）时自动回退头部扫描，modified 用文件 mtime（append-only 下 mtime = 最后写入时刻），不会产生错误结果；meta 中的空名（清除）与最新重命名随写入同步维护（含首条 assistant 之前的未落盘改名，flush 时不丢失），列表展示与 `getSessionName()` 语义一致；删除会话时 meta 一并删除
- Session resume 性能优化（几百 MB 会话文件）：`buildSessionContext` 批量 materialize 路径上全部 lazy 占位（单 fd 按 offset 顺序读回，替代逐条 open/read/close），`materialize` 用 `entryIndex`（id→下标 Map）替换 O(N) `findIndex`，`buildSessionContext`/`getBranch` 的 `path.unshift` 改为 push+reverse，`SessionManager.open` 复用预读 entries 避免大文件二次全量读取——200MB 会话 resume 从 ~30s 降至 ~3s

## [0.13.1] - 2026-08-03

### Added

- codex 插件兼容：CLI `codex-plugin` 子命令族（`marketplace add/list/remove`、`search [--marketplace]`、`install/list/remove/update`（`-l/--local`）、`hooks list/disable/enable`），install 成功后打印 hooks 摘要（每事件一行 `hooks: <event> <command>`，无 hooks 打印 `hooks: none`）
- codex 插件兼容：`CodexPluginManager` 管理类（市场别名 add/remove/list/search、安装 local/git/npm 来源、hooks/commands 物化（`${PLUGIN_ROOT}`/`${PLUGIN_DATA}` 等替换为绝对路径）、MCP 注册进 mcp.json（`<plugin>-` 前缀）、skills 资源收集（`origin: "codex-plugin"`）），支持用户级 `agentDir/codex-plugins` 与项目级 `.pi/codex-plugins` 存储
- codex 插件兼容：marketplace/manifest/hooks 解析层（`readCodexMarketplaceCatalog` / `readCodexPluginManifest` / `normalizeCodexHooks` / `normalizeCodexHookEventName` / `parseCodexInstallSpec`），支持新格式 `.codex-plugin/plugin.json` 与旧格式根 `plugin.json`，`CodexEventName` 新增 `turn_start`
- codex 插件兼容：内置 hooks 桥接（`core/codex-hooks-bridge.ts`）：12 个 codex 事件映射到 Pi 事件（`session_start`/`session_end`/`user_prompt_submit`/`pre_tool_use`/`permission_request`/`post_tool_use`/`pre_compact`/`post_compact`/`subagent_start`/`subagent_stop`/`stop`/`turn_start`），`additionalContext` 经 `before_agent_start` 注入 systemPrompt；子进程协议（无 args 走 `sh -c` 完整命令行、有 args 走 spawn 数组、stdin JSON、exit 2=block、超时默认 30s 且 `session_end` 3s、注入 `PLUGIN_ROOT`/`PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` env）；注册 `/codex:<plugin>:<command>` 斜杠命令；插件来源经 `CodexPluginManager.listConfiguredPlugins()` 实时读取（disable 即时生效）
- codex 插件兼容：resource-loader 集成——已启用 codex 插件的 skills 自动纳入技能资源解析（metadata `origin: "codex-plugin"`，诊断以 warning 合并进技能诊断），构造器内置注入 codex hooks 桥接 inline factory（随每次扩展加载/reload 注册，不依赖可选安装）
- codex 插件兼容：交互式管理命令 `/codex-plugin`（斜杠命令打开插件管理器：搜索市场/安装/卸载/更新/市场管理，与 `/claude-plugin` 对称，组件 `CodexPluginManagerComponent`）
- codex 插件兼容：内置默认市场源 `openai`（`https://github.com/openai/plugins`，OpenAI 官方 catalog），未配置市场时 `search`/`install <plugin>@openai` 直接可用；用户同名 `marketplace add` 覆盖默认、`marketplace remove` 仅移除自定义覆盖（内置默认不可删，`marketplace list` 带 `(default)` 标记）；`readCodexMarketplaceCatalog` 支持 `.agents/plugins/marketplace.json` 目录回退（适配官方仓库布局）
- claude 插件兼容：内置默认市场源 `claude-plugins-official`（`https://github.com/anthropics/claude-plugins-official`，Anthropic 官方 catalog，catalog 在仓库 `.claude-plugin/marketplace.json` 与解析器直接匹配），未配置市场时 `search`/`install <plugin>@claude-plugins-official` 直接可用；用户同名 `marketplace add` 覆盖默认、`marketplace remove` 仅移除自定义覆盖（内置默认不可删，`marketplace list` 带 `(default)` 标记）

### Changed

- claude 插件兼容：settings 字段语义化重命名——`pluginMarketplaces` → `claudePluginMarketplaces`、`plugins` → `claudePlugins`（类型 `InstalledPluginSettings` → `InstalledClaudePluginSettings`），与 `codexPluginMarketplaces`/`codexPlugins` 命名对称；`migrateSettings` 自动迁移旧字段到新字段（旧字段存在且新字段为空时搬移并清理，新字段优先）
- codex 插件兼容：hooks 桥接从可选 dist-assets 扩展（`install.sh` 的 `file:codex-hooks.ts`）改为内置核心代码，随二进制始终生效；`install.sh` 移除 codex-hooks 安装选项并在升级时自动删除旧扩展残留，防止与内置双份注册 hooks/斜杠命令
- git snapshot 新增 `tracked-only` 模式（默认）：只记录/回滚 git 跟踪的文件，untracked 文件不捕获、revert 时也保留不动（不再执行 `clean -fd`）；`gitSnapshotMode` 三值共存 `tracked-only` / `include-untracked` / `all`，默认从 `include-untracked` 改为 `tracked-only`（snapshot 记录带 `mode` 字段，旧记录按 `include-untracked` 兼容）

### Fixed

- claude/codex 插件兼容：`searchMarketplaces` 单源失败不再中断整个搜索——失败市场（clone/读取 catalog 报错）聚合成 `failures` 跳过并继续，其余源结果正常返回；CLI 以黄色警告输出被跳过的市场，交互组件在状态栏提示（返回结构改为 `{ results, failures }`）
- codex 插件兼容：npm 来源安装修复（`npm pack` 加 `--ignore-scripts` 不跑 lifecycle，`tar -xzf` 在临时目录 cwd 内解包）；git-subdir 来源插件的子目录 `path` 持久化到 settings（`InstalledCodexPluginSettings` 新增 `path` 字段），`update()` 可恢复子目录重新物化
- codex 插件兼容：hooks 子进程 stdin/stdout/stderr 流挂 error 监听，快速退出的 hook（如 `sh -c 'exit 2'`）写 stdin 触发 EPIPE 不再崩溃整个进程
- codex 插件兼容：`InstalledCodexPluginSettings` 新增 `installedPath` 字段（install/update 时持久化物化根目录），git/npm 来源插件的 hooks 执行时可定位插件根并注入 `PLUGIN_ROOT` env（此前仅本地绝对路径 source 生效）
- codex 插件兼容：新格式 manifest 未声明 `hooks` 字段时回退加载默认 `hooks/hooks.json`（此前默认 hooks 静默丢失；显式声明的非空 hooks 仍优先，不被覆盖）
- codex 插件兼容：`stopContinued` 仅在真实用户输入（`input` 事件 `source !== "extension"`）时重置，扩展注入的继续消息不再击穿 stop 防递归（`stop_hook_active` 第二轮起对 hook 可见为 true，避免确定性 block 的 stop hook 造成无界继续循环）

## [0.13.0] - 2026-08-02

### Added

- subagent 工具卡片主界面显示 worker assistant 文字（按 task 分组：每个 task 的 heading+工具+worker 文字紧邻，每个 task 头部用 `DynamicBorder` 整行横线分隔（含首个 task））：运行中显示 outputSummary 摘要，完成后折叠显示最后回复、展开显示完整 assistant 文字过程（Markdown 渲染，从 `SubagentTaskResult.messages` 提取）
- subagent 卡片每个 task heading 序号前加 🚀 标识，多 task 时更易区分
- Session resume 性能优化：`loadEntriesFromFile` 两阶段加载，compaction 前的 message 行懒加载为 `LazyEntry` 占位（`materialize` 按需读回），避免大 tool 输出行全量 parse 阻塞 resume
- Compaction entry 新增 `cumulativeUsage` 字段（`appendCompaction` 写入截至 compaction 的全部 usage 累计）：resume 后 footer 以最后一个 compaction 的 `cumulativeUsage` 作基线累加其后条目，compaction 前被 lazy 占位跳过的大行用量不再缺失（`computeFooterUsage` 抽为可测纯函数，无 `cumulativeUsage` 时退化为线性累加）

### Changed

- 复制选区时向下自动滚动改为仅在指针拖到 footer 区域底部（终端底行）时触发：整个 footer（输入框等固定底部）成为死区，避免选区刚到 footer 上方就意外滚走（无 footer 时行为不变）
- subagent 卡片工具行（heading/工具调用/输出摘要/错误）改用 `TruncatedText` 按窗口宽度截断，移除固定 80 字符截断：长命令/路径在窄终端单行 `…` 截断而非换行撑高卡片
- `/running-subagents` 面板懒加载：`updateSubagentDetails` 只在 overlay 打开时 `loadSubagentRunEntries` 加载历史，`pi --resume` 遍历历史时不再为每个 subagent 结果重读历史（overlay/panel 未开时仅缓存 `latestSubagentDetails`）
- 懒加载去 64KB 阈值（v3）：`loadEntriesFromFile` 对非 header/compaction 行一律 peek 元数据（不再按大小判断），compaction 前全部行（含小行）懒加载为 `LazyEntry` 占位；compaction 后 / 无 compaction 的行仍 full parse（零回归）。移除 `LAZY_ENTRY_THRESHOLD` 常量
- 恢复 chatbox 渲染 `[compaction]` summary 块：`addMessageToChat` 渲染 compaction summary 消息，compaction 完成后向 chatbox 追加 `[compaction]` 摘要（summary 是当前上下文的总结，非 compaction 前原始消息；LLM 上下文不变）
- tree materialize-on-view：tree 查看/复制/搜索 lazy 条目时经注入的 `materialize` 回调恢复完整内容（`[lazy message]` 占位仅在无回调时兜底），compaction 前历史可在 tree 中完整回顾

### Fixed

- git snapshot 跨会话总数限制：`gitSnapshotMaxCount` 现限制同一 cwd 下所有 session 的 snapshot 总数（而非每个 session 独立上限）。snapshot 改存 cwd 级全局索引 `snapshots.jsonl`（跨 session 共享），全局索引写操作经 lockfile 串行化防并发丢失；git ref 改用 full UUID（`refs/pi-snapshots/<refId>`）根除跨 session ref 冲突；session tree 保留 refId 锦点（revert 兼容迁移前的旧格式数据）；启动时批量迁移旧 in-tree 条目（失败不中断启动）。移除已无生产调用的 `countCustomEntries`/`trimOldestCustomEntries`
- LazyEntry 占位条目导致的 `.message` 解引用崩溃：`buildSessionContext` / `_persist` / `createBranchedSession` 对无 `.message` 的 message 条目增加 optional chaining guard
- LazyEntry 全量重写丢内容：`_rewriteFile` / `_persist` 首次 flush 分支 / `forkFrom` 对 lazy 条目原样写回磁盘 raw 而非 `JSON.stringify` 占位；`createBranchedSession` 切换 sessionFile 前先 materialize lazy 条目
- 全仓剩余 `.message` 解引用点 lazy guard：`sessionEntryToContextMessages` / compaction（`findCutPoint` / `getLastAssistantUsage`）/ `branchSummarizeBranch` / fork（`agent-session-runtime`）/ `getUserMessagesForForking` / `getSessionStats` / 上下文 token 估算 / footer 用量统计 / `getUsageCostBreakdown` / cache-stats / tree-selector 渲染与复制 / `getSubagentMessages` / export-html（preRenderCustomTools + template.js）/ examples 扩展，遇无 `.message` 的 LazyEntry 不再崩溃（lazy 条目不参与上下文与统计累计）
- v3 懒加载只对 `type=message` 行 peek（其余类型 full parse）：label / subagent_run / custom / thinking_level_change / model_change / branch_summary / session_info 等在 compaction 前不再被错误 lazy 化，`_buildIndex`（labelsById）/ `loadSubagentRunEntries` / `getLabel` 等索引与查询恢复完整字段
- compaction 保留的 kept messages 不再丢失：`buildSessionContext` 新增可选 `materializer` 参数，`SessionManager.buildSessionContext` 传入 `materialize`，resume 后 lazy 占位的 kept messages 读回并进入 LLM 上下文（不再只剩 summary）
- resume 后二次 compaction / 分支汇总不再丢 kept 内容：`compact` / `_runAutoCompaction` / `navigateTree` 汇总前 materialize lazy 占位（`_materializeBranchEntries`），`prepareCompaction` / `generateBranchSummary` 拿到完整消息
- resume 后触发新 compaction 的 `cumulativeUsage` 漏算 lazy 历史 usage：`sumEntriesUsage` 改为以最后一个带 `cumulativeUsage` 的 compaction 作基线重置累加（对齐 `computeFooterUsage`），不再因 lazy 占位条目无 `.message` 被跳过而丢失 compaction 前历史用量（footer 累计 token/cost 不再偏小）
- `_lazyRawCache` 读取 lazy raw 失败时记录 `console.error` 告警：原静默吞异常，降级为占位写入会不可见地丢失消息内容

## [0.12.8] - 2026-07-31

### Fixed

- 测试修复：`SessionManager.inMemory()` 默认使用 `process.cwd()` 导致 git snapshot 在项目仓库上执行 `stash push/pop`，产生 ~94ms 延迟使并发检测测试 flaky；改用测试临时目录并禁用 git snapshot

## [0.12.7] - 2026-07-30

### Fixed

- Esc 无法退出 auto-compaction：`_runAutoCompaction` 中 AbortController 在 `compaction_start` 事件后才创建，导致 signal 可能无法及时响应；catch 块总将 `aborted` 设为 `false`，AbortError 时用户看不到取消提示
- TUI 滚轮性能优化：`getMaxScrollOffset()` 改用法 `doRender` 中缓存的子组件行数，避免滚轮事件时暴力重渲染全部聊天内容
- MCP 工具结果渲染截断：`formatToolExecution()` 对超过 3000 字符的工具输出截断显示，防止聊天容器无限膨胀

## [0.12.6] - 2026-07-28

### Fixed

- Subagent 子会话不再触发 git snapshot，避免产生无用的 stash commit 和 git ref 残留

### Changed

- 顶部边框整体重排：左侧显示 Π + agent + path + branch，右侧显示 (provider) model · effort（思考强度），底部 footer 保留完整 token/上下文统计
- 边框元素分隔符从 `·`/`•` 改为空格，相邻元素使用不同颜色以维持视觉区分
- primary-agent 移至 Π 符号之后，emoji 风格添加 🚀 前缀
- 移除编辑器 prompt 前缀功能（`>` / `$`）

## [0.12.5] - 2026-07-28

### Fixed

- **Revert and Delete**：修复 revert 后选中的节点对应的 snapshot entry 和其 git ref 未被清理的问题，现在执行 revert and delete 时会同时移除回滚点对应的快照条目，确保 snapshot 引用不会持续累积

## [0.12.4] - 2026-07-28

### Added

- **Revert and Delete**：在 session tree 中选中用户消息节点 → Enter → 选择 "Revert and Delete"，除正常 revert 行为外，还会删除回滚点之后的所有游离 session 条目及其对应的 git snapshot 引用，阻止磁盘空间持续膨胀
- **Checkpoint 数量上限**：新增 `gitSnapshotMaxCount` 设置项（默认 20，设为 0 则完全禁用快照），每次创建新 git 快照时自动修剪超出上限的最旧快照，释放对应的 `refs/pi-snapshots/` git 引用，允许 git gc 回收 stash 对象
- **Snapshot 设置交互配置**：`gitSnapshotMode` 和 `gitSnapshotMaxCount` 注册到 `/settings` 菜单，支持交互式修改

## [0.12.3] - 2026-07-28

### Changed

- Shift+Tab 切换 primary agent 时，选择持久化到全局 settings（`~/.pi/settings.json`），不再写入项目级 `.pi/settings.json`

### Added

- Tree Revert 功能：在 session tree 中选中用户消息节点 → Enter → 选择 "Revert"，将 git 工作区恢复到目标节点时间点的文件状态（包括 untracked 文件），并切换 session 到该节点。仅对用户消息节点显示 Revert 选项
- Git 快照系统：用户发送消息时自动记录 git 工作区快照（通过 `git stash push --include-untracked` + `git stash pop`），存储为 session CustomEntry，用于 Revert 回滚
- 新增 `gitSnapshotMode` 设置项：`"include-untracked"`（默认，仅 untracked 文件）/ `"all"`（含 `.gitignore` 忽略的文件），控制快照捕获范围
- 顶部横线布局调整：左侧按序显示路径/branch + 主agent + 模型/思考强度 + 上下文用量，右侧仅显示 ↑input · ↓output 简洁统计。底部 footer 保留完整统计

## [0.12.2] - 2026-07-28

### Added

- SessionContext 新增 `entryIds` 字段，与 `messages` 数组对齐追踪对应的 session entry ID
- `renderSessionContext` 中建立 `entryIdToComponent` 映射，按 entryId 追踪已渲染消息的 TUI 组件
- 树导航选择器新增操作选择器：Peek（不切分支滚动定位）/ Navigate / Navigate with summary / Navigate with custom prompt，替代旧的「是否摘要」三选项
- Tree Peek 功能：在 session tree 中选中节点 → Enter → 选择 "Peek"，关闭 tree 并滚动聊天视图到目标消息位置，不切换分支
- 为 `custom_message` 和 `branch_summary` entry 类型添加 entryIds 对齐测试

### Fixed

- 修复 `renderSessionContext` 中 `entryIdToComponent` 缺失导致回归测试崩溃的问题
- 移除 `NAVIGATE` 分支中无效的 `getBranchSummarySkipPrompt` 死代码
- Tree 操作选择器：选中节点后弹出 Peek / Navigate / Navigate with summary / Navigate with custom prompt 选项，默认选中 Peek
- 修复切换主 agent（shift+tab）后边框标题（agent 名/模型/状态）不同步的问题：footer 的 `invalidate()` 现在主动将最新标题推送到编辑器边框，避免滞后一帧
- Tree Peek：修复工具调用/工具结果（toolResult）节点无法通过 Peek 定位的问题——`renderSessionContext` 现在将 toolResult entryId 注册到对应的 `ToolExecutionComponent`，使工具结果节点也能滚动定位

## [0.12.1] - 2026-07-26

### Changed

- Subagent 运行状态显示优化：TUI heading 中序号后新增 `(agent)` 标签（accent 色），status 使用状态色（success 绿/failed 红/running 黄），model/thinking/tokens/tools 统一 muted 色，方便用户一眼定位 subagent 类型与运行情况
- Footer 优化：路径、分支、session 名从 footer 底部移到输入框顶部横线，减少底部占用行数
- 输入框顶部横线美化：新增 `editorBorderStyle` 设置项（`plain` | `emoji`），默认 `plain` 用颜色+Unicode 分隔符，`emoji` 用 emoji 图标+颜色区分
- 输入框顶部横线新增 `Π` 前缀标识 Pi 品牌
- Model/thinking 信息从 footer 底部移到顶部横线右侧（`borderTitleRight`），footer 底部仅保留 token 统计与 context 用量
- Footer 统计项分隔符从空格改为 ` · `，提升视觉清晰度
- Footer 成本统计修复：现在包含 branch summary、compaction、toolResult 的 usage 成本（之前仅统计 assistant message）

### Fixed

- 修复 subagent 运行后父 session extension runtime 被污染问题：`createSubagentChildSession` 现在创建独立的 `ExtensionRuntime`，子 session dispose 时不再在共享 runtime 上设置 stale 标记（根因：子 session 通过共享 `resourceLoader` 获得同一个 `ExtensionRuntime` 对象，dispose → invalidate 污染父 session）
- Thinking level `max` 在 TUI 中缺少专属颜色：新增 `thinkingMax` 主题 token，`getThinkingBorderColor` 正确映射 `max` 级别
- 修复 54 个预存测试失败（ModelRuntime 重构后测试 mock 过时）：
  - `getSessionStats()` 现在包含 toolResult/branch_summary/compaction 的 usage（之前仅统计 assistant message）
  - `compact()` 返回值恢复 `usage` 字段，`generateSummary`/`generateTurnPrefixSummary` 返回 usage
  - `afterToolCall` 现在传递 tool execution 和 extension handler 的 usage
  - `getContextUsage()` 跳过 0-usage 的 assistant message 继续搜索有效 usage
  - auth snapshot 刷新：`authStorage.modify()` 后调用 `modelRegistry.refresh()` 更新快照
  - HTML 导出主题回退：缺失主题时回退到当前活动主题而非抛出异常
  - LoginDialog 提交键从 `\n` 修正为 `\r`（keybinding 系统将 LF 映射为 Ctrl+J）
  - interactive-mode-status mock 补充 `modelRuntime.getAvailableSnapshot` 等方法
  - 各测试文件修复 mock 过时问题（env var 迁移期望值、extension runner 消息格式、model selector 渲染等）

## [0.12.0] - 2026-07-25

### Added

- 同步上游 v0.80.6 → v0.81.1：Model Runtime 架构重构（model-runtime.ts + 9 个新核心文件），provider 注册/认证流程统一到 ModelRuntime，model-registry.ts 降级为兼容 facade
- llama.cpp router 扩展：支持本地 llama.cpp 服务和 Hugging Face 模型搜索（src/extensions/llama/）
- Radius gateway 支持（radius.ts）
- Qwen Token Plan 内置 provider
- message copy 快捷键（`app.message.copy`）：tree selector 中复制选中消息到剪贴板
- `get_available_thinking_levels` RPC 命令：查询当前模型可用的 thinking 等级
- message-anchored tool loading：工具定义动态加载到 tool result 位置，改善 Anthropic/OpenAI cache 命中率
- 剪贴板文本 fallback：图片粘贴失败时自动回退到纯文本粘贴
- Primary agent 支持 `skills` 字段：通过 glob 模式按需过滤可用 skills。不配置则使用全部 skills（默认行为），显式空数组则禁用 skills，配置模式则只启用匹配的 skills。Primary agent 的 skills 过滤仅影响主会话系统提示词，不影响 subagent
- Goal 自主编排扩展：`/goal <target>` 启动全自动编排（分解→调度→追踪→循环完成），通过 `before_agent_start`/`agent_end` 事件 hooks 实现无人值守的多 turn 自动驱动
- `updateGoal` LLM 工具：结构化进度更新（set_tasks / update_task / complete），含子任务重试逻辑（最多 2 次）
- `/goal:status` 和 `/goal:abort` 命令：查看编排进度、中止当前编排
- install.sh 扩展候选新增 goal（file:goal.ts，默认不勾选）

### Changed

- npm 依赖升级：`@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core` 从 0.80.6 升级到 0.81.1
- 认证流程重构：`authStorage.login/get/set` → `modelRuntime.login/logout/checkAuth/getAuth/setRuntimeApiKey`，统一 AuthInteraction 接口（prompt + notify）
- `agent-session.ts`：`getApiKeyAndHeaders` → `getAuth`，`streamFn` → `streamFunction`，`AuthResult` + `withoutDeletedHeaders` 辅助
- `session-manager.ts`：`CompactionEntry` 和 `BranchSummaryEntry` 新增 `usage` 字段，`appendCompaction`/`branchWithSummary` 接受 `usage` 参数
- `resolve-config-value.ts`：`resolveHeadersOrThrow` 新增 `env` 参数
- 系统提示词移除 `Current date` 行
- `provider-attribution.ts`：header 类型从 `Record<string, string>` 升级为 `ProviderHeaders`

### Fixed

- clone 未保存会话时给出清晰错误提示（"This session has not been saved yet"）
- read 工具错误内容不再语法高亮（避免错误着色）
- 扩展加载修复：jiti alias 前缀匹配导致 `@earendil-works/pi-ai/<subpath>` 被错误重写为 `compat.js/<subpath>`（Node/tsx 模式）；VIRTUAL_MODULES 缺少 `@earendil-works/pi-ai` 裸包名映射导致 Bun 二进制模式扩展找不到 `@earendil-works/pi-ai`（optional peerDependency 未安装时）

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
