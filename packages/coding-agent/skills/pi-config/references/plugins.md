# Plugins 配置要点（Claude / Codex 插件）

## 安装与配置

- 命令族 `pi claude-plugin`：`marketplace add/list/remove <name> <url>`、`search [query] [--marketplace/-m]`、`install <name>@<marketplace>|<url>|./local`、`list`、`remove <name>`、`update [name]`
- 默认用户级 `~/.pi/agent/settings.json` + 克隆存 `~/.pi/agent/plugins/`；`-l` 切项目级 `.pi/settings.json` + `.pi/plugins/`
- 内置默认市场 `claude-plugins-official`（anthropics/claude-plugins-official），无需配置即可 search/install
- 交互模式 `/claude-plugin` 打开管理器（搜索/装/卸/更新/市场管理）
- 对称的 `pi codex-plugin` 命令族：内置 OpenAI 官方市场 `openai`；`/codex-plugin` 交互管理器

## 插件兼容机制

- 读取 `.claude-plugin/plugin.json`，支持字段：
  - `skills` → 并入 Pi 技能系统
  - `commands` → 作 Pi prompt templates 加载
  - `mcpServers` → 写入 `~/.pi/agent/mcp.json` 或项目 `.pi/mcp.json`
- skills/commands 省略时回退约定目录 `skills/`、`commands/`、`.claude/commands/`
- MCP server 名加插件名前缀防冲突；`${CLAUDE_PLUGIN_ROOT}` 替换为安装根
- 不支持的字段（hooks、agents、session hooks）仅报告诊断，不模拟 Claude 运行时行为

## Codex 插件差异

- hooks 映射 12 个 Pi 事件（session_start/end、pre/post_tool_use 等），子进程执行（无 args 走 sh -c），stdin JSON、stdout JSON、exit code 2 = block
- Pi 不支持 `.app.json`（解析时告警跳过），实际生效的是 skills/MCP 部分

## 常见坑

- **Pi 包与 Claude 插件互不相通**：`pi install` 管原生包，`pi claude-plugin` 管市场插件
- 内置默认市场不可删除；marketplace remove 只删覆盖
