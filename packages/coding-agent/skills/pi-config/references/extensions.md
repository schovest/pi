# Extensions 配置要点

## 位置与加载

- 自动发现：`~/.pi/agent/extensions/*.ts` 与 `~/.pi/agent/extensions/*/index.ts`（全局）；`.pi/extensions/*.ts` 与 `.pi/extensions/*/index.ts`（项目级，须信任后加载）
- settings.json 可加 `extensions: ["/path/to/file.ts", "/path/to/dir"]` 附加路径；`pi -e ./x.ts` 仅临时测试
- 自动发现位置的扩展可 `/reload` 热重载；加载器为 jiti（TS 免编译）
- 依赖 npm 包：扩展目录放 package.json + npm install；运行时依赖必须放 `dependencies`（安装默认 `--omit=dev`）

## 扩展结构

- 默认导出工厂函数：`export default function (pi: ExtensionAPI)`，可同步或 async（async 完成后才继续启动）
- 类型导入自 `@schovest/pi-coding-agent`（ExtensionAPI、ExtensionContext）；参数 schema 用 `typebox`（`Type.Object`）；枚举用 `@schovest/pi-ai` 的 `StringEnum`
- 三种形态：单文件 .ts / 目录含 index.ts / 目录含 package.json（`pi.extensions: ["./src/index.ts"]`）

## 核心 API

- **事件**（`pi.on`）：`project_trust → session_start → resources_discover → input → before_agent_start → agent_start → turn_start → context → before_provider_request/headers → after_provider_response → tool_execution_start → tool_call（可 block，event.input 可变）→ tool_result（可改结果）→ tool_execution_end → turn_end → agent_end → agent_settled`；会话切换/分支/压缩/树导航各配 before/after 事件
- **工具**：`pi.registerTool({name,label,description,promptSnippet,promptGuidelines,parameters,prepareArguments,execute,renderCall,renderResult})`；同名可覆盖内置工具；`--no-builtin-tools` 禁用内置
- 其他：`registerCommand`（重名加 `:1` 后缀）、`registerShortcut`、`registerFlag`、`registerProvider`、`sendMessage/sendUserMessage`（deliverAs: "steer"/"followUp"/"nextTurn"）、`appendEntry`、`pi.events` 扩展间事件总线、`exec`、`getAllTools/setActiveTools`、`setModel/setThinkingLevel`
- **UI**：ctx.ui 的 select/confirm/input/editor/notify、setStatus、setWidget、setTitle、setFooter、addAutocompleteProvider、setEditorComponent
- **ctx**：sessionManager、signal（agent 中止信号）、mode、hasUI、isProjectTrusted()、getContextUsage()、compact()、shutdown()、reload()

## 常见坑

- 有状态工具把状态放 tool result `details`（分支可重建），session_start 里从 getBranch() 重建
- 自定义改文件工具须用 `withFileMutationQueue(绝对路径, fn)` 与内置 edit/write 同队列，防并行覆盖丢改
- execute 抛错才置 isError（返回值永不置错）；`terminate:true` 可跳过后续 LLM 调用
- promptGuidelines 追加到 Guidelines 段无工具名前缀，必须自带工具名
- 输出截断内置限制 50KB / 2000 行；`truncateHead/truncateTail/truncateLine/formatSize` 辅助
