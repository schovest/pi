# MCP (Model Context Protocol)

Pi 内置 MCP 适配器作为插件运行，支持 stdio、SSE 和 StreamableHTTP 传输，提供 proxy tool 和 direct tools 两种调用模式，支持 OAuth 2.1 认证和 MCP Apps UI。

## 配置文件

MCP 配置从多个来源加载，按优先级合并：

| 优先级 | 路径 | 说明 |
|--------|------|------|
| 1 (低) | `~/.config/mcp/mcp.json` | 通用全局配置 |
| 2 | `~/.pi/agent/mcp.json` | Pi 全局配置 |
| 3 | `.mcp.json` | 项目配置 |
| 4 (高) | `.pi/mcp.json` | Pi 项目配置 |

Pi 优先读取标准路径（`~/.config/mcp/mcp.json`、`.mcp.json`），写入时写入 Pi 专属路径。这允许与其他 MCP 兼容工具共享服务器定义。

使用 `--mcp-config <path>` 或 CLI flag `mcp-config` 指定自定义配置路径。

## 配置结构

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "API_KEY": "xxx" }
    }
  },
  "imports": ["cursor", "claude-code"],
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10,
    "directTools": false,
    "autoAuth": true
  }
}
```

### mcpServers

服务器定义映射。每个服务器支持以下字段：

#### stdio 传输

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  "env": { "NODE_OPTIONS": "--max-old-space-size=4096" },
  "cwd": "/optional/working/directory",
  "lifecycle": "lazy",
  "idleTimeout": 15,
  "debug": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | string | 可执行命令 |
| `args` | string[] | 命令行参数 |
| `env` | object | 环境变量 |
| `cwd` | string | 工作目录 |
| `lifecycle` | string | 生命周期模式：`lazy`（默认）、`eager`、`keep-alive` |
| `idleTimeout` | number | 空闲超时（分钟），0 禁用 |
| `debug` | boolean | 显示服务器 stderr |

#### HTTP 传输

```json
{
  "url": "https://api.example.com/mcp",
  "headers": { "X-Custom-Header": "value" },
  "auth": "oauth",
  "oauth": {
    "clientId": "xxx",
    "clientSecret": "xxx",
    "scope": "read write"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `url` | string | MCP 端点 URL（SSE 或 StreamableHTTP） |
| `headers` | object | 自定义请求头 |
| `auth` | string | 认证类型：`oauth`、`bearer`、`false` |
| `bearerToken` | string | 静态 Bearer token |
| `bearerTokenEnv` | string | Bearer token 环境变量名 |
| `oauth` | object | OAuth 配置，或 `false` 禁用 |

#### OAuth 配置

```json
{
  "oauth": {
    "grantType": "authorization_code",
    "clientId": "optional-pre-registered-id",
    "clientSecret": "optional-secret",
    "scope": "optional-scopes",
    "redirectUri": "optional-redirect-uri",
    "clientName": "Pi MCP Client",
    "clientUri": "https://pi.dev"
  }
}
```

省略 `clientId` 时，SDK 自动进行动态客户端注册。`client_credentials` 授权类型无需用户交互，适合服务端场景。

#### 通用选项

| 字段 | 类型 | 说明 |
|------|------|------|
| `exposeResources` | boolean | 是否将 MCP resources 暴露为工具（默认 true） |
| `directTools` | boolean \| string[] | 注册为独立工具而非通过 proxy |
| `excludeTools` | string[] | 排除的工具名（原始名或前缀名） |

### imports

从其他工具导入 MCP 服务器配置：

```json
{
  "imports": ["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "vscode"]
}
```

导入路径：

| 工具 | 配置路径 |
|------|----------|
| cursor | `~/.cursor/mcp.json` |
| claude-code | `~/.claude/mcp.json`, `~/.claude.json` |
| claude-desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| codex | `~/.codex/config.json` |
| windsurf | `~/.windsurf/mcp.json` |
| vscode | `.vscode/mcp.json` |

导入的服务器定义优先级低于 `mcpServers` 中的显式定义。

### settings

全局 MCP 设置：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `toolPrefix` | string | `"server"` | 工具名前缀模式：`server`、`short`、`none` |
| `idleTimeout` | number | 10 | 全局空闲超时（分钟），0 禁用 |
| `directTools` | boolean | false | 默认启用 direct tools |
| `disableProxyTool` | boolean | false | 禁用 proxy tool |
| `autoAuth` | boolean | false | 自动触发 OAuth 流程 |
| `sampling` | boolean | true | 启用 LLM sampling 支持 |
| `samplingAutoApprove` | boolean | false | 自动批准 sampling 请求 |
| `authRequiredMessage` | string | - | 自定义认证提示消息 |

#### toolPrefix 模式

| 模式 | 示例 | 说明 |
|------|------|------|
| `server` | `xcodebuild_list_sims` | 完整服务器名作为前缀 |
| `short` | `xcodebuild_list_sims` | 服务器名去掉 `-mcp` 后缀 |
| `none` | `list_sims` | 无前缀（可能冲突） |

## 工具调用模式

### Proxy Tool

默认模式。所有 MCP 工具通过单一 `mcp` tool 访问：

```
Mode: tool (call) > connect > describe > search > server (list) > action > nothing (status)
```

**调用工具**：
```json
{ "tool": "xcodebuild_list_sims", "args": "{\"query\": \"iPhone\"}" }
```

**连接服务器**：
```json
{ "connect": "server-name" }
```

**描述工具**：
```json
{ "describe": "tool-name" }
```

**搜索工具**：
```json
{ "search": "xcode", "regex": false, "includeSchemas": true }
```

**列出服务器工具**：
```json
{ "server": "server-name" }
```

**获取 UI session 消息**：
```json
{ "action": "ui-messages" }
```

无参数时返回所有服务器状态。

### Direct Tools

将 MCP 工具注册为独立 Pi tool，跳过 proxy 层：

```json
{
  "mcpServers": {
    "xcodebuild": {
      "command": "npx",
      "args": ["-y", "@anthropic/xcodebuild-mcp"],
      "directTools": true
    }
  }
}
```

或指定特定工具：
```json
{
  "directTools": ["list_sims", "build"]
}
```

环境变量覆盖：
```bash
MCP_DIRECT_TOOLS=xcodebuild,other-server/tool_name
MCP_DIRECT_TOOLS=__none__  # 禁用所有 direct tools
```

Direct tools 适合高频工具，减少 proxy 层开销。Proxy tool 适合低频工具或工具发现场景。

## 命令

### CLI

```bash
pi --mcp-config /path/to/config.json  # 自定义配置路径
pi --no-mcp                           # 禁用 MCP 插件
```

### 交互式命令

| 命令 | 说明 |
|------|------|
| `/mcp` | 打开 MCP 面板，查看服务器状态、配置 direct tools |
| `/mcp setup` | 打开设置向导，导入配置或创建初始配置 |
| `/mcp reconnect [server]` | 重连服务器 |
| `/mcp tools` | 列出所有可用工具 |
| `/mcp logout <server>` | 清除 OAuth 凭证 |
| `/mcp-auth [server]` | OAuth 认证 |

### Proxy Tool 用法

```
mcp({ })                              → 显示服务器状态
mcp({ server: "name" })               → 列出服务器工具
mcp({ search: "query" })              → 搜索工具
mcp({ describe: "tool_name" })        → 显示工具参数
mcp({ connect: "server-name" })       → 连接服务器
mcp({ tool: "name", args: '{}' })     → 调用工具
mcp({ action: "ui-messages" })        → 获取 UI session 消息
```

## 认证

### OAuth 2.1

HTTP 传输服务器支持 OAuth：

1. 配置 `auth: "oauth"` 或省略（自动检测）
2. 运行 `/mcp-auth <server>` 触发授权流程
3. 浏览器打开授权页面，用户授权后回调到本地服务器
4. Token 存储在 `~/.pi/agent/oauth/`
5. 后续请求自动携带 token

`autoAuth: true` 时，检测到需要认证会自动触发流程（仅限 `client_credentials` 或交互模式）。

### Bearer Token

静态 token 配置：

```json
{
  "auth": "bearer",
  "bearerToken": "static-token"
}
```

或从环境变量读取：

```json
{
  "auth": "bearer",
  "bearerTokenEnv": "MY_API_KEY"
}
```

## 生命周期管理

### 生命周期模式

| 模式 | 行为 |
|------|------|
| `lazy` | 首次调用时连接，空闲超时后关闭 |
| `eager` | 启动时连接，空闲超时后关闭 |
| `keep-alive` | 启动时连接，永不自动关闭 |

### 空闲超时

全局设置：
```json
{
  "settings": { "idleTimeout": 10 }
}
```

服务器覆盖：
```json
{
  "mcpServers": {
    "heavy-server": {
      "command": "...",
      "idleTimeout": 30
    }
  }
}
```

`idleTimeout: 0` 禁用空闲关闭。

### 元数据缓存

工具和资源 schema 缓存在 `~/.pi/agent/mcp-metadata.json`，加速后续启动。服务器定义变更时自动失效。

## 高级功能

### MCP Resources

服务器可暴露资源（文件、数据等）。默认情况下，每个资源生成一个 `resource_<encoded_uri>` 工具用于读取。

禁用：
```json
{
  "exposeResources": false
}
```

### MCP Apps UI

支持 MCP Apps 的工具可显示嵌入式 UI：

1. 工具返回 `ui` 类型 resource
2. Pi 启动本地 HTTP 服务器托管 HTML
3. UI 在 iframe sandbox 中渲染
4. 通过 `AppBridge` JS API 与工具通信

UI session 消息通过 `mcp({ action: "ui-messages" })` 获取。

### LLM Sampling

MCP 服务器可请求 LLM 生成文本：

```json
{
  "settings": {
    "sampling": true,
    "samplingAutoApprove": false
  }
}
```

`samplingAutoApprove: true` 时自动批准，无需用户确认。非交互模式必须启用此选项。

### RepoPrompt 自动发现

检测到 RepoPrompt 安装时，setup 向导提供一键添加选项。

## 故障排查

### 服务器连接失败

1. 检查命令路径：`npx` 需要 Node.js 和网络
2. 检查环境变量：`env` 中的变量是否正确展开
3. 启用 debug 模式：`"debug": true` 显示服务器 stderr
4. 检查空闲超时：服务器可能已关闭，使用 `/mcp reconnect` 重连

### OAuth 认证失败

1. 检查 URL 是否正确
2. 检查 OAuth 配置（clientId、scope 等）
3. 检查浏览器是否打开回调页面
4. 检查 `~/.pi/agent/oauth/` 下的 token 存储

### 工具未显示

1. 检查服务器是否连接：`/mcp` 查看状态
2. 检查工具是否被排除：`excludeTools` 配置
3. 检查 direct tools 配置：`directTools` 是否正确
4. 检查元数据缓存：删除 `~/.pi/agent/mcp-metadata.json` 重新生成

### Proxy tool 未注册

`disableProxyTool: true` 且无 direct tools 时，proxy tool 不会注册。至少保留一种工具访问方式。

## 示例配置

### 本地 stdio 服务器

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "lifecycle": "lazy"
    }
  }
}
```

### HTTP 服务器 + OAuth

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app",
      "auth": "oauth"
    }
  }
}
```

### Direct tools

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/github-mcp"],
      "directTools": ["search_repositories", "create_issue"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  },
  "settings": {
    "toolPrefix": "short"
  }
}
```

### 导入其他工具配置

```json
{
  "imports": ["cursor", "claude-code"],
  "mcpServers": {
    "my-custom-server": {
      "command": "./my-mcp-server"
    }
  }
}
```

## 相关文档

- [Extensions](extensions.md) - 编写扩展注册自定义工具
- [Plugins](plugins.md) - Claude-compatible 插件可声明 `mcpServers`
- [Skills](skills.md) - 技能系统
