# Subagent 剥离为扩展 — 调研与设计

日期：2026-09-02
状态：调研结论（未实施）；2026-09-02 二次修订：采用路线 A（子进程模式）为终态

## 目标

将内置 subagent 工具从 `coding-agent` 核心中剥离为可安装扩展（`pi install` / `install.sh` 分发），符合 AGENTS.md 的分层原则：**可安装扩展优先，核心只保留平台底座**。

## 决策记录

- **初版推荐**：路线 B（进程内 + 核心新增 `createChildSession` API + CustomEntry 持久化）。
- **2026-09-02 修订**：用户决策放弃 `subagent_run` 子消息树持久化与进程内子会话，改为**子进程模式**：扩展直接 spawn `pi` 子进程执行子任务，配置经 CLI 参数注入。核心零新增 API，路线 A 升级为终态。下文第三节为修订后的推荐方案；第二节保留路线对比供追溯。
- **2026-09-02 二次修订**：完成主流实现调研（含 pi-subagents），确认子进程路线与生态成熟实践同构；新增方案 C（直接采用 pi-subagents）对比，见第五节。

## 一、现状盘点

### 1.1 核心代码清单

| 文件 | LOC | 职责 |
| --- | --- | --- |
| `src/core/subagents/discovery.ts` | 134 | 定义发现：内置 3 个（explorer/worker/reviewer）+ `~/.pi/agent/subagents/*.md` + `.pi/subagents/*.md`，同名覆盖合并 |
| `src/core/subagents/runner.ts` | 493 | 运行时：parallel（≤8 任务/并发 4）/ chain（`{previous}` 替换），模型/thinking/tools/skills 解析，事件流 |
| `src/core/subagents/tool.ts` | 354 | 工具定义：TypeBox schema、promptSnippet/promptGuidelines、流式 TUI 渲染（renderCall/renderResult） |
| `src/core/subagents/types.ts` | 81 | 类型定义 |
| `src/core/types/subagent-entry.ts` | 24 | `subagent_run` 会话条目类型（detached 记录，不入 LLM 上下文） |
| `src/modes/interactive/components/subagents-panel.ts` | 234 | `/subagents` 面板 |
| `src/modes/interactive/components/subagent-overlay.ts` | 423 | `/running-subagents` 全屏 overlay |
| `src/modes/interactive/components/subagent-details.ts` | 435 | 详情数据模型 + 状态颜色 + 消息渲染 |

### 1.2 核心接线点（全部需要拆除或改为 API）

**`core/agent-session.ts`**
- `AgentSessionConfig.enableSubagents`（默认 true）→ 构造时注册 `createSubagentToolDefinition(this)`（L428-430）
- 公开方法：`listSubagents()` / `runSubagents()` / `recordSubagentRunEvent()` / `getRunningSubagentCount()`（L1115-1136）
- `createSubagentChildSession()`（@internal，L1139-1187）：**最深的耦合**。克隆父 Agent 的全部运行配置（convertToLlm、streamFn、onPayload/onResponse、transformContext、steering/followUp、transport、thinkingBudgets、toolExecution），`SessionManager.inMemory()`，共享 resourceLoader/modelRuntime/settingsManager，剔除 subagent 工具防递归，`isolatedExtensionRuntime: true` 隔离扩展运行时，`skipGitSnapshot: true`
- `_runningSubagents` Map（footer 统计数据源）
- 为子会话新增的三个 config 选项：`skillsOverride` / `skipGitSnapshot` / `isolatedExtensionRuntime`

**`core/session-manager.ts`**
- `SubagentRunEntry` 进入条目联合类型；`appendSubagentRunEntry()`（不推进 leafId 的 detached 记录）、`appendSubagentMessages()`（child message 挂在条目下，parentId 指向条目）、`loadSubagentRunEntries()`、`getSubagentMessages()`
- 上下文构建时排除 `subagent_run`（L1276-1278）；压缩时保留 subagent 子树（L2027-2074）

