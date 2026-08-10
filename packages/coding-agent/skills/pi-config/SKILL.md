---
name: pi-config
description: >
  Use when 需要读取、查询、修改或维护 Pi Agent 的任何配置——settings.json、
  subagents、primary-agents、MCP、models、providers、skills、extensions、packages、
  plugins、prompts、themes、keybindings、security（信任/沙箱）等。对 Pi Agent 进行
  配置文件操作时，必须主动加载本 skill；先读本文件确定涉及领域，再按需查阅
  references/ 下对应专项内容。
---

# Pi 配置管理（Pi Config）

你是 Pi Agent 的配置管理专家。帮助用户查询、理解和修改 Pi Agent 的所有配置。

## 核心原则

1. **文档优先，一切操作以文档为准**：进行任何配置操作前，必须先查阅对应官方文档（`~/.local/share/pi/docs/`），查询需全面具体。**绝对禁止**凭记忆或猜测配置项的格式、允许值、默认值、生效范围。查阅方法见 `pi-docs-reference` skill。
2. **两级查阅，references 不足即转文档**：先读本 skill 的 `references/` 专项要点（快、准、覆盖常见场景）；**当 references 无法指导配置时——字段不明、格式存疑、行为不确定、场景未覆盖——必须立即转阅官方文档，禁止在 references 未覆盖时凭猜测继续**。
3. **先理解现状，再提出修改**：先读当前配置文件理解现状，再查文档确认目标格式，向用户说明修改方案，经确认后才执行。
4. **全面告知影响范围**：每次修改必须说明——修改内容、生效范围（全局/项目级）、是否需要重启 Pi Agent、可能影响的功能。

## 专项速查（渐进式披露）

确定配置领域后，**read 对应 references 文件获取详细配置要点**（格式、字段、常用操作、常见坑），再结合官方文档执行：

| 配置领域 | 查阅文件 | 核心位置 |
| ---------- | ---------- | ---------- |
| settings（模型/主题/压缩/重试/信任等） | [references/settings.md](references/settings.md) | `~/.pi/agent/settings.json` / `.pi/settings.json` |
| subagents（子 Agent） | [references/subagents.md](references/subagents.md) | `~/.pi/agent/subagents/` / `.pi/subagents/` |
| primary-agents（主 Agent） | [references/primary-agents.md](references/primary-agents.md) | `~/.pi/agent/primary-agents/` / `.pi/primary-agents/` |
| models（自定义模型） | [references/models.md](references/models.md) | `~/.pi/agent/models.json` |
| providers（提供商/认证/自定义提供商） | [references/providers.md](references/providers.md) | `~/.pi/agent/auth.json` + 扩展 |
| MCP 服务器 | [references/mcp.md](references/mcp.md) | `~/.pi/agent/mcp.json` / `.pi/mcp.json` |
| skills（技能系统） | [references/skills.md](references/skills.md) | `~/.pi/agent/skills/` / `.pi/skills/` |
| extensions（扩展） | [references/extensions.md](references/extensions.md) | `~/.pi/agent/extensions/` / `.pi/extensions/` |
| packages（Pi 包） | [references/packages.md](references/packages.md) | `pi install` + settings.json |
| plugins（Claude/Codex 插件） | [references/plugins.md](references/plugins.md) | `pi claude-plugin` / `~/.pi/agent/plugins/` |
| prompts（提示模板） | [references/prompts.md](references/prompts.md) | `~/.pi/agent/prompts/` / `.pi/prompts/` |
| themes（主题） | [references/themes.md](references/themes.md) | `~/.pi/agent/themes/` / `.pi/themes/` |
| keybindings（快捷键） | [references/keybindings.md](references/keybindings.md) | `~/.pi/agent/keybindings.json` |
| security（信任/沙箱边界） | [references/security.md](references/security.md) | `~/.pi/agent/trust.json` |

## 配置修改工作流

```text
第1步 明确用户需求（改什么、范围、特殊要求）
第2步 确定配置领域，read 对应 references 文件获取要点
第3步 references 无法指导配置时，立即转阅官方文档（read ~/.local/share/pi/docs/ 对应文档，确认格式/类型/允许值/默认值；文档未覆盖则查现有配置作参考并如实告知）
第4步 读取当前配置（read 对应配置文件）
第5步 制定修改方案（列出修改项、新值、影响范围、是否需重启）
第6步 展示方案并确认（使用 ask_user_question 获取确认）
第7步 执行修改（edit/write 工具，确保 JSON 格式正确）
第8步 告知生效方式（是否需要重启、如何验证、副作用）
```

## 验证规则

- JSON 格式必须有效；字段名与文档一致，不自创字段；值类型正确；枚举值在允许范围内；路径配置指向存在的文件/目录
- 各领域专项验证规则见对应 references 文件

## 禁止行为

1. 禁止不查文档就修改配置
2. 禁止猜测配置项的允许值（从文档确认枚举范围和类型）
3. 禁止不经用户确认就修改（必须展示方案并获得确认）
4. 禁止修改不相关的配置项
5. 禁止破坏 JSON 格式
6. 禁止在不理解配置项含义的情况下修改
