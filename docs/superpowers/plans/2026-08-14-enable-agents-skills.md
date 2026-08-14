# enableAgentsSkills 配置项实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `enableAgentsSkills` settings 配置项（默认 `false`），禁用 `~/.agents/skills` 与项目级 `.agents/skills` 的自动发现与信任输入触发。

**Architecture:** 单一布尔配置。加载禁用落在 `package-manager.ts` 的 `addAutoDiscoveredResources`（显式 `skills` 数组走独立路径不受影响）；信任联动落在 `trust-manager.ts` 的 `hasProjectTrustInputs`（新增可选 opts 参数，默认保持现状）；`/settings` UI 同步新增开关；测试与文档全量同步。

**Tech Stack:** TypeScript、vitest（coding-agent 包）、pi fork（基于上游 v0.81.1）。

**Spec:** `docs/superpowers/specs/2026-08-14-enable-agents-skills-design.md`

## Global Constraints

- 配置项命名：`enableAgentsSkills`，默认 `false`（不配置 = 禁用）
- 显式 `skills` 数组路径不受禁用影响（与 `--no-skills` 时 `--skill` 仍生效语义一致）
- 禁用时 `.agents/skills` 不作为项目信任输入（`hasProjectTrustInputs` 联动）
- `codex-plugin-manager.ts` 的 `.agents/plugins/marketplace.json` 不在范围，禁止改动
- 禁止 `any`；禁止 inline import；禁止 erasable syntax 违规
- 测试 runner：coding-agent 用 vitest，命令 `npx vitest run --dir packages/coding-agent/test <pattern>`（从项目根运行，禁止从子包目录调用）
- 每个功能 commit 须同步更新 `packages/coding-agent/CHANGELOG.md` 的 `[Unreleased]` 段（Task 1 引入完整条目，后续任务不重复追加）
- 完成标准：`npm run check` 全绿 + 相关测试通过 + `packages/coding-agent/docs/` 逐项自查

---

### Task 1: settings-manager.ts — `enableAgentsSkills` 配置项

**Files:**

- Modify: `packages/coding-agent/src/core/settings-manager.ts`（Settings 接口 190 行附近；getter/setter 加在 `getEnableSkillCommands` 之后 ~1231 行）
- Test: `packages/coding-agent/test/settings-manager.test.ts`（文件末尾追加 describe）

**Interfaces:**

- Consumes: 无（独立任务）
- Produces:
  - `Settings.enableAgentsSkills?: boolean`（默认 false）
  - `getEnableAgentsSkills(): boolean`
  - `setEnableAgentsSkills(enabled: boolean): void`（写全局 settings）

- [ ] **Step 1: 写失败测试**

在 `test/settings-manager.test.ts` 末尾（`describe("getSessionDir", ...)` 之后）追加：

```ts
 describe("enableAgentsSkills", () => {
  it("should default to false", () => {
   const manager = SettingsManager.create(projectDir, agentDir);
   expect(manager.getEnableAgentsSkills()).toBe(false);
  });

  it("should read from global settings", () => {
   const settingsPath = join(agentDir, "settings.json");
   writeFileSync(settingsPath, JSON.stringify({ enableAgentsSkills: true }));
   const manager = SettingsManager.create(projectDir, agentDir);
   expect(manager.getEnableAgentsSkills()).toBe(true);
  });

  it("should persist via setEnableAgentsSkills", () => {
   const manager = SettingsManager.inMemory();
   manager.setEnableAgentsSkills(true);
   expect(manager.getEnableAgentsSkills()).toBe(true);
   manager.setEnableAgentsSkills(false);
   expect(manager.getEnableAgentsSkills()).toBe(false);
  });
 });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test settings-manager`
Expected: FAIL — `getEnableAgentsSkills is not a function` 或类型错误

- [ ] **Step 3: 实现**

`src/core/settings-manager.ts`：

a) Settings 接口，`enableSkillCommands` 行后追加：

