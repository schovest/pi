# 上游 0.79.8~Unreleased 合并设计

> 日期: 2026-07-14 | 版本: v1  
> 上游源: `/data/mine/earendil-works-pi` | 目标: `/data/mine/pi`

## 概述

将上游 Pi (schovest/pi) 0.79.8 到 Unreleased 的 64 项特性和修复合并到本地 fork。按功能模块分解为 8 个独立模块，模块 A（Provider 架构迁移）是其他模块的前置依赖。

## 模块分解

| # | 模块 | 项数 | 核心工作 | 前置依赖 |
|---|------|------|---------|---------|
| A | Provider 架构迁移 | ~35 | api/ + 工厂函数 + 模型生成 + /compat | 无 |
| B | Provider 数据修复 | ~10 | 重新运行模型生成脚本 | A |
| C | Compaction | 5 | token 估算、retained-token、overflow retry | 无(独立) |
| D | Session | 5 | 子树排序、deep branch、--session reject | 无(独立) |
| E | Stability | 9 | retry 分类、null 标准化、truncated calls | 无(独立) |
| F | Tools | 4 | fuzzy edit、bash WSL、find git、edit schema | 无(独立) |
| G | Extension API | 11 | agent_settled、entry renderers、dynamic tools | A |
| H | Misc | 3 | RPC、SDK metadata、安全依赖 | 无(独立) |

## 执行顺序

```
A (Provider架构) → B (模型数据) + G (Extension API)
C, D, E, F, H 可并行
```

---

## 模块 A：Provider 架构迁移

### 目标

将本地单文件 `providers/xxx.ts` (500-1500行) + 单文件 `models.generated.ts` (18665行) 架构，迁移为上游的：
- `api/xxx.ts` (API 实现) + `api/xxx.lazy.ts` (延迟包装器)
- `providers/xxx.ts` (~20行工厂函数) + `providers/xxx.models.ts` (模型数据)
- `models.generated.ts` (聚合文件，~77行)
- `models.ts` (核心 Provider/Models/createProvider 抽象)
- `compat.ts` (旧 API 兼容入口)
- `legacy-api-aliases.ts` (streamSimple 别名)

### 涉及文件 (预估 ~90 文件)

**新建目录 (`packages/ai/src/`):**
- `api/` — 14 个 API 实现 + 14 个 lazy 包装器 + 6 个辅助文件
- `auth/` — 认证上下文、凭据存储、辅助函数

**新建文件:**
- `providers/*.models.ts` — 35 个独立模型定义文件（由生成脚本产出）
- `providers/all.ts` — builtinProviders/builtinModels 工厂
- `compat.ts` — 旧 API 兼容入口
- `legacy-api-aliases.ts` — streamSimple 等旧别名

**覆盖文件:**
- `providers/` 下所有现有文件 → 改为工厂函数（~20行/个）
- `models.generated.ts` → 聚合文件（~77行）
- `models.ts` → Provider/Models/createProvider 抽象（~291行）
- `index.ts` → 精简导出（~47行）
- `types.ts` → 增加 Provider 相关新类型
- `scripts/generate-models.ts` → 适配新的输出路径和格式

**删除文件:**
- `models.generated.ts` 旧版（18665行，由新聚合文件替代）
- `image-models.generated.ts`（如果上游已拆分）

### 方法

策略：**从上游复制基础设施 + API 层，然后在本地适配**。不逐行迁移——因为本地没有对 provider 协议层的修改。

**Step 1: 复制基础设施（无依赖，最先做）**
   - `api/lazy.ts` — 核心 lazy 包装器
   - `auth/` 目录 — 认证抽象
   - `models.ts` — Provider/Models/createProvider
   - `compat.ts`、`legacy-api-aliases.ts`
   
2. **从上游复制 API 层** — 每个 API 文件是纯协议实现，无本地修改：
   - `api/anthropic-messages.ts` + `.lazy.ts`
   - `api/openai-completions.ts` + `.lazy.ts`
   - `api/openai-responses.ts` + `.lazy.ts`
   - `api/openai-codex-responses.ts` + `.lazy.ts`
   - `api/openai-responses-shared.ts`
   - 等共 28 个文件