**其他**
- `core/sdk.ts`：`enableSubagents` SDK 选项透传
- `core/index.ts` + `src/index.ts`：subagent 全量类型与函数的公共导出
- `core/slash-commands.ts`：`/subagents`、`/running-subagents`
- `modes/interactive/interactive-mode.ts`：panel/overlay 实例化、斜杠命令 handler、工具 details 管道（`toolName === "subagent"` 特判，L3567/3772-3787）
- `modes/interactive/components/footer.ts`：`subagents:N` 统计
- `cli/args.ts`：`--tools` 帮助文本提及 `subagent`
- `core/primary-agents/discovery.ts`：plan primary agent `excludedTools: ["bash", "subagent"]`
- `core/compaction/branch-summarization.ts`：`subagent_run` 条目分支处理
- 测试：`test/subagents.test.ts`、`subagents-panel-component.test.ts`、`subagent-details-component.test.ts`、`session-manager/prune-orphaned`、`lazy-loading`、`interactive-mode-status` 等 10 个文件

**无关耦合（保留不动）**
- `codex-hooks-bridge.ts` 的 `subagent_start`/`subagent_stop` 是 Codex 兼容的 hook 事件名（映射自 agent_start/agent_end），与 subagent 功能无关
- `settings-manager.ts` 的同名字符串是 hook 事件类型

### 1.3 运行时依赖矩阵（runner 实际用到什么）

| 依赖 | 扩展现状 | 差距 |
| --- | --- | --- |
| 模型解析（getModels/getModel/hasConfiguredAuth） | `ctx.modelRegistry`（ModelRegistry facade） | ✅ 已覆盖 |
| 工具名集合（getAllToolNames） | `ctx.getActiveTools()` / `ctx.getAllTools()` | ✅ 基本覆盖 |
| 工具/skills glob 匹配（tool-matcher.ts） | 未导出到扩展 | ⚠️ 需导出或随扩展复制 |
| skills（resourceLoader.getSkills） | 无 | ❌ 缺口 |
| settings（默认 provider/model/thinking） | 无 settingsManager 访问 | ❌ 缺口 |
| 子会话创建（createSubagentChildSession） | 无 | ❌ **最大缺口** |
| 会话持久化（appendSubagentRunEntry/appendSubagentMessages） | 仅 `appendEntry`（CustomEntry，扁平无子消息）+ ReadonlySessionManager | ❌ 缺口（可用 CustomEntry 变通） |
| 工具 prompt 注入（promptSnippet/promptGuidelines） | `registerTool` 支持同字段 | ✅ |
| 工具流式渲染（renderCall/renderResult + pi-tui 组件） | `registerTool` 支持，扩展可 import `@schovest/pi-tui`（loader 有 bundled alias） | ✅ |
| `/subagents`、`/running-subagents` UI | `registerCommand` + `ui.custom({ overlay: true })`（doom-overlay 已验证）+ `setStatus`（footer 计数） | ✅ |
| 运行事件监听（interactive-mode 特判管道） | `on("tool_execution_update"/"tool_execution_end")` 含 toolName/partialResult | ✅ |

## 二、两条可行路线

### 路线 A：子进程模式（零核心改动，即刻可行）

`examples/extensions/subagent/` 已提供完整参照：扩展 spawn 独立 `pi` 子进程（JSON 模式）运行每个 subagent，带 parallel/chain、流式渲染、用量统计、abort 传播。

- 优点：不动核心；进程级隔离更彻底；扩展自身已是稳定 API 面
- 缺点：每任务进程启动开销；不共享父会话 resourceLoader/扩展/自定义工具；结果只存在于工具返回值与 details 中，**不写入父会话树**（无 `/running-subagents` 历史回放）；与现内置行为不等价

适用：~~作为快速验证或对等性要求不高的场景。不满足"剥离但保持行为不变"的目标。~~ **2026-09-02 修订后成为终态方案**（见第三节）。

### 路线 B：进程内模式（需要先补核心 API 缝隙）

