# Claude-Compatible Plugins

Pi can install a subset of Claude marketplace plugins through the `pi plugins` command family. These plugins are separate from Pi packages.

Use `pi install`, `pi remove`, `pi list`, and `pi update --extensions` for native Pi packages. Use `pi plugins ...` for Claude-compatible marketplace plugins.

## Commands

```bash
pi plugins marketplace add claude https://github.com/example/marketplace
pi plugins marketplace list
pi plugins marketplace remove claude

pi plugins install superpowers@claude
pi plugins install https://github.com/user/claude-plugin
pi plugins install ./local/plugin -l

pi plugins list
pi plugins remove superpowers
pi plugins update
pi plugins update superpowers
```

By default, plugin settings are written to `~/.pi/agent/settings.json` and plugin clones are stored in `~/.pi/agent/plugins/`. Use `-l` with `install` or `remove` to use project scope: `.pi/settings.json` and `.pi/plugins/`.

## Supported Claude Fields

Pi reads `.claude-plugin/plugin.json` and supports:

- `skills`: loaded into Pi's existing skills system.
- `commands`: loaded as Pi prompt templates.
- `mcpServers`: written to Pi-owned MCP config, `~/.pi/agent/mcp.json` for user scope or `.pi/mcp.json` for project scope.

If `skills` or `commands` are omitted, Pi also checks conventional `skills/`, `commands/`, and `.claude/commands/` directories.

MCP server names are prefixed with the plugin name to avoid collisions. For example, plugin `superpowers-chrome` server `chrome` becomes `superpowers-chrome-chrome`. `${CLAUDE_PLUGIN_ROOT}` is replaced with the installed plugin root. Other variables are left unchanged.

## Unsupported Claude Fields

Pi reports diagnostics for Claude runtime fields that it does not execute, including `hooks`, `agents`, and session hooks. Pi does not emulate Claude runtime behavior for those fields.
