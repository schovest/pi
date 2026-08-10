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