3. **创建 Provider 工厂函数** — 每个 ~20 行，格式统一：
   ```typescript
   export function anthropicProvider(): Provider<"anthropic-messages"> {
     return createProvider({
       id: "anthropic",
       name: "Anthropic",
       auth: { apiKey: ..., oauth: ... },
       models: Object.values(ANTHROPIC_MODELS),
       api: anthropicMessagesApi(),
     });
   }
   ```

4. **运行模型生成脚本** — 上游 `generate-models.ts` 写入 `providers/*.models.ts` + 聚合 `models.generated.ts`

5. **适配 import 路径** — `coding-agent/` 中的 import 从 `@schovest/pi-ai` 根入口改为新路径

6. **更新 index.ts** — 遵循上游的简短导出风格

### 验证标准

- `npx tsgo --noEmit` 零错误
- `packages/ai/test/` 中现有测试全部通过
- provider 延迟加载正常工作（启动不 import 所有 SDK）
- `/model` 选择器中模型列表完整
- 扩展通过 compat 入口正常加载

### 风险

- 大规模文件变动可能导致隐式依赖断裂
- 本地对 provider 的修改需要合并到上游架构中
- 不确定本地是否有对 `providers/` 文件的内部 patch

---

## 模块 B：Provider 数据修复 (~10 项)

### 目标

通过重新运行模型生成脚本，自动获得上游新增/修正的模型元数据：
- Claude Sonnet 5、Fable 5 xhigh/max
- GPT-5.6 metadata
- Thinking level maps
- Context windows
- Input pricing tiers
- OpenRouter 模型上下文窗口

### 方法

运行 `scripts/generate-models.ts` → 写入新 `.models.ts` 文件。

### 验证

- `tsgo --noEmit` 无新增错误
- 新模型在 `/model` 选择器中可见

---

## 模块 C：Compaction (5 项)

### 涉及文件

- `packages/agent/src/harness/compaction/compaction.ts`
- `packages/coding-agent/src/core/compaction/`
- `packages/coding-agent/src/core/session-manager.ts`

### 逐项方案

| # | 上游版本 | 变更 | 文件 | 方法 |
|---|---------|------|------|------|
| C1 | 0.79.8 | post-compaction token 估算 | compaction types | 对比上游 `CompactionResult` 新增字段 |
| C2 | 0.79.8 | 拒绝无可压缩消息的 session | compaction.ts | 对比上游空消息守卫逻辑 |
| C3 | 0.79.8 | overflow retry 完成后不重试 | agent-session.ts | 对比上游 `assistantIsFromBeforeCompaction` 守卫 |
| C4 | 0.80.4 | retained-token 计入自定义消息 | compaction token 计数 | 对比上游 `tokensBefore` 计算 |
| C5 | 0.80.6 | post-compaction output budget | compaction budget | 对比上游 budget 忽略陈旧 usage |

### 验证

- 现有 compaction 测试通过
- 手动 compaction 后 token 数正确

---

## 模块 D：Session (5 项)

### 涉及文件

- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`

### 逐项方案

| # | 上游版本 | 变更 | 方法 |
|---|---------|------|------|
| D1 | 0.79.9 | deep branches 二次方→线性 | 对比上游 `getTree()` O(n) 实现 |
| D2 | 0.80.0 | selector 子树最新活动排序 | 对比上游排序逻辑（子树内 max modified） |
| D3 | 0.80.3 | resource notifications 在 messages 前 | 对比上游 session resume 加载顺序 |
| D4 | 0.80.3 | --session reject 无效文件 | 对比上游文件验证逻辑 |
| D5 | 0.80.3 | --no-session --session-id 确定性 | 对比上游 session-id 传递链路 |

---

## 模块 E：Stability (9 项)

### 涉及文件

分散在 `packages/ai/src/providers/`、`packages/coding-agent/src/`、`packages/agent/src/`

### 逐项方案

| # | 上游版本 | 变更 | 方法 |
|---|---------|------|------|
| E1 | 0.79.9 | same-dir session switch 复用扩展 | 对比上游 switchSession 逻辑 |
| E2 | 0.80.3 | output length 可见错误提示 | 对比上游错误渲染 |
| E3 | 0.80.3 | auto-retry stream errors | 对比上游 retry 分类新增模式 |
| E4 | 0.80.4 | gRPC ResourceExhausted 重试 | 对比上游 retry patterns |
| E5 | 0.80.4 | Cloudflare 524 重试 | 对比上游 retry patterns |
| E6 | 0.80.4 | null message content 标准化 | 对比上游 message transform 层 |
| E7 | 0.80.4 | 截断 tool calls 改为失败 | 对比上游 tool call 解析 |
| E8 | 0.80.4 | Bun socket-drop 自动重试 | 对比上游 fetch error 检测 |
| E9 | 0.80.4 | Windows context 文件发现 | 对比上游 parent 遍历逻辑 |

---

## 模块 F：Tools (4 项)

### 涉及文件

- `packages/coding-agent/src/core/tools/edit-diff.ts`
- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/core/tools/find.ts`