把 `core/subagents/` 四个文件 + 三个 UI 组件整体迁出为扩展，行为不变。前提是补齐 1.3 中三个 ❌ 缺口。

## 三、终态方案：子进程模式（2026-09-02 修订）

### 3.0 架构

```
主 agent（pi）
  └─ 扩展 extensions/subagent/ 注册 "subagent" 工具
       └─ execute() 内 spawn `pi --mode json -p --no-session ...`
            └─ stdout JSONL 事件流（message_end / tool_result_end）
                 → 扩展实时解析 → onUpdate 流式渲染进工具结果
                 → 最终输出作为 tool result 返回主 agent（不入会话树）
```

- 不创建进程内 child AgentSession，**核心零新增 API**（原 P0 `createChildSession` 取消）
- 不写 `subagent_run` 条目与子消息树，子进程 `--no-session`，历史回放能力移除（用户决策）
- 大量实现可直接迁移 `examples/extensions/subagent/index.ts`（1009 行：parallel ≤8/并发 4、chain `{previous}`、流式渲染、usage 统计、abort 传播、`getPiInvocation` 二进制兼容）

### 3.1 配置注入映射（definition frontmatter → CLI 参数）

| 内置行为（进程内） | 子进程注入 | 状态 |
| --- | --- | --- |
| `createSubagentChildSession({model})` | `--model <provider/id>` | ✅ |
| `thinkingLevel` 解析 | `--thinking <level>` | ✅ |
| `resolveActiveTools` glob 匹配 | 扩展内复制匹配逻辑（输入仅工具名列表 + patterns，从 `ctx.getAllTools()` 取名单），结果传 `--tools a,b` | ✅ 逻辑无核心依赖 |
| 防递归（剔除 subagent 工具） | `--exclude-tools subagent` | ✅ |
| definition.prompt 系统提示 | 临时文件 + `--system-prompt`（完全替换，贴近内置）或 `--append-system-prompt`（保留默认 coding prompt + AGENTS.md，example 的选择） | ✅ |
| 子会话不持久化 | `--no-session` | ✅ |
| skills 继承 | 子进程自动发现 `.pi/skills/` + 用户级（语义从"继承主 agent 已加载"变为"自动发现"；扩展 API 无 skills 读取口，常规场景等价） | ⚠️ 语义近似 |
| abort → `child.abort()` | SIGTERM → 5s SIGKILL 兜底 | ✅ |
| 认证/模型配置 | 共享同一 settings.json/auth | ✅ |
| 工具面一致性 | 子进程加载完整扩展集，与主 agent 工具面一致（含 MCP 等价配置） | ✅ |

### 3.2 tmux 的定位（可选增强，不进首期）

直接子进程已完全覆盖 subagent "委托-等待-回传"语义，**不需要 tmux**。tmux 仅在以下场景有价值：

1. 长任务需要 attach 全屏观察或人工接管子 agent（语义从"工具调用"变"并行工作台"）
2. 跨 turn 挂起的后台任务

若只需"后台跑 + 稍后看"，子进程输出重定向到文件 + 扩展轮询即可。tmux 模式留作后续可选，不改变首期架构。

### 3.3 UI 渲染状态等价性（已验证）

三层视图均不受影响：

1. **工具行内流式渲染**：`onUpdate → renderResult 重绘`是 ToolDefinition 通用机制，与子会话实现解耦。内置版数据源 `child.subscribe()`，子进程版数据源 stdout JSONL——`print-mode.ts` 的 JSON 模式是 `session.subscribe` 全量事件透传（含 `tool_execution_start/update/end`、`message_update` 流式增量、`message_end` usage），与内置版订阅的是**同一事件流、同一粒度**，仅多一层管道传输（毫秒级）。
2. **`/running-subagents` overlay 动态查看**：扩展 `api.on("tool_execution_update")` 过滤自己的 toolName（`partialResult.details` 即 onUpdate 推的对象）+ `ui.custom({overlay: true})` 重建，三个 TUI 组件（panel/overlay/details）仅依赖 pi-tui + theme，可原样迁入扩展。差异：无历史回放（已接受）。
3. **footer `subagents:N`**：扩展自维护计数 + `ctx.ui.setStatus`。

