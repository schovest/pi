# 命令面板设计文档

## 概述

为 Pi 添加一个类似 VS Code 的命令面板，通过 `Ctrl+P` 快捷键触发，支持模糊搜索所有可用命令（斜杠命令、快捷键动作、扩展命令、skill 命令），提供统一的命令发现和执行入口。

## 需求

- **快捷键**: `Ctrl+P` 打开命令面板
- **UI 形态**: 居中 overlay，搜索框在上，列表在下
- **命令范围**: 全面命令面板 — 斜杠命令 + 快捷键动作 + 扩展命令 + skill 命令
- **搜索**: 实时模糊匹配，搜索 label、description、keywords、keybinding
- **冲突处理**: 替换现有 `Ctrl+P` 模型切换功能

## 架构

### 组件关系

```
InteractiveMode
├── commandRegistry: CommandRegistry          // 命令注册表
├── showCommandPalette()                      // 创建 overlay
│   └── CommandPaletteComponent               // UI 组件
│       ├── Input (搜索框)
│       └── CommandPaletteList (列表)
└── setupCommandRegistry()                    // 注册内置命令
```

### 文件结构

```
packages/coding-agent/src/
├── core/
│   ├── command-palette/
│   │   ├── types.ts                          // 类型定义
│   │   ├── command-registry.ts               // CommandRegistry 实现
│   │   ├── command-palette-component.ts      // UI 组件
│   │   └── command-palette-list.ts           // 列表渲染组件
│   └── keybindings.ts                        // 修改：新增 app.commandPalette
└── modes/interactive/
    └── interactive-mode.ts                   // 修改：集成命令面板
```

## 核心类型

### CommandPaletteItem

```typescript
interface CommandPaletteItem {
  id: string;                    // 唯一标识，如 "app.model.select"
  label: string;                 // 显示名称，如 "选择模型"
  description?: string;          // 描述文本
  category: CommandCategory;     // 分类
  keywords?: string[];           // 搜索关键词（除 label 外）
  keybinding?: KeyId;            // 关联的快捷键（用于显示提示）
  handler: () => void | Promise<void>;  // 执行函数
  visible?: boolean | (() => boolean);  // 动态可见性
}
```

### CommandCategory

```typescript
type CommandCategory =
  | "navigation"    // 导航：会话、树、fork
  | "model"         // 模型相关
  | "session"       // 会话管理
  | "settings"      // 设置
  | "tools"         // 工具操作
  | "slash"         // 斜杠命令
  | "extension"     // 扩展命令
  | "skill";        // Skill 命令
```

### CommandRegistry

```typescript
interface CommandRegistry {
  register(item: CommandPaletteItem): void;
  unregister(id: string): void;
  getAll(): CommandPaletteItem[];
  search(query: string): CommandPaletteItem[];
}
```

## 命令来源

| 来源 | 注册时机 | 示例 |
|------|----------|------|
| 内置快捷键动作 | `InteractiveMode` 构造时 | `app.model.select`, `app.session.tree` |
| 斜杠命令 | 从 `BUILTIN_SLASH_COMMANDS` 转换 | `/settings`, `/export` |
| 扩展命令 | 扩展加载时 | 扩展注册的命令 |
| Skill 命令 | skills 加载时 | `/skill:xxx` |

## UI 组件

### CommandPaletteComponent

继承 `Container`，实现 `Focusable` 接口。

**内部结构**:
```
Container
├── DynamicBorder (顶部)
├── Input (搜索输入框，带 ">" 提示符)
├── Container (列表区域)
│   └── CommandPaletteList
├── Spacer(1)
└── DynamicBorder (底部)
```

**渲染布局**:
```
┌─────────────────────────────────────────┐
│ > 搜索命令...                            │
├─────────────────────────────────────────┤
│   选择模型          切换 LLM 模型    Ctrl+L│
│ ▸ 新建会话          创建新会话            │
│   会话树            导航会话分支          │
│   ...                                    │
├─────────────────────────────────────────┤
│ 5/24  ↑↓ 导航  Enter 确认  Esc 取消      │
└─────────────────────────────────────────┘
```

**尺寸**:
- 宽度: 终端 60%，最小 40 列
- 最大高度: 终端 50%

### CommandPaletteList

自定义列表组件，三列布局：label + description + 快捷键提示。

**为什么不复用 SelectList**:
1. `SelectList` 是双列布局，命令面板需要三列
2. `SelectList.setFilter` 是前缀匹配，命令面板需要 `fuzzyFilter`
3. 需要自定义快捷键提示的右对齐渲染

**键盘处理**:

| 按键 | 行为 |
|------|------|
| `tui.select.up/down` | 上下移动（循环） |
| `tui.select.confirm` | 执行选中命令，关闭面板 |
| `tui.select.cancel` / Escape | 关闭面板 |
| 其他可打印字符 | 传递给搜索输入框 |
| Backspace/Delete | 传递给搜索输入框 |

### 搜索逻辑

```typescript
search(query: string): CommandPaletteItem[] {
  if (!query) return this.registry.getAll().filter(visible);
  return fuzzyFilter(
    this.registry.getAll().filter(visible),
    query,
    (item) => `${item.label} ${item.description ?? ""} ${(item.keywords ?? []).join(" ")} ${item.keybinding ?? ""}`
  );
}
```

## 快捷键变更

| 快捷键 ID | 变更前 | 变更后 |
|-----------|--------|--------|
| `app.model.cycleForward` | `ctrl+p` | `[]`（无默认绑定） |
| `app.model.cycleBackward` | `shift+ctrl+p` | `[]`（无默认绑定） |
| `app.commandPalette` | 不存在 | `ctrl+p`（新增） |

**说明**: 模型快速切换功能保留，只是移除默认快捷键。用户可通过 `~/.pi/agent/keybindings.json` 恢复。模型选择器仍可通过 `Ctrl+L` 或命令面板访问。

## InteractiveMode 集成

### 新增成员

```typescript
class InteractiveMode {
  private commandRegistry: CommandRegistry;

  private setupCommandRegistry(): void;
  private showCommandPalette(): void;
}
```

### setupCommandRegistry 实现

```typescript
private setupCommandRegistry(): void {
  const registry = this.commandRegistry;

  // 快捷键动作
  registry.register({
    id: "app.model.select",
    label: "选择模型",
    description: "打开模型选择器",
    category: "model",
    keybinding: "ctrl+l",
    handler: () => this.showModelSelector(),
  });

  registry.register({
    id: "app.session.tree",
    label: "会话树",
    description: "导航会话分支",
    category: "session",
    handler: () => this.showTreeSelector(),
  });

  // ... 其他快捷键动作

  // 斜杠命令
  for (const cmd of BUILTIN_SLASH_COMMANDS) {
    registry.register({
      id: `slash.${cmd.name}`,
      label: `/${cmd.name}`,
      description: cmd.description,
      category: "slash",
      handler: () => this.executeSlashCommand(cmd.name),
    });
  }
}
```

### showCommandPalette 实现

```typescript
private showCommandPalette(): void {
  const palette = new CommandPaletteComponent(
    this.commandRegistry,
    this.ui.getTheme(),
    this.keybindingsManager,
    {
      onSelect: (item) => {
        handle.hide();
        item.handler();
      },
      onCancel: () => handle.hide(),
    }
  );

  const handle = this.ui.showOverlay(palette, {
    width: "60%",
    minWidth: 40,
    maxHeight: "50%",
    anchor: "center",
  });
}
```

### setupKeyHandlers 修改

```typescript
// 新增
this.defaultEditor.onAction("app.commandPalette", () => this.showCommandPalette());

// cycleForward/cycleBackward handler 保留，但无默认快捷键
```

## 扩展命令集成

扩展加载时，通过 `ExtensionRunner` 获取注册的命令，动态添加到 `CommandRegistry`：

```typescript
for (const cmd of this.extensionRunner.getRegisteredCommands()) {
  this.commandRegistry.register({
    id: `extension.${cmd.name}`,
    label: cmd.name,
    description: cmd.description,
    category: "extension",
    handler: () => this.extensionRunner.executeCommand(cmd.name),
  });
}
```

## Skill 命令集成

当 `settings.enableSkillCommands` 开启时，skills 加载后注册：

```typescript
for (const skill of this.loadedSkills) {
  this.commandRegistry.register({
    id: `skill.${skill.name}`,
    label: `/skill:${skill.name}`,
    description: skill.description,
    category: "skill",
    handler: () => this.invokeSkill(skill.name),
  });
}
```

## 测试要点

- [ ] `Ctrl+P` 打开命令面板
- [ ] 模糊搜索正确过滤命令
- [ ] 上下键导航，循环滚动
- [ ] Enter 执行命令并关闭面板
- [ ] Escape 关闭面板
- [ ] 快捷键提示正确显示
- [ ] 斜杠命令可搜索并执行
- [ ] 扩展命令动态注册
- [ ] Skill 命令动态注册
- [ ] 原有 `Ctrl+L` 模型选择器仍可用
- [ ] 用户可通过 keybindings.json 恢复模型切换快捷键