### 逐项方案

| # | 上游版本 | 变更 | 方法 |
|---|---------|------|------|
| F1 | 0.79.9 | fuzzy edit 保留未触碰行块 | 对比上游 `applyEditsToNormalizedContent` |
| F2 | 0.79.9 | bash WSL bash.exe stdin | 对比上游 shell spawn 逻辑 |
| F3 | 0.79.10 | find 尊重嵌套 git 边界 | 对比上游 `--no-require-git` 处理 |
| F4 | 0.80.4 | edit schema 允许额外字段 | 对比上游 schema 放宽 |

---

## 模块 G：Extension API (11 项)

### 涉及文件

- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/core/extensions/loader.ts`
- `packages/coding-agent/src/core/agent-session.ts`

### 逐项方案

低复杂度（添加字段/事件类型）：

| # | 上游版本 | 变更 | 方法 |
|---|---------|------|------|
| G1 | 0.79.10 | session_compact 事件加 reason/willRetry | 对比上游 `SessionCompactEvent` 新增字段 + emit 处传递值 |
| G3 | 0.80.0 | 扩展崩溃提示 pi -ne | 对比上游 `EXTENSION_LOAD_FAILURE_HINT` 常量 + 使用位置 |

中复杂度（新增事件发射逻辑）：

| # | 上游版本 | 变更 | 方法 |
|---|---------|------|------|
| G2 | 0.79.10 | transient UI 消息 reload 后保持 | 对比上游 runner.ts 中消息可见性管理 |
| G4 | 0.80.3 | session_info_changed 事件 | 对比上游 agent-session.ts 中 `setSessionName` 发送事件逻辑 |
| G5 | 0.80.3 | extension tool changes 在下一次 request 前应用 | 对比上游 agent-loop 中工具刷新时机 |

高复杂度（新架构概念，逐项对比上游移植）：

| # | 上游版本 | 变更 | 涉及上游文件 |
|---|---------|------|-------------|
| G6 | 0.80.4 | agent_settled 事件 + session 级 idle 等待 | extensions/types.ts, agent-session.ts, agent-harness.ts |
| G7 | 0.80.4 | before_provider_headers 注入请求头 | extensions/types.ts, agent-session.ts, provider 调用链 |
| G8 | 0.80.4 | InlineExtension 类型 | extensions/types.ts, loader.ts |
| G9 | 0.80.4 | entry renderers (display-only entries) | extensions/types.ts, agent-session.ts, interactive-mode components |
| G10 | Unreleased | dynamic tool loading (cache-friendly) | extensions/types.ts, agent-session.ts, tool manager |

---

## 模块 H：Misc (3 项)

| # | 上游版本 | 变更 | 方法 |
|---|---------|------|------|
| H1 | 0.80.3 | RPC get_entries/get_tree | 对比上游 rpc-mode.ts 新增命令 |
| H2 | 0.80.4 | JSONL session metadata | 对比上游 jsonl-storage.ts |
| H3 | 0.79.8 | 安全依赖更新 | 对比上游 package.json 版本号 |

---

## 验证策略

每个模块完成后：
1. `npx tsgo --noEmit` 零错误
2. 相关测试通过
3. CSV 标记已合并
4. 独立 commit

---

## 风险与注意事项

1. **模块 A 是最大风险点**：~90 文件变动。策略是从上游完整复制并适配本地 import 路径，而非逐行手工迁移。
2. **包名差异**：上游使用 `@schovest/pi-ai`，本地使用 `@schovest/pi-ai`（一致）。
3. **coding-agent 依赖**：模块 A 完成后需更新 `packages/coding-agent/src/` 中的 import 路径。
4. **扩展兼容性**：compat 入口保证现有扩展不受影响。