实现注意：`examples/extensions/subagent` 基座只解析 `message_end`/`tool_result_end`（后者不在当前事件联合中，是死分支），迁移时需扩充解析面至 `tool_execution_start/update/end + message_update`；高频增量事件可加节流合并。

### 3.4 与内置行为的差异（接受清单）

1. **无历史回放**：`/running-subagents`（若扩展重建）只剩当前运行视图（details 在扩展内存），旧会话无子 agent 记录
2. **启动开销**：每任务一个 pi 进程（冷启动约 1-2s，含资源发现），对 10s+ 的 LLM 任务可接受；并发 4 时峰值 4 进程，8 任务上限不变
3. **skills 语义**：从"继承主 agent 已加载的 skills（glob 过滤）"变为"子进程自动发现"；`skills` frontmatter 字段的 glob 匹配仅能作用于子进程自行发现的集合（可通过 `--skill` 精确注入补充）
4. **输出体积**：stdout JSONL 全量事件流，长任务较大；沿用 example 的 50KB/task 返回截断

### 3.5 扩展包结构

```
packages/coding-agent/extensions/subagent/
├── index.ts      # registerTool("subagent") + spawn/解析/渲染 + 并发控制
├── agents.ts     # definition 发现（原 discovery.ts 原样迁入）
└── ui/           # renderCall/renderResult 流式渲染（自 example 迁移）
```

- 经 `dist-assets/install.sh` 登记（与 tps、sudo-helper 同层），二进制发行自带、按需安装
- `enableSubagents` SDK 选项随核心代码一并删除；不想用 = 不装扩展
- 工具名保持 `subagent`：plan primary agent 的 `excludedTools: ["subagent"]`、`--tools/--exclude-tools` 按工具名工作，无需改动

### 3.6 核心拆除清单（比原路线 B 更彻底，但无新增 API）

- 删 `core/subagents/`（discovery/runner/tool/types，~1078 行）
- 删 `core/types/subagent-entry.ts`、session-manager 中 `subagent_run` 条目类型、`appendSubagentRunEntry/appendSubagentMessages/loadSubagentRunEntries/getSubagentMessages`、压缩子树保留逻辑、上下文排除特判
- 删 agent-session 的 `enableSubagents`/`listSubagents`/`runSubagents`/`recordSubagentRunEvent`/`getRunningSubagentCount`/`createSubagentChildSession`/`_runningSubagents`，及 `skillsOverride`/`skipGitSnapshot`/`isolatedExtensionRuntime` 三个仅为子会话存在的 config 选项
- 删 sdk.ts `enableSubagents` 透传、`core/index.ts`+`src/index.ts` 导出、`/subagents`+`/running-subagents` 核心命令、interactive-mode 特判管道与 panel/overlay/details 三组件、footer `subagents:N`
- 迁移/删除 10 个相关测试文件；`--tools` 帮助文本更新
- **旧会话兼容**：需确认 session-manager 对未知条目类型（旧 `subagent_run`）的读取容错行为，避免旧 session 加载失败

### 3.7 分阶段落地

1. **P1 扩展迁移**：以 `examples/extensions/subagent/index.ts` 为基座，融合内置版能力（definition 目录约定 `subagents/`、scope 合并、usage 汇总、title 字段），产出 `extensions/subagent/`
2. **P2 核心拆除**：按 3.5 清单删除核心代码与测试，确认旧会话兼容
3. **P3 收尾**：`install.sh` 登记、`docs/subagents.md`/`docs/architecture.md` 重写、CHANGELOG（SDK `session.runSubagents/listSubagents` 删除属破坏性变更，需标注）

工作量估算：P1 约 1-2 天，P2 约 1 天，P3 半天。

### 3.8 风险与代价

