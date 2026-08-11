# Primary Agents 配置要点

## 配置位置与优先级

- 内置（硬编码）：`code`（全工具、无角色 prompt）、`plan`（排除 bash/subagent，只读）
- 用户级：`~/.pi/agent/primary-agents/*.md`（覆盖内置同名）
- 项目级：`.pi/primary-agents/*.md`（从 cwd 向上查找，优先级最高）
- **文件名（不含 .md）即 agent 名**

## Frontmatter 格式

| 字段 | 类型 | 说明 |
| ------ | ------ | ------ |
| `description` | string | Agent 描述 |
| `model` | string | 切换 agent 时自动切换模型 |
| `thinking` | string | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `includedTools` / `excludedTools` | string[] | minimatch glob，规则同 subagents |
| `skills` | string[] | 过滤主会话可用 skills；未设置 → 全部 |

body 是角色 prompt，始终 prepend 在完整系统提示词最前（先于 SYSTEM.md / `--system-prompt`）。

## 与 Subagents 的区别

| 维度 | Primary Agent | Subagent |
| ------ | --------------- | ---------- |
| 作用范围 | 整个会话 | 单次任务 |
| 系统提示词 | 有独立角色 prompt | 无 |
| skills 默认 | 全部 | 不继承 |
| 切换持久化 | `defaultPrimaryAgent` 写入全局 settings | 无 |
| 并存数量 | 同时一个 | 可并行多个 |

## 常用操作

- `/agent` 选择器、`/agent <name>` 直接切换；footer 显示 `{agent} • {model} • {thinking}`
- SDK：`listPrimaryAgents` / `switchPrimaryAgent` / `currentPrimaryAgent`

## 常见坑

- 恢复逻辑 `restorePrimaryAgent()` 仅当 savedAgent ≠ "code" 且 agent 仍存在才切换
- skills 过滤只影响主会话，不影响 subagent
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/primary-agents.md")
```

对应官方文档：`primary-agents.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
