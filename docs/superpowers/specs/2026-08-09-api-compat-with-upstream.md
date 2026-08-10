# API 兼容性研究报告：本仓库 vs 上游 earendil-works/pi

> 研究日期：2026-08-09（首次）；2026-08-09（实施后更新）
> 对比对象：本仓库 `/data/mine/pi`（@schovest/pi-tui、@schovest/pi-coding-agent，版本 0.13.6）
> 上游基线：`/data/mine/earendil-works-pi`（git tag v0.81.1）npm 发布产物 `@earendil-works/pi-tui@0.81.1`、`@earendil-works/pi-coding-agent@0.81.1`
> 方法：TypeScript compiler API 提取两方 `dist/index.d.ts` 的顶层导出符号，递归展开 re-export 对比真实签名；对上游独有符号回查本仓库 `src/` 确认是否有实现

## 结论摘要（实施后）

| 包 | 上游符号数 | 顶层覆盖 | 状态 |
| ---- | ----------- | --------- | ------ |
| pi-tui | 105 | 105（签名 100% 一致） | **全量覆盖** ✓ |
| pi-coding-agent | 361 | 361（仅上游有 = 0） | **全量覆盖** ✓（详见下方差异清单） |

## 一、pi-tui：完全覆盖（无需改动）

- 上游 105 个导出符号全部存在于本仓库，签名逐字一致（0 差异）；本仓库额外 3 个（`Marked`、`Token`、`Tokens`）
- 上游 v0.80.6→v0.81.1 期间 tui 的 `src/index.ts` 导出面零变化

## 二、pi-coding-agent：实施内容

### 已补齐（本轮实施）

| # | 项目 | 改动 |
| --- | ------ | ------ |
| 1 | 16 个未导出符号 | `src/index.ts` 导出列表补齐：extensions 事件类型 8 个（`AgentSettledEvent`、`BeforeProviderHeadersEvent`、`EntryRenderer`、`EntryRenderOptions`、`SessionInfoChangedEvent`、`ToolExecutionEndEvent/Start/Update`）、model-resolver 6 个（`ScopedModel` 等 + `resolveCliModel`/`resolveModelScopeWithDiagnostics`）、session-manager 2 个（`SessionTreeNode`、`sessionEntryToContextMessages`）；同步补 `core/extensions/index.ts` 缺的 5 个类型 |
| 2 | `./rpc-entry` 子路径 | 新增 `src/rpc-entry.ts`（与上游逐字一致）+ package.json exports 条目 |
| 3 | `hasTrustRequiringProjectResources` | `trust-manager.ts` 新增兼容别名函数（上游 rename，fork 保留旧名 `hasProjectTrustInputs`） |
| 4 | `generateSummaryWithUsage` | compaction 新增（返回 `{ text, usage }`）；`generateSummary` 返回类型对齐上游 `Promise<string>`（原返回 `{ summary, usage }` 不兼容）；`completeSummarization` 导出并接入 `retryAssistantCall`（`@earendil-works/pi-ai`）；`createSummarizationOptions` 支持 `env`；新增 `combineUsage`；`generateTurnPrefixSummary` 对齐签名 |
| 5 | compaction retry 透传 | `compact()` 签名加 `env`/`retry`/`callbacks`；`AgentSession` 新增 `_summarizationRetryCallbacks()`（emit `summarization_retry_*` 事件），手动/自动 compact、branch-summary 三处调用传 `getRetrySettings()` + callbacks |
| 6 | `AgentSessionEvent` | 新增 `entry_appended`、`summarization_retry_scheduled`、`summarization_retry_attempt_start`、`summarization_retry_finished` 4 个事件；`appendEntry` 扩展 API emit `entry_appended` |
| 7 | `SessionManager.buildContextEntries()` | 实例方法 + `ReadonlySessionManager` Pick 补齐；模块级 `buildContextEntries`/`buildSessionPath`/`buildEntryIndex` 函数与上游一致 |
| 8 | `SessionInfo.messageCount` | 按用户决策：meta 缓存维护（append 递增，`_initMetaState` 全量统计含 lazy 占位），零额外扫描且准确；meta 缺失/过期时回退头部 100 行近似值；保留 `fileSize`（fork 独有） |
| 9 | `Settings` 3 字段 + `SettingsManager` 6 方法 | `showCacheMissNotices`/`externalEditor`/`outputPad` 及 `getThemeSetting`/`getShowCacheMissNotices`/`setShowCacheMissNotices`/`getExternalEditorCommand`/`getOutputPad`/`setOutputPad`（实现与上游一致） |
| 10 | `BranchSummaryResult.usage` | 字段补齐 + `generateBranchSummary` 返回 usage；`GenerateBranchSummaryOptions` 新增 `retry`/`callbacks`、`apiKey` 改可选、`env` 透传修复 |

### 有意保留的差异（兼容性已确认）

| 差异 | 说明 |
| ------ | ------ |
| `SessionInfo.allMessagesText` | 按用户决策不提供：fork 有意不索引消息内容（搜索只索引标题/元数据，注释说明"无索引的全量内容搜索展示不全且不可信"）；`session-selector` 用 `fileSize` 展示会话体量 |
| 21 个本仓库独有导出 | codex 插件类型 6 个、subagents 14 个、`hasProjectTrustInputs`——fork 增强超集，不影响兼容 |
| 大量字段/方法超集 | `Settings`（defaultPrimaryAgent 等 9 个）、`SettingsManager`（codex/plugin 相关 21 个方法）、`AgentSessionConfig`（agentDir/enableSubagents）、`SessionContext`（entryIds）、`CompactionEntry`（cumulativeUsage）、`SessionEntry`（SubagentRunEntry）、`buildSessionContext`（materializer 参数）、`RetrySettings`（maxRetryDelayMs/provider）、`SessionInfo`（fileSize）等 |
| theme 内部差异 | `detectTerminalBackgroundTheme` 等 auto-theme 检测函数为本仓库更早版本实现，顶层导出一致（非公共 API） |
| `config.ts` SelfUpdate 参数 | 上游 `getSelfUpdateCommand` 第三参数类型改 `SelfUpdatePackageTarget`；顶层不导出（非公共 API） |
| `utils/image-convert` 的 `convertImageBytesToPng` | 上游有但顶层不导出（非公共 API） |
| `packages/ai` 自动生成文件 | 上游 0.81.1 起模型目录用生成文件；本仓库 `packages/ai` 不在工作区（外部 npm 依赖） |

## 三、包结构与依赖关系

- 本仓库为精简双包结构（仅 `packages/coding-agent` + `packages/tui`），agent/ai 层直接依赖上游发布包 `@earendil-works/pi-agent-core@0.81.1`、`@earendil-works/pi-ai@0.81.1`（精确版本），该层 API 与上游天然一致
- 包名差异（`@schovest/*` vs `@earendil-works/*`）为 fork 改名，不在符号兼容性讨论范围

## 四、验证方式

- 对比脚本：`/tmp/upstream-api/compare-dts.mjs`（顶层符号）、`/tmp/upstream-api/compare-module.mjs`（递归展开 re-export 的真实签名）、`/tmp/upstream-api/compare-files.mjs`（dist 文件级）
- 复跑结果：顶层"仅上游有 = 0"；模块级剩余差异全部为本仓库超集或有意保留项
- `npm run check` 全绿；compaction（61+）、session-manager（125+）、agent-session（125+）、settings（36）、session-selector（19）、codex-hooks（13）测试通过