| 项 | 评估 |
| --- | --- |
| 进程开销 | 每任务 spawn；8 任务上限 + 并发 4 缓解；LLM 任务占比小 |
| 子进程资源发现副作用 | 子进程加载全部扩展（可能含 session_start 副作用）；如需纯净可加 `-xt`/`--no-extensions` 类参数注入选项 |
| 旧会话兼容 | 已验证：JSONL 读取仅 `JSON.parse` 断言、无类型校验，未知条目不崩溃；子消息 `parentId` 指向 detached 条目、主链 leaf 永不指向它，天然被树结构隔离。实现时保留最小读侧护栏（忽略 `subagent_run` 及其子消息）并验证渲染默认分支即可 |
| SDK 破坏性 | `session.runSubagents/listSubagents` 删除，CHANGELOG 标注 |
| 上游合并面 | `core/subagents` 为 fork 自有代码，删除不增加冲突面 |

## 四、结论

- 终态采用**子进程模式**：核心零新增 API，扩展经 spawn `pi --mode json` 完成委托，配置全走 CLI 参数注入，会话树不承载子 agent 记录。
- 拆除工作反而更彻底（session 格式中的 `subagent_run` 一并移除），但需验证旧会话容错。
- tmux 不进首期；若将来需要"可观察/可接管"的子 agent，作为扩展内可选模式扩展。

## 五、主流 subagent 实现调研（2026-09-02）

### 5.1 两大流派

| 流派 | 代表 | 机制 | 优势 | 劣势 |
| --- | --- | --- | --- | --- |
| 进程内隔离子会话 | Claude Code（Task 工具）、opencode、Gemini CLI、本 fork 现状 | 同进程独立 context window，事件直连 | 零进程开销、实现简单、事件全粒度 | 难做后台运行/steer/复活；生命周期与宿主绑定 |
| 子进程模式 | **pi-subagents**（nicobailon）、各类 CLI 适配器 | 每 child 一个独立 `pi` 进程，stdout JSONL 协议 | 隔离彻底、天然 async/steer/resume、可把外部 CLI（claude-code/codex/cursor）一体化为 agent | 进程开销、需协议边界防御 |

### 5.2 pi-subagents 架构解剖（github.com/nicobailon/pi-subagents）

纯扩展实现（`pi install npm:pi-subagents`），核心零改动——与我们的修订方案**完全同构**：

- **子进程协议**：spawn pi 子进程消费 stdout JSONL（与 print-mode 全量透传同源）；防御边界：单行 16MiB 上限、stderr 仅留末 128KiB、`agent_settled` 为终止水印、UTF-8 分割行兼容
- **前台/后台双模式**：前台流式进对话；后台 async 由 detached runner 进程执行，run artifacts 落盘（`status.json`/`events.jsonl`/`output-*.log`），完成后经 `pi.sendMessage(..., {triggerTurn})` 唤醒父会话
- **steer 运行中子 agent**：ack 制（3s 超时）、FIFO 20 条、steer/follow_up/auto 三模式；**resume 已完成子 agent**：从持久化 session 文件复活新进程 + 跨进程独占 lease
- **context 继承**：`context: "fresh" | "fork"`——fork 用 `--session <branched-file>` 从父会话当前 leaf 生成真会话分支（非摘要注入）；自动剥离 Anthropic 签名 thinking 块
- **编排**：`workflowScript`（JS 沙箱：`runs.run`/`runs.all`/`runs.lanes`/`runs.steer`），取代 chain/tasks JSON；递归守卫 `maxSubagentSpawnsPerRun=64` + child-safe 嵌套 fanout（`tools: subagent` 显式授权）
- **UI**：FleetView 常驻 widget（editor 下方，setWidget）+ `/subagents-fleet` 全屏 inspector（overlay），支持选中子 agent 发 steer/stop——印证第三节 UI 等价性分析
- **工具渲染**（src/tui/render.ts，~3300 行）：同一套 `renderCall/renderResult` API。renderCall 单行 `subagent <agent>`；运行中折叠卡片：状态 glyph 动画（RUNNING_FRAMES 按 seed+frame 取帧，seed 混合 index/toolCount/tokens/lastActivityAt，并行子 agent 相位互异）+ 标题行（model/thinking badge + context badge + turns/tools/tok/duration/$）+ `⎿ 当前工具: 参数预览 | 持续时长` + activity 新鲜度行（needs attention / active but long-running）+ Fleet/detach hint；完成态：✓/✗/■ + 首行输出预览 + session 文件路径 + artifacts 路径；展开态：全部工具调用（muted）+ 错误词正则高亮（error|fail|timeout...）+ 最终输出 Markdown + Fallbacks 链。自研首期吸收：工具持续时长、activity 新鲜度、截断指向 full output 文件、并行动画相位差；二期：错误词高亮、嵌套 fanout 树
- **配置注入与我们的映射一致**：tools → `--tools`/`--no-tools`/`--exclude-tools`；extensions allowlist / 独有 subagentOnlyExtensions；skills 选择；model；thinking（`:level` 后缀）；systemPromptMode replace/append
- **附加能力**：acceptance gates（attested/checked/verified 验收门）、watchdog、git worktree 隔离、missions/schedules、外部 CLI agent profile（claude-code/codex-exec/cursor 只读与 writer 双档）

