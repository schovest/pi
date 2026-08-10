# MCP 配置要点

## 配置位置（按优先级合并，低 → 高）

- `~/.config/mcp/mcp.json`（通用全局）→ `~/.pi/agent/mcp.json`（Pi 全局）→ `.mcp.json`（项目）→ `.pi/mcp.json`（Pi 项目）
- 可用 `--mcp-config <path>` 指定自定义路径；读标准路径、写 Pi 专属路径

## mcp.json 格式

```json
{
  "mcpServers": { "server-name": { ... } },
  "imports": ["cursor", "claude-code"],
  "settings": { "toolPrefix": "server", "idleTimeout": 10 }
}
```

- **stdio 传输**：`command`、`args`、`env`、`cwd`、`lifecycle`（`lazy` 默认 / `eager` / `keep-alive`）、`idleTimeout`（分钟，0 禁用）、`debug`
- **HTTP 传输**：`url`（SSE/StreamableHTTP）、`headers`、`auth`（`oauth` / `bearer` / `false`）、`bearerToken`、`oauth`（grantType 默认 authorization_code，省略 clientId 自动动态注册；client_credentials 无需交互）
- **通用**：`exposeResources`（默认 true）、`directTools`（boolean | string[]）、`excludeTools`
- settings 默认：`toolPrefix="server"`、`idleTimeout=10`、`directTools=false`、`disableProxyTool=false`、`autoAuth=false`、`sampling=true`、`samplingAutoApprove=false`

## 连接与管理

- 默认 proxy 单入口 `mcp`（Mode: tool > connect > describe > search > server > action > nothing）
- `directTools` 注册为独立 Pi 工具，env 覆盖 `MCP_DIRECT_TOOLS=server/tool`，`__none__` 全禁用
- OAuth token 存 `~/.pi/agent/oauth/`；元数据缓存 `~/.pi/agent/mcp-metadata.json`（服务器定义变更时自动失效）

## 常用操作

- 交互：`/mcp`、`/mcp setup`、`/mcp reconnect [server]`、`/mcp tools`、`/mcp logout <server>`、`/mcp-auth [server]`
- 工具调用：`mcp({tool,args})`、`{connect}`、`{describe}`、`{search, regex, includeSchemas}`、`{server}`、`{action:"ui-messages"}`

## 常见坑

- 连接失败查命令路径/env/debug:true/重连；OAuth 失败查 URL、配置、token 目录
- 工具未显示查 excludeTools、directTools，必要时删元数据缓存
- `disableProxyTool:true` 且无 direct tools 时 proxy 不注册；`samplingAutoApprove` 在非交互模式必须 true
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/mcp.md")
```

对应官方文档：`mcp.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
