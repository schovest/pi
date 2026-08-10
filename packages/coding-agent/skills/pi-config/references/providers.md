# Providers 配置要点

## 配置位置

- 订阅/API key/OAuth 凭证存 `~/.pi/agent/auth.json`（0600 权限）
- 环境变量参考实现 `packages/ai/src/env-api-keys.ts`

## 认证方式

- **订阅类**（`/login`）：ChatGPT Plus/Pro（Codex）、Claude Pro/Max、GitHub Copilot（可配 GHES 域名）；token 自动刷新
- **API key**：`/login` 写入 auth.json 或设环境变量。格式 `{"<key>": {"type":"api_key","key":"..."}}`；auth.json key 与环境变量对应（节选）：`anthropic/ANTHROPIC_API_KEY`、`openai/OPENAI_API_KEY`、`deepseek/DEEPSEEK_API_KEY`、`google/GEMINI_API_KEY`、`mistral/MISTRAL_API_KEY`、`groq/GROQ_API_KEY`、`openrouter/OPENROUTER_API_KEY`、`xai/XAI_API_KEY`、`huggingface/HF_TOKEN`、`kimi-coding/KIMI_API_KEY`、`minimax`、`xiaomi`、`azure-openai-responses` 等
- **云提供商**：Azure（AZURE_OPENAI_API_KEY + BASE_URL 或 RESOURCE_NAME）、Bedrock（AWS_PROFILE / IAM / AWS_BEARER_TOKEN_BEDROCK，region 默认 us-east-1）、Vertex（ADC，GOOGLE_CLOUD_PROJECT / GOOGLE_APPLICATION_CREDENTIALS）

## Key 值语法

- `!command` 执行命令取 stdout（进程生命周期内缓存）
- `$VAR` / `${VAR}` 环境插值；`$$`→字面 `$`、`$!`→字面 `!`；旧式全大写值自动迁移为 `$VAR`
- auth.json 优先级高于环境变量；凭证解析顺序：CLI `--api-key` → auth.json → 环境变量 → models.json 自定义 key

## 自定义 Provider（扩展代码）

- `pi.registerProvider(name, config)` 注册；工厂可为 async（动态拉取模型）；`pi.unregisterProvider(name)` 移除
- 仅给 `baseUrl`/`headers`（无 models）→ 保留该提供商所有现有模型；给 `models` → **替换**全部现有模型
- api 类型：`anthropic-messages`、`openai-completions`（大多数兼容）、`openai-responses`、`mistral-conversations`（原生 Mistral）、`google-generative-ai`、`google-vertex`、`bedrock-converse-stream`
- OAuth：`oauth.{name, login(callbacks), refreshToken, getApiKey, modifyModels?}`；凭据持久化到 auth.json；`/login <provider>` 触发
- 非标准 API：实现 `streamSimple(model, context, options)` 返回 AssistantMessageEventStream
- 参考实现：`packages/ai/src/providers/`；示例 `examples/extensions/custom-provider-anthropic/`

## 常见坑

- `$FOO_BAR` 整个是变量名，字面后缀用 `${FOO}_BAR`；缺失环境变量视为未解析
- 上下文溢出自动压缩重试仅在 errorMessage 匹配内置模式时触发；改写溢出错误勿把 rate limit 类错误改写成 context_length_exceeded
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/providers.md")
```

对应官方文档：`providers.md、custom-provider.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
