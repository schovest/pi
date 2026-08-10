# Keybindings 配置要点

## 位置与生效

- `~/.pi/agent/keybindings.json`；修改后 `/reload` 生效（无需重启会话）

## 配置格式

- 使用命名空间 id（如 `tui.editor.cursorUp`）；每个动作可绑单键或数组 `["up","ctrl+p"]`
- 用户配置覆盖默认；旧版非命名空间 id 自动迁移
- 键格式 `modifier+key`：修饰键 ctrl/shift/alt 可组合；键含 a-z、0-9、特殊键（escape/enter/tab/space/backspace/delete/home/end/pageUp/pageDown/方向键等）、f1-f12、符号键

## 命名空间分类

| 命名空间 | 内容 |
| ---------- | ------ |
| `tui.editor.*` | 光标/删除/剪切环 yank/undo |
| `tui.input.*` | newLine/submit/tab/copy |
| `tui.select.*` | 选择列表 |
| `app.*` | interrupt/clear/exit/suspend/外部编辑器/复制消息/粘贴图片 |
| `app.session.*` | 会话管理 |
| `app.model.*` / `app.thinking.*` | 模型与思考切换 |
| `app.tree.*` | 树导航/过滤 |
| `app.commandPalette` / `app.message.*` / `app.models.*` | 命令面板/消息/模型选择器 |

## 常见坑

- 原生 Windows 上 `app.suspend` 无默认绑定（终端不支持 Unix 作业控制）；Windows 粘贴图片默认 `alt+v`（其他平台 `ctrl+v`）
- 默认值中 `ctrl+p`/`ctrl+d`/`ctrl+t`/`ctrl+l`/`ctrl+o`/`ctrl+a` 等在**不同上下文有不同含义**（如 `ctrl+p` 同时是光标上移补充、session 路径切换、模型切换——按上下文区分）
