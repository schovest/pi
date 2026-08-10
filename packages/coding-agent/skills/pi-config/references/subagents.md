# Subagents 配置要点

## 配置位置

- 用户级：`~/.pi/agent/subagents/*.md`（所有项目可用）
- 项目级：`.pi/subagents/*.md`（仅当前项目，需项目信任）

## Frontmatter 格式

| 字段 | 类型 | 说明 |
| ------ | ------ | ------ |
| `description` | string | Agent 描述，用于工具提示（建议必填） |
| `model` | string | 模型 ID，如 `cli-proxy-api/deepseek-v4-pro`，可被任务参数覆盖 |
| `thinking` | string | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `includedTools` | string[] | 允许的工具列表（minimatch glob，大小写不敏感） |
| `excludedTools` | string[] | 排除的工具列表（glob） |
| `skills` | string[] | 继承的 skills；未设置/空 → 不继承；`"*"` → 全部 |

旧字段 `tools` 仍可读，自动映射为 `includedTools`。

## 工具控制规则

- `"read"` 精确匹配、`"read*"` 前缀匹配、`"!*"` 否定全部
- 两者均未设置 → 默认工具集 `read, bash, edit, write`
- `includedTools: []` → 无工具；**同时设置时 includedTools 生效、excludedTools 被忽略**
- 内置工具名：`read/bash/edit/write/grep/find/ls` + 扩展注册的 `subagent` 等

## 运行模式与作用域

- 单任务 / 并行（最多 8 任务、并发 4，输出按输入顺序）/ 链式（`{previous}` 占位符，首步失败即停）
- scope：`user`（默认，内置+用户级）/ `project`（内置+项目级）/ `both`；项目级覆盖同名用户级
- 内置：`explorer`（全工具、prompt 约束只读）、`worker`（全工具）、`reviewer`（全工具只读）

## 常见坑

- 并行模式失败不中断其他任务（链式会停）；大输出被截断，完整结果在 tool details
- 修改后无需重启，下次调用生效；状态栏 `subagents:N`，`/running-subagents` 查看详情
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/subagents.md")
```

对应官方文档：`subagents.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
