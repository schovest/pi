# 设计：`enableAgentsSkills` 配置项 — 默认禁用 `.agents/skills` 通用技能目录

日期：2026-08-14
状态：已批准

## 背景

fork 支持 [Agent Skills standard](https://agentskills.io) 的通用目录 `~/.agents/skills`（用户级）与项目 `.agents/skills`（项目级，cwd 到 git root 的祖先目录）。但存在安全与行为隐忧：用户机器上其他 agent（如 Claude Code、Codex 生态）写入的技能会被 pi 自动加载，且无法单独禁用（仅有 CLI `--no-skills` 全量禁用）。

**需求**：新增 settings 配置项禁用这两类通用 skills 目录，**默认禁用**（不配置 = 不加载）。

## 涉及行为（探索结论）

| 位置 | 行为 | 文件 |
| ------ | ------ | ------ |
| 用户级加载 | `~/.agents/skills` 无条件加载（`mode: "agents"`） | `package-manager.ts:2328, 2419` |
| 项目级加载 | `.agents/skills` 从 cwd 到 git root 扫描（仅项目信任后） | `package-manager.ts:437, 2368` |
| 信任输入 | 项目级 `.agents/skills` 存在会触发项目信任确认 | `trust-manager.ts:187-197` |

`codex-plugin-manager.ts` 中的 `.agents/plugins/marketplace.json` 与 skills 无关，**不在**本需求范围。

## 决策（用户确认）

1. **配置命名**：`enableAgentsSkills?: boolean`，默认 `false`（对齐 `enableSkillCommands` 等 enable 前缀风格）
2. **信任联动**：`false` 时 `.agents/skills` 不作为项目信任输入（避免"被要求信任但技能不加载"的不一致）
3. **显式优先**：禁用只影响自动发现；settings `skills` 数组显式写入的 `~/.agents/skills` / `.agents/skills` 路径仍加载（与 `--no-skills` 时 `--skill` 仍生效的语义一致）
4. **UI**：加入 `/settings` 交互菜单

## 改动清单

### 1. `src/core/settings-manager.ts`

- `Settings` 接口新增：

  ```ts
  enableAgentsSkills?: boolean; // default: false - load skills from ~/.agents/skills and project .agents/skills
  ```

- 新增 getter/setter（对齐 `enableSkillCommands` 模式，写全局 settings）：

  ```ts
  getEnableAgentsSkills(): boolean {
    return this.settings.enableAgentsSkills ?? false;
  }

  setEnableAgentsSkills(enabled: boolean): void {
    this.globalSettings.enableAgentsSkills = enabled;
    this.markModified("enableAgentsSkills");
    this.save();
  }
  ```

### 2. `src/core/package-manager.ts`

`addAutoDiscoveredResources` 中，`enableAgentsSkills === false` 时：

- 用户级：跳过 `~/.agents/skills` 的 `collectAutoSkillEntries`
- 项目级：`projectAgentsSkillDirs` 置空

读取 `this.settingsManager.getEnableAgentsSkills()`（构造函数已注入 settingsManager）。

显式 `skills` 数组走 `resolveLocalEntries` 独立路径，不受影响。

### 3. `src/core/trust-manager.ts` 及调用方

`hasProjectTrustInputs` 增加可选参数，`enableAgentsSkills === false` 时跳过 `.agents/skills` 目录检测：

```ts
export function hasProjectTrustInputs(
  cwd: string,
  opts?: { enableAgentsSkills?: boolean },
): boolean
```

未传时保持现状（默认 `true`，向后兼容）。调用方传入设置值：

- `src/main.ts`：`hasProjectTrustInputs(cwd)` 与 `resolveProjectTrusted` 调用处
- `src/core/project-trust.ts`：`ResolveProjectTrustedOptions` 增加 `enableAgentsSkills?: boolean`，透传给 `hasProjectTrustInputs`
- `src/package-manager-cli.ts`：`resolveProjectTrusted` 调用处

### 4. `/settings` UI

- `settings-selector.ts`：`SettingsConfig` / `SettingsCallbacks` 新增 `enableAgentsSkills` 与 `onEnableAgentsSkillsChange`；在 "skill-commands" 项后插入 "Agents skills" 开关（label: `Agents skills`，description: `Load skills from ~/.agents/skills and project .agents/skills (default: off)`）；switch 中处理 `case "agents-skills"`
- `interactive-mode.ts`：`showSettingsSelector` 中配置值与 `onEnableAgentsSkillsChange` 接线（调 `settingsManager.setEnableAgentsSkills`）

### 5. 测试

- `test/package-manager.test.ts`：
  - 现有 `.agents/skills` 相关测试（~7 个）在 beforeEach 中显式 `setEnableAgentsSkills(true)`（仅 `.agents` 相关 describe 或全部 beforeEach，视结构而定）
  - 新增：默认禁用时 `.agents/skills` 不加载（用户级 + 项目级）
  - 新增：默认禁用时 `skills` 数组显式写 `~/.agents/skills` 路径仍加载
- `test/trust-manager.test.ts`：
  - 新增：`enableAgentsSkills: false` 时 `.agents/skills` 不触发信任输入
  - 现有测试保持（默认参数不变）

### 6. 文档

- `docs/settings.md`：新增配置项说明
- `docs/skills.md`：Locations 部分注明默认禁用、如何开启
- `skills/pi-config/references/skills.md`：同步
- `README.md`：skills 位置说明处同步
- `CHANGELOG.md`：`[Unreleased]` 下新增条目，标注 breaking change（升级后 `~/.agents/skills` 默认不再自动加载）

## 行为预期

| 场景 | 行为 |
|------|------|
| 不配置 / `false` | `.agents/skills` 不自动发现、不触发信任确认；`skills` 数组显式路径仍加载 |
| `true` | 恢复 fork 现状（自动发现 + 信任输入） |

## 验证

- `npm run check` 全绿
- `npx vitest run --dir packages/coding-agent/test package-manager` 与 `trust-manager` 通过
- 手工验证：不配置时 `~/.agents/skills` 技能不出现在 `/skills` 列表；配置 `true` 后出现
