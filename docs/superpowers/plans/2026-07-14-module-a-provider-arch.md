# 模块 A：Provider 架构迁移实现计划

> **目标**: 将本地单文件 provider 架构迁移为上游 api/+providers/ 分离架构 + pi-ai /compat 入口
> **涉及文件**: ~110 个（85 新建/复制 + 15 修改 + 10 删除）
> **上游源**: `/data/mine/earendil-works-pi/packages/ai/src`

---

## 文件变动清单

### 新建目录（从上游完整复制）

| 源路径 (upstream) | 目标路径 | 文件数 | 说明 |
|---|---|---|---|
| `src/api/` | `packages/ai/src/api/` | 28 | API 实现 + lazy 包装器 |
| `src/auth/` | `packages/ai/src/auth/` | 5 | 认证上下文/凭据存储 |

### 新建/替换文件（从上游复制，覆盖本地）

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/compat.ts` | 新建 | pi-ai 旧 API 兼容入口 |
| `src/legacy-api-aliases.ts` | 新建 | streamSimple 等旧别名 |
| `src/models.ts` | 替换 | Provider/Models/createProvider 核心抽象 |
| `src/index.ts` | 替换 | 精简为 ~47 行 |
| `src/types.ts` | 替换 | 新 Provider 类型（含 cacheWrite1h/reasoning） |
| `src/cli.ts` | 替换 | |
| `src/env-api-keys.ts` | 替换 | |
| `src/session-resources.ts` | 替换 | |
| `src/bedrock-provider.ts` | 替换 | |
| `src/oauth.ts` | 替换 | |
| `src/stream.ts` | 替换 | |
| `src/image-models.ts` | 替换 | |
| `src/image-models.generated.ts` | 替换 | |
| `src/images.ts` | 替换 | |
| `src/images-api-registry.ts` | 替换 | |
| `src/utils/` | 替换 | 全目录 |
| `scripts/generate-models.ts` | 替换 | 适配输出 providers/*.models.ts |

### 替换 provider 文件（上游工厂函数替代本地单块实现）

| 本地文件 → | 操作 | 行数变化 |
|---|---|---|
| `providers/anthropic.ts` (1225行) | 替换为上游 (21行) | -1204 |
| `providers/openai-completions.ts` (~1300行) | 替换为上游 (~20行) | -1280 |
| `providers/openai-responses.ts` (~450行) | 替换为上游 (~20行) | -430 |
| `providers/openai-codex-responses.ts` (~650行) | 替换为上游 (~20行) | -630 |
| `providers/openai-responses-shared.ts` (~600行) | 删除（移入 api/） | -600 |
| `providers/amazon-bedrock.ts` (~900行) | 替换为上游 (~25行) | -875 |
| `providers/google.ts` (~600行) | 替换为上游 (~20行) | -580 |
| `providers/google-vertex.ts` (~600行) | 替换为上游 (~20行) | -580 |
| `providers/mistral.ts` (~600行) | 替换为上游 (~20行) | -580 |
| `providers/azure-openai-responses.ts` (~350行) | 替换为上游 (~20行) | -330 |
| `providers/cloudflare.ts` (~800行) | 替换为上游 (~30行) | -770 |
| `providers/faux.ts` | 保留（测试用） | — |
| `providers/register-builtins.ts` | 删除（由 all.ts 替代） | -全部 |
| `providers/github-copilot-headers.ts` | 删除（移入 api/） | -全部 |
| `providers/google-shared.ts` | 删除（移入 api/） | -全部 |
| `providers/openai-prompt-cache.ts` | 删除（移入 api/） | -全部 |
| `providers/simple-options.ts` | 删除（移入 api/） | -全部 |
| `providers/transform-messages.ts` | 删除（移入 api/） | -全部 |
| 其余 providers/*.ts (25个) | 替换为上游工厂函数 | 大幅缩减 |

### 运行生成脚本产出

| 文件 | 说明 |
|---|---|
| `providers/*.models.ts` (35个) | 每个 provider 的模型定义 |
| `models.generated.ts` | 聚合文件 (~77行) |

### 需要删除的旧文件

```
providers/openai-responses-shared.ts
providers/register-builtins.ts
providers/github-copilot-headers.ts
providers/google-shared.ts
providers/openai-prompt-cache.ts
providers/simple-options.ts
providers/transform-messages.ts
```

### 需要适配 import 的文件（来自 coding-agent 和 agent 包）

完成 Provider 迁移后修复编译错误，预估 ~20 个文件需要更新 import 语句。

---

## Task 1: 复制基础设施层（auth/ + api/ + 核心文件）

**无依赖**，可立即执行。

- [ ] **Step 1: 复制 auth/ 目录（5 文件）**

```bash
UPSTREAM="/data/mine/earendil-works-pi/packages/ai/src"
LOCAL="/data/mine/pi/packages/ai/src"
cp -r "$UPSTREAM/auth" "$LOCAL/auth"
```

- [ ] **Step 2: 复制 api/ 目录（28 文件）**

```bash
cp -r "$UPSTREAM/api" "$LOCAL/api"
```

- [ ] **Step 3: 复制 compat/legacy/模型核心文件（8 文件）**

```bash
cp "$UPSTREAM/compat.ts" "$LOCAL/"
cp "$UPSTREAM/legacy-api-aliases.ts" "$LOCAL/"
cp "$UPSTREAM/models.ts" "$LOCAL/"
cp "$UPSTREAM/stream.ts" "$LOCAL/"
cp "$UPSTREAM/cli.ts" "$LOCAL/"
cp "$UPSTREAM/env-api-keys.ts" "$LOCAL/"
cp "$UPSTREAM/oauth.ts" "$LOCAL/"
cp "$UPSTREAM/session-resources.ts" "$LOCAL/"
```

- [ ] **Step 4: 复制图片模型和支持文件（7 文件）**

```bash
cp "$UPSTREAM/image-models.ts" "$LOCAL/"
cp "$UPSTREAM/image-models.generated.ts" "$LOCAL/"
cp "$UPSTREAM/images.ts" "$LOCAL/"
cp "$UPSTREAM/images-api-registry.ts" "$LOCAL/"
cp "$UPSTREAM/images-models.ts" "$LOCAL/"
cp "$UPSTREAM/bedrock-provider.ts" "$LOCAL/"
```

- [ ] **Step 5: 复制 utils/ 目录**

```bash
cp -r "$UPSTREAM/utils/" "$LOCAL/utils/"
```

- [ ] **Step 6: 复制 types.ts（包含 cacheWrite1h/reasoning 等上游已包含字段）**

```bash
cp "$UPSTREAM/types.ts" "$LOCAL/"
```

- [ ] **Step 7: 复制生成脚本**

```bash
cp "$UPSTREAM/scripts/generate-models.ts" /data/mine/pi/packages/ai/scripts/generate-models.ts
```

---

## Task 2: 替换 provider 文件为工厂函数

- [ ] **Step 1: 复制上游 provider 工厂文件（非 .models.ts 的 .ts 文件）**

```bash
UPSTREAM="/data/mine/earendil-works-pi/packages/ai/src/providers"
LOCAL="/data/mine/pi/packages/ai/src/providers"
for f in "$UPSTREAM"/*.ts; do
    name=$(basename "$f")
    # 保留本地独有的 faux.ts
    if [ "$name" = "faux.ts" ]; then continue; fi
    cp "$f" "$LOCAL/$name"
done
```

- [ ] **Step 2: 删除已移到 api/ 的旧文件**

```bash
cd /data/mine/pi/packages/ai/src/providers
rm -f openai-responses-shared.ts register-builtins.ts github-copilot-headers.ts \
      google-shared.ts openai-prompt-cache.ts simple-options.ts transform-messages.ts
```

- [ ] **Step 3: 确认 faux.ts 未被覆盖（保留本地测试文件）**

```bash
wc -l /data/mine/pi/packages/ai/src/providers/faux.ts
```

---

## Task 3: 运行模型生成脚本

- [ ] **Step 1: 运行 generate-models.ts**

```bash
cd /data/mine/pi/packages/ai
npx tsx scripts/generate-models.ts
```

预期输出：
- 35 个 `providers/*.models.ts` 文件
- 1 个聚合 `models.generated.ts` (~77行)

- [ ] **Step 2: 验证模型数量**

```bash
cd /data/mine/pi && grep -c 'Provider' packages/ai/src/models.generated.ts
```

---

## Task 4: 替换 index.ts

- [ ] **Step 1: 备份本地 index.ts 的特殊导出**

```bash
diff /data/mine/pi/packages/ai/src/index.ts /data/mine/earendil-works-pi/packages/ai/src/index.ts | grep '^<' | head -30
```

检查本地是否有特有导出需要保留。

- [ ] **Step 2: 替换为上游 index.ts**

```bash
cp /data/mine/earendil-works-pi/packages/ai/src/index.ts /data/mine/pi/packages/ai/src/index.ts
```

- [ ] **Step 3: 如有本地特有导出，追加到新 index.ts**

在上一步 diff 中检查，如有必要的本地导出，追加到文件末尾。

---

## Task 5: 编译修复（迭代）

- [ ] **Step 1: 首次编译 — 记录全部错误**

```bash
cd /data/mine/pi && npx tsgo --noEmit 2>&1 | grep -v 'packages/ai/test/' | grep 'error' | head -50
```

- [ ] **Step 2: 逐批修复 import 路径**

预期错误类型和处理：
1. `Cannot find module './providers/xxx'` → import 路径已变，但上游已修复
2. `Module '"@schovest/pi-ai"' has no exported member 'X'` → 类型已移到新位置
3. `Type '"xxx"' is not assignable to type '"yyy"'` → 枚举/字面量类型变更

每修复一批运行 `npx tsgo --noEmit` 验证，直到零错误。

- [ ] **Step 3: 处理 coding-agent 包的 import 适配**

```bash
cd /data/mine/pi && npx tsgo --noEmit 2>&1 | grep 'packages/coding-agent/' | grep -v test | head -20
```

- [ ] **Step 4: 处理 agent 包的 import 适配**

```bash
cd /data/mine/pi && npx tsgo --noEmit 2>&1 | grep 'packages/agent/' | grep -v test | head -20
```

---

## Task 6: 最终验证与提交

- [ ] **Step 1: 全量类型检查零错误**

```bash
cd /data/mine/pi && npx tsgo --noEmit 2>&1 | grep -v 'packages/ai/test/' | grep -v 'node_modules' | grep error
```

预期：无输出

- [ ] **Step 2: ai 包测试**

```bash
cd /data/mine/pi && npx vitest run --dir packages/ai/test 2>&1 | tail -20
```

- [ ] **Step 3: agent 包测试**

```bash
cd /data/mine/pi && npx vitest run --dir packages/agent/test 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
cd /data/mine/pi
git add packages/ai/src/api/ packages/ai/src/auth/ packages/ai/src/providers/ \
        packages/ai/src/*.ts packages/ai/scripts/generate-models.ts
git status -s
git commit -m "refactor: 迁移 Provider 架构到上游 api/+providers/ 分离模式

- 新增 api/ 目录 (28 文件): API 实现 + lazy 包装器
- 新增 auth/ 目录 (5 文件): 认证上下文/凭据存储
- 替换 providers/ 为工厂函数 (39 文件, ~20行/个)
- 运行 generate-models.ts 生成 35 个 .models.ts
- 替换 models.ts 为 Provider/Models/createProvider 抽象
- 新增 compat.ts / legacy-api-aliases.ts: 旧 API 兼容
- 替换 index.ts 为上游精简版本
- 替换 types.ts/utils.ts 等基础设施文件
- models.generated.ts: 18k行 → 77行聚合"
```
