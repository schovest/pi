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
