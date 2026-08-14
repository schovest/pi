# Skills 系统配置要点

## 存放位置

- **内置**：安装目录 `skills/`（pi-config、pi-docs-reference，最后加载）
- 全局：`~/.pi/agent/skills/`、`~/.agents/skills/`（默认禁用，需 `enableAgentsSkills: true`）
- 项目（信任后）：`.pi/skills/`、`.agents/skills/`（cwd 及祖先目录，至 git 根；默认禁用，同上）
- 包：`skills/` 目录或 package.json `pi.skills` 条目
- 设置 `skills` 数组；CLI `--skill <path>`（可重复，`--no-skills` 时仍加载）；`--no-skills` 禁用发现

## SKILL.md 格式

| 字段 | 必填 | 约束 |
| ------ | ------ | ------ |
| `name` | 是 | 1-64 字符，小写字母/数字/连字符，无首尾/连续连字符 |
| `description` | 是 | ≤1024 字符，描述何时使用 |
| `license` / `compatibility` / `metadata` | 否 | 可选元数据 |
| `allowed-tools` | 否 | 预授权工具（实验性） |
| `disable-model-invocation` | 否 | true 时对模型隐藏，仅 `/skill:name` 可调 |

## 发现机制

- 启动时扫描 name+description 注入 system prompt（XML 格式，渐进式披露）；完整 SKILL.md 按需 `read` 加载
- 目录含 SKILL.md 递归发现；**含 SKILL.md 的目录不再递归子目录**
- `~/.pi/agent/skills/` 与 `.pi/skills/` 下根级 `.md` 视为独立技能；`.agents/skills/` 下根级 .md 忽略
- 内置最后加载，同名用户/项目技能优先；缺 description 不加载

## 常用操作

- `/skill:name`、`/skill:name args`（参数以 `User: <args>` 追加）
- `enableSkillCommands` 设置或 `/settings` 开关

## 常见坑

- 多数格式违规仅警告；未知 frontmatter 字段忽略；同名冲突保留先发现的
- skill 含可执行代码，加载前需审查内容
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/skills.md")
```

对应官方文档：`skills.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
