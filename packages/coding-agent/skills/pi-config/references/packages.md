# Packages 配置要点

## 安装方式

- **npm**：`npm:@scope/pkg@1.2.3` / `npm:pkg`
- **git**：`git:github.com/user/repo@v1`、`https://...`、`ssh://...`
- **本地路径**：绝对/相对路径；文件=单个扩展，目录=包规则
- 默认写用户 `~/.pi/agent/settings.json`；`-l` 写项目 `.pi/settings.json`；项目信任后启动自动装缺失包
- `pi -e npm:@foo/bar` 临时试用（仅本次运行）

## 安装位置

- npm：`~/.pi/agent/npm/`（用户）或 `.pi/npm/`（项目）
- git：`~/.pi/agent/git/<host>/<path>` 或 `.pi/git/<host>/<path>`

## 包结构 / Manifest

- package.json 加 `"pi"` key：`{extensions, skills, prompts, themes}` 数组；路径相对包根，支持 glob 与 `!` 排除；加 `keywords: ["pi-package"]` 进画廊
- 无 pi manifest 时按约定目录自动发现：`extensions/`（.ts/.js）、`skills/`（递归 SKILL.md + 顶层 .md）、`prompts/`（.md）、`themes/`（.json）
- 虚拟模块（须列 peerDependencies `"*"`，勿打包）：`@earendil-works/pi-ai`（含 `/compat`）、`@earendil-works/pi-agent-core`、`@schovest/pi-coding-agent`、`@schovest/pi-tui`、`typebox`
- 其他 pi 包须 `dependencies` + `bundledDependencies` 打包

## 常用操作

- `pi install <spec>` / `pi remove npm:@foo/bar` / `pi list` / `pi update`（含 `--extensions` 限定）/ `pi self-update`（`--force`）
- `pi config` 启用/禁用已装包及本地目录资源（全局/项目 scope）
- settings 对象式过滤：`{source, extensions: ["extensions/*.ts","!extensions/legacy.ts"], skills: [], prompts: [...], themes: ["+themes/legacy.json"]}`；省略 key=全载、`[]`=不载、`!` 排除、`+`/`-` 精确路径强制包含/排除

## 常见坑

- 版本化 npm spec 被钉死，`pi update` 跳过；git ref（tag/commit）钉死不自动升级，改 ref 需重新 `pi install git:...@new-ref`
- 包可同现全局+项目，项目条目优先；身份：npm=包名、git=去 ref 的 URL、local=绝对路径
- CI 用 `GIT_TERMINAL_PROMPT=0`、`GIT_SSH_COMMAND` 防 git 挂起
## 文档兜底（本文件不足时）

本文件为要点提炼，遇到以下情况**必须**转查阅官方文档，禁止凭猜测继续：

- 字段含义、格式、允许值不确定
- 需要默认值、生效范围、生效方式等细节
- 本文件未覆盖的场景

```text
read(path: "~/.local/share/pi/docs/packages.md")
```

对应官方文档：`packages.md`。查阅方法见 `pi-docs-reference`。

文档仍无法覆盖时：查看现有配置文件作为参考，并如实告知用户文档未覆盖该主题。
