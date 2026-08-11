# Themes 配置要点

## 位置

- 内置 dark/light；全局 `~/.pi/agent/themes/*.json`；项目 `.pi/themes/*.json`（信任后）
- 包：`themes/` 目录或 package.json `pi.themes`；设置 `themes` 数组；CLI `--theme <path>`；`--no-themes` 禁用

## 主题 JSON 格式

| 字段 | 必填 | 说明 |
| ------ | ------ | ------ |
| `$schema` | 否 | 编辑器补全/校验 |
| `name` | 是 | 主题名，唯一 |
| `vars` | 否 | 可复用颜色变量 |
| `colors` | 是 | **必须定义全部 51 个 token**（无可选色） |
| `export` | 否 | /export HTML 用色，省略则从 userMessageBg 派生 |

## 颜色值格式（4 种）

- hex `#rrggbb`、256 色索引 0-255、vars 变量引用、`""` 终端默认色

## 常用操作

- `theme` 设置或 `/settings` 选择；首次运行自动探测终端背景选 dark/light
- 编辑当前激活主题文件自动热重载

## 常见坑

- Pi 用 24-bit RGB，旧终端自动回退 256 色近似（`echo $COLORTERM` 应为 truecolor/24bit）
- 51 token 分组：核心 UI 11、背景/内容 11、Markdown 10、工具 diff 3、语法高亮 9、思考层级边框 7、bashMode 1
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/themes.md")
```

对应官方文档：`themes.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