```ts
 enableAgentsSkills?: boolean; // default: false - load skills from ~/.agents/skills and project .agents/skills
```

b) `getEnableSkillCommands` / `setEnableSkillCommands` 之后追加：

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

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run --dir packages/coding-agent/test settings-manager`
Expected: PASS

- [ ] **Step 5: 更新 CHANGELOG 并提交**

在 `CHANGELOG.md` 的 `## [Unreleased]` 下新增：

```md
### Changed
- `.agents/skills` 通用技能目录（`~/.agents/skills` 与项目级 `.agents/skills`）默认不再自动加载，需在 settings 中设置 `enableAgentsSkills: true` 开启（breaking change；显式 `skills` 数组路径不受影响）
```

```bash
git add packages/coding-agent/src/core/settings-manager.ts packages/coding-agent/test/settings-manager.test.ts packages/coding-agent/CHANGELOG.md
git commit -m "feat: 新增 enableAgentsSkills 配置项（默认禁用 .agents/skills 自动发现）"
```

---

### Task 2: package-manager.ts — `.agents/skills` 加载禁用

**Files:**

- Modify: `packages/coding-agent/src/core/package-manager.ts`（`addAutoDiscoveredResources`，2328-2445 行）
- Test: `packages/coding-agent/test/package-manager.test.ts`

**Interfaces:**

- Consumes: `settingsManager.getEnableAgentsSkills()`（Task 1）
- Produces: 无新接口；行为变更——`enableAgentsSkills` 为 false 时自动发现跳过 `.agents/skills`

- [ ] **Step 1: 更新现有 `.agents` 测试显式开启**

对 `test/package-manager.test.ts` 中所有创建 `.agents` 目录的测试（grep `".agents"` 定位：`~/.agents` baseDir 测试 ~328 行、项目 `.agents` baseDir 测试 ~353 行、`.agents/skills auto-discovery` describe 内全部测试 ~388-510 行），在 `pm.resolve()` 调用前插入一行（使用该测试作用域内的 settingsManager 变量，注意个别测试自建 `localSettingsManager`）：

```ts
settingsManager.setEnableAgentsSkills(true);
```

- [ ] **Step 2: 新增默认禁用测试**

在 `.agents/skills auto-discovery` describe 内末尾追加两个测试：

```ts
  it("should not load .agents/skills by default", async () => {
   const previousHome = process.env.HOME;
   process.env.HOME = tempDir;
   try {
    // 用户级
    const userSkill = join(tempDir, ".agents", "skills", "user-off", "SKILL.md");
    mkdirSync(join(tempDir, ".agents", "skills", "user-off"), { recursive: true });
    writeFileSync(userSkill, "---\nname: user-off\ndescription: user off\n---\n");

    // 项目级
    const repoRoot = join(tempDir, "repo-off");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const repoSkill = join(repoRoot, ".agents", "skills", "repo-off", "SKILL.md");
    mkdirSync(join(repoRoot, ".agents", "skills", "repo-off"), { recursive: true });
    writeFileSync(repoSkill, "---\nname: repo-off\ndescription: repo off\n---\n");

    const pm = new DefaultPackageManager({ cwd: repoRoot, agentDir, settingsManager });
    const result = await pm.resolve();
    expect(result.skills.some((r) => r.path === userSkill)).toBe(false);
    expect(result.skills.some((r) => r.path === repoSkill)).toBe(false);
   } finally {
    if (previousHome === undefined) {
     delete process.env.HOME;
    } else {
     process.env.HOME = previousHome;
    }
   }
  });

  it("should load explicit .agents/skills path from skills array even when disabled", async () => {
   const previousHome = process.env.HOME;
   process.env.HOME = tempDir;
   try {
    const agentsSkillsDir = join(tempDir, ".agents", "skills");
    const skillPath = join(agentsSkillsDir, "explicit", "SKILL.md");
    mkdirSync(join(agentsSkillsDir, "explicit"), { recursive: true });
    writeFileSync(skillPath, "---\nname: explicit\ndescription: explicit\n---\n");

    settingsManager.setSkillPaths([agentsSkillsDir]);
    const result = await packageManager.resolve();
    expect(result.skills.some((r) => r.path === skillPath && r.enabled)).toBe(true);
   } finally {
    if (previousHome === undefined) {
     delete process.env.HOME;
    } else {
     process.env.HOME = previousHome;
    }
   }
  });
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test package-manager`
Expected: 现有 `.agents` 测试因默认禁用 FAIL（未开启的）；新增两个测试 FAIL

