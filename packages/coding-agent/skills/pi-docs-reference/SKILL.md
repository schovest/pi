---
name: pi-docs-reference
description: >
  Use when 需要查阅 Pi Agent 官方文档（~/.local/share/pi/docs/）确认任何配置项
  的格式、允许值、默认值、生效范围，或了解 Pi Agent 的任意功能细节（设置、
  子 Agent、MCP、模型、技能、扩展、包、主题、快捷键、提供商、会话、SDK 等）。
---

# Pi 官方文档查阅参考（Pi Docs Reference）

Pi Agent 官方文档位于 `~/.local/share/pi/docs/`。**所有配置操作必须先查阅对应文档，禁止凭记忆或猜测。**

## 文档目录

| 文档 | 内容说明 | 配置相关性 |
| ------ | ---------- | ------------ |
| `settings.md` | **★ 最常用** — 所有设置项完整参考（settings.json 全局/项目级配置） | 直接配置 |
| `subagents.md` | **★ 最常用** — 子 Agent 创建、配置、管理（frontmatter 格式、工具集、运行模式） | 直接配置 |
| `models.md` | 模型配置，添加自定义模型条目 | 直接配置 |
| `mcp.md` | MCP 服务器配置（mcp.json 格式、连接管理） | 直接配置 |
| `extensions.md` | 扩展系统，TypeScript 扩展编写与加载 | 直接配置 |
| `skills.md` | 技能系统，技能创建与加载 | 直接配置 |
| `packages.md` | Pi 包管理，npm/git 包安装与配置 | 直接配置 |
| `plugins.md` | Claude 插件兼容层，插件安装与配置 | 直接配置 |
| `prompt-templates.md` | 提示模板，可复用提示词 | 直接配置 |
| `themes.md` | 主题配置，内置与自定义主题 | 直接配置 |
| `keybindings.md` | 快捷键配置 | 直接配置 |
| `providers.md` | 提供商配置，API 密钥与订阅设置 | 直接配置 |
| `custom-provider.md` | 自定义提供商，自定义 API 与 OAuth | 直接配置 |
| `compaction.md` | 上下文压缩配置 | 直接配置 |
| `security.md` | 安全设置，项目信任、沙箱边界 | 直接配置 |
| `sessions.md` / `session-format.md` | 会话管理、目录、分支；会话文件格式规范 | 参考 |
| `index.md` | 文档索引和导航 | 导航用 |
| `quickstart.md` / `usage.md` | 快速入门；交互模式、斜杠命令 | 参考 |
| `containerization.md` | 容器化部署（Docker/OpenShell/Gondolin） | 参考 |
| `sdk.md` / `rpc.md` | SDK 编程接口；RPC 模式接口 | 参考 |
| `tui.md` / `development.md` | TUI 组件开发；开发环境搭建 | 参考 |

## 查阅工作流

```text
用户提问 → 确定涉及哪个配置领域 → read 对应文档 → 理解相关配置项
→ 读取当前配置文件对比现状 → 说明修改方案 → 用户确认后执行
```

## 查阅技巧

1. **先用 index.md 获取全局视角**：不确定问题涉及哪个文档时，先读 `index.md` 定位
2. **并行查阅多个相关文档**：配置可能横跨多文档（如创建 subagent 同时查 subagents.md + settings.md + models.md），可同时发起多个 read
3. **文档大时分段阅读**：extensions.md 约 100KB、settings.md 约 13KB，被截断时用 `read(path, offset, limit)` 分段读取
4. **文档未覆盖时**：查看实际配置文件作为参考、查看 `docs.json` 确认文档结构、如实告知用户文档未覆盖该主题

## 常用查阅场景

| 场景 | 文档 |
| ------ | ------ |
| settings.json 任意配置项 | settings.md |
| 创建/修改子 Agent | subagents.md |
| MCP 服务器配置 | mcp.md |
| 自定义模型 | models.md |
| 技能/扩展/包 | skills.md / extensions.md / packages.md |
| 提供商/API 密钥 | providers.md / custom-provider.md |
| 主题/快捷键 | themes.md / keybindings.md |
| 上下文压缩 | compaction.md |
| 项目信任/沙箱 | security.md |
