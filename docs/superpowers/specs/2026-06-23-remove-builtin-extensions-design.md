# 彻底移除内置扩展 — 设计文档

日期: 2026-06-23
状态: 已获批

## 目标

删除 `packages/plugins/` 整个内置扩展包，所有扩展通过 `pi install` 按需安装。让 Pi 核心更简洁。

## 变更概要

### 1. 删除 `packages/plugins/` 整包

- 删除 `packages/plugins/` 目录
- 从 `packages/coding-agent/package.json` 移除:
  - `dependencies` 中的 `"@earendil-works/pi-plugins": "file:../plugins"`
  - `bundledDependencies` 中的 `"@earendil-works/pi-plugins"`
  - `build:binary` 中 `npm --prefix ../plugins run build &&`
  - `copy-binary-assets` 中拷贝 `pi-plugins` 的脚本行
  - 移除 `node_modules/@earendil-works/pi-plugins` 软链接（如有）
- root `package.json` 中移除 workspace 引用（如有）

### 2. `resource-loader.ts` 变更

文件: `packages/coding-agent/src/core/resource-loader.ts`

**删除:**
- `import { BUILTIN_PLUGINS } from "@earendil-works/pi-plugins"`
- `DefaultResourceLoaderOptions.disabledBuiltinPlugins` 字段
- `private disabledBuiltinPlugins` 字段声明及构造函数初始化
- `loadExtensionFactories()` 方法内 BUILTIN_PLUGINS 循环（保留 inline factories 处理）

**简化 `loadExtensionFactories()`:** 仅处理 extensionFactories（inline factories），不再加载 BUILTIN_PLUGINS。

### 3. `main.ts` 变更

文件: `packages/coding-agent/src/main.ts`

- 移除 `disabledBuiltinPlugins: parsed.noMcp ? ["mcp"] : []`
- 传给 `DefaultResourceLoader` 时不再包含 `disabledBuiltinPlugins` 参数
- `--no-mcp` CLI 标志处理同步移除

### 4. `install.sh` 重构

文件: `packages/coding-agent/dist-assets/install.sh` 和 `packages/coding-agent/dist/install.sh`

#### 扩展选择菜单

**标准安装 (默认勾选 [*]):**

| # | 标识 | 安装方式 |
|---|------|----------|
| 1 | pi-mcp-adapter | `pi install npm:pi-mcp-adapter` |
| 2 | @juicesharp/rpiv-todo | `pi install npm:@juicesharp/rpiv-todo` |
| 3 | @juicesharp/rpiv-ask-user-question | `pi install npm:@juicesharp/rpiv-ask-user-question` |

**可选安装 (默认不勾选 [ ]):**

| # | 标识 | 安装方式 |
|---|------|----------|
| 4 | tps | 文件拷贝到 `~/.pi/extensions/tps.ts` |
| 5 | context-mode | `pi install npm:context-mode` |
| 6 | @juicesharp/rpiv-btw | `pi install npm:@juicesharp/rpiv-btw` |

#### 交互按键

- ↑/↓ 移动光标
- Space 切换勾选
- `a` 全选所有项（不直接安装）
- `s` 恢复标准集
- Enter 确认选中项并安装
- `q` 跳过全部

#### 复选框格式

- `[ ]` 未选中
- `[*]` 已选中

### 5. 测试更新

文件: `packages/coding-agent/test/resource-loader.test.ts`

- 删除所有 `disabledBuiltinPlugins` 参数的测试构造
- 删除 `"should load built-in plugins except disabled ones"` 测试
- 删除 `"should skip built-in plugins when extensions are disabled"` 测试

## 不受影响

- `pi install` / `pi plugins` 命令本身不受影响
- 外部扩展加载（文件路径、npm 包）不受影响
- MCP 功能不受影响（通过独立安装 `pi-mcp-adapter` 获得）
- `tps.ts` 源文件保留在 `packages/coding-agent/dist-assets/extensions/tps.ts`（供 install.sh 拷贝）

## plan 插件的处理

`plan` 插件（`packages/plugins/src/plan/`）直接删除，不在 install.sh 中列出。