- [ ] **Step 4: 实现**

`src/core/package-manager.ts` `addAutoDiscoveredResources`：

a) 项目级（2366-2368 行附近）：

```ts
  const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
  const enableAgentsSkills = this.settingsManager.getEnableAgentsSkills();
  const projectTrusted = this.settingsManager.isProjectTrusted();
  const projectAgentsSkillDirs =
   enableAgentsSkills && projectTrusted
    ? collectAncestorAgentsSkillDirs(this.cwd).filter((dir) => resolve(dir) !== resolve(userAgentsSkillsDir))
    : [];
```

b) 用户级（2419 行附近的 `// User skills from ~/.agents/ (with its own baseDir)` 块）用 `if (enableAgentsSkills) { ... }` 包裹：

```ts
  if (enableAgentsSkills) {
   // User skills from ~/.agents/ (with its own baseDir)
   const userAgentsBaseDir = dirname(userAgentsSkillsDir);
   const userAgentsMetadata: PathMetadata = {
    ...userMetadata,
    baseDir: userAgentsBaseDir,
   };
   addResources(
    "skills",
    collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
    userAgentsMetadata,
    userOverrides.skills,
    userAgentsBaseDir,
   );
  }
```

注意：确认 `enableAgentsSkills` 局部变量在用户级块处仍在使用范围内（同一函数体内）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run --dir packages/coding-agent/test package-manager`
Expected: 全部 PASS（含两个新测试）

- [ ] **Step 6: 提交**

```bash
git add packages/coding-agent/src/core/package-manager.ts packages/coding-agent/test/package-manager.test.ts
git commit -m "feat: enableAgentsSkills 禁用 .agents/skills 自动发现（显式 skills 数组优先）"
```

---

### Task 3: trust-manager.ts — 信任输入联动 + 调用方

**Files:**

- Modify: `packages/coding-agent/src/core/trust-manager.ts`（`hasProjectTrustInputs`，184-206 行）
- Modify: `packages/coding-agent/src/core/project-trust.ts`（`ResolveProjectTrustedOptions` + `resolveProjectTrusted`）
- Modify: `packages/coding-agent/src/main.ts`（606、619、639 行附近）
- Modify: `packages/coding-agent/src/package-manager-cli.ts`（434-452 行）
- Test: `packages/coding-agent/test/trust-manager.test.ts`

**Interfaces:**

- Consumes: `settingsManager.getEnableAgentsSkills()`（Task 1）
- Produces:
  - `hasProjectTrustInputs(cwd: string, opts?: { enableAgentsSkills?: boolean }): boolean`（opts 未传时行为不变）
  - `ResolveProjectTrustedOptions.enableAgentsSkills?: boolean`

- [ ] **Step 1: 写失败测试**

`test/trust-manager.test.ts`，在 `it("detects project trust inputs", ...)` 之后追加：

```ts
 it("should ignore .agents/skills as trust input when enableAgentsSkills is false", () => {
  mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
  expect(hasProjectTrustInputs(cwd, { enableAgentsSkills: false })).toBe(false);
  // 默认参数保持现状：仍视为信任输入
  expect(hasProjectTrustInputs(cwd)).toBe(true);
 });
```

（`cwd` 已在 `describe("ProjectTrustStore")` 作用域由 beforeEach 定义，直接使用；beforeEach 每次重建目录，无状态泄漏。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --dir packages/coding-agent/test trust-manager`
Expected: FAIL — `enableAgentsSkills: false` 时仍返回 true

