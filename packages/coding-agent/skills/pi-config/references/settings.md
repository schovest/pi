# Settings 配置要点

## 配置位置与合并规则

- 全局：`~/.pi/agent/settings.json`；项目级：`.pi/settings.json`
- **项目级覆盖全局**；嵌套对象（如 `compaction`）逐 key 深度合并，不是整体替换
- 路径解析：全局相对 `~/.pi/agent`，项目相对 `.pi`；支持绝对路径与 `~`

## 核心配置项

| 配置项 | 含义 | 默认/允许值 |
| -------- | ------ | ------------- |
| `defaultProvider` / `defaultModel` | 默认提供商与模型 | 如 `"anthropic"`、`"openai"` |
| `defaultThinkingLevel` | 思考级别 | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `theme` | 主题 | `"dark"`（默认）/ `"light"` / 自定义 |
| `defaultProjectTrust` | 项目信任默认策略 | `"ask"`（默认）/ `"always"` / `"never"`，仅全局设置 |
| `compaction.enabled` / `reserveTokens` / `keepRecentTokens` | 上下文压缩 | true / 16384 / 20000 |
| `retry.enabled` / `maxRetries` / `baseDelayMs` | 重试机制 | true / 3 / 2000 |
| `retry.provider.maxRetries` / `maxRetryDelayMs` | provider 重试 | 3（遇配额挂起可改 0）/ 60000（0 禁用上限） |
| `steeringMode` / `followUpMode` | 引导与追问模式 | `"one-at-a-time"`（默认）/ `"all"` |
| `transport` | 传输 | `"auto"` / `"sse"` / `"websocket"` / `"websocket-cached"` |
| `bashBackgroundTimeout` | 后台命令超时 | 默认 120s，超时转后台而非被杀 |
| `gitSnapshotMode` | git 快照 | `"include-untracked"`（默认）/ `"tracked-only"` / `"all"` |
| `gitSnapshotMaxCount` | 快照数上限 | 100（跨会话），0 禁用 |
| `packages` / `extensions` / `skills` / `prompts` / `themes` | 资源加载 | 数组；packages 支持字符串或对象（按资源类型过滤） |
| `enabledModels` | 模型切换列表 | string[]，同 `--models` 格式 |
| `sessionDir` | 会话目录 | 优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > 配置项 |
| `terminal.showImages` / `images.autoResize` | 终端图片 | true / true（2000x2000） |

## 常用操作

- 环境变量：`PI_SKIP_VERSION_CHECK=1` 禁用版本检查；`--offline` / `PI_OFFLINE=1` 禁用全部启动联网（含检查、遥测）
- `npmCommand` 用 argv 数组形式（如 `["mise","exec","node@20","--","npm"]`）；npm 包装到 `~/.pi/agent/npm/`（用户级）或 `.pi/npm/`（项目级）
- 资源数组支持 glob 过滤：`!pattern` 排除、`+path` 强制包含、`-path` 强制排除

## 常见坑

- 项目信任未解决时，非交互模式（`-p`、`--mode json/rpc`）不弹信任提示：`"ask"`/`"never"` 忽略受信任门禁资源，`"always"` 信任；`--approve`/`-a`、`--no-approve`/`-na` 可单次覆盖
- `/trust` 只写 `~/.pi/agent/trust.json`，当前会话不重载，需重启生效