### 5.3 对本方案的验证与借鉴

1. **方向验证**：子进程 + JSONL + CLI 参数注入在生产级扩展上成立；它依赖的扩展 API（registerTool/registerCommand/setWidget/ui.custom overlay/pi.events/getMarkdownTheme）本 fork 全部具备（已逐项核对，含 `--fork` flag 与 EventBus）。
2. **首期吸收**（防御与继承）：JSONL 单行上限 + stderr 截断 + `agent_settled` 终止判定；`context: fork` 支持（`--fork <parent-session>`，比内置进程内版多出的能力）；run debug artifacts 落盘（为远期 async 铺路）。
3. **明确不做（首期）**：async 后台、steer/resume、workflowScript、外部 CLI profile、missions——架构留缝，列为远期。

### 5.4 方案 C：直接采用 pi-subagents（替代自研）

| 维度 | 自研轻量扩展（方案 A 终态） | 直接集成 pi-subagents |
| --- | --- | --- |
| 行为面 | 对齐内置（LLM 无感知迁移） | 远超内置：async/steer/workflow/acceptance，工具 schema 大变 |
| 维护 | 自研，随发行版节奏 | 第三方包节奏；发行版仅登记 install |
| 定义兼容 | 沿用 `~/.pi/agent/subagents/` + `.pi/subagents/` | 用 `~/.pi/agent/agents/` + `.pi/agents/`，存量定义需迁移 |
| 契合度 | 完全可控，符合 install.sh 分发模式 | 符合 AGENTS.md「优先成熟生态」原则，但重量级、黑盒面大 |
| 风险 | 自研工作量（已估 3-4 天） | 上游兼容性/安全审计/依赖外部维护 |

**建议**：首期自研（方案 A 终态 + 5.3 借鉴项），保持对内置行为的等价迁移；pi-subagents 列为 install.sh 可选的重量级替代（工具名同为 `subagent`，二选一，不共存）。

## 附：关键源码索引

- 工具注册门：`core/agent-session.ts:428-430`
- 子会话工厂：`core/agent-session.ts:1139-1187`
- 扩展 API 面：`core/extensions/types.ts`（ExtensionAPI L1174 起、ExtensionContext L305 起、ui.custom L207 起）
- 扩展模块解析：`core/extensions/loader.ts`（`@schovest/pi-coding-agent` bundled alias，扩展只能用公共导出面）
- 子进程扩展示例：`examples/extensions/subagent/index.ts`（spawn pi + registerTool）
- overlay 扩展示例：`examples/extensions/doom-overlay/`
- 会话条目处理：`core/session-manager.ts:1276/1371-1440/1657-1686/2027-2074`
