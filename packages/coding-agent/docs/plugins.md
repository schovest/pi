# Claude-Compatible Plugins

Pi can install a subset of Claude marketplace plugins through the `pi claude-plugin` command family. These plugins are separate from Pi packages.

Use `pi install`, `pi remove`, `pi list`, and `pi update --extensions` for native Pi packages. Use `pi claude-plugin ...` for Claude-compatible marketplace plugins.

## Commands

```bash
pi claude-plugin marketplace add claude https://github.com/example/marketplace
pi claude-plugin marketplace list
pi claude-plugin marketplace remove claude

pi claude-plugin search
pi claude-plugin search super
pi claude-plugin search super --marketplace claude

pi claude-plugin install superpowers@claude
pi claude-plugin install https://github.com/user/claude-plugin
pi claude-plugin install ./local/plugin -l

pi claude-plugin list
pi claude-plugin remove superpowers
pi claude-plugin update
pi claude-plugin update superpowers
```

By default, plugin settings are written to `~/.pi/agent/settings.json` and plugin clones are stored in `~/.pi/agent/plugins/`. Use `-l` with `install` or `remove` to use project scope: `.pi/settings.json` and `.pi/plugins/`.

`pi claude-plugin search [query]` searches the catalogs from configured `pluginMarketplaces`. With no query it lists all catalog entries. Use `--marketplace <name>` or `-m <name>` to search one configured marketplace.

In interactive mode, `/claude-plugin` opens the plugin manager. It can search marketplace catalogs, install a selected plugin to user or project scope, list installed user/project plugins, update or remove installed plugins, and list/add/remove configured marketplaces. Marketplace add/remove writes user settings by default, matching the CLI behavior.

## Supported Claude Fields

Pi reads `.claude-plugin/plugin.json` and supports:

- `skills`: loaded into Pi's existing skills system.
- `commands`: loaded as Pi prompt templates.
- `mcpServers`: written to Pi-owned MCP config, `~/.pi/agent/mcp.json` for user scope or `.pi/mcp.json` for project scope.

If `skills` or `commands` are omitted, Pi also checks conventional `skills/`, `commands/`, and `.claude/commands/` directories.

MCP server names are prefixed with the plugin name to avoid collisions. For example, plugin `superpowers-chrome` server `chrome` becomes `superpowers-chrome-chrome`. `${CLAUDE_PLUGIN_ROOT}` is replaced with the installed plugin root. Other variables are left unchanged.

## Unsupported Claude Fields

Pi reports diagnostics for Claude runtime fields that it does not execute, including `hooks`, `agents`, and session hooks. Pi does not emulate Claude runtime behavior for those fields.

## Codex-Compatible Plugins

Pi 也可以安装 codex 生态的插件（`pi codex-plugin` 命令族），与原生 Pi packages 和 `claude-plugin` 分开管理。交互模式下输入 `/codex-plugin` 可打开图形化管理器（搜索市场/安装/卸载/更新/市场管理），行为与 `/claude-plugin` 对称。

```bash
pi codex-plugin marketplace add my-market https://github.com/example/codex-marketplace
pi codex-plugin marketplace list
pi codex-plugin marketplace remove my-market
pi codex-plugin search
pi codex-plugin search super --marketplace my-market
pi codex-plugin install superpowers@my-market
pi codex-plugin install https://github.com/user/codex-plugin
pi codex-plugin install ./local/plugin -l
pi codex-plugin list
pi codex-plugin remove superpowers
pi codex-plugin update
pi codex-plugin hooks list
pi codex-plugin hooks disable superpowers
pi codex-plugin hooks enable superpowers
```

- **安装与信任**：`install` 支持市场条目（`name@marketplace`）、git 仓库（含子目录）、npm 包和本地路径；默认写入用户级 `~/.pi/agent/settings.json` 并在 `~/.pi/agent/codex-plugins/` 存储，`-l` 改为项目级 `.pi/settings.json` 与 `.pi/codex-plugins/`。安装即信任——安装成功会打印每个事件的 hooks 摘要（每行 `hooks: <event> <command>`，无 hooks 打印 `hooks: none`）。
- **hooks 行为**：读取新格式 `.codex-plugin/plugin.json` 或旧格式根 `plugin.json` 的 `hooks` 字段，映射为 Pi 事件（`session_start`、`session_end`、`user_prompt_submit`、`pre_tool_use`、`permission_request`、`post_tool_use`、`pre_compact`、`post_compact`、`subagent_start`、`subagent_stop`、`stop`、`turn_start`）。manifest 未声明 `hooks` 字段或声明为空时，回退加载插件根的默认 `hooks/hooks.json`。hook 以子进程执行（无 args 走 `sh -c`，有 args 走 spawn 数组），stdin 传入 JSON 事件负载，stdout 返回 JSON 结果，exit code 2 表示 block；注入 `PLUGIN_ROOT`/`PLUGIN_DATA` 环境变量。`hooks list/disable/enable` 即时查看与启停（disable 即时生效）。
- **其他字段**：`skills` 并入 Pi 技能系统（metadata `origin: "codex-plugin"`）；`mcpServers` 注册进 Pi 的 mcp.json（`<plugin>-` 前缀防冲突，`${PLUGIN_ROOT}` 替换为安装根，`remove` 时清理）。`apps` 字段（codex 运行时专属）不受支持，解析时输出诊断。
