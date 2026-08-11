# Prompts（提示模板）配置要点

## 位置

- 全局：`~/.pi/agent/prompts/*.md`；项目：`.pi/prompts/*.md`（信任后）；包：`prompts/` 目录或 package.json `pi.prompts`
- 设置 `prompts` 数组；CLI `--prompt-template <path>`（可重复）；`--no-prompt-templates` 禁用

## 格式

- Markdown 文件，**文件名即命令名**（review.md → `/review`）
- frontmatter：
  - `description` 可选（缺省取首个非空行）
  - `argument-hint` 可选（显示于自动补全；`<>` 必填、`[]` 可选）

## 常用操作

- 编辑器输入 `/name` 展开；`/name arg1 "arg2"` 传参；自动补全列出模板+描述
- 位置参数：`$1`、`$@`/`$ARGUMENTS`、`${1:-默认值}`、`${@:N}`、`${@:N:L}`（1 起始）

## 常见坑

- `prompts/` 目录发现**非递归**，子目录模板须通过 `prompts` 设置或包清单显式添加
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/prompt-templates.md")
```

对应官方文档：`prompt-templates.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
