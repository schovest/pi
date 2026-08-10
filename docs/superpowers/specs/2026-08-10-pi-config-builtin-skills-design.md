# pi-config 内置 Skills 设计

- 日期：2026-08-10
- 状态：已批准
- 涉及：packages/coding-agent

## 背景与目标

内置主 agent `config.md`（`dist-assets/primary-agents/config.md`，安装到 `~/.pi/agent/primary-agents/config.md`）承担 Pi Agent 配置管理职责：文档优先原则、`~/.local/share/pi/docs/` 文档体系知识、配置文件体系、常见配置任务工作流、验证规则。

问题：

1. 这些能力只存在于 config agent 的提示词中，其他主 agent（coding/plan）遇到配置类任务无法复用
2. 主程序目前没有"内置 skills"加载机制，skills 只能放用户目录/项目目录/显式路径，随用户迁移存在丢失风险
3. config agent 与 skills 双份维护成本高

目标：将 config-agent 转化为**内置注册发布的 skills**（随主程序二进制/包分发，迁移零丢失），任意 agent 在配置类任务中可发现并加载；移除 config.md 主 agent 入口。

## 设计

### 1. 内置 skills 源目录

```
packages/coding-agent/skills/
├─ pi-config/SKILL.md           # 配置管理主 skill
└─ pi-docs-reference/SKILL.md   # 文档查阅参考 skill
```

放在 `packages/coding-agent/skills/`（而非 dist-assets/），因为 `getPackageDir()` 在三种运行形态下统一命中：

| 运行形态 | getPackageDir() | skills 位置 |
| --------- | ---------------- | ------------ |
| dev（src 运行） | `packages/coding-agent/` | `skills/`（源码树） |
| npm 包（dist） | 包根（`dist/`） | `dist/skills/`（构建拷贝） |
| Bun 二进制 | 二进制所在目录（`$PREFIX`） | `$PREFIX/skills/`（install.sh 拷贝） |

### 2. 加载逻辑（resource-loader.ts）

在 `skillPaths` 合并处（`updateSkillsFromPaths` 前的构造位置）末尾追加内置目录：

```ts
const builtinSkillsDir = join(getPackageDir(), "skills");
if (existsSync(builtinSkillsDir) && !skillPaths.includes(builtinSkillsDir)) {
  skillPaths.push(builtinSkillsDir);
}
```

规则：

- 存在才加入（避免 `loadSkills` 对不存在路径产生 warning）
- **放最后** → 用户级/项目级/settings 声明的同名 skills 优先（`addSkills` 先注册者赢）
- `--no-skills` 语义不变（noSkills 时 skillPaths 为空 → 内置也不加载）

### 3. 构建与安装

- `package.json` `copy-binary-assets`：增加 `shx mkdir -p dist/skills && shx cp -r skills/* dist/skills/`
- `dist-assets/install.sh`：目录拷贝循环 `for dir in ...` 增加 `skills`
- `dist-assets/install.sh`：`AGENT_NAMES/AGENT_DESCS/AGENT_DEFAULTS/AGENT_INSTALLS` 移除 config 条目

### 4. 移除 config.md

- 删除 `dist-assets/primary-agents/config.md`
- 删除用户级 `~/.pi/agent/primary-agents/config.md`（本机生效，需用户确认后执行）

### 5. Skills 内容（第一批）

**pi-config**（配置管理主 skill）

- description 触发条件："对 Pi Agent 进行配置文件的读取/查询/修改时主动加载"
- 内容：核心原则（文档优先、先理解现状、全面告知影响范围）、配置文件体系表、配置修改 7 步工作流、验证规则、常见任务速查（引用 pi-docs-reference）

**pi-docs-reference**（文档查阅参考）

- description 触发条件："需要查阅 Pi Agent 官方文档（~/.local/share/pi/docs/）内容时"
- 内容：文档目录结构表（24 个文件 + 用途）、文档查阅工作流（index.md 导航、并行查阅、分段阅读、文档未覆盖处理）

## 验证

1. 单元测试：内置 skills 目录加载（`loadSkills`/resource-loader 层面），含同名覆盖语义
2. `npm run check` 全绿
3. 本机 dev 模式验证：skills 出现在系统提示可用列表中，`/skill:pi-config` 可加载
4. CHANGELOG Unreleased 增加条目
5. 自查 `packages/coding-agent/docs/` 是否需要更新（skills.md / primary-agents.md / architecture.md）

## 不做（YAGNI）

- 不为内置 skills 增加"用户同名冲突时静默跳过"逻辑（保留现有 collision warning 语义）
- 不改 `loadSkills` 的 includeDefaults 分支（主流程全部走 resource-loader）
- 不新增 `SourceScope` 枚举（内置 skills 使用现有 synthetic source，source 标记为 builtin）