- [ ] **Step 3: 实现 trust-manager.ts**

```ts
export function hasProjectTrustInputs(cwd: string, opts?: { enableAgentsSkills?: boolean }): boolean {
 const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
 const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
 const checkAgentsSkills = opts?.enableAgentsSkills !== false;
 let currentDir = canonicalizePath(resolvePath(cwd));

 const configDir = join(currentDir, CONFIG_DIR_NAME);
 if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) {
  return true;
 }

 while (true) {
  if (checkAgentsSkills) {
   const agentsSkillsDir = join(currentDir, ".agents", "skills");
   if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
    return true;
   }
  }

  const parentDir = dirname(currentDir);
  if (parentDir === currentDir) {
   return false;
  }
  currentDir = parentDir;
 }
}
```

- [ ] **Step 4: 实现调用方**

a) `src/core/project-trust.ts`：`ResolveProjectTrustedOptions` 加字段 `enableAgentsSkills?: boolean;`；`resolveProjectTrusted` 中：

```ts
 if (!hasProjectTrustInputs(options.cwd, { enableAgentsSkills: options.enableAgentsSkills })) {
  return true;
 }
```

b) `src/main.ts`（`startupSettingsManager` 已在 559 行定义，均在作用域内）：

- 606 行：`const autoTrustOnReloadCwd = parsed.projectTrustOverride === undefined && !hasProjectTrustInputs(sessionCwd, { enableAgentsSkills: startupSettingsManager.getEnableAgentsSkills() }) ? sessionCwd : undefined;`
- 619 行：`const hasTrustInputs = hasProjectTrustInputs(cwd, { enableAgentsSkills: startupSettingsManager.getEnableAgentsSkills() });`
- 639 行 `resolveProjectTrusted({...})` 参数中加：`enableAgentsSkills: startupSettingsManager.getEnableAgentsSkills(),`

c) `src/package-manager-cli.ts`（`settingsManager` 已在 434 行创建）：

- 435 行：`hasProjectTrustInputs(options.cwd, { enableAgentsSkills: settingsManager.getEnableAgentsSkills() })`
- `resolveProjectTrusted({...})` 参数中加：`enableAgentsSkills: settingsManager.getEnableAgentsSkills(),`

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run --dir packages/coding-agent/test trust-manager`
Expected: PASS

- [ ] **Step 6: 类型检查**

Run: `npx tsgo --noEmit`（项目根）
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/coding-agent/src/core/trust-manager.ts packages/coding-agent/src/core/project-trust.ts packages/coding-agent/src/main.ts packages/coding-agent/src/package-manager-cli.ts packages/coding-agent/test/trust-manager.test.ts
git commit -m "feat: enableAgentsSkills=false 时 .agents/skills 不再触发项目信任确认"
```

---

### Task 4: /settings UI — "Agents skills" 开关

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（`showSettingsSelector`，~4859 与 ~4905 行）

**Interfaces:**

- Consumes: `settingsManager.getEnableAgentsSkills()` / `setEnableAgentsSkills`（Task 1）
- Produces: 无新接口；`SettingsConfig.enableAgentsSkills`、`SettingsCallbacks.onEnableAgentsSkillsChange`

- [ ] **Step 1: 实现 settings-selector.ts**

a) `SettingsConfig` 接口（51 行 `enableSkillCommands: boolean;` 后）：

```ts
 enableAgentsSkills: boolean;
```

b) `SettingsCallbacks` 接口（84 行后）：

```ts
 onEnableAgentsSkillsChange: (enabled: boolean) => void;
```

c) items 插入（`skill-commands` 项之后，436 行 `const skillCommandsIndex = ...` 块后追加）：

