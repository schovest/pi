# Pi Built-in Plugins

`packages/plugins` holds built-in plugins that ship with this Pi distribution.

These plugins are internal distribution components, not standalone published packages. Runtime code should load them through the registry exported from `@earendil-works/pi-plugins` so new built-ins can be added without scattering source under `packages/coding-agent`.
