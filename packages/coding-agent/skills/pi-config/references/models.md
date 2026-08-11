# Models 配置要点

## 配置位置

- `~/.pi/agent/models.json`（单一位置）；每次打开 `/model` 时重载，会话中编辑无需重启

## 模型条目格式

| 字段 | 默认 | 说明 |
| ------ | ------ | ------ |
| `id` | 必填 | 传给 API 的标识；`/model`、`--list-models` 按 id 列条目 |
| `name` | = id | 仅用于匹配（`--model` 模式）与次要展示 |
| `api` | 取 provider | `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai` |
| `reasoning` | false | 推理模型标记 |
| `thinkingLevelMap` | — | 映射 pi 级别到供应商值；不支持的级别用 `null`（UI 隐藏/跳过） |
| `input` | `["text"]` | 可含 `image` |
| `contextWindow` / `maxTokens` | 128000 / 16384 | 上下文窗口与最大输出 |
| `cost` | 全 0 | 每百万 token：input/output/cacheRead/cacheWrite |
| `compat` | — | provider 级合并（见 providers） |
| `resilience` | 省略禁用 | `high`（不限）/ `medium`（50 turns）/ `low`（80 turns） |

## Provider 级字段（models.json 中 provider 条目）

- `baseUrl`、`api`、`apiKey`、`headers`、`authHeader`（true 则自动加 `Authorization: Bearer <apiKey>`）
- `models`、`modelOverrides`（按 id 定制内置模型，未知 id 忽略）
- apiKey/headers 值语法：`!command`（执行命令取 stdout）、`$ENV`/`${ENV}` 插值（`$$`→`$`、`$!`→`!`）、字面量

## 覆盖内置 Provider

- 只给 `baseUrl` → 代理且保留全部内置模型
- 带 `models` 数组 → 内置保留 + 按 id upsert（同 id 自定义模型替换内置）

## 常见坑

- apiKey 必填但 Ollama 忽略（任意值可）
- OpenAI 兼容服务器不认 developer 角色 → `compat.supportsDeveloperRole: false`
- 不支持 reasoning_effort → `compat.supportsReasoningEffort: false`
- shell 命令在请求时解析、无内置 TTL/缓存，需自包脚本实现缓存
- anthropic 兼容代理默认发 per-tool `eager_input_streaming: true`，不接受时设 `supportsEagerToolInputStreaming: false`
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/models.md")
```

对应官方文档：`models.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