```ts
  // Agents skills toggle (insert after skill-commands)
  const agentsSkillsIndex = items.findIndex((item) => item.id === "skill-commands");
  items.splice(agentsSkillsIndex + 1, 0, {
   id: "agents-skills",
   label: "Agents skills",
   description: "Load skills from ~/.agents/skills and project .agents/skills (default: off)",
   currentValue: config.enableAgentsSkills ? "true" : "false",
   values: ["true", "false"],
  });
```

d) switch（`case "skill-commands":` 后）：

```ts
     case "agents-skills":
      callbacks.onEnableAgentsSkillsChange(newValue === "true");
      break;
```

- [ ] **Step 2: 实现 interactive-mode.ts**

a) `showSettingsSelector` 的 config 对象（`enableSkillCommands: this.settingsManager.getEnableSkillCommands(),` 后）：

```ts
     enableAgentsSkills: this.settingsManager.getEnableAgentsSkills(),
```

b) callbacks 对象（`onEnableSkillCommandsChange` 块后）：

```ts
     onEnableAgentsSkillsChange: (enabled) => {
      this.settingsManager.setEnableAgentsSkills(enabled);
     },
```

- [ ] **Step 3: 类型检查**

Run: `npx tsgo --noEmit`（项目根）
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add packages/coding-agent/src/modes/interactive/components/settings-selector.ts packages/coding-agent/src/modes/interactive/interactive-mode.ts
git commit -m "feat: /settings 菜单新增 Agents skills 开关"
```

---

### Task 5: 文档 + 全量验证

**Files:**

- Modify: `packages/coding-agent/docs/settings.md`（Resources 表格 ~260 行）
- Modify: `packages/coding-agent/docs/skills.md`（Locations 部分）
- Modify: `packages/coding-agent/skills/pi-config/references/skills.md`（6-7 行）
- Modify: `README.md`（350 行附近）
- Modify: `packages/coding-agent/CHANGELOG.md`（如 Task 1 已加条目则跳过）

- [ ] **Step 1: docs/settings.md**

Resources 表格 `enableSkillCommands` 行后追加：

```md
| `enableAgentsSkills` | boolean | `false` | Load skills from `~/.agents/skills` and project `.agents/skills` |
```

- [ ] **Step 2: docs/skills.md**

Locations 部分改为：

```md
- Global:
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`（默认禁用，settings 中设 `"enableAgentsSkills": true` 开启）
- Project (only after the project is trusted):
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)（默认禁用，同上）
```

并在该节末尾追加一句：`~/.agents/skills` 与项目 `.agents/skills` 的自动发现默认关闭（`enableAgentsSkills` 默认 `false`）；settings `skills` 数组显式列出的路径不受影响。

- [ ] **Step 3: skills/pi-config/references/skills.md**

第 6-7 行改为：

```md
- 全局：`~/.pi/agent/skills/`、`~/.agents/skills/`（默认禁用，需 `enableAgentsSkills: true`）
- 项目（信任后）：`.pi/skills/`、`.agents/skills/`（cwd 及祖先目录，至 git 根；默认禁用，同上）
```

- [ ] **Step 4: README.md**

350 行 skills 位置说明处，`~/.agents/skills/`、`.agents/skills/` 后加注 `（默认禁用，`enableAgentsSkills: true`开启）`。

- [ ] **Step 5: 全量检查与测试**

```bash
npm run check
npm test > /tmp/pi-test.txt
```

Expected: check 全绿；测试全部通过（重点确认 package-manager、trust-manager、settings-manager 无回归）

- [ ] **Step 6: 自查 docs/ 并提交**

逐项自查 `packages/coding-agent/docs/` 下所有文件与本变更的一致性（重点：skills.md、settings.md、sdk.md 中若有 `.agents/skills` 描述需同步）。

```bash
git add packages/coding-agent/docs/settings.md packages/coding-agent/docs/skills.md packages/coding-agent/skills/pi-config/references/skills.md README.md
git commit -m "docs: enableAgentsSkills 配置说明与 .agents/skills 默认禁用说明"
```
